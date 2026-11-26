import type { Config } from '@tsugimori/config';
import type { ChatRef } from '@tsugimori/plugin-sdk';

import { configFilename, envFilename } from '@tsugimori/config';
import { agentHome } from '@tsugimori/plugin-sdk';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { PluginRegistry } from './registry.ts';

type Agent = Config['agents'][number];

export interface ChatDefaults {
  chat: ChatRef;
  original: string;
  path: string;
  updated: string;
}

export async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
}

function within(parent: string, path: string) {
  const rel = relative(parent, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function overlaps(a: string, b: string) {
  return within(a, b) || within(b, a);
}

export function displayPath(workspace: string, path: string) {
  return within(workspace, path) ? relative(workspace, path) : path;
}

export async function secureDirectory(path: string) {
  const stat = await statIfPresent(path);
  if (!stat) return;
  if (!stat.isDirectory() || (await realpath(path)) !== path)
    throw new Error('Expected a directory without symbolic links');
  return stat;
}

export function splitCredentials(text: string, names: readonly string[]) {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    const key = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/.exec(line)?.[1];
    (key && names.includes(key) ? removed : kept).push(line);
  }
  return { kept: kept.join(''), removed: removed.join('') };
}

function decodePathId(id: string) {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export async function findChatDefaults(workspace: string, agentId: string) {
  const root = join(workspace, 'chats');
  const result: ChatDefaults[] = [];
  if (!(await secureDirectory(root))) return result;
  for (const adapter of await readdir(root, { withFileTypes: true })) {
    if (!adapter.isDirectory()) continue;
    const directory = join(root, adapter.name);
    if (!(await secureDirectory(directory))) continue;
    for (const chat of await readdir(directory, { withFileTypes: true })) {
      if (!chat.isDirectory()) continue;
      const workdir = join(directory, chat.name);
      if (!(await secureDirectory(workdir))) continue;
      const path = join(workdir, 'agents.json');
      if (!(await statIfPresent(path))?.isFile()) continue;
      const original = await readFile(path, 'utf8');
      let contents: Record<string, unknown> | null;
      try {
        contents = JSON.parse(original);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        continue;
      }
      if (contents?.agentId !== agentId) continue;
      for (const key of ['agentId', 'model', 'thinking', 'serviceTier', 'fast'])
        delete contents[key];
      result.push({
        chat: {
          adapterId: decodePathId(adapter.name),
          chatId: decodePathId(chat.name),
        },
        original,
        path,
        updated: JSON.stringify(contents, null, 2) + '\n',
      });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function agentDirectories(
  workspace: string,
  config: Config,
  entry: Agent,
  registry: PluginRegistry,
) {
  const runtimePaths = (agent: Agent) =>
    (
      registry
        .forInstance('agent', agent.kind)
        ?.managedRuntimePaths?.(workspace, agent) ?? []
    ).map((path) => resolve(workspace, path));
  const home = (agent: Agent) => {
    const custom =
      agent.kind === 'codex'
        ? agent.options?.codexHome
        : agent.options?.claudeHome;
    return agentHome(
      workspace,
      agent.id,
      typeof custom === 'string' ? custom : undefined,
    );
  };
  const others = config.agents.filter(({ id }) => id !== entry.id);
  const inUse = await Promise.all(
    others.flatMap((agent) => {
      const command = agent.options?.command;
      const executable = Array.isArray(command) ? command[0] : command;
      return [
        home(agent),
        ...runtimePaths(agent),
        ...(typeof executable === 'string' && executable.includes('/')
          ? [resolve(workspace, executable)]
          : []),
      ].map(async (path) =>
        (await statIfPresent(path)) ? realpath(path) : path,
      );
    }),
  );
  const directories = [home(entry), ...runtimePaths(entry)];
  const protectedPaths = [
    resolve(workspace, config.storage.path),
    join(workspace, configFilename),
    join(workspace, envFilename),
    ...['data', 'chats', 'platforms', 'rules', '.git'].map((name) =>
      join(workspace, name),
    ),
  ];
  const roots = [join(workspace, 'agents'), join(workspace, 'runtime')];
  const kept = directories.filter((path) =>
    inUse.some((other) => overlaps(path, other)),
  );
  const removable = [
    ...new Set(directories.filter((path) => !kept.includes(path))),
  ];
  for (const path of removable) {
    if (
      within(path, workspace) ||
      within(path, homedir()) ||
      within(path, process.execPath) ||
      protectedPaths.some((protectedPath) => overlaps(path, protectedPath)) ||
      roots.some((root) => within(path, root))
    )
      throw new Error(
        'Configured agent directory overlaps protected workspace paths',
      );
  }
  return {
    kept,
    removable: removable.filter(
      (path) =>
        !removable.some((other) => other !== path && within(other, path)),
    ),
  };
}
