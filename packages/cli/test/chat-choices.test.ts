import type { TestContext } from 'node:test';

import { Gateway, PluginRegistry } from '@tsugimori/core';
import { TelegramAdapter } from '@tsugimori/platform-telegram';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { AgentFactory } from '../../plugin-sdk/src/index.ts';

interface KeyboardButton {
  callback_data: string;
  text: string;
}

interface TelegramMessage {
  id: number;
  reply_markup?: { inline_keyboard: KeyboardButton[][] };
  text: string;
}

const adapterId = 'telegram-test';
const owner = 79;
const room = {
  chat: { id: -1001, type: 'supergroup' },
  is_topic_message: true,
  message_thread_id: 17,
};
const bot = { id: 42, username: 'botname' };
const model = 'model-' + 'abcdefghij'.repeat(10);

async function fixture(
  t: TestContext,
  models = ['one', 'two', 'three', 'four', model],
) {
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-chat-choices-'));
  const store = new SqliteStore(':memory:');
  const sent: TelegramMessage[] = [];
  const edits = new Map<number, TelegramMessage>();
  const answers = new Map<string, string | undefined>();
  const updates: Record<string, unknown>[] = [];
  const setupAnswers: string[] = [];
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
    switch (method) {
      case 'sendMessage': {
        const id = 1_000 + sent.length;
        sent.push({ ...body, id });
        return ok({ message_id: id });
      }
      case 'editMessageText':
        edits.set(body.message_id, { ...body, id: body.message_id });
        return ok(true);
      case 'answerCallbackQuery':
        answers.set(body.callback_query_id, body.text);
        return ok(true);
      default:
        assert.ok(
          ['deleteMessage', 'deleteMyCommands', 'setMyCommands'].includes(
            method ?? '',
          ),
          method,
        );
        return ok(true);
    }
  };
  const agent: AgentFactory = ({ id }) => ({
    id,
    kind: 'demo',
    loop: 'external',
    settings: { serviceTiers: true, thinking: ['low', 'high'] },
    ...(id === 'first' && {
      listModels: () => models,
    }),
    async *run() {
      assert.fail('These messages should be handled by commands and setup.');
    },
  });
  const registry = new PluginRegistry([
    {
      name: 'telegram',
      adapters: {
        telegram: ({ id }) => new TelegramAdapter({ fetch }, id, '1:fake'),
      },
    },
    {
      name: 'demo',
      agents: { demo: agent },
      setupSteps: [
        {
          id: 'login',
          title: 'Choose sign-in method',
          async run(ctx) {
            const method = await ctx.prompt({
              text: 'Reply login or token.',
              choices: [
                { value: 'login', label: 'Browser' },
                { value: 'token', label: 'Token' },
              ],
            });
            setupAnswers.push(method);
            if (method === 'token')
              await ctx.prompt({
                text: 'Enter the token.',
                secret: true,
                choices: [{ value: 'ignored', label: 'Ignored' }],
              });
            ctx.writeConfig({ entry: { enabled: false } });
          },
        },
      ],
    },
  ]);
  const gateway = new Gateway({ registry, store, workspace, log: () => {} });
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
      owner: { [adapterId]: String(owner) },
      platforms: [{ id: adapterId, kind: 'telegram', tokenEnv: 'TEST_TOKEN' }],
      agents: [
        { id: 'first', kind: 'demo' },
        { id: 'second', kind: 'demo' },
        { id: 'disabled', kind: 'demo', enabled: false },
      ],
    }),
  );
  await gateway.start();

  async function wait<T>(read: () => T | undefined): Promise<T> {
    let found: T | undefined;
    while ((found = read()) === undefined)
      await delay(5, undefined, { signal: t.signal });
    return found;
  }
  let updateId = 0;
  async function deliver(payload: Record<string, unknown>) {
    const id = ++updateId;
    updates.push({ ...payload, update_id: id });
    await wait(
      () =>
        store.getCursor(adapterId, String(bot.id))?.offset === id + 1 ||
        undefined,
    );
  }
  return {
    setupAnswers,
    sent,
    store,
    async say(text: string, replyTo?: number, dm = false) {
      await deliver({
        message: {
          ...(dm ? { chat: { id: owner, type: 'private' } } : room),
          from: { id: owner },
          message_id: updateId + 1,
          reply_to_message:
            replyTo === undefined
              ? undefined
              : { message_id: replyTo, from: bot },
          text,
        },
      });
    },
    async press(id: number, button: KeyboardButton, user = owner, thread = 17) {
      const query = 'query-' + (updateId + 1);
      await deliver({
        callback_query: {
          id: query,
          data: button.callback_data,
          from: { id: user },
          message: { ...room, message_thread_id: thread, message_id: id },
        },
      });
      assert.ok(answers.has(query), 'Telegram receives answerCallbackQuery');
      return answers.get(query);
    },
    prompt: (part: string, start = 0) =>
      wait(() => sent.slice(start).find(({ text }) => text.includes(part))),
    edit: (id: number) => wait(() => edits.get(id)),
    hasEdit: (id: number) => edits.has(id),
  };
}

