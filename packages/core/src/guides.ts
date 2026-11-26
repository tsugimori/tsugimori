import type { ToolDefinition } from '@tsugimori/plugin-sdk';

import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { Logger } from './hooks.ts';

const maxBytes = 64 * 1024;
const privateRoots = new Set([
  'data',
  'agents',
  'runtime',
  'chats',
  'node_modules',
]);

export function guideTools({
  log,
  workspace,
}: {
  log: Logger;
  workspace: string;
}): ToolDefinition[] {
  return [
    {
      name: 'guide.read',
      description:
        'Read a workspace guideline Markdown file listed in AGENTS.md, for example writing/code.md.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
      run: async (args, { taskId }) => {
        const { path } = args as { path: string };
        const segments = path.split('/');
        const root = segments[0]!;
        if (
          !path.endsWith('.md') ||
          isAbsolute(path) ||
          path.includes('\\') ||
          path.includes('\0') ||
          root.startsWith('.') ||
          privateRoots.has(root) ||
          segments.some(
            (segment) => !segment || segment === '.' || segment === '..',
          )
        )
          return { error: 'forbidden' };

        try {
          let entry = await realpath(workspace);
          for (const parent of segments.slice(0, -1)) {
            entry = join(entry, parent);
            if (!(await lstat(entry)).isDirectory())
              return { error: 'forbidden' };
          }
          entry = join(entry, segments.at(-1)!);
          const expected = await lstat(entry, { bigint: true });
          if (!expected.isFile() || (await realpath(entry)) !== entry)
            return { error: 'forbidden' };

          const file = await open(
            entry,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const opened = await file.stat({ bigint: true });
            if (
              !opened.isFile() ||
              opened.dev !== expected.dev ||
              opened.ino !== expected.ino ||
              (await realpath(entry)) !== entry
            )
              return { error: 'forbidden' };
            const data = Buffer.allocUnsafe(maxBytes + 1);
            let length = 0;
            while (length < data.length) {
              const { bytesRead } = await file.read(
                data,
                length,
                data.length - length,
                length,
              );
              if (!bytesRead) break;
              length += bytesRead;
            }
            if (length <= maxBytes)
              return { path, content: data.toString('utf8', 0, length) };
            const size = Math.max(length, (await file.stat()).size);
            const decoder = new StringDecoder('utf8');
            return {
              path,
              content:
                decoder.write(data.subarray(0, maxBytes)) +
                `\n[truncated: ${size} bytes total]`,
            };
          } finally {
            await file.close();
          }
        } catch (error) {
          const code =
            error instanceof Error && 'code' in error ? error.code : undefined;
          if (code === 'ENOENT' || code === 'ENOTDIR')
            return { error: 'not_found' };
          if (
            code !== 'ELOOP' &&
            code !== 'EACCES' &&
            code !== 'EPERM' &&
            code !== 'ENAMETOOLONG'
          )
            log({ level: 'error', event: 'guide.read_failed', taskId });
          return { error: 'forbidden' };
        }
      },
    },
  ];
}
