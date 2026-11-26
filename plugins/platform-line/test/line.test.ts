import type {
  AdapterContext,
  InboundMessage,
  PluginInstanceConfig,
  SetupContext,
} from '@tsugimori/plugin-sdk';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

import {
  PlatformStartError,
  SendFailure,
  SetupError,
} from '@tsugimori/plugin-sdk';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { LineText } from '../src/api.ts';

import line, { LineAdapter } from '../src/index.ts';
import { closeServer, listen, listenAddress } from '../src/webhook.ts';

const secret = 'test-secret';
const token = 'test-access-token';
const userId = 'U' + '1'.repeat(32);
const groupId = 'C' + '2'.repeat(32);
const roomId = 'R' + '3'.repeat(32);
const bot = {
  userId: 'U' + '4'.repeat(32),
  basicId: '@test-bot',
  displayName: 'Test Bot',
};

interface ApiCall {
  body?: {
    chatId?: string;
    messages?: LineText[];
    replyToken?: string;
    to?: string;
  };
  headers: Headers;
  path: string;
}

function fakeApi(
  override?: (
    call: ApiCall,
  ) => Response | undefined | Promise<Response | undefined>,
) {
  const calls: ApiCall[] = [];
  let id = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const { hostname, pathname: path } = new URL(String(url));
    assert.equal(hostname, 'api.line.me');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${token}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { path, headers, body };
    calls.push(call);
    const result = await override?.(call);
    if (result) return result;
    if (path === '/v2/bot/info') return Response.json(bot);
    if (path.includes('/profile/') || path.includes('/member/'))
      return Response.json({ displayName: 'Test User' });
    if (path.endsWith('/loading/start')) return Response.json({});
    if (path.endsWith('/reply') || path.endsWith('/push'))
      return Response.json({
        sentMessages: body.messages.map(() => ({ id: String(++id) })),
      });
    assert.fail(`Unexpected LINE API path ${path}`);
  };
  return { calls, fetch };
}

async function loopback() {
  const server = createServer();
  await listen(server, { host: '127.0.0.1', port: 0 });
  const port = (server.address() as AddressInfo).port;
  return { port, server };
}

function message(
  id: string,
  source: object = { type: 'user', userId },
  fields: object = {},
) {
  return {
    type: 'message',
    webhookEventId: 'event-' + id,
    deliveryContext: { isRedelivery: false },
    replyToken: 'token-' + id,
    source,
    message: {
      id,
      type: 'text',
      text: 'hello',
      quoteToken: 'quote-' + id,
      ...fields,
    },
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      'Timed out waiting for LINE to handle the event',
    );
    await delay(5);
  }
}

async function fixture(
  t: TestContext,
  api = fakeApi(),
  options: {
    emit?: AdapterContext['emit'];
    replyTokenTtlMs?: number;
  } = {},
) {
  const { server, port } = await loopback();
  await closeServer(server);
  let now = 1000;
  const adapter = new LineAdapter(
    { fetch: api.fetch, now: () => now },
    'main',
    {
      listen: `127.0.0.1:${port}`,
      secret,
      token,
      replyTokenTtlMs: options.replyTokenTtlMs,
    },
  );
  t.after(() => adapter.stop());
  const events: InboundMessage[] = [];
  const warnings: string[] = [];
  const debug: string[] = [];
  await adapter.start({
    async emit(event) {
      assert.equal(event.type, 'message');
      events.push(event);
      await options.emit?.(event);
    },
    logDebug: (event) => debug.push(event),
    logWarning: (event) => warnings.push(event),
  });
  const base = `http://127.0.0.1:${port}`;
  async function post(
    events: unknown[],
    {
      path = '/line/main/webhook',
      mode = 'valid',
      raw,
    }: { mode?: 'bad' | 'missing' | 'valid'; path?: string; raw?: string } = {},
  ) {
    const body = raw ?? JSON.stringify({ events });
    const signature = createHmac('sha256', secret)
      .update(body)
      .digest('base64');
    const response = await fetch(base + path, {
      method: 'POST',
      body,
      headers:
        mode === 'missing'
          ? {}
          : {
              'x-line-signature':
                mode === 'bad' ? 'a'.repeat(signature.length) : signature,
            },
    });
    await response.arrayBuffer();
    return response.status;
  }
  return {
    adapter,
    api,
    base,
    debug,
    events,
    post,
    warnings,
    advance(ms: number) {
      now += ms;
    },
    waitFor: (count: number) => waitFor(() => events.length >= count),
  };
}