function buttons(message: TelegramMessage, labels: string[]) {
  const choices = message.reply_markup?.inline_keyboard.flat();
  assert.ok(choices);
  assert.deepEqual(
    choices.map(({ text }) => text),
    labels,
  );
  for (const { callback_data } of choices) {
    assert.ok(Buffer.byteLength(callback_data) <= 64);
    assert.match(callback_data, /^choice:[a-f0-9]+$/);
  }
  return choices;
}

test(
  'Telegram setup accepts buttons and typed replies and retires answered, cancelled and expired keyboards',
  { timeout: 6_000 },
  async (t) => {
    const f = await fixture(t);
    const expire = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    let expirePrompt = false;
    t.mock.method(AbortSignal, 'timeout', (ms: number) =>
      ms === 600_000 && expirePrompt ? expire.signal : timeout(ms),
    );

    await f.say('/add');
    const categories = await f.prompt('Usage: /add');
    const [agent] = buttons(categories, ['Agent', 'Platform']);
    await f.press(categories.id, agent!);
    assert.deepEqual((await f.edit(categories.id)).reply_markup, {
      inline_keyboard: [],
    });
    const kinds = await f.prompt('Choose a plugin for /add agent');
    const [demo] = buttons(kinds, ['demo']);
    await f.press(kinds.id, demo!);
    assert.match((await f.edit(kinds.id)).text, /\/add agent demo/);
    const name = await f.prompt('Enter the instance name');
    const [suggested] = buttons(name, ['demo']);
    await f.press(name.id, suggested!);
    assert.match((await f.edit(name.id)).text, /Selected: demo/);

    const method = await f.prompt('Reply login or token');
    const [browser, token] = buttons(method, ['Browser', 'Token']);
    const unavailable = 'This selection is unavailable.';
    assert.equal(await f.press(method.id, token!, owner + 1), unavailable);
    assert.equal(await f.press(method.id, token!, owner, 18), unavailable);
    assert.equal(await f.press(method.id + 1, token!), unavailable);
    assert.deepEqual(f.setupAnswers, []);
    assert.equal(f.hasEdit(method.id), false);

    assert.equal(await f.press(method.id, token!), undefined);
    const selected = await f.edit(method.id);
    assert.match(selected.text, /Selected: Token/);
    assert.deepEqual(selected.reply_markup, { inline_keyboard: [] });
    assert.equal(await f.press(method.id, browser!), unavailable);
    assert.deepEqual(f.setupAnswers, ['token']);
    const secret = await f.prompt('Enter the token');
    assert.equal(secret.reply_markup, undefined);
    await f.say('synthetic-setup-value', secret.id, true);
    await f.prompt('demo signed in. It is disabled');

    let start = f.sent.length;
    await f.say('/add agent demo --id typed');
    const typed = await f.prompt('Reply login or token', start);
    const [typedBrowser] = buttons(typed, ['Browser', 'Token']);
    await f.say('login', typed.id);
    assert.match((await f.edit(typed.id)).text, /Selected: Browser/);
    assert.deepEqual((await f.edit(typed.id)).reply_markup, {
      inline_keyboard: [],
    });
    assert.equal(await f.press(typed.id, typedBrowser!), unavailable);
    assert.deepEqual(f.setupAnswers, ['token', 'login']);
    await f.prompt('typed signed in. It is disabled');

    start = f.sent.length;
    await f.say('/add agent demo --id cancelled');
    const cancelled = await f.prompt('Reply login or token', start);
    const [cancelledBrowser] = buttons(cancelled, ['Browser', 'Token']);
    await f.say('/cancel');
    assert.match((await f.edit(cancelled.id)).text, /Selection cancelled/);
    assert.deepEqual((await f.edit(cancelled.id)).reply_markup, {
      inline_keyboard: [],
    });
    assert.equal(await f.press(cancelled.id, cancelledBrowser!), unavailable);

    start = f.sent.length;
    expirePrompt = true;
    await f.say('/add agent demo --id expired');
    const expired = await f.prompt('Reply login or token', start);
    const [expiredBrowser] = buttons(expired, ['Browser', 'Token']);
    expire.abort();
    assert.match((await f.edit(expired.id)).text, /Selection expired/);
    assert.deepEqual((await f.edit(expired.id)).reply_markup, {
      inline_keyboard: [],
    });
    assert.equal(await f.press(expired.id, expiredBrowser!), unavailable);
    assert.deepEqual(f.setupAnswers, ['token', 'login']);
  },
);

