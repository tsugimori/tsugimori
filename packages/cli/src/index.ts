import type { Config, WorkspaceConfig } from '@tsugimori/config';
import type { SetupDependencies, SetupRequest } from '@tsugimori/core';

import claude from '@tsugimori/agent-claude-sdk';
import codex from '@tsugimori/agent-codex';
import { Auth } from '@tsugimori/auth';
import {
  ConfigError,
  configFilename,
  configuredOwner,
  envFilename,
  loadConfig,
  loadSettings,
} from '@tsugimori/config';
import {
  EnvironmentChecks,
  Gateway,
  GuidedSetup,
  PluginRegistry,
  Removal,
  removalMessages,
  SetupCancelled,
  systemInstallPlan,
  Webhooks,
} from '@tsugimori/core';
import { SetupError } from '@tsugimori/core';
import sandbox from '@tsugimori/exec-local-sandbox';
import line from '@tsugimori/platform-line';
import telegram from '@tsugimori/platform-telegram';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import tunnel, { NamedTunnel, QuickTunnel } from '@tsugimori/tunnel-cloudflare';
import { AdminServer, createAccessVerifier } from '@tsugimori/web';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, parseArgs } from 'node:util';

import { listenForRemoval, readGatewayWebhook, runRemoval } from './removal.ts';
import { doctorText, runSetup, terminalIO } from './setup.ts';

const usage =
  'Usage: tsugimori init [dir] | start [dir] | pair [dir] --adapter <id> | previews [dir] | doctor [dir] [--json] | setup [dir] [--yes] [--upgrade] | add <agent|platform> <kind> [--id <id>] [--dir <dir>] | setup <agent|platform> <kind> [--id <id>] [--dir <dir>] | setup login <agentId> [--dir <dir>] | remove <platform|agent> <id> [--dir <dir>] [--yes]';

class UsageError extends Error {}