test('webhook validates the raw signature and body, and acknowledges before emit finishes', async (t) => {
  const emitted = Promise.withResolvers<void>();
  const f = await fixture(t, fakeApi(), { emit: () => emitted.promise });
  t.after(() => emitted.resolve());
  assert.deepEqual(f.adapter.botIdentity, {
    id: bot.userId,
    username: 'test-bot',
    displayName: bot.displayName,
  });
  const event = message(
    'm1',
    { type: 'user', userId },
    { text: '嗨 👋\nhello' },
  );
  for (const mode of ['bad', 'missing'] as const)
    assert.equal(await f.post([event], { mode }), 401);
  assert.equal(await f.post([], { mode: 'bad', raw: '{' }), 401);
  assert.equal(await f.post([], { raw: '{' }), 400);
  assert.equal(await f.post([event], { path: '/line/other/webhook' }), 404);
  const get = await fetch(f.base + '/line/main/webhook');
  assert.equal(get.status, 404);
  await get.arrayBuffer();
  assert.equal(await f.post([], { raw: 'x'.repeat(1024 * 1024 + 1) }), 413);
  assert.equal(f.events.length, 0);
  assert.equal(
    await f.post([], { raw: JSON.stringify({ events: [event] }, null, 2) }),
    200,
  );
  await f.waitFor(1);
  assert.equal(f.events[0]?.text, '嗨 👋\nhello');
  assert.equal(await f.post([]), 200);
});

test('redeliveries dedupe and group, room, DM, media, mentions and profiles map to inbound events', async (t) => {
  const f = await fixture(
    t,
    fakeApi((call) =>
      call.path.includes('/room/')
        ? Response.json({}, { status: 404 })
        : undefined,
    ),
  );
  const group = { type: 'group', groupId, userId };
  const groupMessage = message('mg', group, {
    mention: { mentionees: [{ isSelf: false }, { isSelf: true }] },
  });
  const redelivery = {
    ...groupMessage,
    deliveryContext: { isRedelivery: true },
  };
  assert.equal(
    await f.post([redelivery, groupMessage, message('mg2', group)]),
    200,
  );
  assert.equal(
    await f.post([
      message('md'),
      message('mr', { type: 'room', roomId, userId }, { type: 'image' }),
      message('missing', { type: 'group', groupId }),
      { type: 'join', webhookEventId: 'join' },
      { ...message('standby'), mode: 'standby' },
    ]),
    200,
  );
  await f.waitFor(4);
  assert.deepEqual(
    [...f.events]
      .sort((a, b) => a.messageId.localeCompare(b.messageId))
      .map(
        ({
          chatId,
          chatKind,
          messageId,
          mentionsBot,
          text,
          userDisplay,
          userId: sender,
        }) => [
          messageId,
          chatId,
          chatKind,
          sender,
          text,
          mentionsBot,
          userDisplay,
        ],
      ),
    [
      ['md', userId, 'dm', userId, 'hello', false, 'Test User'],
      ['mg', groupId, 'group', userId, 'hello', true, 'Test User'],
      ['mg2', groupId, 'group', userId, 'hello', false, 'Test User'],
      ['mr', roomId, 'group', userId, '[image]', false, undefined],
    ],
  );
  assert.deepEqual(f.warnings, ['line.message_missing_user']);
  assert.ok(f.debug.includes('line.event_ignored'));
  assert.ok(f.debug.includes('line.profile_unavailable'));
  assert.equal(
    f.api.calls.filter(
      ({ path }) => path === `/v2/bot/group/${groupId}/member/${userId}`,
    ).length,
    1,
  );
  assert.ok(
    f.api.calls.some(({ path }) => path === `/v2/bot/profile/${userId}`),
  );
  assert.ok(
    f.api.calls.some(
      ({ path }) => path === `/v2/bot/room/${roomId}/member/${userId}`,
    ),
  );
});

