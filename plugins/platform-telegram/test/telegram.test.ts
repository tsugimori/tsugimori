import type { AdapterCursor, InboundEvent } from '@tsugimori/plugin-sdk';

import { SendFailure } from '@tsugimori/plugin-sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { splitText, TelegramAdapter } from '../src/index.ts';

function ok(result: unknown) {
  return Response.json({ ok: true, result });
}

function longPoll(init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else
      signal?.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
  });
}

const chat = { id: -1001, title: 'forum', type: 'supergroup' };
const address = { chat, is_topic_message: true, message_thread_id: 17 };
const me = { id: 42, username: 'ExampleBot' };
const from = { id: 79, first_name: 'Example sender' };

test(
  'long polling maps Telegram updates and resumes the bot-scoped cursor',
  { timeout: 4_000 },
  async (t) => {
    const polls: Record<string, unknown>[] = [];
    const resumed = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    const updates = [
      {
        update_id: 10,
        message: {
          ...address,
          from: { ...from, username: 'ExampleUser' },
          message_id: 21,
          caption: '😀 @EXAMPLEBOT',
          caption_entities: [{ type: 'mention', offset: 3, length: 11 }],
          via_bot: { id: 90 },
          reply_to_message: { message_id: 9, from: { id: 88 } },
        },
      },
      {
        update_id: 11,
        edited_message: {
          ...address,
          from,
          message_id: 21,
          text: 'edited',
          entities: [{ type: 'text_mention', user: me }],
        },
      },
      {
        update_id: 12,
        message: {
          chat: { id: 79, type: 'private' },
          from,
          message_id: 22,
          text: 'answer',
          reply_to_message: { message_id: 10, from: me },
        },
      },
      {
        update_id: 13,
        callback_query: {
          from: { ...from, username: 'example_sender' },
          id: 'query-1',
          data: 'approval:once:test-id',
          message: { ...address, message_id: 23 },
        },
      },
    ];
    const fakeFetch: typeof fetch = (input, init) => {
      if (String(input).endsWith('/getMe')) return Promise.resolve(ok(me));
      assert.ok(String(input).endsWith('/getUpdates'));
      assert.ok(typeof init?.body === 'string');
      polls.push(JSON.parse(init.body));
      if (polls.length === 1) return Promise.resolve(ok(updates));
      if (polls.length === 2) received.resolve();
      if (polls.length === 3) resumed.resolve();
      return longPoll(init);
    };
    const adapter = new TelegramAdapter({ fetch: fakeFetch }, 'tg', '1:fake');
    t.after(() => adapter.stop());
    const events: InboundEvent[] = [];
    let cursor: AdapterCursor | undefined;
    const context = {
      emit(event: InboundEvent) {
        events.push(event);
        return Promise.resolve();
      },
      loadCursor(stream: string) {
        assert.equal(stream, '42');
        return cursor;
      },
      saveCursor(stream: string, value: AdapterCursor) {
        assert.equal(stream, '42');
        cursor = value;
      },
    };
    const ready = Promise.withResolvers<void>();
    await adapter.start({ ...context, ready: ready.promise });
    assert.equal(polls.length, 0);
    ready.resolve();
    await received.promise;
    assert.deepEqual(polls[0], {
      timeout: 50,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
    });
    assert.equal(polls[1]?.offset, 14);
    assert.deepEqual(
      events.map((event) => [event.type, event.chatId, event.threadId]),
      [
        ['message', '-1001', '17'],
        ['message', '-1001', '17'],
        ['message', '79', undefined],
        ['callback', '-1001', '17'],
      ],
    );
    const [first, edit, reply, callback] = events;
    assert.equal(first?.type, 'message');
    assert.equal(first.chatKind, 'supergroup');
    assert.equal(first.userId, '79');
    assert.equal(first.userUsername, 'ExampleUser');
    assert.equal(first.text, '😀 @EXAMPLEBOT');
    assert.equal(first.replyTo, '9');
    assert.equal(first.mentionsBot, true);
    assert.equal(edit?.type, 'message');
    assert.equal(edit.edited, true);
    assert.equal(edit.userUsername, null);
    assert.equal(edit.text, 'edited');
    assert.equal(edit.mentionsBot, true);
    assert.equal(reply?.type, 'message');
    assert.equal(reply.chatKind, 'dm');
    assert.equal(reply.repliesToBot, true);
    assert.equal(callback?.type, 'callback');
    assert.equal(callback.callbackId, 'approval:once:test-id');
    assert.equal(callback.queryId, 'query-1');
    assert.equal(callback.userUsername, 'example_sender');
    assert.equal(callback.userDisplay, 'Example sender');
    assert.equal(adapter.capabilities.deleteEvents, false);
    await adapter.stop();
    await adapter.start(context);
    await resumed.promise;
    assert.equal(polls[2]?.offset, 14);
    assert.equal(events.length, 4);
  },
);

