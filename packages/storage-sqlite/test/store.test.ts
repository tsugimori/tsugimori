import type { TaskExecution } from '@tsugimori/plugin-sdk';

import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../src/index.ts';

test('upgrades old chat rows and carries settings through group migration', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'tsugimori-store-settings-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, 'store.db');
  const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
  const legacyMigrations = join(temp, 'drizzle');
  await mkdir(legacyMigrations);
  for (const folder of (await readdir(migrations)).sort()) {
    if (folder.endsWith('_chat_agent_settings')) break;
    await symlink(
      join(migrations, folder),
      join(legacyMigrations, folder),
      'dir',
    );
  }
  const legacy = new DatabaseSync(path);
  try {
    migrate(drizzle({ client: legacy }), {
      migrationsFolder: legacyMigrations,
    });
    legacy.exec(
      "INSERT INTO chats (adapter_id, chat_id, kind, model) VALUES ('a', 'old', 'group', 'chosen')",
    );
    legacy.exec(
      "INSERT INTO messages (adapter_id, chat_id, message_id, direction, text) VALUES ('a', 'old', 'original', 'inbound', 'Legacy message')",
    );
  } finally {
    legacy.close();
  }

  const chat = { adapterId: 'a', chatId: 'old' };
  const store = new SqliteStore(path);
  try {
    assert.equal(store.getChat(chat)?.model, 'chosen');
    assert.equal(store.getChat(chat)?.serviceTier, null);
    assert.equal(store.getChat(chat)?.thinking, null);
    store.setChatRoute(chat, { serviceTier: 'fast', thinking: 'xhigh' });
    assert.equal(store.migrateChat(chat, 'new'), true);
  } finally {
    store.close();
  }
  const reopened = new SqliteStore(path);
  try {
    const migrated = reopened.getChat(reopened.resolveChat(chat));
    assert.equal(migrated?.kind, 'supergroup');
    assert.equal(migrated?.model, 'chosen');
    assert.equal(migrated?.serviceTier, 'fast');
    assert.equal(migrated?.thinking, 'xhigh');
    const history = reopened.historyMessages(chat, {
      query: 'Legacy',
      limit: 1,
    });
    assert.equal(history[0]?.text, 'Legacy message');
    assert.equal(history[0]?.recordedAt, null);
    assert.deepEqual(
      reopened.historyMessages(chat, {
        query: 'Legacy',
        fromTime: 0,
        limit: 1,
      }),
      [],
    );
  } finally {
    reopened.close();
  }
});

test('applies generated migrations, enables WAL, and reopens existing data', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'tsugimori-store-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, 'store.db');
  const chat = { adapterId: 'a', chatId: 'c' };
  const owner = { adapterId: 'a', userId: 'owner' };
  const store = new SqliteStore(path);
  try {
    const source = {
      ...chat,
      messageId: 'm1',
      direction: 'inbound' as const,
      userId: owner.userId,
      text: 'hello',
      raw: { update: 123 },
      replyTo: 'm0',
      threadId: 'topic',
    };
    const group = { ...chat, kind: 'group' as const, title: 'Test group' };
    const user = { ...owner, display: 'Owner', username: 'old_username' };
    assert.ok(store.recordInbound(group, user, source));
    assert.ok(
      store.recordInbound(
        group,
        { ...user, username: 'new_username' },
        source,
        true,
      ),
    );
    assert.equal(store.recordInbound(group, user, source), undefined);
    assert.ok(
      store.recordInbound(
        group,
        { ...owner, display: null },
        { ...source, messageId: 'm2' },
      ),
    );
    store.markDeleted(chat, 'm2');
    store.setAllowlisted(chat, true);
    store.saveCursor('a', 'bot', { offset: 3, updatedAt: 123 });
    store.saveCursor('a', 'bot', { offset: 5, updatedAt: 456 });
  } finally {
    store.close();
  }
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const readOnly = new DatabaseSync(path, { readOnly: true });
  try {
    const tableNames = readOnly
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    for (const name of [
      'chats',
      'users',
      'messages',
      'agent_sessions',
      'tasks',
      'approvals',
      'grants',
      'owners',
      'pairing_codes',
      'trace_spans',
    ])
      assert.ok(tableNames.includes(name), name);
    assert.equal(
      readOnly.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'wal',
    );
  } finally {
    readOnly.close();
  }

  const reopened = new SqliteStore(path);
  try {
    assert.deepEqual(reopened.getUser(owner), {
      ...owner,
      display: 'Owner',
      username: 'new_username',
    });
    reopened.recordUser({ ...owner, display: null, username: null });
    assert.deepEqual(reopened.getUser(owner), {
      ...owner,
      display: 'Owner',
      username: null,
    });
    assert.equal(reopened.getChat(chat)?.allowlisted, true);
    assert.deepEqual(reopened.getCursor('a', 'bot'), {
      offset: 5,
      updatedAt: 456,
    });
    assert.equal(reopened.getCursor('other', 'bot'), undefined);
    assert.deepEqual(reopened.getMessage(chat, 'm1')?.raw, { update: 123 });
    assert.equal(reopened.getMessage(chat, 'm1')?.threadId, 'topic');
    reopened.markDeleted(chat, 'm1');
    assert.equal(reopened.getMessage(chat, 'm1')?.deleted, true);
    assert.deepEqual(
      reopened.recentMessages(chat, { limit: 10, throughSeq: 100 }),
      [],
    );
  } finally {
    reopened.close();
  }
});

