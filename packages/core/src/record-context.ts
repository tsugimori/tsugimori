import type { AssembledEntry } from '@tsugimori/context';
import type {
  AdminTaskRecord,
  TaskExecution,
  TaskRefs,
} from '@tsugimori/plugin-sdk';
import type { Store, TaskRecord } from '@tsugimori/storage';

import {
  guidelineBlock,
  guidelineFileBlock,
  telegramTableBlocks,
} from '@tsugimori/context';
import { scheduleReplyStyle } from '@tsugimori/scheduler';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(workspace: string, args: string[]) {
  try {
    return (
      await exec('git', ['--no-replace-objects', '-C', workspace, ...args], {
        timeout: 2_000,
        maxBuffer: Infinity,
      })
    ).stdout;
  } catch {
    // A workspace may lack Git, and references may outlive Git objects.
    return;
  }
}

function sha256(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

export async function ruleReferences(
  workspace: string,
  entries: readonly AssembledEntry[],
  store: Pick<Store, 'saveContextBlob'>,
): Promise<TaskRefs['workspace']> {
  const rules = entries.filter((entry) => entry.kind === 'rule');
  const repo = await git(workspace, [
    'rev-parse',
    'HEAD',
    '--show-object-format',
  ]);
  const [commit, format] = repo?.trim().split('\n') ?? [];
  const tracked = new Map<string, string>();
  if (!rules.length && !commit) return;
  if (rules.length && commit && (format === 'sha1' || format === 'sha256')) {
    const tree = await git(workspace, [
      '--literal-pathspecs',
      'ls-tree',
      '-z',
      commit,
      '--',
      ...rules.map(({ path }) => path),
    ]);
    for (const entry of tree?.split('\0') ?? []) {
      const tab = entry.indexOf('\t');
      const [mode, type, oid] = entry.slice(0, tab).split(' ');
      if (mode?.startsWith('100') && type === 'blob' && oid)
        tracked.set(entry.slice(tab + 1), oid);
    }
  }
  return {
    commit,
    files: rules.map(({ path, content }) => {
      const hash = sha256(content);
      const oid =
        (format === 'sha1' || format === 'sha256') &&
        createHash(format)
          .update(`blob ${Buffer.byteLength(content)}\0`)
          .update(content)
          .digest('hex');
      if (!commit || tracked.get(path) === oid) return { path, sha256: hash };
      store.saveContextBlob(hash, content);
      return { path, sha256: hash, blob: true };
    }),
  };
}

export async function reconstructContext(
  store: Store,
  workspace: string,
  task: TaskRecord,
  { refs, input }: TaskExecution,
): Promise<AdminTaskRecord['context']> {
  const fixed = await Promise.all(
    (refs.workspace?.files ?? []).map(async (file) => {
      const commit = refs.workspace?.commit;
      const content = file.blob
        ? store.contextBlob(file.sha256)
        : commit && /^[a-f0-9]{40,64}$/.test(commit)
          ? await git(workspace, ['show', `${commit}:./${file.path}`])
          : undefined;
      return {
        kind: 'fixed' as const,
        title: file.path,
        ref: file.sha256,
        text:
          content !== undefined && sha256(content) === file.sha256
            ? guidelineFileBlock(file.path, content).content
            : undefined,
      };
    }),
  );
  return refs.order.flatMap((entry): AdminTaskRecord['context'] => {
    switch (entry.kind) {
      case 'system': {
        const system = {
          guidelines: {
            title: 'System guidelines',
            text: guidelineBlock.content,
          },
          'schedule-style': {
            title: 'Scheduled reply style',
            text: scheduleReplyStyle,
          },
          'telegram-tables-bullets': {
            title: 'Telegram table formatting',
            text: telegramTableBlocks['telegram-tables-bullets'].content,
          },
          'telegram-tables-rich': {
            title: 'Telegram table formatting',
            text: telegramTableBlocks['telegram-tables-rich'].content,
          },
        };
        return [
          { kind: 'fixed', ref: refs.tsugimori.commit, ...system[entry.name] },
        ];
      }
      case 'rule': {
        const section = fixed[entry.index];
        return section ? [section] : [];
      }
      case 'history':
        return [
          {
            kind: 'history',
            title: `Message #${entry.seq}`,
            ref: String(entry.seq),
            text: store.contextMessage(task, entry.seq, entry.revision),
          },
        ];
      case 'summary':
        return [
          {
            kind: 'summary',
            title: 'Chat summary',
            ref: String(refs.summary?.revision ?? 'unavailable'),
            text:
              refs.summary &&
              store.getSummaryVersion(
                {
                  adapterId: task.adapterId,
                  chatId: refs.summary.chatId ?? task.chatId,
                },
                refs.summary.revision,
              ),
          },
        ];
      case 'new': {
        const block = input?.[entry.index];
        return [
          {
            kind: 'new',
            title: block ? `${block.source} · ${block.trust}` : 'New input',
            ref: String(entry.index + 1),
            text: block?.content,
          },
        ];
      }
    }
  });
}
