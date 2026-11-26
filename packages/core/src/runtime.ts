import type { Config, WorkspaceConfig } from '@tsugimori/config';
import type {
  AgentConnector,
  PlatformAdapter,
  PlatformInboundEvent,
  PlatformInstanceConfig,
  PluginInstanceConfig,
} from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';

import { parseConfig } from '@tsugimori/config';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { CheckReport, EnvironmentChecks } from './checks.ts';
import type { Logger } from './hooks.ts';
import type { PluginRegistry } from './registry.ts';

import { failureText } from './checks.ts';
import { describeError } from './errors.ts';

type AgentConfig = Config['agents'][number];
type AgentEntry = { agent: AgentConnector; config: AgentConfig };
type AdapterEntry = {
  adapter: PlatformAdapter;
  buffered: PlatformInboundEvent[];
  config: PlatformInstanceConfig;
  generation?: symbol;
  ready?: ReturnType<typeof Promise.withResolvers<void>>;
  state: 'staged' | 'active' | 'stopped';
};

interface RuntimeDeps {
  checks: EnvironmentChecks;
  interrupt(
    adapters: ReadonlySet<string>,
    agents: ReadonlySet<string>,
  ): Promise<void>;
  log: Logger;
  measure<T>(target: string, run: () => Promise<T>): Promise<T>;
  receive(adapter: PlatformAdapter, event: PlatformInboundEvent): Promise<void>;
  registry: PluginRegistry;
  store: Pick<
    Store,
    | 'clearAgentSessions'
    | 'getCursor'
    | 'getSetupRun'
    | 'getUser'
    | 'saveCursor'
  >;
  workspace: string;
}