test(
  'sends plain-text reply parts with receipts and retries only known rejections',
  { timeout: 4_000 },
  async (t) => {
    const sent: Record<string, unknown>[] = [];
    let uncertain = false;
    const fakeFetch: typeof fetch = async (input, init) => {
      const method = String(input).split('/').at(-1);
      if (method === 'getMe') return ok(me);
      if (method === 'getUpdates') return longPoll(init);
      assert.equal(method, 'sendMessage');
      assert.ok(typeof init?.body === 'string');
      sent.push(JSON.parse(init.body));
      if (sent.length === 1)
        return Response.json(
          {
            ok: false,
            error_code: 429,
            parameters: { retry_after: 0 },
          },
          { status: 429 },
        );
      if (uncertain && sent.length === 5)
        throw new TypeError('ambiguous fake network failure');
      return ok({ message_id: sent.length });
    };
    const adapter = new TelegramAdapter({ fetch: fakeFetch }, 'tg', '1:fake');
    t.after(() => adapter.stop());
    await adapter.start({ emit: () => Promise.resolve() });
    const first = 'markdown **unchanged**' + 'a'.repeat(3_980) + '\n\n';
    const remainder = 'b'.repeat(110);
    const message = {
      chatId: '-1001',
      threadId: '17',
      replyTo: '21',
      text: first + remainder,
    };
    const receipt = await adapter.send({
      ...message,
      buttons: [{ id: 'approval:once:test-id', label: 'Approve' }],
    });
    assert.equal(receipt.messageId, '2');
    assert.deepEqual(
      receipt.parts?.map((part) => part.text),
      [first, remainder],
    );
    assert.deepEqual(sent[1], sent[0]);
    assert.deepEqual(sent[1], {
      chat_id: '-1001',
      message_thread_id: 17,
      text: first,
      reply_parameters: { message_id: 21, allow_sending_without_reply: true },
      reply_markup: {
        inline_keyboard: [
          [{ callback_data: 'approval:once:test-id', text: 'Approve' }],
        ],
      },
    });
    assert.equal(sent[2]?.reply_markup, undefined);
    assert.equal(sent[2]?.message_thread_id, 17);
    assert.deepEqual(splitText('z'.repeat(4095) + '😀'), [
      'z'.repeat(4095),
      '😀',
    ]);
    uncertain = true;
    await assert.rejects(adapter.send(message), (error) => {
      assert.ok(error instanceof SendFailure);
      assert.equal(error.deliveryUnknown, true);
      assert.deepEqual(
        error.parts.map((part) => part.messageId),
        ['4'],
      );
      return true;
    });
    assert.equal(sent.length, 5);
  },
);