export async function main(
  argv: string[],
  registry = new PluginRegistry([
    telegram,
    line,
    codex,
    claude,
    sandbox,
    tunnel,
  ]),
  deps: SetupDependencies = {},
) {
  const [action, ...parameters] = argv;
  const [target, name] = parameters;
  const guided = action === 'setup' && name && !name.startsWith('-');
  const login = guided && target === 'login';
  const command =
    guided && (target === 'agent' || target === 'platform') ? 'add' : action;
  const args = login ? parameters.slice(1) : parameters;
  if (command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (
    command !== 'init' &&
    command !== 'start' &&
    command !== 'pair' &&
    command !== 'previews' &&
    command !== 'doctor' &&
    command !== 'setup' &&
    command !== 'add' &&
    command !== 'remove'
  ) {
    throw new UsageError(usage);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: login
        ? { dir: { type: 'string' } }
        : command === 'pair'
          ? { adapter: { type: 'string' } }
          : command === 'doctor'
            ? { json: { type: 'boolean' } }
            : command === 'setup'
              ? { yes: { type: 'boolean' }, upgrade: { type: 'boolean' } }
              : command === 'add'
                ? { id: { type: 'string' }, dir: { type: 'string' } }
                : command === 'remove'
                  ? { dir: { type: 'string' }, yes: { type: 'boolean' } }
                  : {},
    });
  } catch {
    throw new UsageError(usage);
  }
  if (command === 'remove') {
    const [category, id] = parsed.positionals;
    if (
      (category !== 'platform' && category !== 'agent') ||
      !id ||
      parsed.positionals.length !== 2
    )
      throw new UsageError(usage);
    const { dir, yes } = parsed.values;
    const workspace = resolve(typeof dir === 'string' ? dir : '.');
    const target = { category, id } as const;
    await runRemoval(workspace, target, yes === true, async (confirmPlan) => {
      const store = await openStore(
        workspace,
        await loadSettings(workspace, registry),
      );
      const removal = new Removal({ registry, store, workspace });
      try {
        const plan = await removal.plan(target);
        console.log(
          (await confirmPlan(plan))
            ? await removal.execute(plan)
            : removalMessages(plan.locale).cancelled,
        );
      } finally {
        try {
          await removal.flushTrace();
        } finally {
          store.close();
        }
      }
    });
    return;
  }
  if (command === 'add' || login) {
    const [category, kind] = parsed.positionals;
    const request: SetupRequest | undefined = login
      ? category && parsed.positionals.length === 1
        ? { mode: 'login', id: category }
        : undefined
      : (category === 'agent' || category === 'platform') &&
          kind &&
          parsed.positionals.length === 2
        ? {
            mode: 'add',
            category,
            kind,
            id:
              typeof parsed.values.id === 'string'
                ? parsed.values.id
                : undefined,
          }
        : undefined;
    if (!request) throw new UsageError(usage);
    const workspace = resolve(
      typeof parsed.values.dir === 'string' ? parsed.values.dir : '.',
    );
    const store = await openStore(
      workspace,
      await loadSettings(workspace, registry),
    );
    const io = terminalIO();
    try {
      const requiresWebhook =
        request.mode === 'add' &&
        request.category === 'platform' &&
        registry.requiresWebhook(request.kind);
      const webhook = requiresWebhook
        ? cliWebhookSetup(workspace, registry, deps, io.signal)
        : undefined;
      const setup = new GuidedSetup({
        ...deps,
        registry,
        store,
        workspace,
        webhookIngress: webhook?.ingress,
      });
      const result = await setup.run(request, {
        ...io,
        webhookStatus: webhook?.status,
        waitForAttach: webhook?.waitForAttach,
      });
      console.log(
        [
          `Saved ${result.id}. A running gateway will attach it after reloading the workspace.`,
          result.summary,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (error) {
      if (!(error instanceof SetupCancelled)) throw error;
      console.log(error.message);
    } finally {
      io.close();
      store.close();
    }
    return;
  }
  if (parsed.positionals.length > 1) throw new UsageError(usage);
  const workspace = resolve(parsed.positionals[0] ?? '.');

  switch (command) {
    case 'doctor': {
      const checks = new EnvironmentChecks(deps, workspace);
      const snapshot = await loadConfig(workspace, registry);
      const liveWebhook = await readGatewayWebhook(workspace);
      const items = await checks.all(snapshot, registry, liveWebhook?.status);
      await systemInstallPlan(
        checks.context({ id: 'core', kind: 'core' }, snapshot.env),
        items,
      );
      console.log(
        parsed.values.json
          ? JSON.stringify(items, null, 2)
          : doctorText(items, snapshot.config.locale),
      );
      return items.some(({ status }) => status === 'fail') ? 1 : 0;
    }
    case 'setup':
      return runSetup(deps, workspace, registry, {
        yes: parsed.values.yes === true,
        upgrade: parsed.values.upgrade === true,
        print: console.log,
      });
    case 'init':
      await initialize(workspace, registry);
      console.log('Workspace initialized.');
      break;
    case 'pair': {
      const adapterId = parsed.values.adapter;
      if (
        typeof adapterId !== 'string' ||
        !/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(adapterId)
      ) {
        throw new UsageError(usage);
      }
      const config = await loadSettings(workspace, registry);
      const store = await openStore(workspace, config);
      try {
        const kind = config.platforms.find(
          (entry) => entry.id === adapterId,
        )?.kind;
        const auth = new Auth({
          store,
          configuredOwner: (id) => configuredOwner(config, id, kind),
        });
        if (auth.owner(adapterId))
          throw new UsageError('This adapter already has an owner.');
        const code = auth.createPairingCode(adapterId);
        console.log(
          `Send /pair ${code} to the bot in a direct message. The code expires in 10 minutes.`,
        );
      } finally {
        store.close();
      }
      break;
    }
    case 'previews': {
      const store = await openStore(
        workspace,
        await loadSettings(workspace, registry),
      );
      try {
        for (const preview of store.listPreviews()) {
          if (preview.expiresAt > Date.now())
            console.log(JSON.stringify(preview));
        }
      } finally {
        store.close();
      }
      break;
    }
    case 'start':
      await start(workspace, registry, deps);
      break;
  }
}

function cliWebhookSetup(
  workspace: string,
  registry: PluginRegistry,
  deps: SetupDependencies,
  signal: AbortSignal,
) {
  let live: Awaited<ReturnType<typeof readGatewayWebhook>>;
  let offline: ReturnType<Webhooks['status']> = { state: 'unconfigured' };
  return {
    async status() {
      live = await readGatewayWebhook(workspace);
      if (live) return live.status;
      const ingress = new Webhooks({ ...deps, registry, workspace });
      try {
        await ingress.configure(await loadConfig(workspace, registry));
        offline = await ingress.check();
        return offline;
      } finally {
        await ingress.stop();
      }
    },
    async waitForAttach(id: string) {
      if (!live) return;
      const wait = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      try {
        do {
          live = await readGatewayWebhook(workspace, id);
          if (!live || live.attached) return;
          await delay(50, undefined, { signal: wait });
        } while (!wait.aborted);
      } catch (error) {
        if (!wait.aborted || signal.aborted) throw error;
      }
    },
    ingress: {
      status: () => live?.status ?? offline,
      url(path: string) {
        const key = path.replace(/\/$/, '') || '/';
        if (
          live?.status.state === 'ok' &&
          live.status.baseUrl &&
          live.paths.includes(key)
        )
          return live.status.baseUrl + path;
      },
      async register() {
        throw new Error('Webhook routes are registered by the gateway');
      },
    },
  };
}

async function initialize(workspace: string, registry: PluginRegistry) {
  for (const dir of ['data', 'rules', 'platforms', 'chats']) {
    await mkdir(join(workspace, dir), { recursive: true });
  }
  const config = {
    owner: {},
    timezone: 'Asia/Taipei',
    storage: { kind: 'sqlite', path: 'data/tsugimori.db' },
    platforms: [],
    agents: [],
    context: { recentMessages: 30 },
  };
  await createFile(
    join(workspace, configFilename),
    JSON.stringify(config, null, 2) + '\n',
    0o600,
  );
  await createFile(
    join(workspace, envFilename),
    '# Workspace plugin credentials\n# TELEGRAM_BOT_TOKEN=\n',
    0o600,
  );
  const store = await openStore(
    workspace,
    await loadSettings(workspace, registry),
  );
  store.close();
}

async function createFile(path: string, text: string, mode: number) {
  try {
    await writeFile(path, text, { flag: 'wx', mode });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    )
      throw error;
  }
}

async function openStore(workspace: string, config: Config) {
  const path = resolve(workspace, config.storage.path);
  await mkdir(dirname(path), { recursive: true });
  return new SqliteStore(path);
}

async function start(
  workspace: string,
  registry: PluginRegistry,
  deps: SetupDependencies,
) {
  const ready = Promise.withResolvers<Gateway | undefined>();
  const gateway = async () => {
    const active = await ready.promise;
    if (!active) throw new SetupError('The gateway is not running.');
    return active;
  };
  const close = await listenForRemoval(workspace, {
    plan: async (target) => (await gateway()).removal.plan(target),
    execute: async (plan) => (await gateway()).removeInstance(plan),
    webhookInfo: async (id) => (await gateway()).webhookInfo(id),
  });
  try {
    await startGateway(workspace, registry, deps, ready.resolve);
  } finally {
    ready.resolve(undefined);
    await close();
  }
}

async function startGateway(
  workspace: string,
  registry: PluginRegistry,
  deps: SetupDependencies,
  ready: (gateway: Gateway) => void,
) {
  const snapshot = await loadConfig(workspace, registry);
  const verify = createAccessVerifier();
  const config = snapshot.config.web;
  const quick = new QuickTunnel({
    logError: () =>
      console.error(
        JSON.stringify({ level: 'error', event: 'preview.quick_failed' }),
      ),
  });
  const namedPreview = namedPreviewFactory(verify, deps.fetch);
  const store = await openStore(workspace, snapshot.config).catch(() => {
    throw new ConfigError(
      'Could not open the workspace SQLite database. Check its path and write permissions.',
    );
  });

  const gateway = new Gateway({
    store,
    workspace,
    registry,
    setup: deps,
    namedPreview,
    previews: { quick },
  });
  const access =
    config?.accessAud && config.accessTeam
      ? {
          aud: config.accessAud,
          team: config.accessTeam,
          ownerEmail: config.ownerEmail,
          ownerSub: config.ownerSub,
        }
      : undefined;
  const admin =
    config && config.enabled !== false
      ? new AdminServer(
          {
            reader: gateway.admin,
            verify,
            logError: () =>
              console.error(
                JSON.stringify({ level: 'error', event: 'web.request_failed' }),
              ),
          },
          {
            access,
            allowLocalWithoutAccess: config.allowLocalWithoutAccess,
            listen: config.listen,
          },
        )
      : undefined;
  const terminated = Promise.withResolvers<void>();
  const stop = () => terminated.resolve();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await gateway.start(snapshot);
    await admin?.start();
    ready(gateway);
    await terminated.promise;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    try {
      try {
        await admin?.stop();
      } finally {
        await gateway.stop();
      }
    } finally {
      store.close();
    }
  }
}

