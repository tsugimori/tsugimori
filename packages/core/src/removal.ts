import type { Config } from '@tsugimori/config';
import type { PluginInstanceConfig } from '@tsugimori/plugin-sdk';
import type { RemovalRows, RemovalTarget, Store } from '@tsugimori/storage';

import {
  loadSettings,
  parseEnv,
  readWorkspaceCredentials,
  replaceWorkspaceCredentials,
  updateSettings,
} from '@tsugimori/config';
import { pathId } from '@tsugimori/context';
import { credentialKey, SetupError } from '@tsugimori/plugin-sdk';
import { Tracer } from '@tsugimori/trace';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { PluginRegistry } from './registry.ts';

import {
  agentDirectories,
  displayPath,
  findChatDefaults,
  secureDirectory,
  splitCredentials,
  statIfPresent,
} from './removal-files.ts';
import { removalMessages } from './removal-messages.ts';
import { recordWorkspace, writeWorkspaceSettings } from './workspace-files.ts';

interface RemovalDependencies {
  registry: PluginRegistry;
  store: Store;
  trace?: Tracer;
  workspace: string;
}

interface Options {
  actor?: string;
  adapterId?: string;
  locale?: Config['locale'];
}

interface ExecutionOptions extends Options {
  detach?(current: Config, next: Config): Promise<void>;
}

export interface RemovalPlan extends RemovalTarget {
  chatDefaults: string[];
  directories: { exists: boolean; path: string }[];
  env: string[];
  keptDirectories: string[];
  kind: string;
  locale: Config['locale'];
  ownerMapping: boolean;
  processEnv: string[];
  rows: RemovalRows;
}

const setupCredentials: Record<string, readonly string[]> = {
  'claude-sdk': ['CLAUDE_CODE_OAUTH_TOKEN'],
  line: ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN'],
  telegram: ['TELEGRAM_BOT_TOKEN'],
};

const leaseMs = 60_000;

function references(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    /Env$/.test(key) && typeof child === 'string' ? [child] : references(child),
  );
}

function entries(config: Config, category: RemovalTarget['category']) {
  return category === 'agent' ? config.agents : config.platforms;
}

function defaultAgent(config: Config) {
  return (
    config.agents.find(({ id }) => id === config.defaultAgent)?.id ??
    config.agents.find(({ enabled }) => enabled !== false)?.id
  );
}

export class Removal {
  readonly #deps: RemovalDependencies;
  readonly #trace: Tracer;

  constructor(deps: RemovalDependencies) {
    this.#deps = deps;
    this.#trace = deps.trace ?? new Tracer(deps.store);
  }

  flushTrace() {
    return this.#trace.flush();
  }