test('one concurrent send can use the latest reply token and quoted bot messages map to native IDs', async (t) => {
  const f = await fixture(t);
  await f.post([message('inbound')]);
  await f.waitFor(1);
  const first = {
    chatId: userId,
    replyTo: 'inbound',
    text: 'approve or deny',
    approval: true,
  };
  const [receipt] = await Promise.all([
    f.adapter.send(first),
    f.adapter.send(first),
  ]);
  const replies = f.api.calls.filter(({ path }) => path.endsWith('/reply'));
  const pushes = f.api.calls.filter(({ path }) => path.endsWith('/push'));
  assert.equal(replies.length, 1);
  assert.equal(pushes.length, 1);
  assert.equal(replies[0]?.headers.get('X-Line-Retry-Key'), null);
  assert.equal(replies[0]?.body?.replyToken, 'token-inbound');
  assert.deepEqual(replies[0]?.body?.messages, [
    { type: 'text', text: first.text, quoteToken: 'quote-inbound' },
  ]);
  assert.match(
    pushes[0]?.headers.get('X-Line-Retry-Key') ?? '',
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
  );

  await f.post([
    message(
      'answer',
      { type: 'user', userId },
      { quotedMessageId: receipt.messageId, text: 'approve' },
    ),
    message(
      'other',
      { type: 'group', groupId, userId },
      { quotedMessageId: receipt.messageId },
    ),
  ]);
  await f.waitFor(3);
  const answer = f.events.find(({ messageId }) => messageId === 'answer');
  assert.equal(answer?.replyTo, receipt.messageId);
  assert.equal(answer?.repliesToBot, true);
  assert.equal(
    f.events.find(({ messageId }) => messageId === 'other')?.repliesToBot,
    false,
  );
});

test('uses push for older and expired tokens and falls back for an invalid token only', async (t) => {
  const api = fakeApi(({ body, path }) => {
    if (!path.endsWith('/reply')) return;
    return Response.json(
      {
        message:
          body?.replyToken === 'token-invalid'
            ? 'Invalid reply token'
            : 'Invalid message object',
      },
      { status: 400 },
    );
  });
  const f = await fixture(t, api, { replyTokenTtlMs: 10 });
  await f.post([message('old'), message('new')]);
  await f.waitFor(2);
  const send = (replyTo: string) =>
    f.adapter.send({ chatId: userId, text: replyTo, replyTo });
  await send('old');
  f.advance(10);
  await send('new');
  await f.post([message('invalid')]);
  await f.waitFor(3);
  await send('invalid');
  await f.post([message('bad-message')]);
  await f.waitFor(4);
  await assert.rejects(
    send('bad-message'),
    (error) => error instanceof SendFailure && !error.deliveryUnknown,
  );
  assert.deepEqual(
    api.calls
      .filter(({ path }) => path.includes('/message/'))
      .map(({ path, body }) => [
        path.split('/').at(-1),
        body?.replyToken,
        body?.messages?.[0]?.quoteToken,
      ]),
    [
      ['push', undefined, 'quote-old'],
      ['push', undefined, 'quote-new'],
      ['reply', 'token-invalid', 'quote-invalid'],
      ['push', undefined, 'quote-invalid'],
      ['reply', 'token-bad-message', 'quote-bad-message'],
    ],
  );
});

