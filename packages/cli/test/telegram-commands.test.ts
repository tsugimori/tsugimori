import type { Logger } from '@tsugimori/core';

import { approvalCallbackId, Auth } from '@tsugimori/auth';
import { Gateway, PluginRegistry } from '@tsugimori/core';
import { TelegramAdapter } from '@tsugimori/platform-telegram';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

type ScheduleRecord = Parameters<SqliteStore['createSchedule']>[0];

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
    let statusEntities: unknown;
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
        if (
          typeof body.text === 'string' &&
          body.text.startsWith('🟢 tsugimori ')
        )
          statusEntities = body.entities;
        return ok({ message_id: 1_000 + replies.length });
      }
      if (method === 'sendChatAction') return ok(true);
      assert.ok(method === 'setMyCommands' || method === 'deleteMyCommands');
      requests.push({ method, ...body });
      if (body.scope.type === 'default' && failDefault) {
        failDefault = false;
        return Response.json({
          ok: false,
          error_code: 400,
          description: `Bad Request: command menu rejected at ${String(input)} for 1:fake`,
        });
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
    const failure = logs.find(
      ({ event }) => event === 'platform.commands_failed',
    );
    assert.equal(failure?.code, 400);
    assert.match(failure?.error ?? '', /Bad Request: command menu rejected/);
    assert.doesNotMatch(failure?.error ?? '', /1:fake|https?:\/\//);

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
      replies.some(
        (text) => text.startsWith('🟢 tsugimori ') && text.includes('🖥 System'),
      ),
    );
    assert.ok(Array.isArray(statusEntities));
    assert.deepEqual(statusEntities[0], {
      type: 'bold',
      offset: '🟢 '.length,
      length: 'tsugimori'.length,
    });
    assert.ok(replies.includes('Usage: /compact'));
    assert.equal(replies.length, 4);
    assert.equal(
      store.getMessage({ adapterId, chatId: `${newGroup.id}_12` }, '6')?.text,
      '/compact@otherbot',
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
    const failedSpan = spans.find(
      ({ name, status, attrs }) =>
        name === 'platform.commands' &&
        status === 'error' &&
        attrs.scope === 'default',
    );
    assert.equal(failedSpan?.attrs.error, failure?.error);
    assert.equal(failedSpan?.attrs.code, 400);
  },
);

