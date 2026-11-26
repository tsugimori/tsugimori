import type { Config, WorkspaceConfig } from '@tsugimori/config';
import type {
  AgentConnector,
  AgentDefaults,
  PlatformAdapter,
  PlatformInboundEvent,
  PlatformInstanceConfig,
  PluginInstanceConfig,
} from '@tsugimori/plugin-sdk';
import type { RemovalTarget, Store } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { ConfigError, parseConfig } from '@tsugimori/config';
import { PlatformStartError } from '@tsugimori/plugin-sdk';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { CheckReport, EnvironmentChecks } from './checks.ts';
import type { Logger } from './hooks.ts';
import type { PluginRegistry } from './registry.ts';

import { failureText } from './checks.ts';
import { describeError } from './errors.ts';

type AgentConfig = Config['agents'][number];
type AgentEntry = {
  agent: AgentConnector;
  config: AgentConfig;
  defaults?: AgentDefaults;
};
export type AttachmentStatus = { id: string } & (
  | { state: 'running' | 'disabled' | 'starting' }
  | { attempt: number; retryAt: number; state: 'retrying' }
  | { failure?: CheckReport; state: 'unavailable' }
);
type AgentAttachmentStatus = AttachmentStatus & {
  implementation?: string;
  kind: string;
};
export type PlatformNotice =
  | { kind: 'unavailable' | 'recovered' }
  | { kind: 'environment'; report: CheckReport };

type AdapterEntry = {
  adapter: PlatformAdapter;
  alert?: NodeJS.Timeout;
  announced?: boolean;
  attempt: number;
  availableSince?: number;
  config: PlatformInstanceConfig;
  controller?: AbortController;
  failedAt?: number;
  failure?: CheckReport;
  inFlight?: Promise<void>;
  notices: PlatformNotice[];
  retry?: NodeJS.Timeout;
  retryAt?: number;
  state: 'starting' | 'active' | 'stopped';
};

const alertAfterMs = 5 * 60_000;
const maxTimerMs = 2 ** 31 - 1;

interface RuntimeDeps {
  checks: EnvironmentChecks;
  interrupt(
    adapters: ReadonlySet<string>,
    agents: ReadonlySet<string>,
  ): Promise<void>;
  log: Logger;
  platformChanged(ready: boolean): void;
  receive(adapter: PlatformAdapter, event: PlatformInboundEvent): Promise<void>;
  registry: PluginRegistry;
  store: Pick<
    Store,
    | 'clearAgentSessions'
    | 'getCursor'
    | 'getSetupRun'
    | 'getUser'
    | 'resolveChat'
    | 'saveCursor'
  >;
  trace: Tracer;
  workspace: string;
}