test('backfills state for group upgrades already recorded before chat continuity', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'tsugimori-store-upgrade-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, 'store.db');
  const old = { adapterId: 'telegram', chatId: '-100' };
  const next = { ...old, chatId: '-100100' };
  const store = new SqliteStore(path);
  try {
    for (const chat of [old, next]) {
      store.recordInbound(
        { ...chat, kind: chat === old ? 'group' : 'supergroup', title: null },
        { adapterId: chat.adapterId, userId: 'user', display: null },
        {
          ...chat,
          direction: 'inbound',
          messageId: '1',
          userId: 'user',
          text: chat.chatId,
          raw: null,
          replyTo: null,
          threadId: null,
        },
      );
    }
    store.setSession({
      ...old,
      agentId: 'agent',
      model: 'model',
      sessionId: 'id',
      throughSeq: 1,
      seenAfter: [],
    });
  } finally {
    store.close();
  }
  const legacy = new DatabaseSync(path);
  try {
    legacy
      .prepare(
        'UPDATE chats SET migrated_to_chat_id = ? WHERE adapter_id = ? AND chat_id = ?',
      )
      .run(next.chatId, old.adapterId, old.chatId);
  } finally {
    legacy.close();
  }
  for (let i = 0; i < 2; i++) {
    const reopened = new SqliteStore(path);
    try {
      assert.deepEqual(reopened.resolveChat(old), next);
      assert.deepEqual(reopened.listChatMessages(old), []);
      assert.equal(
        reopened.getMessage(next, '1', old.chatId)?.text,
        old.chatId,
      );
      assert.equal(reopened.getMessage(next, '1', '')?.text, next.chatId);
      assert.equal(
        reopened.getSession(next, 'agent', 'model')?.sessionId,
        'id',
      );
      assert.equal(reopened.listChatMessages(next).length, 2);
    } finally {
      reopened.close();
    }
  }
});