test(
  'retries a rejected Markdown chunk once with stripped text and no entities',
  { timeout: 4_000 },
  async (t) => {
    const sent: Record<string, unknown>[] = [];
    const warnings: string[] = [];
    const rejected = (description: string) =>
      Response.json(
        { ok: false, error_code: 400, description },
        { status: 400 },
      );
    const fakeFetch: typeof fetch = async (input, init) => {
      const method = String(input).split('/').at(-1);
      if (method === 'getMe') return ok(me);
      if (method === 'getUpdates') return longPoll(init);
      assert.equal(method, 'sendMessage');
      assert.ok(typeof init?.body === 'string');
      const body = JSON.parse(init.body);
      sent.push(body);
      assert.equal(body.parse_mode, undefined);
      if (body.text === 'Other 400')
        return rejected('Bad Request: chat not found');
      if (body.entities || body.text === 'Second failure')
        return rejected("Bad Request: can't parse entities: bad offset");
      return ok({ message_id: sent.length });
    };
    const adapter = new TelegramAdapter({ fetch: fakeFetch }, 'tg', '1:fake');
    t.after(() => adapter.stop());
    await adapter.start({
      emit: () => Promise.resolve(),
      logWarning: (event) => warnings.push(event),
    });
    const first = 'x'.repeat(4094) + '\n\n';
    const message = {
      chatId: '-1001',
      format: 'markdown',
      replyTo: '21',
      threadId: '17',
    } as const;
    const receipt = await adapter.send({
      ...message,
      text: first + '**70%** [weather](https://example.test)',
    });
    assert.deepEqual(
      receipt.parts?.map(({ messageId, text }) => ({ messageId, text })),
      [
        { messageId: '1', text: first },
        { messageId: '3', text: '70% weather' },
      ],
    );
    assert.deepEqual(sent[1]?.entities, [
      { type: 'bold', offset: 0, length: 3 },
      { type: 'text_link', offset: 4, length: 7, url: 'https://example.test' },
    ]);
    assert.deepEqual(sent[2], {
      chat_id: '-1001',
      message_thread_id: 17,
      reply_parameters: { message_id: 21, allow_sending_without_reply: true },
      text: '70% weather',
    });
    assert.deepEqual(warnings, ['telegram.entities_rejected']);
    for (const text of ['**Other 400**', '**Second failure**']) {
      await assert.rejects(adapter.send({ ...message, text }), (error) => {
        assert.ok(error instanceof SendFailure);
        assert.equal(error.deliveryUnknown, false);
        assert.deepEqual(error.parts, []);
        return true;
      });
    }
    assert.deepEqual(
      sent.slice(3).map(({ text, entities }) => [text, Boolean(entities)]),
      [
        ['Other 400', true],
        ['Second failure', true],
        ['Second failure', false],
      ],
    );
    assert.deepEqual(warnings, [
      'telegram.entities_rejected',
      'telegram.entities_rejected',
    ]);
  },
);