test('splits into UTF-16-safe batches, returns every part, and uses plain text for Markdown', async (t) => {
  const f = await fixture(t);
  const content = 'x'.repeat(4999) + '😀'.repeat(12_501);
  const receipt = await f.adapter.send({ chatId: roomId, text: content });
  const pushes = f.api.calls.filter(({ path }) => path.endsWith('/push'));
  assert.equal(pushes.length, 2);
  assert.deepEqual(
    pushes.map(({ body }) => body?.messages?.length),
    [5, 2],
  );
  assert.notEqual(
    pushes[0]?.headers.get('X-Line-Retry-Key'),
    pushes[1]?.headers.get('X-Line-Retry-Key'),
  );
  assert.equal(receipt.parts?.map(({ text }) => text).join(''), content);
  for (const { text } of receipt.parts ?? []) {
    assert.ok(text.length <= 5000);
    assert.ok(text.isWellFormed());
  }
  const formatted = await f.adapter.send({
    chatId: userId,
    format: 'markdown',
    text: '# Heading\n**bold** and `x * y`\n\n```ts\nconst x = "*";\n```\n[Docs](https://example.org)',
  });
  assert.equal(
    formatted.parts?.[0]?.text,
    'Heading\nbold and x * y\n\nconst x = "*";\nDocs (https://example.org)',
  );
});

test('exposes rate limits and records already sent parts on ambiguous network failure', async (t) => {
  let count = 0;
  const f = await fixture(
    t,
    fakeApi(({ path }) => {
      if (!path.endsWith('/push')) return;
      count++;
      if (count === 1)
        return Response.json(
          {},
          { status: 429, headers: { 'Retry-After': '3' } },
        );
      if (count === 3) throw new TypeError('Simulated connection drop');
    }),
  );
  await assert.rejects(
    f.adapter.send({ chatId: groupId, text: 'hello' }),
    (error) => {
      assert.ok(error instanceof SendFailure);
      assert.equal(error.deliveryUnknown, false);
      assert.equal(error.retryAfterMs, 3000);
      return true;
    },
  );
  await assert.rejects(
    f.adapter.send({ chatId: groupId, text: 'x'.repeat(26_000) }),
    (error) => {
      assert.ok(error instanceof SendFailure);
      assert.equal(error.deliveryUnknown, true);
      assert.equal(error.parts.length, 5);
      return true;
    },
  );
  assert.equal(count, 3);
});

test('retries a push server error with the same UUID and recognizes prior acceptance', async (t) => {
  const keys: (string | null)[] = [];
  const f = await fixture(
    t,
    fakeApi(({ path, headers }) => {
      if (!path.endsWith('/push')) return;
      keys.push(headers.get('X-Line-Retry-Key'));
      if (keys.length === 1) return Response.json({}, { status: 503 });
      return Response.json(
        { sentMessages: [{ id: '90071992547409930' }] },
        {
          status: 409,
          headers: { 'X-Line-Accepted-Request-Id': 'original' },
        },
      );
    }),
  );
  const receipt = await f.adapter.send({ chatId: userId, text: 'one push' });
  assert.equal(receipt.messageId, '90071992547409930');
  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.equal(keys[1], keys[0]);
});

test('typing calls the loading endpoint in direct messages only and ignores failures', async (t) => {
  const f = await fixture(
    t,
    fakeApi(({ path }) =>
      path.endsWith('/loading/start')
        ? Response.json({}, { status: 400 })
        : undefined,
    ),
  );
  const signal = new AbortController().signal;
  for (const chatId of [userId, groupId, roomId])
    f.adapter.typing({ chatId }, signal);
  await waitFor(() =>
    f.api.calls.some(({ path }) => path.endsWith('/loading/start')),
  );
  const loading = f.api.calls.filter(({ path }) =>
    path.endsWith('/loading/start'),
  );
  assert.equal(loading.length, 1);
  assert.equal(loading[0]?.body?.chatId, userId);
});

test('the default LINE webhook listens on IPv4 loopback port 8789', () => {
  assert.deepEqual(listenAddress(), { host: '127.0.0.1', port: 8789 });
});