test('migrates existing tasks, raw JSON and the current summary, then stores new summary revisions', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'tsugimori-record-migration-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, 'records.db');
  const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
  const legacyMigrations = join(temp, 'drizzle');
  await mkdir(legacyMigrations);
  for (const folder of (await readdir(migrations)).sort()) {
    if (folder.endsWith('_execution_records')) break;
    await symlink(
      join(migrations, folder),
      join(legacyMigrations, folder),
      'dir',
    );
  }
  const legacy = new DatabaseSync(path);
  try {
    migrate(drizzle({ client: legacy }), {
      migrationsFolder: legacyMigrations,
    });
    legacy.exec(`
      INSERT INTO chats (adapter_id, chat_id, kind) VALUES ('adapter', 'chat', 'dm');
      INSERT INTO messages (adapter_id, chat_id, message_id, direction, text, raw)
        VALUES ('adapter', 'chat', 'old', 'inbound', 'Legacy text', '{"legacy":true}');
      INSERT INTO chat_summaries (adapter_id, chat_id, revision, text, through_seq, updated_at)
        VALUES ('adapter', 'chat', 3, 'Legacy summary', 1, 42);
      INSERT INTO tasks (id, adapter_id, chat_id, source_message_id, status, created_at)
        VALUES ('old-task', 'adapter', 'chat', 'old', 'completed', 42);
    `);
  } finally {
    legacy.close();
  }
  const ref = { adapterId: 'adapter', chatId: 'chat' };
  const store = new SqliteStore(path);
  t.after(() => store.close());
  assert.equal(store.getTask('old-task')?.status, 'completed');
  assert.equal(store.getTaskExecution('old-task'), undefined);
  assert.deepEqual(store.messageRaw(ref, 1), { legacy: true });
  assert.equal(store.getSummaryVersion(ref, 3), 'Legacy summary');
  const message = {
    ...ref,
    direction: 'inbound',
    userId: 'user',
    replyTo: null,
    threadId: null,
    messageId: 'new',
    text: 'New message',
    raw: { text: '界'.repeat(2000) },
  } as const;
  const stored = store.recordInbound(
    { ...ref, kind: 'dm', title: null },
    { adapterId: ref.adapterId, userId: 'user', display: null },
    message,
  )!;
  const next = 'Updated summary '.repeat(100);
  assert.ok(
    store.saveSummary({
      ...store.getSummary(ref)!,
      text: next,
      throughSeq: stored.seq,
    }),
  );
  assert.equal(store.getSummary(ref)?.revision, 4);
  assert.equal(store.getSummaryVersion(ref, 4), next);

  const inspect = new DatabaseSync(path, { readOnly: true });
  try {
    const row = inspect
      .prepare('SELECT raw, raw_z FROM messages WHERE seq = ?')
      .get(stored.seq);
    const raw = Buffer.from(row?.raw_z as Uint8Array);
    assert.equal(row?.raw, null);
    assert.deepEqual([...raw.subarray(0, 5)], [1, 0x28, 0xb5, 0x2f, 0xfd]);
    assert.ok(raw.length < 100);
    assert.deepEqual(store.messageRaw(ref, stored.seq), message.raw);
  } finally {
    inspect.close();
  }
});

test('prunes the oldest task transcript first and preserves outcomes and tool metadata', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const ref = { adapterId: 'adapter', chatId: 'chat' };
  const payload = randomBytes(4_096).toString('base64');
  const state: TaskExecution = {
    agent: {
      agentId: 'fake',
      kind: 'test',
      model: 'model',
      requestedModel: 'default',
    },
    input: [{ source: 'message', trust: 'owner', content: payload }],
    output: payload,
    refs: {
      tsugimori: { commit: 'unknown' },
      history: {},
      session: { mode: 'new' },
      order: [],
    },
    outcome: {
      kind: 'delivered',
      delivery: {
        adapterId: ref.adapterId,
        parts: [{ ok: true, messageId: 'outbound' }],
      },
    },
    timing: {
      queuedMs: 0,
      contextMs: 0,
      agentMs: 1,
      toolsMs: 0,
      deliveryMs: 1,
      totalMs: 2,
    },
    supplements: [],
  };
  for (const createdAt of [1, 2]) {
    const id = 'task-' + createdAt;
    store.createTask({
      ...ref,
      id,
      createdAt,
      sourceMessageId: 'source-' + createdAt,
      status: 'sent',
      startedAt: createdAt,
      finishedAt: createdAt + 1,
      agentId: 'fake',
      model: 'model',
    });
    store.saveTaskExecution(id, state);
    store.appendTaskEvents(id, [
      { seq: 1, at: createdAt, kind: 'text', data: { text: payload } },
    ]);
    store.createToolCall({
      taskId: id,
      approvalId: null,
      args: 'arguments',
      callId: null,
      name: 'fixture',
      startedAt: createdAt,
      endedAt: createdAt + 1,
      status: 'ok',
      result: 'result',
    });
  }
  store.recordOutbound({
    ...ref,
    messageId: 'outbound',
    direction: 'outbound',
    userId: null,
    replyTo: null,
    threadId: null,
    text: 'Delivered',
    raw: { payload },
  });
  const before = store.recordUsage();
  assert.equal(before.oldestFullTaskAt, 1);
  const cap = Math.floor(before.bytes * 0.8);
  const prune = store.pruneRecords(cap);
  const remaining = store.recordUsage();
  assert.deepEqual(prune, { bytes: before.bytes - remaining.bytes, tasks: 1 });
  assert.ok(remaining.bytes <= Math.floor(cap * 0.9));
  assert.equal(remaining.oldestFullTaskAt, 2);
  assert.equal(store.getTask('task-1')?.status, 'sent');
  assert.equal(store.getTaskExecution('task-1')?.input, null);
  assert.equal(store.getTaskExecution('task-1')?.output, null);
  assert.deepEqual(store.getTaskExecution('task-1')?.outcome, state.outcome);
  assert.deepEqual(store.getTaskEvents('task-1'), []);
  assert.equal(store.taskToolCalls(['task-1'])[0]?.name, 'fixture');
  assert.equal(store.taskToolCalls(['task-1'])[0]?.args, null);
  assert.equal(store.taskToolCalls(['task-1'])[0]?.result, null);
  assert.equal(store.getTaskExecution('task-2')?.output, payload);
  assert.deepEqual(store.messageRaw(ref, 1), { payload });

  const prior = store.beginSummary(ref);
  assert.ok(
    store.saveSummary({ ...prior, text: 'old summary', throughSeq: 1 }),
  );
  const active = store.getSummary(ref)!;
  assert.ok(
    store.saveSummary({ ...active, text: 'current summary', throughSeq: 2 }),
  );
  store.saveContextBlob('orphan', payload);
  store.saveContextBlob('in-use', payload);
  assert.ok(
    store.pruneRecords(0, [
      {
        ...ref,
        taskId: 'running',
        refs: {
          workspace: {
            files: [{ path: 'AGENTS.md', sha256: 'in-use', blob: true }],
          },
        },
      },
    ]).bytes > 0,
  );
  assert.equal(store.contextBlob('in-use'), payload);
  assert.equal(store.messageRaw(ref, 1), null);
  assert.equal(store.getMessage(ref, 'outbound')?.text, 'Delivered');
  assert.equal(store.contextBlob('orphan'), undefined);
  assert.equal(store.getSummaryVersion(ref, active.revision), undefined);
  assert.equal(
    store.getSummaryVersion(ref, store.getSummary(ref)!.revision),
    'current summary',
  );
  assert.equal(store.getTaskExecution('task-2')?.outcome.kind, 'delivered');
});