  async plan(target: RemovalTarget, options?: Options): Promise<RemovalPlan> {
    return this.#trace.span('remove.plan', { ...target }, async () => {
      await this.#trace.flush();
      return (await this.#prepare(target, options)).plan;
    });
  }

  async #prepare(
    target: RemovalTarget,
    { adapterId, locale: preferredLocale }: Options = {},
  ) {
    const { registry, store } = this.#deps;
    const workspace = await realpath(this.#deps.workspace);
    const config = await loadSettings(workspace, registry);
    const locale = preferredLocale ?? config.locale;
    const m = removalMessages(locale);
    const { category, id } = target;
    const configured = entries(config, category);
    const entry = configured.find((item) => item.id === id);
    if (!entry)
      throw new SetupError(
        m.unknown(category, id, configured.map((item) => item.id).sort()),
      );
    if (category === 'platform' && adapterId === id)
      throw new SetupError(m.ownPlatform);
    const runs = store.instanceSetupRuns(target);
    if (runs.some(({ lease, leaseUntil }) => lease && leaseUntil > Date.now()))
      throw new SetupError(m.activeSetup(id));
    if (category === 'agent' && defaultAgent(config) === id) {
      const alternatives = config.agents.filter(
        (agent) => agent.id !== id && agent.enabled !== false,
      );
      throw new SetupError(
        m.defaultAgent(
          id,
          alternatives.map((agent) => agent.id),
        ),
      );
    }
    const credentials = (
      type: RemovalTarget['category'],
      instance: PluginInstanceConfig,
    ) => [
      ...references(instance),
      ...(registry
        .forInstance(type, instance.kind)
        ?.credentialNames?.(instance) ?? []),
    ];
    const shared = new Set([
      ...config.agents
        .filter((item) => category !== 'agent' || item.id !== id)
        .flatMap((item) => credentials('agent', item)),
      ...config.platforms
        .filter((item) => category !== 'platform' || item.id !== id)
        .flatMap((item) => credentials('platform', item)),
      ...(config.preview?.named
        ? [config.preview.named.tokenEnv ?? 'CLOUDFLARE_API_TOKEN']
        : []),
    ]);
    const envText = await readWorkspaceCredentials(workspace);
    const currentEnv = parseEnv(envText);
    const names = [
      ...new Set([
        ...credentials(category, entry),
        ...runs.flatMap((run) => credentials(category, run.draft.entry)),
        ...(Object.hasOwn(setupCredentials, entry.kind)
          ? setupCredentials[entry.kind]!
          : []
        ).map((prefix) => credentialKey(prefix, id)),
      ]),
    ]
      .filter((name) => !shared.has(name))
      .sort();
    const defaults =
      category === 'agent' ? await findChatDefaults(workspace, id) : [];
    const rows = store.inspectInstanceData(
      target,
      defaults.map(({ chat }) => chat),
    );
    const paths =
      'version' in entry || category === 'agent'
        ? await agentDirectories(workspace, config, entry, registry)
        : { kept: [], removable: [join(workspace, 'chats', pathId(id))] };
    const dirs = await Promise.all(
      paths.removable.map(async (path) => ({
        path,
        stat: await secureDirectory(path),
      })),
    );
    const remainingKindOwner = config.platforms.some(
      (item) => item.id !== id && item.kind === id,
    );
    const plan: RemovalPlan = {
      category,
      id,
      kind: entry.kind,
      locale,
      rows,
      chatDefaults: defaults.map(({ path }) => displayPath(workspace, path)),
      directories: dirs.map(({ path, stat }) => ({
        path: displayPath(workspace, path),
        exists: Boolean(stat),
      })),
      keptDirectories: paths.kept.map((path) => displayPath(workspace, path)),
      env: names.filter((name) => currentEnv.has(name)),
      processEnv: names.filter(
        (name) => !currentEnv.has(name) && Object.hasOwn(process.env, name),
      ),
      ownerMapping:
        category === 'platform' &&
        Object.hasOwn(config.owner, id) &&
        !remainingKindOwner,
    };
    return { config, defaults, dirs, entry, envText, plan, workspace };
  }

  async execute(confirmed: RemovalPlan, options: ExecutionOptions = {}) {
    const { registry, store } = this.#deps;
    const trace = this.#trace;
    const { category, id, locale } = confirmed;
    const m = removalMessages(locale);
    const target = { category, id };
    return trace.span('remove.execute', target, async () => {
      const key = JSON.stringify(['remove', category, id]);
      const lease = randomUUID();
      const now = Date.now();
      let leaseUntil = now + leaseMs;
      const reservation = store.claimSetupRun(
        {
          id: key,
          category,
          mode: 'remove',
          lease,
          leaseUntil,
          step: 0,
          status: 'pending',
          draft: { entry: { id, kind: confirmed.kind } },
        },
        now,
      );
      if (!reservation)
        throw new SetupError(
          store
            .instanceSetupRuns(target)
            .some((run) => run.lease && run.leaseUntil > now)
            ? m.activeSetup(id)
            : m.busy,
        );
      const heartbeat = setInterval(() => {
        try {
          const renewedUntil = Date.now() + leaseMs;
          if (
            !store.saveSetupRun(
              { ...reservation, leaseUntil: renewedUntil },
              lease,
            )
          ) {
            leaseUntil = 0;
            trace.record('remove.lease_lost', target, 0, 'error');
          } else {
            leaseUntil = renewedUntil;
          }
        } catch {
          trace.record('remove.lease_refresh_failed', target, 0, 'error');
        }
      }, leaseMs / 3).unref();
      const completed: string[] = [];
      let step = m.recheck;
      let backup: string | undefined;
      try {
        await trace.flush();
        const prepared = await this.#prepare(target, { ...options, locale });
        const { config, defaults, dirs, entry, envText, plan, workspace } =
          prepared;
        if (!isDeepStrictEqual(plan, confirmed))
          throw new SetupError(m.changed);
        const removeEntry = (settings: Config) => {
          const instances = entries(settings, category);
          instances.splice(
            instances.findIndex((item) => item.id === id),
            1,
          );
          if (plan.ownerMapping) delete settings.owner[id];
        };
        const next = structuredClone(config);
        removeEntry(next);

        const stage = async <T>(
          name: string,
          label: string,
          run: () => T | Promise<T>,
        ) => {
          step = label;
          if (Date.now() >= leaseUntil) throw new SetupError(m.changed);
          return trace.span('remove.' + name, target, run);
        };

        await stage('backup', m.backupStage, async () => {
          const data = join(workspace, 'data');
          const backups = join(data, 'backups');
          await secureDirectory(data);
          await mkdir(data, { recursive: true, mode: 0o700 });
          await secureDirectory(backups);
          await mkdir(backups, { recursive: true, mode: 0o700 });
          const parent = await secureDirectory(backups);
          if (dirs.some(({ stat }) => stat && stat.dev !== parent?.dev))
            throw new SetupError(m.crossFilesystem);
          const stamp = new Date().toISOString().replaceAll(':', '-');
          const path = join(backups, `remove-${category}-${id}-${stamp}`);
          await mkdir(path, { mode: 0o700 });
          backup = path;
          store.backup(join(path, 'tsugimori.db'));
          completed.push(m.saved('tsugimori.db'));
          await writeFile(
            join(path, 'removed.env'),
            splitCredentials(envText, plan.env).removed,
            { flag: 'wx', mode: 0o600 },
          );
          completed.push(m.saved('removed.env'));
          const owner = plan.ownerMapping
            ? { [id]: config.owner[id] }
            : undefined;
          await writeFile(
            join(path, 'entry.json'),
            JSON.stringify({ ...target, entry, owner }, null, 2) + '\n',
            { flag: 'wx', mode: 0o600 },
          );
          completed.push(m.saved('entry.json'));
          for (const [index, settings] of defaults.entries()) {
            const file = `chat-defaults-${index + 1}.json`;
            await writeFile(join(path, file), settings.original, {
              flag: 'wx',
              mode: 0o600,
            });
            completed.push(
              m.saved(file + ' · ' + displayPath(workspace, settings.path)),
            );
          }
        });

        if (options.detach) {
          await stage('detach', m.detachStage, () =>
            options.detach!(config, next),
          );
          completed.push(m.detachStage);
        }
        await stage('config', m.configStage, () =>
          updateSettings(workspace, registry, (current) => {
            if (!isDeepStrictEqual(config, current))
              throw new SetupError(m.changed);
            removeEntry(current);
          }),
        );
        completed.push(m.configStage);

        const verifySettings = async () => {
          if (!isDeepStrictEqual(await loadSettings(workspace, registry), next))
            throw new SetupError(m.changed);
        };

        if (plan.env.length) {
          await stage('credentials', m.envStage, async () => {
            await verifySettings();
            await replaceWorkspaceCredentials(
              workspace,
              envText,
              splitCredentials(envText, plan.env).kept,
            );
          });
          completed.push(`${m.envStage} · ${plan.env.join(', ')}`);
        }

        for (const settings of defaults) {
          const workdir = dirname(settings.path);
          const file = displayPath(workspace, settings.path);
          await stage('chat_defaults', file, async () => {
            if (
              !(await secureDirectory(workdir)) ||
              !(await statIfPresent(settings.path))?.isFile() ||
              (await readFile(settings.path, 'utf8')) !== settings.original
            )
              throw new SetupError(m.changed);
            await writeWorkspaceSettings(
              workdir,
              settings.updated,
              options.actor ?? 'local-owner',
              false,
            );
            completed.push(m.cleared(file));
            if ((await statIfPresent(join(workdir, '.git')))?.isDirectory())
              await recordWorkspace(
                workdir,
                options.actor ?? 'local-owner',
                true,
              );
          });
        }

        const counts = await stage('database', m.dbStage, async () => {
          await verifySettings();
          await trace.flush();
          return store.deleteInstanceData(
            target,
            defaults.map(({ chat }) => chat),
            Date.now(),
          );
        });
        completed.push(
          `${m.dbStage} · ${Object.entries(counts)
            .map(([name, count]) => `${name}=${count}`)
            .join(', ')}`,
        );

        for (const [index, { path, stat }] of dirs.entries()) {
          if (!stat) continue;
          const file = displayPath(workspace, path);
          await stage('directory', file, async () => {
            const current = await secureDirectory(path);
            if (current?.ino !== stat.ino || current.dev !== stat.dev)
              throw new SetupError(m.changed);
            const folder = `directory-${index + 1}`;
            await mkdir(join(backup!, folder), { mode: 0o700 });
            const name = join(folder, basename(path));
            await rename(path, join(backup!, name));
            completed.push(m.moved(file, name));
          });
        }
        return m.finished(target, backup!, completed);
      } catch (error) {
        if (!backup && error instanceof SetupError) throw error;
        throw new SetupError(m.failed(step, backup, completed));
      } finally {
        clearInterval(heartbeat);
        store.releaseRemoval(key, lease);
      }
    });
  }
}