test(
  'renders native IDs as current @usernames or UTF-16 text mentions',
  { timeout: 4_000 },
  async (t) => {
    const sent: Record<string, unknown>[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const method = String(input).split('/').at(-1);
      if (method === 'getMe') return ok(me);
      if (method === 'getUpdates') return longPoll(init);
      assert.equal(method, 'sendMessage');
      assert.ok(typeof init?.body === 'string');
      sent.push(JSON.parse(init.body));
      return ok({ message_id: sent.length });
    };
    const adapter = new TelegramAdapter({ fetch: fakeFetch }, 'tg', '1:fake');
    t.after(() => adapter.stop());
    let username: string | null = null;
    await adapter.start({
      emit: () => Promise.resolve(),
      getUser: (userId) =>
        userId === '79' ? { display: 'First 👋', username } : undefined,
    });
    const first = '😀 **literal** @example_user [other](https://example.com) ';
    const name = 'First 👋';
    const padding = 'x'.repeat(4094 - first.length - name.length);
    const receipt = await adapter.send({
      chatId: '-1001',
      text:
        first +
        '[First 👋](tg://user?id=79)' +
        padding +
        '[第二位 😀](tg://user?id=80)!',
      mentions: ['79', '81'],
    });
    assert.deepEqual(
      [...sent],
      [
        {
          chat_id: '-1001',
          text: first + name + padding,
          entities: [
            {
              type: 'text_mention',
              offset: first.length,
              length: name.length,
              user: { id: 79 },
            },
          ],
        },
        {
          chat_id: '-1001',
          text: '第二位 😀!\n\nuser 81',
          entities: [
            { type: 'text_mention', offset: 0, length: 6, user: { id: 80 } },
            { type: 'text_mention', offset: 9, length: 7, user: { id: 81 } },
          ],
        },
      ],
    );
    assert.deepEqual(
      receipt.parts?.map(({ text }) => text),
      sent.map(({ text }) => text),
    );
    sent.length = 0;
    username = 'current_user';
    await adapter.send({
      chatId: '-1001',
      text: '請[原稿](tg://user?id=79)記得喝水。',
    });
    await adapter.send({ chatId: '-1001', text: '提醒', mentions: ['79'] });
    assert.deepEqual(
      [...sent],
      [
        { chat_id: '-1001', text: '請 @current_user 記得喝水。' },
        { chat_id: '-1001', text: '提醒\n\n@current_user' },
      ],
    );
    sent.length = 0;
    const prefix = '提醒😀 ';
    const reminder = prefix + '月光 👋，記得喝水。\n**原樣送出**';
    await adapter.send({
      chatId: '-1001',
      text: reminder,
      entities: [
        { type: 'mention', offset: 5, length: 5, userId: '1234567890123' },
      ],
    });
    const header = '🔔 需要你同意：排程提醒\n內容：\n';
    await adapter.send({
      chatId: '-1001',
      text: header + reminder,
      entities: [
        { type: 'pre', offset: header.length, length: reminder.length },
      ],
    });
    assert.deepEqual(
      [...sent],
      [
        {
          chat_id: '-1001',
          text: reminder,
          entities: [
            {
              type: 'text_mention',
              offset: 5,
              length: 5,
              user: { id: 1234567890123 },
            },
          ],
        },
        {
          chat_id: '-1001',
          text: header + reminder,
          entities: [
            { type: 'pre', offset: header.length, length: reminder.length },
          ],
        },
      ],
    );
    sent.length = 0;
    username = 'renamed_user';
    const reminderWithBoth = '😀 月光 👋，請提醒 小林。';
    await adapter.send({
      chatId: '-1001',
      text: reminderWithBoth,
      entities: [
        { type: 'mention', offset: 3, length: 5, userId: '79' },
        {
          type: 'mention',
          offset: reminderWithBoth.indexOf('小林'),
          length: 2,
          userId: '80',
        },
      ],
    });
    const delivered = '😀 @renamed_user，請提醒 小林。';
    assert.deepEqual(
      [...sent],
      [
        {
          chat_id: '-1001',
          text: delivered,
          entities: [
            {
              type: 'text_mention',
              offset: delivered.indexOf('小林'),
              length: 2,
              user: { id: 80 },
            },
          ],
        },
      ],
    );
    const recipientLine = '🔔 對象：';
    const prompt = recipientLine + '@月光\n內容：\n';
    const approvalWithMention = await adapter.send({
      approval: true,
      chatId: '-1001',
      text: prompt + reminder,
      entities: [
        {
          type: 'mention',
          offset: recipientLine.length,
          length: 3,
          userId: '79',
        },
        { type: 'pre', offset: prompt.length, length: reminder.length },
      ],
    });
    const renderedPrompt = recipientLine + '@renamed_user\n內容：\n';
    const pre = {
      type: 'pre',
      offset: renderedPrompt.length,
      length: reminder.length,
    };
    assert.deepEqual(approvalWithMention.approvalEntities, [pre]);
    assert.deepEqual(sent.at(-1), {
      chat_id: '-1001',
      text: renderedPrompt + reminder,
      entities: [pre],
    });
    sent.length = 0;
    const long = '🌙'.repeat(2200) + '\n記得喝水';
    const approval = await adapter.send({
      approval: true,
      buttons: [{ id: 'approval:once:example', label: '同意' }],
      chatId: '-1001',
      entities: [{ type: 'pre', offset: header.length, length: long.length }],
      text: header + long,
    });
    assert.equal(approval.messageId, String(sent.length));
    assert.ok(sent.length > 1);
    assert.equal(sent.map(({ text }) => text).join(''), header + long);
    assert.equal(sent[0]?.reply_markup, undefined);
    assert.ok(sent.at(-1)?.reply_markup);
    assert.equal(
      sent
        .slice(1)
        .map(({ text, entities }) => {
          assert.deepEqual(entities, [
            { type: 'pre', offset: 0, length: (text as string).length },
          ]);
          return text;
        })
        .join(''),
      long,
    );
  },
);