export class Runtime {
  readonly #deps: RuntimeDeps;
  #adapters = new Map<string, AdapterEntry>();
  #agents = new Map<string, AgentEntry>();
  #snapshot?: WorkspaceConfig;
  #reports: CheckReport[] = [];
  #stopping = false;
  #transition?: Promise<void>;

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
  }

  get snapshot() {
    if (!this.#snapshot) throw new Error('Gateway has not started');
    return this.#snapshot;
  }

  get config() {
    return this.snapshot.config;
  }

  get transition() {
    return this.#transition;
  }

  get attachments() {
    const failure = (category: 'agent' | 'platform', id: string) =>
      this.#reports.find(
        (item) =>
          item.target === `${category}/${id}` &&
          item.status === 'fail' &&
          (!item.capabilities || item.capabilities.includes(category)),
      );
    const platforms = this.config.platforms.map(
      ({ enabled, id }): AttachmentStatus => {
        if (enabled === false) return { id, state: 'disabled' };
        const entry = this.#adapters.get(id);
        if (entry?.state === 'active') return { id, state: 'running' };
        if (entry?.retryAt !== undefined)
          return {
            id,
            state: 'retrying',
            attempt: entry.attempt,
            retryAt: entry.retryAt,
          };
        if (entry?.state === 'starting' && !entry.failure)
          return { id, state: 'starting' };
        return {
          id,
          state: 'unavailable',
          failure: entry?.failure ?? failure('platform', id),
        };
      },
    );
    const agents = this.config.agents.map(
      ({ enabled, id, kind }): AgentAttachmentStatus => {
        const entry = this.#agents.get(id);
        const implementation =
          entry?.agent.implementation ||
          this.#deps.registry.agentImplementation(kind);
        const identity = { id, implementation, kind };
        if (enabled === false) return { ...identity, state: 'disabled' };
        if (entry) return { ...identity, state: 'running' };
        return {
          ...identity,
          state: 'unavailable',
          failure: failure('agent', id),
        };
      },
    );
    return { platforms, agents };
  }

  get adapterIds() {
    return [...this.#adapters.keys()].filter((id) => this.getAdapter(id));
  }

  adapterKind(id: string) {
    return (
      this.#adapters.get(id)?.config.kind ??
      this.config.platforms.find((entry) => entry.id === id)?.kind
    );
  }

  getAdapter(id: string) {
    const entry = this.#adapters.get(id);
    if (entry?.state === 'active') return entry.adapter;
  }

  availableSince(id: string) {
    return this.#adapters.get(id)?.availableSince;
  }

  get pendingPlatformNotices() {
    return [...this.#adapters.entries()]
      .filter(([, entry]) => entry.notices.length)
      .map(([id]) => id);
  }

  takePlatformNotices(id: string) {
    return this.#adapters.get(id)?.notices.splice(0) ?? [];
  }

  adminAgentInfo(id: string) {
    const attachment = this.attachments.agents.find((agent) => agent.id === id);
    const config = this.config.agents.find((agent) => agent.id === id);
    const login = this.#reports.find(
      ({ target, id: check }) =>
        target === `agent/${id}` &&
        ['claude-login', 'codex-login', 'login-pending'].includes(check),
    );
    return {
      implementation: attachment?.implementation,
      isDefault:
        id === (this.config.defaultAgent ?? this.defaultAgent()?.agent.id),
      model: config?.model ?? this.getAgent(id)?.defaults?.model,
      login:
        login?.status === 'ok'
          ? ('signed-in' as const)
          : login?.status === 'fail'
            ? ('required' as const)
            : ('unknown' as const),
      state:
        attachment?.state === 'disabled'
          ? ('disabled' as const)
          : attachment?.state === 'running'
            ? ('ready' as const)
            : ('error' as const),
    };
  }

  getAgent(id: string) {
    return this.#agents.get(id);
  }

  defaultAgent() {
    const id = this.config.defaultAgent;
    return (id && this.getAgent(id)) || this.#agents.values().next().value;
  }

  get reports() {
    return [
      ...this.#reports,
      ...[...this.#adapters.values()].flatMap(({ adapter, failure, state }) =>
        state === 'starting' ? [failure ?? unavailableReport(adapter.id)] : [],
      ),
    ];
  }

  get environmentReports() {
    return this.#reports;
  }

  disabled(capability: string) {
    return this.#reports.some(
      (item) =>
        item.status === 'fail' && item.capabilities?.includes(capability),
    );
  }

  unavailable(id?: string) {
    const first =
      id ??
      this.config.defaultAgent ??
      this.config.agents.find(({ enabled }) => enabled !== false)?.id;
    if (!first || this.getAgent(first)) return '';
    return failureText(
      this.#reports.filter(({ target }) => target === `agent/${first}`),
      this.config.locale,
    );
  }

  async apply(
    snapshot: WorkspaceConfig,
    removal?: RemovalTarget,
    configureWebhooks?: () => Promise<void>,
  ) {
    const { workspace, registry } = this.#deps;
    const config = parseConfig(JSON.stringify(snapshot.config), registry);
    const env = new Map(snapshot.env);
    if (
      this.#snapshot &&
      resolve(workspace, config.storage.path) !==
        resolve(workspace, this.config.storage.path)
    ) {
      throw new Error('Changing the database path requires a restart');
    }
    const envChanged = !isDeepStrictEqual(env, this.#snapshot?.env);
    const credentialsChanged = (
      category: 'agent' | 'platform',
      entry: PluginInstanceConfig,
    ) => {
      if (!envChanged) return false;
      const names = registry
        .forInstance(category, entry.kind)
        ?.credentialNames?.(entry);
      return (
        !names ||
        names.some((name) => env.get(name) !== this.#snapshot?.env.get(name))
      );
    };
    const { checks, trace } = this.#deps;
    const measure = <T>(target: string, run: () => Promise<T>) =>
      trace.span('environment.check', { target }, run);
    const current = { config, env };
    const reloaded =
      this.#snapshot && !isDeepStrictEqual(current, this.#snapshot);
    const reports = await measure('core', () => checks.core(current));
    const conflicts = reports.filter(({ id }) => id === 'listener-conflict');
    if (conflicts.length) throw new ConfigError(failureText(conflicts));
    await configureWebhooks?.();
    reports.push(
      ...(await measure('features', () => checks.features(current, registry))),
    );
    const check = async (
      category: 'agent' | 'platform',
      entry: PluginInstanceConfig,
    ) => {
      const target = `${category}/${entry.id}`;
      const items = await measure(target, () =>
        checks.plugin(
          registry.forInstance(category, entry.kind),
          { ...checks.context(entry, env, config), startup: true },
          target,
          category,
        ),
      );
      reports.push(...items);
      return !items.some(
        (item) =>
          item.status === 'fail' &&
          (item.capabilities ?? [category]).includes(category),
      );
    };
    const failedStart = (category: 'agent' | 'platform', id: string) => {
      reports.push({
        target: `${category}/${id}`,
        id: 'attach',
        title: 'Plugin startup',
        status: 'fail',
        detail:
          'The plugin could not start. Check its configuration and try again.',
        localized: {
          'zh-TW': { title: '插件啟動', hint: '請檢查插件設定後重試。' },
        },
      });
    };
    const nextAgents = new Map<string, AgentEntry>();
    const nextAdapters = new Map<string, AdapterEntry>();
    const createdAgents: AgentEntry[] = [];
    const stoppedAdapters: AdapterEntry[] = [];
    const changedAdapters = new Set<string>();
    const changedAgents = new Set<string>();
    let removalStopFailed = false;
    const ready = Promise.withResolvers<void>();

    try {
      for (const entry of config.agents) {
        if (entry.enabled === false) {
          const pending = this.#deps.store.getSetupRun(
            JSON.stringify(['login', 'agent', entry.id]),
          );
          if (pending?.status === 'pending') {
            reports.push({
              target: `agent/${entry.id}`,
              id: 'login-pending',
              title: 'Login pending',
              status: 'fail',
              detail: `Sign-in is incomplete. Run /login ${entry.id} to resume.`,
              localized: {
                'zh-TW': {
                  title: '等待登入',
                  hint: `請執行 /login ${entry.id} 繼續登入。`,
                },
              },
            });
          }
          continue;
        }
        const old = this.#agents.get(entry.id);
        if (
          old &&
          !credentialsChanged('agent', entry) &&
          isDeepStrictEqual(old.config, entry)
        ) {
          nextAgents.set(entry.id, old);
          reports.push(
            ...this.#reports.filter(
              ({ target }) => target === `agent/${entry.id}`,
            ),
          );
        } else {
          if (!(await check('agent', entry))) continue;
          let agent: AgentConnector | undefined;
          try {
            agent = await registry.agent(entry.kind)(
              entry,
              checks.context(entry, env),
            );
            checkIdentity(entry, agent);
            await agent.start?.();
            const next = { config: entry, agent };
            createdAgents.push(next);
            nextAgents.set(entry.id, next);
          } catch {
            await this.#stop(() => agent?.stop?.());
            failedStart('agent', entry.id);
          }
        }
      }
      for (const entry of config.platforms.filter(
        (entry) => entry.enabled !== false,
      )) {
        const old = this.#adapters.get(entry.id);
        if (
          old &&
          !credentialsChanged('platform', entry) &&
          isDeepStrictEqual(old.config, entry)
        ) {
          nextAdapters.set(entry.id, old);
          reports.push(
            ...this.#reports.filter(
              ({ target }) => target === `platform/${entry.id}`,
            ),
          );
        } else {
          if (!(await check('platform', entry))) continue;
          try {
            const adapter = await registry.platform(entry.kind)(
              entry,
              checks.context(entry, env),
            );
            checkIdentity(entry, adapter);
            nextAdapters.set(entry.id, {
              config: entry,
              adapter,
              state: 'stopped',
              attempt: 0,
              notices: [],
            });
          } catch {
            failedStart('platform', entry.id);
          }
        }
      }
      for (const [id, entry] of this.#adapters) {
        // Rebind pending retries to the new snapshot while preserving their cooldown.
        if (
          nextAdapters.get(id) !== entry ||
          (reloaded && entry.retryAt !== undefined)
        )
          changedAdapters.add(id);
      }
      for (const [id, entry] of this.#agents) {
        if (nextAgents.get(id) !== entry) changedAgents.add(id);
      }
      for (const [id, entry] of nextAgents) {
        if (!entry.agent.describeDefaults) continue;
        let defaults: AgentDefaults | undefined;
        try {
          defaults = await entry.agent.describeDefaults();
        } catch {
          this.#deps.log({
            level: 'warn',
            event: 'agent.defaults_failed',
            target: `agent/${id}`,
          });
        }
        nextAgents.set(id, { ...entry, defaults });
      }
      const sandboxChanged =
        this.#snapshot &&
        (!isDeepStrictEqual(this.config.exec, config.exec) ||
          !isDeepStrictEqual(
            sandboxHomes(
              this.config,
              removal?.category === 'agent' ? removal.id : undefined,
            ),
            sandboxHomes(config),
          ) ||
          this.disabled('exec') !==
            reports.some(
              (item) =>
                item.status === 'fail' && item.capabilities?.includes('exec'),
            ));
      if (changedAdapters.size || changedAgents.size || sandboxChanged)
        this.#transition = ready.promise;
      // Stop the previous receiver before starting a replacement for the same platform identity.
      for (const id of changedAdapters) {
        const entry = this.#adapters.get(id);
        if (!entry) continue;
        this.#suspend(entry);
        const replacement = nextAdapters.get(id);
        if (replacement && replacement !== entry) {
          replacement.announced = entry.announced;
          replacement.notices.push(...entry.notices);
        }
        stoppedAdapters.push(entry);
      }
      await this.#deps.interrupt(
        sandboxChanged ? new Set(this.#adapters.keys()) : changedAdapters,
        changedAgents,
      );
      for (const id of changedAgents) {
        const old = this.#agents.get(id)!;
        const next = nextAgents.get(id)?.config;
        if (
          (removal?.category !== 'agent' || removal.id !== id) &&
          (!next ||
            credentialsChanged('agent', next) ||
            !isDeepStrictEqual(
              { ...old.config, compactAt: next.compactAt },
              next,
            ))
        )
          this.#deps.store.clearAgentSessions(id);
      }
      for (const entry of stoppedAdapters) {
        try {
          await this.#stopAdapter(entry);
        } catch {
          nextAdapters.delete(entry.adapter.id);
          failedStart('platform', entry.adapter.id);
          if (
            removal?.category === 'platform' &&
            removal.id === entry.adapter.id
          )
            removalStopFailed = true;
        }
      }
    } catch (error) {
      for (const entry of createdAgents)
        await this.#stop(() => entry.agent.stop?.());
      this.#transition = undefined;
      ready.resolve();
      for (const entry of stoppedAdapters) {
        try {
          await this.#stopAdapter(entry);
          await this.#resume(entry);
        } catch {
          this.#deps.log({
            level: 'error',
            event: 'platform.restore_failed',
            adapterId: entry.adapter.id,
          });
        }
      }
      throw error;
    }

    for (const id of changedAgents) {
      const stop = () => this.#agents.get(id)?.agent.stop?.();
      if (removal?.category === 'agent' && removal.id === id) {
        try {
          await stop();
        } catch {
          removalStopFailed = true;
          this.#deps.log({
            level: 'error',
            event: 'plugin.stop_failed',
            target: `agent/${id}`,
          });
        }
      } else {
        await this.#stop(stop);
      }
    }
    this.#snapshot = current;
    for (const item of reports) {
      if (
        item.status === 'ok' ||
        this.#reports.some((old) => isDeepStrictEqual(old, item))
      )
        continue;
      this.#deps.log({
        level: 'warn',
        event: 'environment.check',
        target: item.target,
        check: item.id,
        reason: item.detail,
      });
    }
    this.#reports = reports;
    this.#adapters = nextAdapters;
    this.#agents = nextAgents;
    this.#transition = undefined;
    ready.resolve();
    await Promise.all(
      [...nextAdapters.values()].map((entry) => this.#resume(entry)),
    );
    if (removalStopFailed)
      throw new Error('Removed plugin did not stop cleanly');
  }

  #resume(entry: AdapterEntry) {
    if (this.#stopping || entry.state === 'active' || entry.inFlight) return;
    entry.state = 'starting';
    if (entry.failure) {
      this.#schedule(entry);
      return;
    }
    return this.#launch(entry);
  }

  #launch(entry: AdapterEntry) {
    const controller = new AbortController();
    entry.controller = controller;
    entry.inFlight = this.#attempt(entry, controller.signal).finally(() => {
      entry.inFlight = undefined;
    });
    return entry.inFlight;
  }

  async #attempt(entry: AdapterEntry, signal: AbortSignal) {
    const { adapter } = entry;
    const { store, log, trace } = this.#deps;
    const attempt = ++entry.attempt;
    const attrs = { adapterId: adapter.id, attempt };
    const buffered: PlatformInboundEvent[] = [];
    const ready = Promise.withResolvers<void>();
    let activated = false;
    try {
      await trace.span('platform.start', attrs, async () => {
        await adapter.start({
          emit: async (event) => {
            signal.throwIfAborted();
            if (activated) await this.#deps.receive(adapter, event);
            else buffered.push(event);
          },
          ready: ready.promise,
          signal,
          getUser: (userId) => store.getUser({ adapterId: adapter.id, userId }),
          resolveChatId: (chatId) =>
            store.resolveChat({ adapterId: adapter.id, chatId }).chatId,
          loadCursor: (stream) => store.getCursor(adapter.id, stream),
          saveCursor: (stream, cursor) =>
            store.saveCursor(adapter.id, stream, cursor),
          logInfo: (event) =>
            log({ level: 'info', event, adapterId: adapter.id }),
          logDebug: (event) =>
            log({ level: 'debug', event, adapterId: adapter.id }),
          logError: (event, error) =>
            log({
              level: 'error',
              event,
              adapterId: adapter.id,
              ...(error === undefined ? {} : { error: describeError(error) }),
            }),
          logWarning: (event, reason) =>
            log({
              level: 'warn',
              event,
              adapterId: adapter.id,
              ...(reason === undefined ? {} : { reason }),
            }),
        });
        signal.throwIfAborted();
      });
    } catch (error) {
      if (signal.aborted) return;
      const hint =
        error instanceof PlatformStartError ? error.options : undefined;
      const terminal = hint && 'failure' in hint ? hint.failure : undefined;
      const cooldown = hint && 'retryAfterMs' in hint ? hint.retryAfterMs : 0;
      const base = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
      const nextDelayMs = terminal
        ? null
        : Math.max(
            Math.ceil(base * (0.75 + Math.random() * 0.25)),
            Number.isFinite(cooldown) ? cooldown : 0,
          );
      const now = Date.now();
      entry.failure = terminal
        ? { ...terminal, target: `platform/${adapter.id}` }
        : unavailableReport(adapter.id);
      entry.failedAt ??= now;
      entry.retryAt = nextDelayMs === null ? undefined : now + nextDelayMs;
      log({
        level: 'warn',
        event: 'platform.start_failed',
        ...attrs,
        nextDelayMs,
      });
      trace.record(
        'platform.start_failed',
        { ...attrs, nextDelayMs },
        0,
        'error',
      );

      if (terminal) {
        clearTimeout(entry.alert);
        entry.alert = undefined;
        entry.announced = true;
        entry.notices.push({ kind: 'environment', report: entry.failure });
        this.#deps.platformChanged(false);
      } else {
        this.#scheduleAlert(entry, entry.failedAt);
      }
      const controller = entry.controller;
      entry.controller = undefined;
      controller?.abort();
      await this.#stop(() => adapter.stop());
      if (entry.state === 'starting' && !this.#stopping) this.#schedule(entry);
      return;
    }

    clearTimeout(entry.alert);
    entry.alert = undefined;
    entry.retryAt = undefined;
    entry.failure = undefined;
    entry.failedAt = undefined;
    entry.availableSince = Date.now();
    entry.state = 'active';
    while (buffered.length && !signal.aborted) {
      try {
        await this.#deps.receive(adapter, buffered.shift()!);
      } catch {
        log({ level: 'error', event: 'inbound.failed', adapterId: adapter.id });
      }
    }
    if (signal.aborted) return;
    activated = true;
    ready.resolve();
    if (entry.announced) {
      entry.announced = false;
      entry.notices.push({ kind: 'recovered' });
    }
    entry.attempt = 0;
    this.#deps.platformChanged(true);
  }

  #schedule(entry: AdapterEntry) {
    const { retryAt, failedAt } = entry;
    if (retryAt === undefined || failedAt === undefined) return;
    this.#scheduleAlert(entry, failedAt);
    if (entry.retry) return;
    entry.retry = setTimeout(
      () => {
        entry.retry = undefined;
        if (retryAt > Date.now()) {
          this.#schedule(entry);
          return;
        }
        void this.#launch(entry).catch(() =>
          this.#deps.log({
            level: 'error',
            event: 'platform.retry_failed',
            adapterId: entry.adapter.id,
          }),
        );
      },
      Math.min(maxTimerMs, Math.max(0, Math.ceil(retryAt - Date.now()))),
    );
    entry.retry.unref();
  }

  #scheduleAlert(entry: AdapterEntry, failedAt: number) {
    if (entry.alert || entry.announced) return;
    entry.alert = setTimeout(
      () => {
        entry.alert = undefined;
        entry.announced = true;
        entry.notices.push({ kind: 'unavailable' });
        this.#deps.platformChanged(false);
      },
      Math.max(0, failedAt + alertAfterMs - Date.now()),
    );
    entry.alert.unref();
  }

  #suspend(entry: AdapterEntry) {
    entry.state = 'stopped';
    clearTimeout(entry.alert);
    clearTimeout(entry.retry);
    entry.alert = entry.retry = undefined;
    entry.controller?.abort();
  }

  async #stopAdapter(entry: AdapterEntry) {
    await entry.inFlight;
    if (entry.controller) {
      entry.controller = undefined;
      await entry.adapter.stop();
    }
  }

  cancelStarts() {
    this.#stopping = true;
    for (const entry of this.#adapters.values()) {
      if (entry.state === 'starting') this.#suspend(entry);
    }
  }

  async #stop(stop: () => void | Promise<void>) {
    try {
      await stop();
    } catch {
      this.#deps.log({ level: 'error', event: 'plugin.stop_failed' });
    }
  }

  async stop() {
    this.cancelStarts();
    for (const entry of this.#adapters.values()) this.#suspend(entry);
    await this.#deps.interrupt(new Set(this.#adapters.keys()), new Set());
    for (const entry of this.#adapters.values())
      await this.#stop(() => this.#stopAdapter(entry));
    for (const entry of this.#agents.values())
      await this.#stop(() => entry.agent.stop?.());
    this.#adapters.clear();
    this.#agents.clear();
  }
}

function unavailableReport(id: string): CheckReport {
  return {
    target: `platform/${id}`,
    id: 'attach',
    title: 'Platform startup',
    status: 'fail',
    detail:
      'The platform is unavailable. Startup will be retried automatically.',
    localized: {
      'zh-TW': {
        title: '平台啟動',
        hint: '平台目前無法使用，系統會自動重試。',
      },
    },
  };
}

function checkIdentity(
  entry: { id: string; kind: string },
  plugin: { id: string; kind: string },
) {
  if (entry.id !== plugin.id || entry.kind !== plugin.kind) {
    throw new Error('Plugin instance identity differs from its configuration');
  }
}

function sandboxHomes(config: Config, excluded?: string) {
  return config.agents
    .filter(({ id }) => id !== excluded)
    .flatMap(({ options }) => [options?.codexHome, options?.claudeHome])
    .filter((value): value is string => typeof value === 'string')
    .sort();
}