export class Runtime {
  readonly #deps: RuntimeDeps;
  #adapters = new Map<string, AdapterEntry>();
  #agents = new Map<string, AgentEntry>();
  #snapshot?: WorkspaceConfig;
  #reports: CheckReport[] = [];
  #transition?: Promise<void>;

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
  }

  get config() {
    if (!this.#snapshot) throw new Error('Gateway has not started');
    return this.#snapshot.config;
  }

  get transition() {
    return this.#transition;
  }

  get agentCount() {
    return this.#agents.size;
  }

  get adapterCount() {
    return this.#adapters.size;
  }

  get adapterIds() {
    return [...this.#adapters.keys()];
  }

  adapterKind(id: string) {
    return this.#adapters.get(id)?.config.kind;
  }

  getAdapter(id: string) {
    return this.#adapters.get(id)?.adapter;
  }

  getAgent(id: string) {
    return this.#agents.get(id);
  }

  defaultAgent() {
    const id = this.config.defaultAgent;
    return (id && this.getAgent(id)) || this.#agents.values().next().value;
  }

  get reports() {
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

  async apply(snapshot: WorkspaceConfig) {
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
    const { checks, measure } = this.#deps;
    const current = { config, env };
    const reports = [
      ...(await measure('core', () => checks.core(current))),
      ...(await measure('features', () => checks.features(current, registry))),
    ];
    const check = async (
      category: 'agent' | 'platform',
      entry: PluginInstanceConfig,
    ) => {
      const target = `${category}/${entry.id}`;
      const items = await measure(target, () =>
        checks.plugin(
          registry.forInstance(category, entry.kind),
          checks.context(entry, env),
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
    const startedAdapters: AdapterEntry[] = [];
    const stoppedAdapters: AdapterEntry[] = [];
    const changedAdapters = new Set<string>();
    const changedAgents = new Set<string>();
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
              state: 'staged',
              buffered: [],
            });
          } catch {
            failedStart('platform', entry.id);
          }
        }
      }
      for (const [id, entry] of this.#adapters) {
        if (nextAdapters.get(id) !== entry) changedAdapters.add(id);
      }
      for (const [id, entry] of this.#agents) {
        if (nextAgents.get(id) !== entry) changedAgents.add(id);
      }
      const sandboxChanged =
        this.#snapshot &&
        (!isDeepStrictEqual(this.config.exec, config.exec) ||
          !isDeepStrictEqual(sandboxHomes(this.config), sandboxHomes(config)) ||
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
        entry.state = 'stopped';
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
          !next ||
          credentialsChanged('agent', next) ||
          !isDeepStrictEqual({ ...old.config, compactAt: next.compactAt }, next)
        )
          this.#deps.store.clearAgentSessions(id);
      }
      for (const entry of stoppedAdapters) {
        try {
          await entry.adapter.stop();
        } catch {
          nextAdapters.delete(entry.adapter.id);
          failedStart('platform', entry.adapter.id);
        }
      }
      for (const entry of nextAdapters.values()) {
        if (entry.state === 'active') continue;
        try {
          await this.#startAdapter(entry);
          startedAdapters.push(entry);
        } catch {
          entry.state = 'stopped';
          await this.#stop(() => entry.adapter.stop());
          nextAdapters.delete(entry.adapter.id);
          failedStart('platform', entry.adapter.id);
        }
      }
    } catch (error) {
      for (const entry of startedAdapters) {
        entry.state = 'stopped';
        await this.#stop(() => entry.adapter.stop());
      }
      for (const entry of createdAgents)
        await this.#stop(() => entry.agent.stop?.());
      for (const entry of stoppedAdapters) {
        try {
          await this.#startAdapter(entry);
          await this.#activate(entry);
        } catch {
          entry.state = 'stopped';
          this.#deps.log({
            level: 'error',
            event: 'platform.restore_failed',
            adapterId: entry.adapter.id,
          });
        }
      }
      this.#transition = undefined;
      ready.resolve();
      throw error;
    }

    for (const id of changedAgents) {
      await this.#stop(() => this.#agents.get(id)?.agent.stop?.());
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
    for (const entry of startedAdapters) await this.#activate(entry);
  }

  async #startAdapter(entry: AdapterEntry) {
    entry.state = 'staged';
    entry.buffered = [];
    const generation = Symbol();
    const ready = Promise.withResolvers<void>();
    entry.generation = generation;
    entry.ready = ready;
    const { adapter } = entry;
    const { store, log } = this.#deps;
    await entry.adapter.start({
      emit: async (event) => {
        if (entry.generation !== generation || entry.state === 'stopped')
          throw new Error('Platform receiver is detached');
        if (entry.state === 'staged') entry.buffered.push(event);
        if (entry.state === 'active')
          await this.#deps.receive(entry.adapter, event);
      },
      ready: ready.promise,
      getUser: (userId) => store.getUser({ adapterId: adapter.id, userId }),
      loadCursor: (stream) => store.getCursor(adapter.id, stream),
      saveCursor: (stream, cursor) =>
        store.saveCursor(adapter.id, stream, cursor),
      logError: (event, error) =>
        log({
          level: 'error',
          event,
          adapterId: adapter.id,
          ...(error === undefined ? {} : { error: describeError(error) }),
        }),
    });
  }

  async #activate(entry: AdapterEntry) {
    while (entry.buffered.length) {
      const events = entry.buffered.splice(0);
      for (const event of events) {
        try {
          await this.#deps.receive(entry.adapter, event);
        } catch {
          this.#deps.log({
            level: 'error',
            event: 'inbound.failed',
            adapterId: entry.adapter.id,
          });
        }
      }
    }
    entry.state = 'active';
    entry.ready?.resolve();
  }

  async #stop(stop: () => void | Promise<void>) {
    try {
      await stop();
    } catch {
      this.#deps.log({ level: 'error', event: 'plugin.stop_failed' });
    }
  }

  async stop() {
    for (const entry of this.#adapters.values()) entry.state = 'stopped';
    await this.#deps.interrupt(new Set(this.#adapters.keys()), new Set());
    for (const entry of this.#adapters.values())
      await this.#stop(() => entry.adapter.stop());
    for (const entry of this.#agents.values())
      await this.#stop(() => entry.agent.stop?.());
    this.#adapters.clear();
    this.#agents.clear();
  }
}

function checkIdentity(
  entry: { id: string; kind: string },
  plugin: { id: string; kind: string },
) {
  if (entry.id !== plugin.id || entry.kind !== plugin.kind) {
    throw new Error('Plugin instance identity differs from its configuration');
  }
}

function sandboxHomes(config: Config) {
  return config.agents
    .flatMap(({ options }) => [options?.codexHome, options?.claudeHome])
    .filter((value): value is string => typeof value === 'string')
    .sort();
}
