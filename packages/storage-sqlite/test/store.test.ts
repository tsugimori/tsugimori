import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import assert from 'node:assert/strict';
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