test(
  'Telegram upgrades carry conversation state, pending approvals, and running schedules',
  { timeout: 8_000 },
  async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-chat-upgrade-'));
    const store = new SqliteStore(':memory:');
    const adapterId = 'telegram:test';
    const bot = { id: 42, username: 'testbot' };
    const owner = 79;
    const ref = (chatId: string) => ({ adapterId, chatId });
    const old = ref('-77');
    const next = ref('-10077');
    const apiOld = ref('-78');
    const apiNext = ref('-10078');
    const principal = { adapterId, userId: String(owner), display: 'Owner' };
    const messages = (chatId: string) =>
      store.listChatMessages(ref(chatId)).map(({ text }) => text);
    const seedHistory = (chat: typeof old, text: string) =>
      store.recordInbound(
        { ...chat, kind: 'group', title: 'Original group' },
        principal,
        {
          ...chat,
          direction: 'inbound',
          messageId: '5',
          raw: null,
          replyTo: null,
          threadId: null,
          text,
          userId: principal.userId,
        },
      )!;
    const history = seedHistory(old, 'Earlier history');
    seedHistory(apiOld, 'API group history');
    store.setAllowlisted(old, true);
    store.setAllowlisted(apiOld, true);
    store.saveSummary({
      ...store.beginSummary(old),
      text: 'Earlier summary',
      throughSeq: history.seq,
    });
    store.setSession({
      ...old,
      agentId: 'agent',
      model: 'model',
      sessionId: 'session',
      seenAfter: [],
      throughSeq: history.seq,
    });
    const at = Date.now() + 2_000;
    const reminder: ScheduleRecord = {
      ...old,
      id: 'original-schedule',
      action: { kind: 'message', text: 'Migrated reminder' },
      address: { chatId: old.chatId },
      target: { chatId: old.chatId },
      createdBy: principal.userId,
      deliveryApprovedBy: principal.userId,
      mentions: [],
      missed: 'latest',
      nextDueAt: at,
      status: 'active',
      timezone: 'UTC',
      trigger: { kind: 'interval', at, minutes: 60 },
    };
    const apiReminder: ScheduleRecord = {
      ...reminder,
      ...apiOld,
      address: { chatId: apiOld.chatId },
      target: { chatId: apiOld.chatId },
      id: 'api-schedule',
      action: { kind: 'message', text: 'API reminder' },
    };
    assert.ok(store.createSchedule(reminder, 20));
    assert.ok(store.createSchedule(apiReminder, 20));
    const crossChat: ScheduleRecord = {
      ...apiReminder,
      id: 'cross-chat-schedule',
      status: 'paused',
      target: reminder.target,
    };
    assert.ok(store.createSchedule(crossChat, 20));
    store.createTask({
      ...old,
      id: 'request-task',
      agentId: null,
      model: null,
      status: 'completed',
      createdAt: at - 1_000,
      startedAt: at - 1_000,
      finishedAt: at - 1_000,
      sourceMessageId: history.messageId,
    });
    const scheduledAt = at + 60_000;
    const pending: ScheduleRecord = {
      ...reminder,
      id: 'pending-schedule',
      deliveryApprovedBy: null,
      nextDueAt: scheduledAt,
      trigger: { kind: 'once', at: scheduledAt },
    };
    const auth = new Auth({ store, configuredOwner: () => principal.userId });
    const approval = auth.createApproval(
      old,
      'request-task',
      principal.userId,
      {
        action: 'schedule.create',
        resource: {
          type: 'schedule',
          id: pending.id,
          deliveryKey: 'original-key',
        },
      },
      { continuation: { kind: 'schedule', change: { schedule: pending } } },
    );
    const prompt = 'Approve the schedule';
    store.recordOutbound({
      ...old,
      direction: 'outbound',
      messageId: '9',
      userId: null,
      raw: null,
      replyTo: '5',
      threadId: null,
      text: prompt,
    });
    store.linkApproval(approval.id, '9');

    const updates: unknown[] = [];
    const sends: {
      chat_id: string;
      reply_parameters?: unknown;
      text: string;
    }[] = [];
    const reactions: unknown[] = [];
    const ok = (result: unknown) => Response.json({ ok: true, result });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const method = new URL(String(input)).pathname.split('/').at(-1);
      if (method === 'getMe') return ok(bot);
      if (method === 'getUpdates') {
        await delay(5, undefined, { signal: init?.signal ?? undefined });
        return ok(updates.splice(0));
      }
      assert.equal(typeof init?.body, 'string');
      const body = JSON.parse(String(init?.body));
      if (method === 'setMessageReaction') reactions.push(body);
      if (method !== 'sendMessage') return ok(true);
      sends.push(body);
      if (body.chat_id === apiOld.chatId)
        return Response.json(
          {
            ok: false,
            error_code: 400,
            parameters: { migrate_to_chat_id: Number(apiNext.chatId) },
          },
          { status: 400 },
        );
      return ok({ message_id: 100 + sends.length });
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
      log: () => undefined,
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
    await writeFile(
      join(workspace, 'tsugimori.json'),
      JSON.stringify({
        owner: { [adapterId]: principal.userId },
        platforms: [
          { id: adapterId, kind: 'telegram', tokenEnv: 'TEST_TOKEN' },
        ],
      }),
    );
    const deliver = async (update: object) => {
      const updateId = store.getCursor(adapterId, String(bot.id))?.offset ?? 1;
      updates.push({ update_id: updateId, ...update });
      while (
        store.getCursor(adapterId, String(bot.id))?.offset !==
        updateId + 1
      )
        await delay(5, undefined, { signal: t.signal });
      await gateway.idle();
    };
    const group = { id: Number(old.chatId), type: 'group' };
    const supergroup = { id: Number(next.chatId), type: 'supergroup' };
    await gateway.start();
    await deliver({
      message: {
        chat: group,
        from: { id: owner },
        message_id: 7,
        migrate_to_chat_id: supergroup.id,
      },
    });
    assert.equal(store.getSummary(next)?.text, 'Earlier summary');
    assert.equal(
      store.getSession(next, 'agent', 'model')?.sessionId,
      'session',
    );
    assert.equal(
      store.getSession(next, 'agent', 'model')?.scopeChatId,
      old.chatId,
    );
    assert.equal(store.getMessage(next, history.messageId)?.seq, history.seq);
    assert.deepEqual(store.getSchedule(reminder.id), {
      ...reminder,
      ...next,
      address: { chatId: next.chatId },
      target: { chatId: next.chatId },
    });
    assert.deepEqual(store.getSchedule(crossChat.id), {
      ...crossChat,
      target: { chatId: next.chatId },
    });
    await deliver({
      message: {
        chat: supergroup,
        from: { id: 80 },
        message_id: 5,
        text: 'Native message with the same ID',
      },
    });
    await deliver({
      message: {
        chat: group,
        from: { id: 80 },
        message_id: 6,
        text: 'Late old-chat message',
      },
    });
    assert.ok(messages(next.chatId).includes('Earlier history'));
    assert.ok(
      messages(next.chatId).includes('Native message with the same ID'),
    );
    assert.ok(messages(next.chatId).includes('Late old-chat message'));
    assert.deepEqual(messages(old.chatId), []);

    const migratedApproval = store.getApproval(approval.id)!;
    assert.equal(migratedApproval.chatId, next.chatId);
    assert.ok(migratedApproval.promptMessageId);
    assert.notEqual(migratedApproval.promptMessageId, '9');
    assert.ok(
      sends.some(
        ({ chat_id, text }) => chat_id === next.chatId && text === prompt,
      ),
    );
    await deliver({
      callback_query: {
        id: 'approve-request',
        from: { id: owner },
        message: {
          chat: supergroup,
          message_id: Number(migratedApproval.promptMessageId),
        },
        data: approvalCallbackId(approval.id, 'approve'),
      },
    });
    assert.deepEqual(store.getSchedule(pending.id), {
      ...pending,
      ...next,
      address: { chatId: next.chatId },
      target: { chatId: next.chatId },
      deliveryApprovedBy: principal.userId,
    });
    assert.deepEqual(reactions, []);
    assert.ok(
      sends.some(
        ({ chat_id, text, reply_parameters }) =>
          chat_id === next.chatId &&
          text.includes('was created') &&
          reply_parameters === undefined,
      ),
    );

    while (
      store.getSchedule(apiReminder.id)?.target.chatId !== apiNext.chatId ||
      !sends.some(({ text }) => text.endsWith('Migrated reminder')) ||
      !sends.some(
        ({ chat_id, text }) =>
          chat_id === apiNext.chatId && text.endsWith('API reminder'),
      )
    )
      await delay(10, undefined, { signal: t.signal });
    const targets = (text: string) =>
      sends
        .filter((sent) => sent.text.endsWith(text))
        .map(({ chat_id }) => chat_id);
    assert.deepEqual(targets('Migrated reminder'), [next.chatId]);
    assert.deepEqual(targets('API reminder'), [apiOld.chatId, apiNext.chatId]);
    assert.deepEqual(store.getSchedule(apiReminder.id), {
      ...apiReminder,
      ...apiNext,
      address: { chatId: apiNext.chatId },
      target: { chatId: apiNext.chatId },
      nextDueAt: at + 60 * 60_000,
    });
  },
);