test('startup rejects public and busy addresses, honors cancellation, and releases its port on stop', async (t) => {
  const { port, server } = await loopback();
  t.after(() => closeServer(server));
  const api = fakeApi();
  const ctx: AdapterContext = { async emit() {} };
  const address = `127.0.0.1:${port}`;
  const options = { secret, token, listen: address };
  const busy = new LineAdapter(api, 'busy', options);
  t.after(() => busy.stop());
  await assert.rejects(
    busy.start(ctx),
    (error) =>
      error instanceof PlatformStartError &&
      /already in use/.test(error.message),
  );
  await assert.rejects(
    new LineAdapter(api, 'public', {
      ...options,
      listen: '0.0.0.0:8789',
    }).start(ctx),
    /loopback|127\.0\.0\.1/,
  );
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const cancelled = new LineAdapter(
    {
      fetch: async (_input, init) => {
        const signal = init?.signal;
        assert.ok(signal);
        entered.resolve();
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
    },
    'cancelled',
    options,
  );
  t.after(() => cancelled.stop());
  const starting = cancelled.start({ ...ctx, signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(starting, { name: 'AbortError' });
  await closeServer(server);
  await busy.start(ctx);
  await busy.stop();
  await listen(server, { host: '127.0.0.1', port });
});

test('setup hides credentials, validates the token, confirms the bot and prints the webhook path', async () => {
  const api = fakeApi();
  const entry: PluginInstanceConfig = { id: 'main', kind: 'line' };
  const outputs: string[] = [];
  const prompts: Parameters<SetupContext['prompt']>[0][] = [];
  const writes = new Map<string, string>();
  let patch: Parameters<SetupContext['writeConfig']>[0] | undefined;
  const context: SetupContext = {
    entry,
    arch: process.arch,
    platform: process.platform,
    workspace: '/unused',
    fetch: api.fetch,
    signal: new AbortController().signal,
    runCheck: async () => assert.fail('Unexpected check'),
    runCommand: async () => assert.fail('Unexpected command'),
    testTurn: async () => assert.fail('Unexpected test turn'),
    install: async () => assert.fail('Unexpected install'),
    credential: (name) => writes.get(name),
    async prompt(options) {
      prompts.push(options);
      return [secret, token, 'yes'][(prompts.length - 1) % 3]!;
    },
    async show(text) {
      outputs.push(text);
    },
    async writeEnv(key, value) {
      writes.set(key, value);
    },
    writeConfig(value) {
      patch = value;
    },
  };
  const setup = line.setupSteps?.[0];
  assert.ok(setup);
  assert.deepEqual(line.credentialNames?.(entry), [
    'LINE_CHANNEL_SECRET',
    'LINE_CHANNEL_ACCESS_TOKEN',
  ]);
  const rejected = fakeApi(() =>
    Response.json({ message: token }, { status: 401 }),
  );
  await assert.rejects(
    async () =>
      setup.run({
        ...context,
        fetch: rejected.fetch,
        prompt: async ({ text }) => (text.includes('secret') ? secret : token),
      }),
    (error) => error instanceof SetupError && !error.message.includes(token),
  );
  assert.equal(writes.size, 0);
  await setup.run(context);
  assert.deepEqual(
    prompts.map(({ secret }) => !!secret),
    [true, true, false],
  );
  assert.match(prompts[2]!.text, /Test Bot/);
  assert.deepEqual([...writes.values()], [secret, token]);
  assert.deepEqual(line.credentialNames?.({ ...entry, ...patch?.entry }), [
    ...writes.keys(),
  ]);
  assert.match(outputs.join(' '), /\/line\/main\/webhook.*HTTPS.*Use webhook/);
  assert.ok(!outputs.join(' ').includes(secret));
  assert.ok(!outputs.join(' ').includes(token));

  const { port, server } = await loopback();
  try {
    const config = { ...entry, ...patch?.entry, listen: `127.0.0.1:${port}` };
    const checks = await line.checks?.({ ...context, entry: config });
    assert.equal(checks?.find(({ id }) => id === 'line-token')?.status, 'ok');
    assert.match(
      checks?.find(({ id }) => id === 'line-listen')?.detail ?? '',
      /already in use/,
    );
    await closeServer(server);
    const open = await line.checks?.({ ...context, entry: config });
    assert.equal(open?.find(({ id }) => id === 'line-listen')?.status, 'ok');
  } finally {
    await closeServer(server);
  }
});