test(
  'typing refreshes until cancelled and approval feedback answers before editing',
  { timeout: 4_000 },
  async (t) => {
    const calls: [string, Record<string, unknown>][] = [];
    const refreshed = Promise.withResolvers<void>();
    const fakeFetch: typeof fetch = async (input, init) => {
      const method = String(input).split('/').at(-1);
      assert.ok(method);
      if (method === 'getMe') return ok(me);
      if (method === 'getUpdates') return longPoll(init);
      assert.ok(typeof init?.body === 'string');
      calls.push([method, JSON.parse(init.body)]);
      if (calls.length === 2) refreshed.resolve();
      return ok(true);
    };
    const adapter = new TelegramAdapter(
      { fetch: fakeFetch, typingIntervalMs: 20 },
      'tg',
      '2:fake',
    );
    t.after(() => adapter.stop());
    await adapter.start({ emit: () => Promise.resolve() });
    const activity = new AbortController();
    adapter.typing({ chatId: '-1001', threadId: '17' }, activity.signal);
    assert.equal(calls[0]?.[0], 'sendChatAction');
    await Promise.race([refreshed.promise, delay(200)]);
    activity.abort();
    await adapter.respondToApproval({
      chatId: '-1001',
      messageId: '50',
      queryId: 'unauthorized',
      notice: '這項審核已無法處理。',
    });
    await adapter.respondToApproval({
      chatId: '-1001',
      messageId: '50',
      queryId: 'approved',
      decision: 'approve',
      decisionText: '✅ 已同意',
      notice: '✅ 已同意',
      prompt: '🔔 同意\n你好😀',
      pre: { offset: 6, length: 4 },
      entities: [
        { type: 'mention', offset: 3, length: 2, userId: '79' },
        { type: 'pre', offset: 6, length: 4 },
      ],
    });
    await adapter.respondToApproval({
      chatId: '-1001',
      messageId: '51',
      decision: 'expired',
      decisionText: '⌛ 已逾時',
      notice: '已逾時',
      prompt: '🔔 需要你同意',
    });
    await adapter.respondToApproval({
      chatId: '-1001',
      messageId: '51',
      decision: 'expired',
      queryId: 'late',
      notice: '已逾時',
    });
    await delay(30);
    assert.deepEqual(
      calls.map(([method]) => method),
      [
        'sendChatAction',
        'sendChatAction',
        'answerCallbackQuery',
        'answerCallbackQuery',
        'editMessageText',
        'editMessageText',
        'answerCallbackQuery',
      ],
    );
    assert.deepEqual(calls[0]?.[1], {
      chat_id: '-1001',
      message_thread_id: 17,
      action: 'typing',
    });
    assert.deepEqual(calls[2]?.[1], {
      callback_query_id: 'unauthorized',
      text: '這項審核已無法處理。',
    });
    assert.deepEqual(calls[4]?.[1], {
      chat_id: '-1001',
      message_id: 50,
      text: '🔔 同意\n你好😀\n\n✅ 已同意',
      entities: [
        { type: 'text_mention', offset: 3, length: 2, user: { id: 79 } },
        { type: 'pre', offset: 6, length: 4 },
      ],
      reply_markup: { inline_keyboard: [] },
    });
    assert.deepEqual(calls[5]?.[1], {
      chat_id: '-1001',
      message_id: 51,
      text: '🔔 需要你同意\n\n⌛ 已逾時',
      reply_markup: { inline_keyboard: [] },
    });
    assert.deepEqual(calls[6]?.[1], {
      callback_query_id: 'late',
      text: '已逾時',
    });
  },
);

test(
  'backs off after a polling network error and saves only processed updates',
  { timeout: 4_000 },
  async (t) => {
    const saved = Promise.withResolvers<number>();
    const logged: string[] = [];
    let polls = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/getMe')) return ok(me);
      if (++polls === 1) throw new TypeError('simulated reset');
      if (polls === 2)
        return ok([
          {
            update_id: 5,
            message: {
              chat: { id: 79, type: 'private' },
              from,
              message_id: 13,
              text: 'received',
            },
          },
        ]);
      return longPoll(init);
    };
    const adapter = new TelegramAdapter({ fetch: fakeFetch }, 'tg', '3:fake');
    t.after(() => adapter.stop());
    let delivered = false;
    await adapter.start({
      emit: async () => {
        delivered = true;
      },
      saveCursor(_stream, cursor) {
        assert.equal(delivered, true);
        saved.resolve(cursor.offset);
      },
      logError: (event) => logged.push(event),
    });
    assert.equal(await saved.promise, 6);
    assert.deepEqual(logged, ['telegram.poll_retry']);
  },
);