test(
  'Telegram menus follow group migrations and resume unavailable scopes after a fresh message',
  { timeout: 8_000 },
  async (t) => {
    const workspace = await mkdtemp(
      join(tmpdir(), 'tsugimori-command-recovery-'),
    );
    const dbPath = join(workspace, 'store.db');
    let store = new SqliteStore(dbPath);
    const adapterId = 'telegram:test';
    const bot = { id: 42, username: 'ExampleBot' };
    const owner = 79;
    const apiSource = -301;
    const updateToSource = -302;
    const updateFromSource = -303;
    const supergroup = (id: number) => -1_000_000_000_000 + id;
    const kicked = -401;
    const missing = -402;
    const notMember = -403;
    const rejected = new Map([
      [
        kicked,
        {
          code: 403,
          description: 'Forbidden: bot was kicked from the group chat',
        },
      ],
      [missing, { code: 400, description: 'Bad Request: chat not found' }],
      [
        notMember,
        {
          code: 400,
          description: 'Bad Request: user is not a member of the chat',
        },
      ],
    ]);
    const ref = (chatId: number) => ({ adapterId, chatId: String(chatId) });
    const route = { agentId: 'selected', model: 'chosen' };
    const recordGroup = (id: number, kind: 'group' | 'supergroup') => {
      const chat = ref(id);
      store.recordInbound(
        { ...chat, kind, title: 'Earlier group' },
        { adapterId, userId: String(owner), display: null },
        {
          ...chat,
          direction: 'inbound',
          messageId: '100',
          raw: null,
          replyTo: null,
          text: 'Earlier message',
          threadId: null,
          userId: String(owner),
        },
      );
    };
    for (const id of [apiSource, updateToSource, updateFromSource]) {
      recordGroup(id, 'group');
      store.setAllowlisted(ref(id), true);
      store.setChatRoute(ref(id), route);
      store.setWorkspaceSettings(ref(id), { thinking: 'high' });
    }
    const existingDestination = ref(supergroup(updateFromSource));
    recordGroup(supergroup(updateFromSource), 'supergroup');
    store.setAllowlisted(existingDestination, false);
    store.setChatRoute(existingDestination, { model: 'destination-model' });
    for (const id of rejected.keys()) recordGroup(id, 'group');

    const requests: number[] = [];
    const updates: unknown[] = [];
    const logs: Parameters<Logger>[0][] = [];
    const ok = (result: unknown) => Response.json({ ok: true, result });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const method = new URL(String(input)).pathname.split('/').at(-1);
      if (method === 'getMe') return ok(bot);
      if (method === 'getUpdates') {
        await delay(10, undefined, { signal: init?.signal ?? undefined });
        return ok(updates.splice(0));
      }
      assert.ok(method === 'setMyCommands' || method === 'deleteMyCommands');
      assert.ok(typeof init?.body === 'string');
      const { scope } = JSON.parse(init.body);
      if (scope.type !== 'chat_member') return ok(true);
      const id = Number(scope.chat_id);
      requests.push(id);
      if (id === apiSource)
        return Response.json(
          {
            ok: false,
            error_code: 400,
            description:
              'Bad Request: group chat was upgraded to a supergroup chat',
            parameters: { migrate_to_chat_id: supergroup(id) },
          },
          { status: 400 },
        );
      const error = rejected.get(id);
      return error
        ? Response.json(
            {
              ok: false,
              error_code: error.code,
              description: error.description,
            },
            { status: error.code },
          )
        : ok(true);
    };
    const registry = new PluginRegistry([
      {
        name: 'test-telegram',
        adapters: {
          telegram: ({ id }) => new TelegramAdapter({ fetch }, id, '1:fake'),
        },
      },
    ]);
    const createGateway = () =>
      new Gateway({
        log: (entry) => logs.push(entry),
        registry,
        store,
        workspace,
      });
    let gateway = createGateway();
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
    const configure = (locale: 'en' | 'zh-TW') =>
      writeFile(
        join(workspace, 'tsugimori.json'),
        JSON.stringify({
          locale,
          owner: { [adapterId]: String(owner) },
          platforms: [
            { id: adapterId, kind: 'telegram', tokenEnv: 'TEST_TOKEN' },
          ],
        }),
      );
    let updateId = 0;
    const deliver = async (
      id: number,
      type: 'group' | 'supergroup',
      fields: object = {},
      edited = false,
    ) => {
      ++updateId;
      updates.push({
        update_id: updateId,
        [edited ? 'edited_message' : 'message']: {
          chat: { id, type, title: 'Upgraded group' },
          from: { id: owner },
          message_id: updateId,
          text: '',
          ...fields,
        },
      });
      await until(
        () =>
          store.getCursor(adapterId, String(bot.id))?.offset === updateId + 1,
      );
      await gateway.idle();
    };
    const assertMigrated = (
      id: number,
      allowlisted = true,
      model = route.model,
    ) => {
      const destination = ref(supergroup(id));
      assert.equal(
        store.getChat(ref(id))?.migratedToChatId,
        destination.chatId,
      );
      const chat = store.getChat(destination);
      assert.equal(chat?.kind, 'supergroup');
      assert.equal(chat.allowlisted, allowlisted);
      assert.equal(chat.agentId, route.agentId);
      assert.equal(chat.model, model);
      assert.deepEqual(store.getWorkspaceSettings(destination), {
        thinking: 'high',
      });
    };

    await configure('en');
    await gateway.start();
    await gateway.idle();
    assert.deepEqual(
      requests.splice(0).sort(),
      [
        apiSource,
        updateToSource,
        updateFromSource,
        supergroup(apiSource),
        supergroup(updateFromSource),
        kicked,
        missing,
        notMember,
      ].sort(),
      JSON.stringify(
        logs.filter(({ event }) => event === 'platform.commands_failed'),
      ),
    );
    assertMigrated(apiSource);
    assert.ok(
      logs.some(
        (entry) =>
          entry.event === 'platform.commands_failed' &&
          entry.chatId === String(apiSource) &&
          entry.migratedToChatId === String(supergroup(apiSource)) &&
          entry.code === 400,
      ),
    );

    await deliver(updateToSource, 'group', {
      migrate_to_chat_id: supergroup(updateToSource),
    });
    assert.deepEqual(requests.splice(0), [supergroup(updateToSource)]);
    assertMigrated(updateToSource);
    assert.equal(
      store.getMessage(ref(supergroup(updateToSource)), '1')?.text,
      '',
    );
    await deliver(supergroup(updateFromSource), 'supergroup', {
      from: undefined,
      migrate_from_chat_id: updateFromSource,
    });
    assertMigrated(updateFromSource, false, 'destination-model');
    store.setAllowlisted(ref(supergroup(updateToSource)), false);
    await deliver(supergroup(updateToSource), 'supergroup', {
      migrate_from_chat_id: updateToSource,
    });
    assertMigrated(updateToSource, false);
    await deliver(apiSource, 'group', { text: 'Queued before migration' });
    await deliver(kicked, 'group', { message_id: 100 }, true);
    assert.deepEqual(requests.splice(0), []);

    await configure('zh-TW');
    await until(() => logs.some(({ event }) => event === 'config.reloaded'));
    await gateway.idle();
    const expected = [apiSource, updateToSource, updateFromSource]
      .map(supergroup)
      .sort();
    assert.deepEqual(requests.splice(0).sort(), expected);

    await gateway.stop();
    store.close();
    store = new SqliteStore(dbPath);
    gateway = createGateway();
    await gateway.start();
    await gateway.idle();
    assert.deepEqual(requests.splice(0).sort(), expected);
    for (const id of [kicked, missing, notMember]) {
      rejected.delete(id);
      await deliver(id, 'group', { text: 'Back in the group' });
      assert.deepEqual(requests.splice(0), [id]);
    }
  },
);