test('ranks sticker search by matched keywords and keeps a stable order for ties', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const chat = { adapterId: 'a', chatId: 'c' };
  const botId = 'bot';
  const puppy = {
    description: 'Happy puppy smiling and waving a paw',
    emoji: '🐶',
    fileId: 'puppy-file',
  };
  const kitten = {
    description: 'Waving kitten wearing an X badge',
    emoji: undefined,
    fileId: 'kitten-file',
  };
  assert.ok(
    store.saveStickerSet('cats', botId, chat, [
      { ...kitten, emoji: null, format: 'static', uniqueId: 'kitten' },
    ]),
  );
  assert.ok(
    store.saveStickerSet('puppies', botId, chat, [
      { ...puppy, format: 'static', uniqueId: 'puppy' },
    ]),
  );

  assert.deepEqual(store.searchStickers(botId, 'happy dog', 10), [puppy]);
  assert.deepEqual(store.searchStickers(botId, 'HAPPY waving', 10), [
    puppy,
    kitten,
  ]);
  assert.deepEqual(store.searchStickers(botId, 'HAPPY waving', 1), [puppy]);
  assert.deepEqual(store.searchStickers(botId, 'waving', 10), [kitten, puppy]);
  assert.deepEqual(store.searchStickers(botId, '', 10), [kitten, puppy]);
  assert.deepEqual(store.searchStickers(botId, '🐶', 10), [puppy]);
  assert.deepEqual(store.searchStickers(botId, 'dolphin 🐶', 10), [puppy]);
  assert.deepEqual(store.searchStickers(botId, 'x puppy', 10), [puppy]);
  assert.deepEqual(store.searchStickers(botId, 'x', 10), [kitten]);
});

