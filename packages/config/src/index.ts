import type {
  AgentInstanceConfig,
  PlatformInstanceConfig,
} from '@tsugimori/plugin-sdk';

import { Ajv } from 'ajv';
import { readFileSync, watch as watchDirectory } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const schema: Record<string, unknown> = JSON.parse(
  readFileSync(
    new URL('../../../schema/tsugimori.schema.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>;

export const configFilename = 'tsugimori.json';
export const envFilename = '.env';

export class ConfigError extends Error {}

export interface Config {
  $schema?: string;
  agents: (AgentInstanceConfig & { model?: string; thinking?: string })[];
  context: {
    recentMessages: number;
    summary?: { enabled?: boolean; model?: string };
  };
  defaultAgent?: string;
  exec?: { denyRead?: string[]; kind?: 'local-sandbox' };
  owner: Record<string, string>;
  platforms: PlatformInstanceConfig[];
  preview?: {
    maxTtlMinutes?: number;
    named?: {
      accessAud: string;
      accessTeam?: string;
      domain: string;
      listen?: string;
      ownerEmail?: string;
      ownerSub?: string;
      tokenEnv?: string;
      tunnelId: string;
      zoneId: string;
    };
  };
  scheduler?: {
    highCostModels?: string[];
    maxActivePerUser?: number;
    minIntervalMinutes?: number;
  };
  storage: { kind: 'sqlite'; path: string };
  timezone: string;
  web?: {
    accessAud?: string;
    accessTeam?: string;
    allowLocalWithoutAccess?: boolean;
    enabled?: boolean;
    listen?: string;
    ownerEmail?: string;
    ownerSub?: string;
  };
}

export interface PluginKinds {
  agentKinds: ReadonlySet<string>;
  platformKinds: ReadonlySet<string>;
}

export interface WorkspaceConfig {
  config: Config;
  env: ReadonlyMap<string, string>;
}

export const noPluginKinds: PluginKinds = {
  agentKinds: new Set(),
  platformKinds: new Set(),
};

const validate = new Ajv({
  allErrors: true,
  useDefaults: true,
}).compile<Config>(schema);

export function parseConfig(
  contents: string,
  kinds: PluginKinds = noPluginKinds,
): Config {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new ConfigError('tsugimori.json is not valid JSON');
  }
  if (!validate(value)) {
    const details = validate.errors?.map(
      (error) => `${error.instancePath || '/'} ${error.keyword}`,
    );
    throw new ConfigError(`Invalid tsugimori.json: ${details?.join(', ')}`);
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timezone });
  } catch {
    throw new ConfigError(
      'Invalid tsugimori.json: /timezone must be a valid time zone',
    );
  }
  checkEntries(value.platforms, kinds.platformKinds, 'platform');
  checkEntries(value.agents, kinds.agentKinds, 'agent');
  return value;
}

function checkEntries(
  entries: readonly AgentInstanceConfig[],
  kinds: ReadonlySet<string>,
  category: string,
) {
  const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (ids.has(entry.id))
      throw new ConfigError(`Duplicate ${category} id at index ${index}`);
    ids.add(entry.id);
    if (entry.enabled !== false && !kinds.has(entry.kind)) {
      throw new ConfigError(`Unknown ${category} kind at index ${index}`);
    }
  }
}

export function parseEnv(contents: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const assignment =
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    const key = assignment?.[1];
    const raw = assignment?.[2];
    if (key === undefined || raw === undefined) throw envError(index);
    const quote = raw[0];
    if (quote === '"' || quote === "'") {
      const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(raw);
      if (!quoted) throw envError(index);
      values.set(
        key,
        quoted[2] ??
          (quoted[1] ?? '').replace(/\\([nrt"\\])/g, (_, char: string) => {
            return { n: '\n', r: '\r', t: '\t' }[char] ?? char;
          }),
      );
    } else {
      values.set(key, raw.split('#', 1)[0]?.trimEnd() ?? '');
    }
  }
  return values;
}

function envError(index: number) {
  return new ConfigError(
    `Invalid workspace environment assignment at line ${index + 1}`,
  );
}

export async function loadSettings(
  workspace: string,
  kinds: PluginKinds = noPluginKinds,
) {
  const contents = await readFile(join(workspace, configFilename), 'utf8');
  return parseConfig(contents, kinds);
}

export async function loadConfig(
  workspace: string,
  kinds: PluginKinds = noPluginKinds,
): Promise<WorkspaceConfig> {
  const config = await loadSettings(workspace, kinds);
  let env: ReadonlyMap<string, string>;
  try {
    env = parseEnv(await readFile(join(workspace, envFilename), 'utf8'));
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
    env = new Map();
  }
  return { config, env };
}

export function configuredOwner(
  config: Config,
  adapterId: string,
  kind?: string,
) {
  if (Object.hasOwn(config.owner, adapterId)) return config.owner[adapterId];
  if (kind && Object.hasOwn(config.owner, kind)) return config.owner[kind];
  return undefined;
}

export interface WatchOptions {
  debounceMs?: number;
  onConfig(config: WorkspaceConfig): void | Promise<void>;
  onError(error: unknown): void;
}

export function watch(
  workspace: string,
  kinds: PluginKinds,
  options: WatchOptions,
) {
  let timer: NodeJS.Timeout | undefined;
  let pending = Promise.resolve();
  let closed = false;

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      pending = pending.then(async () => {
        if (closed) return;
        try {
          const snapshot = await loadConfig(workspace, kinds);
          if (!closed) await options.onConfig(snapshot);
        } catch (error) {
          if (!closed) options.onError(error);
        }
      });
    }, options.debounceMs ?? 75);
  }

  const watcher = watchDirectory(workspace, (_event, filename) => {
    if (
      filename === null ||
      filename === configFilename ||
      filename === envFilename
    )
      schedule();
  });
  watcher.on('error', options.onError);
  schedule();

  return async function close() {
    closed = true;
    clearTimeout(timer);
    watcher.close();
    await pending;
  };
}

export { updateSettings, writeCredential } from './workspace-write.ts';
