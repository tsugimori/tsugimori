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
  await writeFile(join(workspace, 'AGENTS.md'), 'workspace rules');
  await writeFile(join(workspace, 'SOUL.md'), 'persona');
  await writeFile(join(workspace, 'WORDING.md'), 'wording');
  await writeFile(join(workspace, 'MEMORY.md'), 'memory');
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
  assert.match(blocks[0]!.content, /with the guide\.read tool/);
  assert.ok(
    blocks[0]!.content.includes(
      'To share a picture from the web, use `send.image` with its URL, leave Markdown images out of the text, and add a source link only if the user asks for it.',
    ),
  );
  assert.match(
    blocks[0]!.content,
    /A message sent with a session command is addressed to you\. `mentionsYou` and `repliesToYou` mean it tags or replies to you;.*judge from the text/,
  );
  assert.match(
    blocks[0]!.content,
    /answer exactly `NO_REPLY: <short reason>` \(one line, no other text\)\.$/,
  );
  assert.deepEqual(
    blocks
      .slice(1)
      .map(({ trust, source, content }) => [source, trust, content]),
    [
      ['rule', 'trusted', '--- AGENTS.md ---\nworkspace rules'],
      ['rule', 'trusted', '--- SOUL.md ---\npersona'],
      ['rule', 'trusted', '--- WORDING.md ---\nwording'],
      ['rule', 'trusted', '--- MEMORY.md ---\nmemory'],
      ['rule', 'trusted', '--- rules/global.md ---\nglobal'],
      ['rule', 'trusted', '--- platforms/fake.md ---\nplatform'],
      ['rule', 'member', '--- chat rules: 01.md ---\nchat first'],
      ['rule', 'member', '--- chat rules: 02.md ---\nchat second'],
      ['message', 'owner', 'owner message'],
      ['message', 'member', 'member message'],
    ],
  );

  const replacement = join(rules, 'new.md');
  await writeFile(replacement, 'updated');
  await rename(replacement, join(rules, '01.md'));
  await rm(join(workspace, 'AGENTS.md'));
  await symlink(join(workspace, 'MEMORY.md'), join(workspace, 'AGENTS.md'));
  await rm(join(workspace, 'WORDING.md'));
  const reloaded = await context.assemble(input);
  assert.deepEqual(
    reloaded
      .filter(({ source }) => source === 'rule')
      .map(({ content }) => content),
    [
      '--- SOUL.md ---\npersona',
      '--- MEMORY.md ---\nmemory',
      '--- rules/global.md ---\nglobal',
      '--- platforms/fake.md ---\nplatform',
      '--- chat rules: 01.md ---\nupdated',
      '--- chat rules: 02.md ---\nchat second',
    ],
  );
  assert.deepEqual(
    (await context.assemble({ ...input, afterSeq: old.seq })).map(
      (block) => block.content,
    ),
    ['owner message', 'member message'],
  );
});

test('uses a single quoted platform identity line with bounded names', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-context-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const context = new ContextAssembler({
    store: { recentMessages: () => [] },
    workspace,
  });
  const resumed = {
    adapterId: 'line',
    chatId: 'group',
    kind: 'line',
    afterSeq: 1,
    throughSeq: 2,
    recentMessages: 2,
  };
  const displayName = '日太"\\' + '😀'.repeat(60);
  const username = '@' + 'u'.repeat(64);
  const [line] = await context.assemble({
    ...resumed,
    botIdentity: {
      displayName: ' \n日\x00太\u202E"\\\u2028' + '😀'.repeat(100),
      username: 'u\r' + 'u'.repeat(80),
    },
  });
  assert.deepEqual(line, {
    source: 'system',
    trust: 'trusted',
    content: `On this platform you are ${JSON.stringify(displayName)} (${JSON.stringify(username)}). A mention of this name or a reply to your message refers to you.`,
  });
  assert.deepEqual(await context.assemble(resumed), []);
  assert.deepEqual(
    await context.assemble({ ...resumed, botIdentity: { username: '\n' } }),
    [],
  );
});

test('includes the current Telegram table capability next to system guidance, including on resume', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-context-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const context = new ContextAssembler({
    store: { recentMessages: () => [] },
    workspace,
  });
  const request = {
    adapterId: 'main',
    chatId: '1',
    kind: 'telegram',
    throughSeq: 1,
    recentMessages: 2,
  };
  const content = async (
    options: Partial<typeof request> & {
      afterSeq?: number;
      richText?: boolean;
    },
  ) =>
    (await context.assemble({ ...request, ...options })).map(
      ({ content }) => content,
    );
  assert.equal(
    (await content({}))[1],
    'Telegram shows Markdown tables as bullet lists; prefer short lists or sections over tables.',
  );
  assert.equal(
    (await content({ richText: true }))[1],
    'Telegram renders Markdown tables natively; keep tables to 20 columns or fewer.',
  );
  assert.deepEqual(await content({ richText: true, afterSeq: 1 }), [
    'Telegram renders Markdown tables natively; keep tables to 20 columns or fewer.',
  ]);
  assert.ok(
    !(await content({ kind: 'line', richText: true })).some((text) =>
      text.includes('Telegram'),
    ),
  );
});
