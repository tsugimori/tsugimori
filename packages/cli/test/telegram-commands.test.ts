import type { Logger } from '@tsugimori/core';

import { Auth } from '@tsugimori/auth';
import { Gateway, PluginRegistry } from '@tsugimori/core';
import { TelegramAdapter } from '@tsugimori/platform-telegram';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test(
  'Telegram command menus follow core permissions, locale, and group discovery',
  { timeout: 8_000 },
  async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-command-menu-'));
    const store = new SqliteStore(':memory:');
    const adapterId = 'telegram:test';
    const bot = { id: 42, username: 'SuntAI2ndBot' };
    const owner = 79;
    const member = 80;
    const privateChat = { id: owner, type: 'private' };
    const knownGroup = { id: -1001, type: 'supergroup' };
    const newGroup = { id: -1002, type: 'supergroup' };
    const group = { adapterId, chatId: `${knownGroup.id}_17` };
    store.recordInbound(
      { ...group, kind: 'supergroup', title: 'Known group' },
      { adapterId, userId: String(member), display: null },
      {
        ...group,
        direction: 'inbound',
        messageId: '100',
        raw: null,
        replyTo: null,
        text: 'Earlier message',
        threadId: '17',
        userId: String(member),
      },
    );

    const requests: {
      commands?: { command: string; description: string }[];
      method: string;
      scope: object;
    }[] = [];
    const replies: string[] = [];
    const updates: unknown[] = [];
    const logs: Parameters<Logger>[0][] = [];
    const spans: Parameters<SqliteStore['writeTraceSpans']>[0][number][] = [];
    const writeSpans = store.writeTraceSpans.bind(store);
    store.writeTraceSpans = (batch) => {
      spans.push(...batch);
      writeSpans(batch);
    };
    const ok = (result: unknown) => Response.json({ ok: true, result });
    let failDefault = true;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const method = new URL(String(input)).pathname.split('/').at(-1);
      if (method === 'getMe') return ok(bot);
      if (method === 'getUpdates') {
        await delay(10, undefined, { signal: init?.signal ?? undefined });
        return ok(updates.splice(0));
      }
      assert.ok(typeof init?.body === 'string');
      const body = JSON.parse(init.body);
      if (method === 'sendMessage') {
        replies.push(body.text);
        return ok({ message_id: 1_000 + replies.length });
      }
      if (method === 'sendChatAction') return ok(true);
      assert.ok(method === 'setMyCommands' || method === 'deleteMyCommands');
      requests.push({ method, ...body });
      if (body.scope.type === 'default' && failDefault) {
        failDefault = false;
        return Response.json({ ok: false, error_code: 400 }, { status: 400 });
      }
      return ok(true);
    };
    const registry = new PluginRegistry([
      {
        name: 'test-telegram',
        adapters: {
          telegram: ({ id }) => new TelegramAdapter({ fetch }, id, '1:fake'),
        },
      },
    ]);
    const gateway = new Gateway({
      log: (entry) => logs.push(entry),
      registry,
      store,
      workspace,
    });
    t.after(async () => {
      try {
        await gateway.stop();
      } finally {
        store.close();
        await rm(workspace, { recursive: true, force: true });
      }
    });

    const until = async (condition: () => boolean) => {
      while (!condition()) await delay(10, undefined, { signal: t.signal });
    };
    const path = join(workspace, 'tsugimori.json');
    const configure = (
      locale: 'en' | 'zh-TW',
      attached = true,
      ownerId?: number,
    ) =>
      writeFile(
        path,
        JSON.stringify({
          locale,
          owner: ownerId === undefined ? {} : { [adapterId]: String(ownerId) },
          platforms: attached
            ? [{ id: adapterId, kind: 'telegram', tokenEnv: 'TEST_TOKEN' }]
            : [],
        }),
      );
    const reload = async (
      locale: 'en' | 'zh-TW',
      attached = true,
      ownerId?: number,
    ) => {
      const reloads = () =>
        logs.filter(({ event }) => event === 'config.reloaded').length;
      const before = reloads();
      await configure(locale, attached, ownerId);
      await until(() => reloads() > before);
      await gateway.idle();
      return requests.splice(0);
    };
    let updateId = 0;
    async function deliver(
      chat: { id: number; type: string },
      userId: number,
      texts: string[],
      threadId?: number,
    ) {
      for (const text of texts) {
        const id = ++updateId;
        updates.push({
          update_id: id,
          message: {
            chat,
            from: { id: userId },
            message_id: id,
            text,
            is_topic_message: threadId !== undefined,
            message_thread_id: threadId,
            reply_to_message: { message_id: 99, from: bot },
          },
        });
      }
      await until(
        () =>
          store.getCursor(adapterId, String(bot.id))?.offset === updateId + 1,
      );
      await gateway.idle();
    }

    await configure('en');
    await gateway.start();
    await gateway.idle();
    assert.deepEqual(requests.splice(0), [
      { method: 'deleteMyCommands', scope: { type: 'default' } },
      { method: 'deleteMyCommands', scope: { type: 'all_group_chats' } },
      {
        method: 'setMyCommands',
        scope: { type: 'all_private_chats' },
        commands: [
          { command: 'pair', description: 'Pair with the bot as its owner' },
        ],
      },
    ]);
    assert.ok(logs.some(({ event }) => event === 'platform.commands_failed'));

    const code = new Auth({ store }).createPairingCode(adapterId);
    await deliver(knownGroup, owner, [`/pair ${code}`], 17);
    assert.equal(replies.length, 0);
    assert.equal(requests.length, 0);
    await deliver(privateChat, owner, [`/pair@SuntAI2ndBot ${code}`]);
    assert.deepEqual(replies.splice(0), ['Owner paired.']);
    assert.equal(
      store.getMessage({ adapterId, chatId: String(owner) }, '2')?.text,
      '/pair [redacted]',
    );
    const paired = requests.splice(0);
    const ownerCommands = paired[2]?.commands;
    assert.ok(ownerCommands);
    assert.deepEqual(
      ownerCommands.map(({ command }) => command),
      [
        'add',
        'agent',
        'allow',
        'compact',
        'deny',
        'login',
        'model',
        'preview',
        'previews',
        'status',
      ],
    );
    assert.ok(
      ownerCommands.every(
        ({ description }) =>
          description.length > 0 && description.length <= 256,
      ),
    );
    assert.equal(
      ownerCommands.find(({ command }) => command === 'status')?.description,
      'Show status',
    );
    const dmScope = { type: 'chat', chat_id: String(owner) };
    const memberScope = (chatId: number, userId = owner) => ({
      type: 'chat_member',
      chat_id: String(chatId),
      user_id: userId,
    });
    const set = (scope: object, commands = ownerCommands) => ({
      method: 'setMyCommands',
      scope,
      commands,
    });
    const clear = (scope: object) => ({ method: 'deleteMyCommands', scope });
    assert.deepEqual(paired, [
      clear({ type: 'default' }),
      clear({ type: 'all_private_chats' }),
      set(dmScope),
      set(memberScope(knownGroup.id)),
    ]);

    await deliver(newGroup, member, ['/status@suntai2ndbot args'], 11);
    assert.equal(replies.length, 0);
    assert.deepEqual(requests.splice(0), [set(memberScope(newGroup.id))]);
    await deliver(
      newGroup,
      owner,
      [
        '/compact@suntai2ndbot',
        '/COMPACT@SuntAI2ndBot',
        '/compact@otherbot',
        '/status@suntai2ndbot args',
        '/compact@suntai2ndbot unnecessary',
      ],
      12,
    );
    assert.equal(
      replies.filter((text) => text === 'No agent is attached.').length,
      2,
    );
    assert.ok(
      replies.includes('Gateway running with 1 platform(s) and 0 agent(s).'),
    );
    assert.ok(replies.includes('Usage: /compact'));
    assert.equal(replies.length, 4);
    assert.equal(
      store.getMessage({ adapterId, chatId: `${newGroup.id}_12` }, '6'),
      undefined,
    );
    assert.equal(requests.length, 0);

    const localized = await reload('zh-TW');
    const zh = localized[0]?.commands;
    assert.ok(zh);
    assert.equal(
      zh.find(({ command }) => command === 'compact')?.description,
      '壓縮目前對話的上下文',
    );
    assert.equal(
      zh.find(({ command }) => command === 'status')?.description,
      '查看狀態',
    );
    assert.deepEqual(localized, [
      set(dmScope, zh),
      set(memberScope(knownGroup.id), zh),
      set(memberScope(newGroup.id), zh),
    ]);
    assert.deepEqual(await reload('zh-TW'), []);
    assert.deepEqual(await reload('zh-TW', false), []);
    assert.deepEqual(await reload('zh-TW'), []);
    assert.deepEqual(await reload('zh-TW', true, member), [
      clear(dmScope),
      clear(memberScope(knownGroup.id)),
      clear(memberScope(newGroup.id)),
      set({ type: 'chat', chat_id: String(member) }, zh),
      set(memberScope(knownGroup.id, member), zh),
      set(memberScope(newGroup.id, member), zh),
    ]);
    assert.deepEqual(await reload('zh-TW', true, knownGroup.id), [
      clear({ type: 'chat', chat_id: String(member) }),
      clear(memberScope(knownGroup.id, member)),
      clear(memberScope(newGroup.id, member)),
    ]);
    await gateway.stop();
    assert.ok(
      spans.some(
        ({ name, status, attrs }) =>
          name === 'platform.commands' &&
          status === 'error' &&
          attrs.scope === 'default',
      ),
    );
  },
);
