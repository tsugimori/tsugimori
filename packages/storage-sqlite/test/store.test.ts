import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { SqliteStore } from '../src/index.ts';

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
