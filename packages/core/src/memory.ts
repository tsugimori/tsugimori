import type { ToolDefinition } from '@tsugimori/plugin-sdk';

import { ToolFailure } from '@tsugimori/plugin-sdk';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { recordMemory, writeWorkspaceFile } from './workspace-files.ts';

export const memoryAction = 'memory.propose';
const filename = 'MEMORY.md';
const initial = Buffer.from('# MEMORY.md\n\n');

type Proposal = {
  action: 'add' | 'remove' | 'replace';
  match?: string;
  reason: string;
  text?: string;
};

export type MemoryResult =
  { error: string } | { path: string; warning?: string };

async function readMemory(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ENOENT') return;
      if (error.code === 'ELOOP')
        throw new ToolFailure('MEMORY.md must be a regular file');
    }
    throw error;
  });
  if (!file) return { data: initial, mode: undefined };
  try {
    const stat = await file.stat();
    if (!stat.isFile())
      throw new ToolFailure('MEMORY.md must be a regular file');
    return { data: await file.readFile(), mode: stat.mode & 0o777 };
  } finally {
    await file.close();
  }
}

function proposalLines({ action, match, text }: Proposal) {
  let newLine: string | undefined;
  if (action !== 'remove') {
    if (
      text === undefined ||
      !text.isWellFormed() ||
      /[\r\n\u2028\u2029]/u.test(text)
    )
      throw new ToolFailure('Memory text must be a single line');
    newLine = `- ${text}`;
  }
  if (action === 'add') return { oldLine: undefined, newLine };
  if (match === undefined)
    throw new ToolFailure(
      'A match is required to replace or remove a memory bullet',
    );
  return { oldLine: `- ${match}`, newLine };
}

function editMemory(
  data: Buffer,
  { oldLine, newLine }: ReturnType<typeof proposalLines>,
) {
  // Map characters to bytes so unrelated text and line endings survive the edit.
  const contents = data.toString('latin1');
  const replacement =
    newLine === undefined ? undefined : Buffer.from(newLine).toString('latin1');
  if (oldLine === undefined) {
    const firstEnding = /\r\n|[\r\n]/u.exec(contents)?.[0] ?? '\n';
    const separator = contents && !/[\r\n]$/u.test(contents) ? firstEnding : '';
    return Buffer.from(
      contents + separator + replacement + firstEnding,
      'latin1',
    );
  }

  const oldBytes = oldLine.isWellFormed()
    ? Buffer.from(oldLine).toString('latin1')
    : undefined;
  const lines = contents.split(/(\r\n|[\r\n])/u);
  let index = -1;
  for (let i = 0; i < lines.length; i += 2) {
    if (lines[i] !== oldBytes) continue;
    if (index !== -1)
      throw new ToolFailure('More than one MEMORY.md bullet exactly matches');
    index = i;
  }
  if (index === -1)
    throw new ToolFailure('No MEMORY.md bullet exactly matches');
  if (replacement === undefined) lines.splice(index, 2);
  else lines[index] = replacement;
  return Buffer.from(lines.join(''), 'latin1');
}

export class Memory {
  readonly #workspace: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(workspace: string) {
    this.#workspace = workspace;
  }

  tools(reasonPrefix: () => string): ToolDefinition[] {
    return [
      {
        name: memoryAction,
        description:
          'Propose adding, replacing, or removing a bullet in MEMORY.md with linked owner approval. For replace or remove, match the existing bullet text exactly, without the bullet marker.',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'reason'],
          properties: {
            action: { enum: ['add', 'replace', 'remove'] },
            match: { type: 'string' },
            reason: { type: 'string', pattern: '^[^\\u0000]*$' },
            text: { type: 'string', maxLength: 500 },
          },
        },
        permission: {
          action: memoryAction,
          resource: () => ({ type: 'path', path: filename }),
          describe: async (args) => {
            const proposal = args as Proposal;
            const lines = proposalLines(proposal);
            const root = await realpath(this.#workspace);
            const { data } = await readMemory(join(root, filename));
            editMemory(data, lines);
            return [
              ...(lines.oldLine === undefined ? [] : [`- ${lines.oldLine}`]),
              ...(lines.newLine === undefined ? [] : [`+ ${lines.newLine}`]),
              '',
              reasonPrefix() + proposal.reason,
            ].join('\n');
          },
        },
        run: async () => {
          throw new ToolFailure('Memory changes require linked owner approval');
        },
      },
    ];
  }

  apply(args: unknown, approvedBy: string): Promise<MemoryResult> {
    const proposal = args as Proposal;
    const run = async () => {
      const lines = proposalLines(proposal);
      const root = await realpath(this.#workspace);
      const path = join(root, filename);
      const { data, mode } = await readMemory(path);
      await writeWorkspaceFile(path, editMemory(data, lines), mode);
      const warning = await recordMemory(
        root,
        proposal.action,
        proposal.reason,
        approvedBy,
      );
      return { path: filename, ...(warning && { warning }) };
    };
    // Keep the write, commit and push together across approvals in different chats.
    const result = this.#queue.then(run, run);
    this.#queue = result;
    return result;
  }
}
