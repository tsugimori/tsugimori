import type { AssembledEntry } from '@tsugimori/context';
import type { TaskExecution } from '@tsugimori/plugin-sdk';
import type { TaskRecord } from '@tsugimori/storage';

import { guidelineFileBlock } from '@tsugimori/context';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { reconstructContext, ruleReferences } from '../src/record-context.ts';
import { silentReason } from '../src/task-recorder.ts';

function rule(path: string, content: string): AssembledEntry {
  return {
    kind: 'rule',
    path,
    content,
    block: guidelineFileBlock(path, content),
  };
}

test('reconstructs rules from Git and deduplicated dirty snapshots', async (t) => {
  const workspace = fileURLToPath(new URL('../../../', import.meta.url));
  let content: string;
  try {
    content = execFileSync('git', ['-C', workspace, 'show', 'HEAD:README.md'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    t.skip('No Git source checkout');
    return;
  }
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const entries = [
    rule('README.md', content),
    rule('AGENTS.md', 'A synthetic local change'),
    rule('SOUL.md', 'A synthetic local change'),
  ];
  const refs = await ruleReferences(workspace, entries, store);
  assert.match(refs?.commit ?? '', /^[a-f0-9]{40,64}$/);
  const [clean, dirty, identical] = refs?.files ?? [];
  assert.equal(clean?.blob, undefined);
  assert.ok(dirty?.blob);
  assert.equal(dirty.sha256, identical?.sha256);
  assert.equal(store.contextBlob(dirty.sha256), 'A synthetic local change');
  assert.equal(
    store.recordUsage().bytes,
    Buffer.byteLength(JSON.stringify('A synthetic local change')),
  );
  const task: TaskRecord = {
    adapterId: 'adapter',
    chatId: 'chat',
    id: 'task',
    createdAt: 1,
    sourceMessageId: 'source',
    status: 'completed',
    startedAt: 1,
    finishedAt: 2,
    agentId: null,
    model: null,
  };
  const record: TaskExecution = {
    agent: null,
    input: [],
    output: '',
    outcome: { kind: 'silent' },
    supplements: [],
    timing: {
      queuedMs: 0,
      contextMs: 0,
      agentMs: 0,
      toolsMs: 0,
      deliveryMs: 0,
      totalMs: 0,
    },
    refs: {
      tsugimori: { commit: 'unknown' },
      workspace: refs,
      history: {},
      session: { mode: 'new' },
      order: entries.map((_, index) => ({ kind: 'rule', index })),
    },
  };
  assert.deepEqual(
    (await reconstructContext(store, workspace, task, record)).map(
      ({ text }) => text,
    ),
    entries.map(({ block }) => block.content),
  );
  const telegram = await reconstructContext(store, workspace, task, {
    ...record,
    refs: {
      ...record.refs,
      order: [
        { kind: 'system', name: 'telegram-tables-bullets' },
        { kind: 'system', name: 'telegram-tables-rich' },
      ],
    },
  });
  assert.deepEqual(
    telegram.map(({ text }) => text),
    [
      'Telegram shows Markdown tables as bullet lists; prefer short lists or sections over tables.',
      'Telegram renders Markdown tables natively; keep tables to 20 columns or fewer.',
    ],
  );
  const noRepo = await mkdtemp(join(tmpdir(), 'tsm-records-'));
  t.after(() => rm(noRepo, { recursive: true, force: true }));
  const nonGit = await ruleReferences(noRepo, entries, store);
  assert.equal(nonGit?.commit, undefined);
  assert.ok(
    nonGit?.files.every(({ blob, sha256 }) => !blob && sha256.length === 64),
  );
  const unavailable = await reconstructContext(store, noRepo, task, record);
  assert.equal(unavailable[0]?.text, undefined);
  assert.equal(unavailable[0]?.ref, clean?.sha256);
  assert.equal(unavailable[1]?.text, entries[1]?.block.content);
});

test('limits NO_REPLY reasons and rejects multiline or longer replies', () => {
  assert.equal(silentReason('  NO_REPLY  '), '');
  assert.equal(silentReason(' NO_REPLY:  because  '), 'because');
  assert.equal(silentReason('NO_REPLY: ' + '👍'.repeat(501)), '👍'.repeat(500));
  assert.equal(silentReason('NO_REPLY: reason\nnext line'), undefined);
  assert.equal(silentReason('Prefix NO_REPLY'), undefined);
});