function namedPreviewFactory(
  verify: ReturnType<typeof createAccessVerifier>,
  fetch?: typeof globalThis.fetch,
) {
  let previous: ConstructorParameters<typeof NamedTunnel>[1] | undefined;
  let provider: NamedTunnel | undefined;
  return (snapshot?: WorkspaceConfig) => {
    const named = snapshot?.config.preview?.named;
    if (!named) {
      previous = undefined;
      provider = undefined;
      return;
    }
    const config = snapshot?.config.web;
    const tokenName = named.tokenEnv ?? 'CLOUDFLARE_API_TOKEN';
    const token = process.env[tokenName] ?? snapshot?.env.get(tokenName);
    const team = named.accessTeam ?? config?.accessTeam;
    const ownerEmail = named.ownerEmail ?? config?.ownerEmail;
    const ownerSub = named.ownerSub ?? config?.ownerSub;
    const port = Number((named.listen ?? '127.0.0.1:8788').split(':').at(-1));
    if (
      !token ||
      !team ||
      (!ownerEmail && !ownerSub) ||
      port < 1 ||
      port > 65535
    )
      return;
    const options = {
      domain: named.domain,
      tunnelId: named.tunnelId,
      zoneId: named.zoneId,
      port,
      token,
      access: { aud: named.accessAud, team, ownerEmail, ownerSub },
    };
    if (!isDeepStrictEqual(previous, options) || !provider) {
      previous = options;
      provider = new NamedTunnel(
        {
          fetch,
          verify,
          logError: () =>
            console.error(
              JSON.stringify({ level: 'error', event: 'preview.dns_failed' }),
            ),
        },
        options,
      );
    }
    return provider;
  };
}

export function reportError(error: unknown) {
  let reason;
  if (
    error instanceof UsageError ||
    error instanceof ConfigError ||
    error instanceof SetupError
  )
    reason = error.message;
  else if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    reason = error.code;
  }
  console.error(
    JSON.stringify({ level: 'error', event: 'cli.failed', reason }),
  );
}
