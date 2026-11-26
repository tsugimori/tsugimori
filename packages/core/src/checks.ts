import type { Config, WorkspaceConfig } from '@tsugimori/config';
import type {
  CheckContext,
  CheckItem,
  PluginDefinition,
  PluginInstanceConfig,
  SetupDependencies,
} from '@tsugimori/plugin-sdk';

import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { PluginRegistry } from './registry.ts';

import { runCommand } from './commands.ts';

export interface CheckReport extends CheckItem {
  target: string;
}

export class EnvironmentChecks {
  readonly #workspace: string;
  readonly #deps: SetupDependencies;

  constructor(deps: SetupDependencies, workspace: string) {
    this.#workspace = workspace;
    this.#deps = deps;
  }

  context(
    entry: PluginInstanceConfig,
    env: WorkspaceConfig['env'],
  ): CheckContext {
    return {
      entry,
      workspace: this.#workspace,
      credential: (name) => process.env[name] ?? env.get(name),
      platform: this.#deps.platform ?? process.platform,
      arch: this.#deps.arch ?? process.arch,
      fetch: this.#deps.fetch ?? globalThis.fetch,
      runCommand: this.#deps.runCommand ?? runCommand,
    };
  }

  async core(snapshot: WorkspaceConfig): Promise<CheckReport[]> {
    const major = Number(process.versions.node.split('.')[0]);
    const ctx = this.context({ id: 'core', kind: 'core' }, snapshot.env);
    const location = resolve(this.#workspace, snapshot.config.storage.path);
    const [database, git] = await Promise.all([
      databaseWritable(location),
      commandWorks(ctx, ['git', '--version']),
    ]);
    const checks = [
      {
        id: 'node',
        title: 'Node.js',
        status: major >= 24 ? 'ok' : 'fail',
        detail: 'Node.js ' + process.versions.node,
        fix: major >= 24 ? undefined : { hint: 'Install Node.js 24 or newer.' },
        localized: {
          'zh-TW': { title: 'Node.js', hint: '請安裝 Node.js 24 或更新版本。' },
        },
      },
      {
        id: 'database',
        title: 'SQLite database path',
        status: database ? 'ok' : 'fail',
        detail: database
          ? location
          : `Cannot write SQLite data at ${location}.`,
        fix: database
          ? undefined
          : { hint: 'Choose a writable database path in tsugimori.json.' },
        localized: {
          'zh-TW': {
            title: 'SQLite 資料庫路徑',
            hint: '請在 tsugimori.json 設定可寫入的資料庫路徑。',
          },
        },
      },
      {
        id: 'git',
        title: 'Git',
        status: git ? 'ok' : 'fail',
        detail: git
          ? 'Git is available.'
          : 'Git is unavailable. Workspace version recording is disabled.',
        fix: git
          ? undefined
          : { hint: 'Run tsugimori setup to see the install command.' },
        localized: {
          'zh-TW': {
            title: 'Git',
            hint: '請執行 tsugimori setup 查看安裝指令。',
          },
        },
        capabilities: ['workspace.record'],
      },
    ].map((item): CheckReport => ({
      ...item,
      status: item.status as CheckItem['status'],
      target: 'core',
    }));
    return [...checks, ...listenerConflicts(snapshot.config)];
  }

  async plugin(
    plugin: PluginDefinition | undefined,
    ctx: CheckContext,
    target: string,
    capability: string,
  ): Promise<CheckReport[]> {
    try {
      return ((await plugin?.checks?.(ctx)) ?? []).map((item) => ({
        ...item,
        target,
      }));
    } catch {
      return [
        {
          target,
          id: 'check-error',
          status: 'fail',
          title: 'Plugin checks',
          detail: 'The plugin could not complete its checks.',
          fix: { hint: 'Check the plugin configuration and try again.' },
          localized: {
            'zh-TW': { title: '插件檢查', hint: '請檢查插件設定後重試。' },
          },
          capabilities: [capability],
        },
      ];
    }
  }

  features(snapshot: WorkspaceConfig, registry: PluginRegistry) {
    const { config, env } = snapshot;
    const exec = config.exec?.kind ?? 'local-sandbox';
    const sandbox = registry.forFeature('exec', exec);
    const preview = registry.forFeature('preview', 'tunnel-cloudflare');
    const checks: Promise<CheckReport[]>[] = [];
    if (sandbox && config.exec)
      checks.push(
        this.plugin(
          sandbox,
          this.context({ id: exec, kind: exec }, env),
          `exec/${exec}`,
          'exec',
        ),
      );
    if (preview && config.preview)
      checks.push(
        this.plugin(
          preview,
          this.context(
            {
              id: 'cloudflare',
              kind: 'cloudflare',
              options: { named: config.preview.named, web: config.web },
            },
            env,
          ),
          'preview/cloudflare',
          'preview.quick',
        ),
      );
    return Promise.all(checks).then((items) => items.flat());
  }

  async all(snapshot: WorkspaceConfig, registry: PluginRegistry) {
    const items = await this.core(snapshot);
    items.push(...(await this.features(snapshot, registry)));
    for (const [category, entries] of [
      ['agent', snapshot.config.agents],
      ['platform', snapshot.config.platforms],
    ] as const) {
      for (const entry of entries) {
        if (entry.enabled !== false)
          items.push(
            ...(await this.plugin(
              registry.forInstance(category, entry.kind),
              this.context(entry, snapshot.env),
              `${category}/${entry.id}`,
              category,
            )),
          );
      }
    }
    return items;
  }
}

function listenerConflicts(config: Config): CheckReport[] {
  const listeners = new Map<string, string[]>();
  function add(name: string, value: unknown) {
    if (typeof value !== 'string') return;
    const split = value.lastIndexOf(':');
    const port = Number(value.slice(split + 1));
    if (port < 1 || port > 65535) return;
    const address = `${value.slice(0, split)}:${port}`;
    const names = listeners.get(address) ?? [];
    names.push(name);
    listeners.set(address, names);
  }

  if (config.web?.enabled !== false) add('web.listen', config.web?.listen);
  add('preview.named.listen', config.preview?.named?.listen);
  for (const entry of config.platforms) {
    if (entry.kind === 'line' && entry.enabled !== false)
      add(`LINE ${entry.id} listen`, entry.listen);
  }

  return [...listeners]
    .filter(([, names]) => names.length > 1)
    .map(([address, names]) => {
      const detail = `${names.join('、')} 皆設定為 ${address}。請在 tsugimori.json 中為每個監聽服務設定不同的位址。`;
      return {
        target: 'core',
        id: 'listener-conflict',
        title: 'Listener addresses',
        status: 'fail',
        detail: `${address} is configured for ${names.join(', ')}. Assign each listener a unique address in tsugimori.json.`,
        localized: {
          'zh-TW': { title: '監聽位址', detail, hint: detail },
        },
      };
    });
}

async function databaseWritable(path: string) {
  let current = path;
  for (;;) {
    try {
      const stat = await lstat(current);
      if (current === path && !stat.isFile()) return false;
      if (current !== path && !stat.isDirectory()) return false;
      if (current === path) {
        await access(current, constants.W_OK | constants.R_OK);
        current = dirname(current);
        continue;
      }
      await access(current, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        return false;
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

async function commandWorks(ctx: CheckContext, command: [string, ...string[]]) {
  try {
    return (await ctx.runCommand(command)).exitCode === 0;
  } catch {
    return false;
  }
}

export function failureText(
  items: readonly CheckReport[],
  locale?: Config['locale'],
) {
  const separator = locale === 'zh-TW' ? '：' : ': ';
  return items
    .filter((item) => item.status === 'fail')
    .map(({ target, title, detail, fix, localized }) => {
      const translation = locale === 'zh-TW' ? localized?.[locale] : undefined;
      const hint =
        translation?.hint ??
        (locale && (fix?.hint || fix?.command?.join(' '))) ??
        detail;
      return `${target} · ${translation?.title ?? title}${separator}${hint}`.replace(
        /[\r\n\u2028\u2029]+/g,
        ' ',
      );
    })
    .join('\n');
}
