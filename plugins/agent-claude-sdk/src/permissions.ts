import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { AgentIO } from '@tsugimori/plugin-sdk';

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const protectedDirectories = [
  '.ssh',
  '.cloudflared',
  '.codex',
  '.claude',
  '.aws',
].map((name) => join(homedir(), name));

const fileTools = new Set(['Read', 'Write', 'Edit', 'NotebookEdit']);
const searchTools = new Set(['Glob', 'Grep']);

function contains(root: string, path: string) {
  const child = relative(root, path);
  return (
    child === '' ||
    (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function isProtected(path: string) {
  return (
    protectedDirectories.some((directory) => contains(directory, path)) ||
    path.split(sep).some((part) => part === '.env' || part.startsWith('.env.'))
  );
}

async function canonical(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' ||
        error.code === 'ENOTDIR' ||
        error.code === 'EACCES')
    )
      return;
    throw error;
  }
}

function stable(value: unknown) {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry))
      return Object.fromEntries(
        Object.entries(entry).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
    return entry;
  });
}

export const askThroughHost: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
    },
  };
};

export function toolPermission(
  workdir: string,
  io: AgentIO,
  runSignal: AbortSignal,
  gatewayTools: ReadonlySet<string> = new Set(),
  denyRead?: readonly string[],
): CanUseTool {
  return async (toolName, input, { blockedPath, signal, toolUseID }) => {
    const active = AbortSignal.any([runSignal, signal]);
    const deny = () => {
      if (toolUseID) io.reportToolDenial?.(toolUseID);
      return { behavior: 'deny', message: 'Permission denied.' } as const;
    };
    if (active.aborted) return deny();
    if (gatewayTools.has(toolName))
      return { behavior: 'allow', updatedInput: input };
    const path =
      toolName === 'NotebookEdit'
        ? input.notebook_path
        : fileTools.has(toolName)
          ? input.file_path
          : searchTools.has(toolName)
            ? (input.path ?? workdir)
            : blockedPath;
    const target =
      typeof path === 'string' ? resolve(workdir, path) : undefined;
    const resolved = target ? await canonical(target) : undefined;
    if (
      (target && isProtected(target)) ||
      (resolved && isProtected(resolved)) ||
      denyRead?.some(
        (path) =>
          (target && contains(path, target)) ||
          (resolved && contains(path, resolved)),
      ) ||
      active.aborted
    )
      return deny();
    const pattern = toolName === 'Glob' ? input.pattern : input.glob;
    const localPattern =
      pattern === undefined ||
      (typeof pattern === 'string' &&
        !isAbsolute(pattern) &&
        !pattern.split(/[/\\]/u).includes('..'));
    if (
      target &&
      resolved &&
      contains(workdir, target) &&
      contains(workdir, resolved) &&
      (toolName === 'Read' || (searchTools.has(toolName) && localPattern))
    ) {
      return { behavior: 'allow', updatedInput: input };
    }

    if (denyRead) return deny();

    const description = stable({
      workdir,
      target,
      resolved,
      blockedPath,
      input,
    });
    const interrupted = Promise.withResolvers<boolean>();
    const abort = () => interrupted.resolve(false);
    active.addEventListener('abort', abort, { once: true });
    try {
      const allowed = await Promise.race([
        io.requestApproval(
          {
            action: `claude.${toolName}`,
            resource: {
              type: 'project',
              id: createHash('sha256').update(description).digest('hex'),
            },
            description: `${description.slice(0, 3_500)}${description.length > 3_500 ? '…' : ''}`,
          },
          toolUseID,
        ),
        interrupted.promise,
      ]);
      return allowed && !active.aborted
        ? { behavior: 'allow', updatedInput: input }
        : deny();
    } finally {
      active.removeEventListener('abort', abort);
    }
  };
}
