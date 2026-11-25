import type { WorkspaceConfig } from '@tsugimori/config';
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
    return [
      {
        id: 'node',
        title: 'Node.js',
        status: major >= 24 ? 'ok' : 'fail',
        detail: 'Node.js ' + process.versions.node,
        fix: major >= 24 ? undefined : { hint: 'Install Node.js 24 or newer.' },
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
        capabilities: ['workspace.record'],
      },
    ].map((item): CheckReport => ({
      ...item,
      status: item.status as CheckItem['status'],
      target: 'core',
    }));
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

export function failureText(items: readonly CheckReport[]) {
  return items
    .filter((item) => item.status === 'fail')
    .map(({ target, title, detail }) => `${target} · ${title}: ${detail}`)
    .join('\n');
}