test(
  'Telegram keeps all command choices reachable when a catalog spans pages',
  { timeout: 6_000 },
  async (t) => {
    const models = Array.from({ length: 105 }, (_, index) => `model-${index}`);
    const f = await fixture(t, models);
    await f.say('/model');
    const first = await f.prompt('Page 1 of 2');
    const next = buttons(first, [...models.slice(0, 80), 'Next']).at(-1)!;
    await f.press(first.id, next);
    assert.deepEqual((await f.edit(first.id)).reply_markup, {
      inline_keyboard: [],
    });
    const second = await f.prompt('Page 2 of 2');
    const [last] = buttons(second, [
      ...models.slice(80),
      'default',
      'Previous',
    ]).slice(-3);
    await f.press(second.id, last!);
    assert.equal((await f.edit(second.id)).text, 'Model set to model-104.');
  },
);

test(
  'Telegram command buttons run the same owner commands and show their results in place',
  { timeout: 6_000 },
  async (t) => {
    const f = await fixture(t);
    const chat = { adapterId, chatId: '-1001_17' };
    await f.say('/fast');
    const fast = await f.prompt('Fast: default (default)');
    const [on] = buttons(fast, ['on', 'off', 'default']);
    assert.match((await f.press(fast.id, on!, owner + 1)) ?? '', /unavailable/);
    assert.equal(f.store.getChat(chat)?.serviceTier, null);
    await f.press(fast.id, on!);
    assert.equal(f.store.getChat(chat)?.serviceTier, 'fast');
    assert.equal((await f.edit(fast.id)).text, 'Fast set to on.');
    assert.deepEqual((await f.edit(fast.id)).reply_markup, {
      inline_keyboard: [],
    });

    await f.say('/thinking');
    const thinking = await f.prompt('Effort: default (default)');
    const [, high] = buttons(thinking, ['low', 'high', 'default']);
    await f.say('/thinking high', thinking.id);
    assert.equal(f.store.getChat(chat)?.thinking, 'high');
    assert.equal((await f.edit(thinking.id)).text, 'Effort set to high.');
    assert.match((await f.press(thinking.id, high!)) ?? '', /unavailable/);

    await f.say('/model');
    const models = await f.prompt('Model: default (default)');
    const selected = buttons(models, [
      'one',
      'two',
      'three',
      'four',
      model,
      'default',
    ])[4]!;
    assert.equal(models.reply_markup?.inline_keyboard.length, 2);
    await f.press(models.id, selected);
    assert.equal(f.store.getChat(chat)?.model, model);
    assert.equal((await f.edit(models.id)).text, `Model set to ${model}.`);

    await f.say('/agent');
    const agents = await f.prompt('Agent: first (default)');
    const [, second] = buttons(agents, ['first', 'second']);
    await f.press(agents.id, second!);
    assert.equal(f.store.getChat(chat)?.agentId, 'second');
    assert.equal((await f.edit(agents.id)).text, 'Agent set to second.');
    const afterSwitch = f.sent.length;
    await f.say('/model');
    assert.equal(
      (await f.prompt(`Model: ${model} (this chat)`, afterSwitch)).reply_markup,
      undefined,
    );

    await f.say('/login');
    const login = await f.prompt('Usage: /login');
    const signIn = buttons(login, ['first', 'second', 'disabled'])[2]!;
    await f.press(login.id, signIn);
    assert.match((await f.edit(login.id)).text, /\/login disabled/);
    await f.prompt('Reply login or token');
    await f.say('/cancel');
  },
);