test('lists task summaries with indexed filters and stable pagination on timestamp ties', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const group = { adapterId: 'tg:main', chatId: 'group' };
  const dm = { adapterId: 'line:main', chatId: 'direct' };
  const platforms = new Map([
    ['tg:main', 'telegram'],
    ['line:main', 'line'],
  ]);
  const source = store.recordInbound(
    { ...group, title: 'Example chat', kind: 'group' },
    { adapterId: group.adapterId, userId: 'user', display: 'Participant' },
    {
      ...group,
      messageId: 'first',
      direction: 'inbound',
      userId: 'user',
      raw: { hidden: 'raw fixture' },
      replyTo: null,
      threadId: null,
      text: 'A literal 100%_ check ' + '界'.repeat(300) + ' tail marker',
    },
  );
  assert.ok(source);
  for (const [id, ref, createdAt, status, agentId] of [
    ['new', group, 3000, 'running', 'a'],
    ['tie-z', group, 2000, 'failed', 'b'],
    ['tie-a', dm, 2000, 'sent', 'a'],
    ['old', group, 1000, 'cancelled', null],
  ] as const) {
    store.createTask({
      ...ref,
      id,
      createdAt,
      status,
      agentId,
      sourceMessageId: 'first',
      startedAt: createdAt + 10,
      finishedAt: status === 'running' ? null : createdAt + 40,
      model: agentId === null ? null : 'model',
    });
  }
  store.saveTrigger(
    {
      ...group,
      at: 1990,
      messageId: 'first',
      taskId: 'tie-z',
      triggered: true,
      reason: 'mention',
    },
    source.seq,
  );
  const call = store.createToolCall({
    taskId: 'tie-z',
    approvalId: null,
    callId: null,
    args: null,
    result: null,
    name: 'fixture',
    startedAt: 2015,
    endedAt: 2018,
    status: 'error',
  });
  assert.ok(call);
  const metric = (
    name: string,
    startedAt: number,
    attrs: Record<string, string | number>,
  ) => ({
    name,
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    status: 'ok' as const,
    attrs: { ...attrs, taskId: 'tie-z' },
  });
  store.writeTraceSpans([
    metric('agent.usage', 2012, { inputTokens: 3, outputTokens: 4 }),
    metric('agent.usage', 2013, { inputTokens: 7 }),
    metric('agent.usage', 2014, {
      inputTokens: 1000,
      outputTokens: 900,
      purpose: 'summary',
    }),
    metric('tool.run', 2015, { name: 'fixture', toolCallSeq: call }),
    metric('agent.tool', 2016, { name: 'legacy' }),
    metric('task.failed', 2040, { error: 'fixture error' }),
  ]);

  const ids = (filter: Parameters<SqliteStore['adminTasks']>[0]) =>
    store.adminTasks(filter, platforms).map(({ id }) => id);
  const first = store.adminTasks({ limit: 2 }, platforms);
  assert.deepEqual(
    first.map(({ id }) => id),
    ['new', 'tie-z', 'tie-a'],
  );
  const cursor = { createdAt: first[1]!.createdAt, id: first[1]!.id };
  assert.deepEqual(ids({ limit: 2, cursor }), ['tie-a', 'old']);
  assert.deepEqual(
    ids({
      limit: 10,
      status: 'failed',
      agent: 'b',
      chat: group,
      platform: 'telegram',
      since: 2000,
      before: 3000,
      q: '100%_',
    }),
    ['tie-z'],
  );
  assert.deepEqual(ids({ limit: 10, platform: 'line' }), ['tie-a']);
  assert.deepEqual(ids({ limit: 10, platform: 'tg:main' }), []);
  assert.deepEqual(ids({ limit: 10, platform: 'missing' }), []);
  assert.deepEqual(ids({ limit: 10, q: '100%X' }), []);
  assert.deepEqual(ids({ limit: 10, q: 'TAIL MARKER' }), [
    'new',
    'tie-z',
    'old',
  ]);
  const failed = first[1]!;
  assert.equal(failed.chatKey, JSON.stringify([group.adapterId, group.chatId]));
  assert.equal(failed.chatTitle, 'Example chat');
  assert.equal(failed.triggerReason, 'mention');
  assert.ok(failed.triggerText?.endsWith('…'));
  assert.ok(!failed.triggerText?.includes('tail marker'));
  assert.equal(failed.durationMs, 30);
  assert.equal(failed.inputTokens, 7);
  assert.equal(failed.outputTokens, 4);
  assert.equal(failed.toolCount, 2);
  assert.equal(failed.error, 'fixture error');
  assert.equal(first[0]?.durationMs, null);
  assert.equal(first[2]?.triggerText, null);
  assert.equal(first[2]?.triggerReason, null);
});
