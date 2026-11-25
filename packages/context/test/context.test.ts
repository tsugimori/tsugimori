import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ContextAssembler } from '../src/index.ts';

test('assembles ordered rules, marked recent messages, and scoped resume context', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-context-'));
  const store = new SqliteStore(':memory:');
  t.after(async () => {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const chat = { adapterId: 'fake:main', chatId: 'group' };
  const rules = join(workspace, 'chats', chat.adapterId, chat.chatId, 'rules');
  await mkdir(rules, { recursive: true });
  await mkdir(join(workspace, 'rules'));
  await mkdir(join(workspace, 'platforms'));
  await writeFile(join(workspace, 'rules/global.md'), 'global');
  await writeFile(join(workspace, 'platforms/fake.md'), 'platform');
  await writeFile(join(rules, '02.md'), 'chat second');
  await writeFile(join(rules, '01.md'), 'chat first');
  await writeFile(join(rules, 'ignore.txt'), 'not a rule');
  await symlink(
    join(workspace, 'rules/global.md'),
    join(rules, 'secret-alias.md'),
  );

  function record(chatId: string, userId: string, text: string) {
    const scope = { ...chat, chatId };
    return store.recordInbound(
      { ...scope, kind: 'group', title: null },
      { adapterId: chat.adapterId, userId, display: null },
      {
        ...scope,
        direction: 'inbound',
        messageId: text,
        userId,
        replyTo: null,
        threadId: null,
        raw: null,
        text,
      },
    );
  }
  const old = record(chat.chatId, 'owner', 'older');
  record('private', 'owner', 'other chat');
  record(chat.chatId, 'owner', 'owner message');
  const recent = record(chat.chatId, 'member', 'member message');
  assert.ok(old && recent);
  const context = new ContextAssembler({ store, workspace });
  const input = {
    ...chat,
    kind: 'fake',
    ownerId: 'owner',
    throughSeq: recent.seq,
    recentMessages: 2,
  };
  const blocks = await context.assemble(input);
  assert.equal(blocks[0]?.source, 'system');
  assert.deepEqual(
    blocks
      .slice(1)
      .map(({ trust, source, content }) => [source, trust, content]),
    [
      ['rule', 'trusted', 'global'],
      ['rule', 'trusted', 'platform'],
      ['rule', 'member', 'chat first'],
      ['rule', 'member', 'chat second'],
      ['message', 'owner', 'owner message'],
      ['message', 'member', 'member message'],
    ],
  );

  const replacement = join(rules, 'new.md');
  await writeFile(replacement, 'updated');
  await rename(replacement, join(rules, '01.md'));
  assert.equal((await context.assemble(input))[3]?.content, 'updated');
  assert.deepEqual(
    (await context.assemble({ ...input, afterSeq: old.seq })).map(
      (block) => block.content,
    ),
    ['owner message', 'member message'],
  );
});
