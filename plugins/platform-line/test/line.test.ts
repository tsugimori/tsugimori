import type {
  AdapterContext,
  InboundMessage,
  PlatformInboundEvent,
  PluginInstanceConfig,
  SetupContext,
  WebhookIngress,
  WebhookRoute,
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
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, get, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { LineMessage } from '../src/api.ts';

import line, { LineAdapter } from '../src/index.ts';

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
    endpoint?: string;
    messages?: LineMessage[];
    replyToken?: string;
    to?: string;
  };
  headers: Headers;
  method?: string;
  path: string;
}

function fakeApi(
  override?: (
    call: ApiCall,
  ) => Response | undefined | Promise<Response | undefined>,
  expectedToken = token,
) {
  const calls: ApiCall[] = [];
  let id = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const { hostname, pathname: path } = new URL(String(url));
    assert.equal(hostname, 'api.line.me');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${expectedToken}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { path, headers, body, method: init?.method };
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

function listen(server: Server, address: { host: string; port: number }) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function tempDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tsugimori-line-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function closeServer(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function fakeIngress(t: TestContext) {
  const routes = new Map<string, { prefix: boolean; route: WebhookRoute }>();
  const server = createServer((req, res) => {
    const path = req.url?.split('?', 1)[0]?.replace(/\/$/, '') ?? '';
    const exact = routes.get(path);
    const prefix = [...routes].find(
      ([base, value]) => value.prefix && path.startsWith(base + '/'),
    );
    const route = exact?.route ?? prefix?.[1].route;
    if (route) route(req, res);
    else res.writeHead(404).end();
  });
  await listen(server, { host: '127.0.0.1', port: 0 });
  t.after(() => closeServer(server));
  return {
    ingress: {
      async register(path, route, _signal, { prefix = false } = {}) {
        const key = path.replace(/\/$/, '');
        routes.set(key, { prefix, route });
        return async () => {
          routes.delete(key);
        };
      },
      url: () => undefined,
      status: () => ({ state: 'unconfigured' }),
    } satisfies WebhookIngress,
    port: (server.address() as AddressInfo).port,
  };
}

function publicIngress(baseUrl: string): WebhookIngress {
  return {
    register: async () => assert.fail('Unexpected registration'),
    status: () => ({ state: 'ok', baseUrl }),
    url: (path) => baseUrl + path,
  };
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

function postback(
  id: string,
  data: string,
  source: object = { type: 'group', groupId, userId },
) {
  return {
    type: 'postback',
    webhookEventId: 'event-' + id,
    replyToken: 'token-' + id,
    source,
    postback: { data },
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
    mediaDirectory?: string;
    mediaMaxBytes?: number;
    mediaTtlMs?: number;
    now?: number;
    publicMedia?: boolean;
    replyTokenTtlMs?: number;
  } = {},
) {
  const { ingress, port } = await fakeIngress(t);
  if (options.publicMedia) {
    Object.assign(ingress, publicIngress('https://hooks.example.test'), {
      register: ingress.register,
    });
  }
  let now = options.now ?? 1000;
  const mediaDirectory = options.mediaDirectory ?? (await tempDirectory(t));
  const adapter = new LineAdapter(
    { fetch: api.fetch, now: () => now },
    'main',
    {
      ingress,
      mediaDirectory,
      mediaMaxBytes: options.mediaMaxBytes,
      mediaTtlMs: options.mediaTtlMs,
      secret,
      token,
      replyTokenTtlMs: options.replyTokenTtlMs,
    },
  );
  t.after(() => adapter.stop());
  const events: InboundMessage[] = [];
  const callbacks: Extract<PlatformInboundEvent, { type: 'callback' }>[] = [];
  const warnings: string[] = [];
  const debug: string[] = [];
  const info: Parameters<NonNullable<AdapterContext['logInfo']>>[] = [];
  await adapter.start({
    async emit(event) {
      if (event.type === 'callback') callbacks.push(event);
      else {
        assert.equal(event.type, 'message');
        events.push(event);
      }
      await options.emit?.(event);
    },
    logDebug: (event) => debug.push(event),
    logInfo: (...event) => info.push(event),
    logWarning: (event) => warnings.push(event),
  });
  const base = `http://127.0.0.1:${port}`;
  async function post(
    events: unknown[],
    {
      path = '/line/main/',
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
    callbacks,
    info,
    events,
    mediaDirectory,
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
  assert.equal(
    await f.adapter.contactLink(),
    'https://line.me/R/ti/p/%40test-bot',
  );
  const event = message(
    'm1',
    { type: 'user', userId },
    { text: '嗨 👋\nhello' },
  );
  for (const mode of ['bad', 'missing'] as const)
    assert.equal(await f.post([event], { mode }), 401);
  assert.equal(await f.post([], { mode: 'bad', raw: '{' }), 401);
  assert.equal(await f.post([], { raw: '{' }), 400);
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

test('accepts the three webhook paths with query strings and rejects other routes', async (t) => {
  const f = await fixture(t);
  const paths = ['/line/main', '/line/main/', '/line/main/webhook'];
  for (const [index, path] of paths.entries()) {
    assert.equal(await f.post([], { path }), 200);
    assert.equal(
      await f.post([message(String(index))], { path: path + '?source=line' }),
      200,
    );
    const get = await fetch(f.base + path);
    assert.equal(get.status, 404);
    await get.arrayBuffer();
  }
  await f.waitFor(paths.length);
  for (const path of [
    '/line/other',
    '/line/other/',
    '/line/other/webhook',
    '/line/main//',
    '/line/main/webhook/',
    '/line/main/extra?path=/line/main/',
  ])
    assert.equal(await f.post([], { path }), 404);
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
    f.events.find(({ messageId }) => messageId === 'mg')?.raw,
    redelivery,
  );
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

test('quick replies attach to the last text part and preserve LINE label and data limits', async (t) => {
  const f = await fixture(t);
  const label = '✅'.repeat(18) + '👋🏽 extra';
  const longLabel = 'a'.repeat(299) + '👋';
  const longId = 'x'.repeat(271);
  const buttons = [
    { id: 'approval:once:example', label: 'Approve' },
    { id: 'choice:emoji', label },
    { id: longId, label: longLabel },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      label: `Option ${i}`,
    })),
  ];
  const text = 'x'.repeat(5000) + 'tail';
  const receipt = await f.adapter.send({ chatId: groupId, text, buttons });
  const messages = f.api.calls.at(-1)?.body?.messages;
  assert.equal(messages?.length, 2);
  assert.deepEqual(messages?.[0], { type: 'text', text: text.slice(0, 5000) });
  const last = messages?.[1];
  assert.equal(last?.type, 'text');
  assert.equal(last.text, 'tail');
  const items = last.quickReply?.items;
  assert.equal(items?.length, 13);
  const [approve, emoji, long] = items;
  assert.match(
    approve!.action.data,
    /^tsm:[a-f0-9]{24}:approval:once:example$/,
  );
  assert.deepEqual(approve, {
    type: 'action',
    action: {
      type: 'postback',
      data: approve!.action.data,
      label: 'Approve',
      displayText: 'Approve',
    },
  });
  assert.equal(emoji!.action.label, '✅'.repeat(18) + '…');
  assert.equal(emoji!.action.displayText, label);
  assert.equal(long!.action.data.length, 300);
  assert.ok(long!.action.data.endsWith(longId));
  assert.equal(long!.action.label, 'a'.repeat(19) + '…');
  assert.equal(long!.action.displayText, 'a'.repeat(299) + '…');
  assert.equal(receipt.messageId, '2');
  assert.deepEqual(
    receipt.parts?.map(({ messageId }) => messageId),
    ['1', '2'],
  );

  const callCount = f.api.calls.length;
  await assert.rejects(
    f.adapter.send({
      chatId: groupId,
      text,
      buttons: [...buttons, buttons[0]!],
    }),
    (error: unknown) =>
      error instanceof SendFailure &&
      error.cause instanceof Error &&
      error.cause.message === 'LINE supports up to 13 quick replies',
  );
  await assert.rejects(
    f.adapter.send({
      chatId: groupId,
      text,
      buttons: [{ id: longId + 'x', label }],
    }),
    (error: unknown) =>
      error instanceof SendFailure &&
      error.cause instanceof Error &&
      error.cause.message === 'Invalid LINE postback data length',
  );
  assert.equal(f.api.calls.length, callCount);
});

test('only issued LINE postbacks from the prompt chat map to callback events across restarts', async (t) => {
  const first = await fixture(t);
  const { messageId } = await first.adapter.send({
    chatId: groupId,
    text: 'Choose',
    buttons: [{ id: 'choice:one', label: 'One' }],
  });
  const payload = first.api.calls.at(-1)?.body?.messages?.[0];
  assert.equal(payload?.type, 'text');
  const data = payload.quickReply?.items[0]?.action.data;
  assert.ok(data);
  await first.adapter.stop();
  const f = await fixture(t, fakeApi(), {
    mediaDirectory: first.mediaDirectory,
  });
  const allowed = postback('allowed', data);
  await f.post([
    postback('foreign', 'action=external'),
    postback('unsent', data.replace(/[a-f0-9]{24}/, 'f'.repeat(24))),
    postback('altered', data.replace('one', 'two')),
    postback('wrong-chat', data, { type: 'room', roomId, userId }),
    { ...postback('standby', data), mode: 'standby' },
    postback('anonymous', data, { type: 'group', groupId }),
    allowed,
    allowed,
  ]);
  await waitFor(() => f.callbacks.length > 0);
  assert.deepEqual(f.callbacks, [
    {
      type: 'callback',
      chatId: groupId,
      callbackId: 'choice:one',
      messageId,
      queryId: 'event-allowed',
      userId,
      userDisplay: 'Test User',
    },
  ]);
  assert.equal(
    f.debug.filter((name) => name === 'line.postback_ignored').length,
    4,
  );
  assert.equal(f.events.length, 0);
});

test('LINE approval feedback falls back to push for a rejected postback reply token', async (t) => {
  const f = await fixture(
    t,
    fakeApi(({ path }) =>
      path.endsWith('/reply')
        ? Response.json({ message: 'Invalid reply token' }, { status: 400 })
        : undefined,
    ),
  );
  const { messageId } = await f.adapter.send({
    chatId: groupId,
    text: 'Choose',
    buttons: [{ id: 'approval:deny:example', label: 'Deny' }],
  });
  const payload = f.api.calls.at(-1)?.body?.messages?.[0];
  assert.equal(payload?.type, 'text');
  const data = payload.quickReply?.items[0]?.action.data;
  assert.ok(data);
  await f.post([postback('decline', data)]);
  await waitFor(() => f.callbacks.length > 0);
  await f.adapter.respondToApproval({
    chatId: groupId,
    messageId,
    queryId: f.callbacks[0]?.queryId,
    decision: 'deny',
    decisionText: '❌ Denied',
    notice: '❌ Denied',
    prompt: 'Choose',
  });
  const messages = [{ type: 'text', text: '❌ Denied' }];
  assert.deepEqual(
    f.api.calls.slice(-2).map(({ body }) => body),
    [
      { messages, replyToken: 'token-decline' },
      { messages, to: groupId },
    ],
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
  assert.equal(answer?.replyTo?.id, receipt.messageId);
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
      .map(({ path, body }) => {
        const first = body?.messages?.[0];
        return [
          path.split('/').at(-1),
          body?.replyToken,
          first?.type === 'text' ? first.quoteToken : undefined,
        ];
      }),
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
  const pairing = await f.adapter.send({
    chatId: userId,
    format: 'markdown',
    text: '請在 24 小時內傳送這一行：\n`/pair demo_pairing1234`\nhttps://example.test/new-bot',
  });
  assert.equal(
    pairing.parts?.[0]?.text.split('\n')[1],
    '/pair demo_pairing1234',
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

test('LINE instances share a listener and keep routes, credentials, and event state separate across reloads', async (t) => {
  const { ingress, port } = await fakeIngress(t);
  const host = '127.0.0.1';
  const address = `${host}:${port}`;
  const otherSecret = 'test-second-secret';
  const otherToken = 'test-second-access-token';
  const firstApi = fakeApi();
  const otherApi = fakeApi(undefined, otherToken);
  const first = new LineAdapter(firstApi, 'main', {
    secret,
    token,
    ingress,
    mediaDirectory: await tempDirectory(t),
  });
  const other = new LineAdapter(otherApi, 'other:bot', {
    secret: otherSecret,
    token: otherToken,
    ingress,
    mediaDirectory: await tempDirectory(t),
  });
  t.after(async () => {
    await Promise.all([first.stop(), other.stop()]);
  });
  const firstEvents: string[] = [];
  const otherEvents: string[] = [];
  const context = (events: string[]): AdapterContext => ({
    async emit(event) {
      assert.equal(event.type, 'message');
      events.push(event.messageId);
    },
  });
  await Promise.all([
    first.start(context(firstEvents)),
    other.start(context(otherEvents)),
  ]);
  const post = async (path: string, key: string, id: string) => {
    const body = JSON.stringify({ events: [message(id)] });
    const signature = createHmac('sha256', key).update(body).digest('base64');
    const response = await fetch(`http://${address}${path}`, {
      method: 'POST',
      body,
      headers: { 'x-line-signature': signature },
    });
    await response.arrayBuffer();
    return response.status;
  };
  assert.equal(await post('/line/other%3Abot/webhook', secret, 'initial'), 401);
  assert.equal(await post('/line/main/', otherSecret, 'initial'), 401);
  assert.equal(await post('/line/main/', secret, 'initial'), 200);
  assert.equal(
    await post('/line/other%3Abot?query=1', otherSecret, 'initial'),
    200,
  );
  await waitFor(() => firstEvents.length === 1 && otherEvents.length === 1);
  await Promise.all(
    [first, other].map((adapter) =>
      adapter.send({ chatId: userId, text: 'reply', replyTo: 'initial' }),
    ),
  );
  assert.equal(firstApi.calls.at(-1)?.body?.replyToken, 'token-initial');
  assert.equal(otherApi.calls.at(-1)?.body?.replyToken, 'token-initial');

  await first.stop();
  assert.equal(await post('/line/main/', secret, 'while-stopped'), 404);
  assert.equal(
    await post('/line/other%3Abot/', otherSecret, 'while-stopped'),
    200,
  );
  await first.start(context(firstEvents));
  assert.equal(await post('/line/main/', secret, 'after-reload'), 200);
  await waitFor(() => firstEvents.length === 2 && otherEvents.length === 2);
  assert.deepEqual(firstEvents, ['initial', 'after-reload']);
  assert.deepEqual(otherEvents, ['initial', 'while-stopped']);
  await Promise.all([first.stop(), other.stop()]);
  assert.equal(await post('/line/other%3Abot/', otherSecret, 'stopped'), 404);
});

test('LINE reports ingress bind failures and honors startup cancellation', async (t) => {
  const { ingress } = await fakeIngress(t);
  const api = fakeApi();
  const ctx: AdapterContext = { async emit() {} };
  const options = {
    secret,
    token,
    ingress,
    mediaDirectory: await tempDirectory(t),
  };
  const busy = new LineAdapter(api, 'busy', {
    ...options,
    ingress: {
      ...ingress,
      async register() {
        throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
      },
    },
  });
  await assert.rejects(
    busy.start(ctx),
    (error) =>
      error instanceof PlatformStartError &&
      /already in use/.test(error.message),
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
});

test('setup hides credentials, validates the token, and confirms the bot', async () => {
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
    recordCredential: () => assert.fail('Unexpected external credential'),
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
  assert.equal(line.setupSteps?.length, 1);
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
  assert.deepEqual(
    prompts[2]?.choices?.map(({ value }) => value),
    ['yes', 'no'],
  );
  assert.deepEqual([...writes.values()], [secret, token]);
  assert.deepEqual(line.credentialNames?.({ ...entry, ...patch?.entry }), [
    ...writes.keys(),
  ]);
  assert.ok(!outputs.join(' ').includes(secret));
  assert.ok(!outputs.join(' ').includes(token));
  const checks = await line.checks?.({
    ...context,
    entry: { ...entry, ...patch?.entry },
    webhookIngress: {
      ...publicIngress('https://hooks.example.com'),
      status: () => ({
        state: 'failed',
        reason: 'Public route is unavailable.',
      }),
    },
  });
  assert.equal(checks?.find(({ id }) => id === 'line-token')?.status, 'ok');
  assert.equal(checks?.find(({ id }) => id === 'line-webhook')?.status, 'fail');
  assert.equal(
    checks?.find(({ id }) => id === 'line-webhook')?.detail,
    'Public route is unavailable.',
  );
  const checking = {
    ...publicIngress('https://hooks.example.com'),
    status: () => ({ state: 'checking' as const }),
  };
  const startup = await line.checks?.({
    ...context,
    entry: { ...entry, ...patch?.entry },
    startup: true,
    webhookIngress: checking,
  });
  assert.equal(
    startup?.find(({ id }) => id === 'line-webhook'),
    undefined,
    'startup skips the endpoint check while the ingress probe is pending',
  );
  const manual = await line.checks?.({
    ...context,
    entry: { ...entry, ...patch?.entry },
    webhookIngress: checking,
  });
  assert.equal(manual?.find(({ id }) => id === 'line-webhook')?.status, 'fail');
});

test('LINE completion confirms an endpoint change before setting and testing it', async () => {
  const endpoint = 'https://webhooks.example.com/teams/line/main/';
  const endpointPath = '/v2/bot/channel/webhook/endpoint';
  const testPath = '/v2/bot/channel/webhook/test';
  const completion = line.setupComplete;
  assert.ok(completion);
  for (const scenario of [
    {
      current: endpoint,
      active: true,
      answer: undefined,
      methods: ['GET', 'POST'],
      testSuccess: true,
      summary: /已接上.*LINE 測試通過/,
      reminder: false,
    },
    {
      current: endpoint,
      active: false,
      answer: undefined,
      methods: ['GET', 'POST'],
      testSuccess: true,
      summary: /已接上.*LINE 測試通過/,
      reminder: true,
    },
    {
      current: 'https://old.example.com/',
      answer: 'no',
      methods: ['GET'],
      testSuccess: false,
      summary: /保留了原有/,
      reminder: false,
    },
    {
      current: 'https://old.example.com/',
      answer: 'yes',
      methods: ['GET', 'PUT', 'POST'],
      testSuccess: true,
      summary: /已接上.*LINE 測試通過/,
      reminder: true,
    },
    {
      current: undefined,
      answer: undefined,
      methods: ['GET', 'PUT', 'POST'],
      testSuccess: true,
      summary: /已接上.*LINE 測試通過/,
      reminder: true,
    },
    {
      current: '',
      answer: undefined,
      methods: ['GET', 'PUT', 'POST'],
      testSuccess: false,
      summary: /測試未通過/,
      reminder: false,
    },
  ]) {
    const api = fakeApi(({ body, method, path }) => {
      if (method === 'GET') {
        assert.equal(path, endpointPath);
        return scenario.current !== undefined
          ? Response.json({
              endpoint: scenario.current,
              active: scenario.active,
            })
          : Response.json({}, { status: 404 });
      }
      assert.deepEqual(body, { endpoint });
      if (method === 'PUT') {
        assert.equal(path, endpointPath);
        return Response.json({});
      }
      assert.equal(path, testPath);
      return Response.json({ success: scenario.testSuccess });
    });
    let asked = 0;
    const summary = await completion.run({
      arch: process.arch,
      platform: process.platform,
      workspace: '/unused',
      entry: { id: 'main', kind: 'line' },
      webhookIngress: publicIngress('https://webhooks.example.com/teams'),
      locale: 'zh-TW',
      fetch: api.fetch,
      signal: AbortSignal.timeout(2000),
      runCommand: async () => assert.fail('Unexpected command'),
      credential: () => token,
      async prompt({ choices, secret, text }) {
        assert.equal(secret, undefined);
        assert.deepEqual(
          choices?.map(({ value }) => value),
          ['yes', 'no'],
        );
        assert.ok(text.includes(endpoint));
        assert.ok(scenario.answer);
        asked++;
        return scenario.answer;
      },
    });
    assert.equal(asked, scenario.answer === undefined ? 0 : 1);
    assert.match(summary, scenario.summary);
    if (scenario.testSuccess)
      assert.ok(summary.includes(endpoint + ' （LINE 測試通過）'));
    assert.equal(summary.includes('Use webhook'), scenario.reminder);
    if (!scenario.testSuccess) {
      assert.doesNotMatch(summary, /已接上/);
      assert.match(summary, /已儲存.*\/webhook check/);
    }
    assert.deepEqual(
      api.calls.map(({ method }) => method),
      scenario.methods,
    );
  }
});

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=',
  'base64',
);
const webPng = Buffer.concat([
  tinyPng,
  Buffer.alloc(3 * 1024 ** 2 - tinyPng.length),
]);
const imageUrl = 'https://images.example.test/picture?signature=test';

test('LINE queues validated stickers, replies with final text and pushes overflow', async (t) => {
  const f = await fixture(t);
  assert.equal(f.adapter.capabilities.reactions, undefined);
  const sticker = f.adapter.searchStickers('apology bow', 1)[0];
  assert.ok(sticker?.packageId);
  assert.match(sticker.description, /apology/);
  assert.equal(f.adapter.searchStickers('1993', 1)[0]?.fileId, '1993');
  const signal = AbortSignal.timeout(3000);
  const destination = { chatId: userId, replyTo: '71' };
  await f.post([message('71')]);
  await f.waitFor(1);
  await assert.rejects(
    f.adapter.sendSticker({ ...destination, fileId: '1234567' }, signal),
    /official sendable stickers/,
  );
  await assert.rejects(
    f.adapter.sendSticker(
      { ...destination, ...sticker, packageId: '1' },
      signal,
    ),
    /official sendable stickers/,
  );
  const queued = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.adapter.sendSticker(
        {
          ...destination,
          fileId: sticker.fileId,
          packageId: sticker.packageId,
        },
        signal,
      ),
    ),
  );
  assert.ok(
    f.api.calls.every(
      ({ path }) => !path.endsWith('/reply') && !path.endsWith('/push'),
    ),
  );
  const to = { chatId: groupId, replyTo: '71', text: '' };
  await assert.rejects(
    f.adapter.send(to, { media: [queued[0]!] }),
    (error: unknown) =>
      error instanceof SendFailure &&
      /different reply/.test(String(error.cause)),
  );
  const receipt = await f.adapter.send(
    { ...destination, text: 'Here are your stickers' },
    { media: queued },
  );
  const requests = f.api.calls.filter(
    ({ path }) => path.endsWith('/reply') || path.endsWith('/push'),
  );
  assert.deepEqual(
    requests.map(({ path }) => path),
    ['/v2/bot/message/reply', '/v2/bot/message/push'],
  );
  assert.equal(requests[0]?.body?.replyToken, 'token-71');
  assert.deepEqual(
    requests.map(({ body }) => body?.messages?.map(({ type }) => type)),
    [['text', 'sticker', 'sticker', 'sticker', 'sticker'], ['sticker']],
  );
  assert.deepEqual(requests[1]?.body?.messages?.[0], {
    type: 'sticker',
    stickerId: sticker.fileId,
    packageId: sticker.packageId,
  });
  assert.deepEqual(
    receipt.parts
      .slice(1)
      .map(({ mediaId, messageId }) => [mediaId, messageId]),
    queued.map(({ id }, i) => [id, String(i + 2)]),
  );
});

test('LINE media-only delivery serves repeated and concurrent GETs and HEAD', async (t) => {
  const f = await fixture(t, fakeApi(), { publicMedia: true });
  await f.post([message('72')]);
  await f.waitFor(1);
  const signal = AbortSignal.timeout(3000);
  const destination = { chatId: userId, replyTo: '72' };
  const large = {
    ...destination,
    file: { name: 'large.png', bytes: Buffer.alloc(10 * 1024 ** 2 + 1) },
    preview: () => assert.fail('unexpected preview'),
  };
  await assert.rejects(f.adapter.sendImage(large, signal), /10 MB size limit/);
  await assert.rejects(
    f.adapter.sendFile(
      { ...large, file: { ...large.file, bytes: tinyPng } },
      signal,
    ),
    /MP4 video files only/,
  );
  const queued = await f.adapter.sendImage(
    { ...large, file: { name: 'small.png', bytes: tinyPng } },
    signal,
  );
  const mp4 = Buffer.from('0000ftypmp42synthetic test video');
  const video = await f.adapter.sendFile(
    {
      ...destination,
      file: { name: 'clip.mp4', bytes: mp4 },
      async preview() {
        return { bytes: tinyPng, mime: 'image/png' };
      },
    },
    signal,
  );
  const receipt = await f.adapter.send(
    { ...destination, text: '' },
    { media: [queued, video] },
  );
  assert.equal(receipt.messageId, '1');
  assert.equal(receipt.parts[0]?.mediaId, queued.id);
  const reply = f.api.calls.find(({ path }) => path.endsWith('/reply'));
  const [sent, sentVideo] = reply?.body?.messages ?? [];
  assert.equal(sent?.type, 'image');
  assert.equal(sentVideo?.type, 'video');
  assert.match(
    sent.originalContentUrl,
    /^https:\/\/hooks\.example\.test\/line\/main\/media\/[A-Za-z0-9_-]{32}$/,
  );
  assert.notEqual(sent.previewImageUrl, sent.originalContentUrl);
  const path = new URL(sent.originalContentUrl).pathname;
  const previewPath = new URL(sent.previewImageUrl).pathname;
  const fetchLocal = (pathname: string, method = 'GET') =>
    fetch(f.base + pathname, { method });
  const verify = async (response: Response, maxAge: number, body = tinyPng) => {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(
      response.headers.get('content-length'),
      String(tinyPng.length),
    );
    assert.equal(
      response.headers.get('cache-control'),
      `public, max-age=${maxAge}, immutable`,
    );
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  };
  const maxAge = 14 * 24 * 60 * 60;
  const responses = await Promise.all([
    fetchLocal(path),
    fetchLocal(path),
    fetchLocal(previewPath, 'HEAD'),
  ]);
  await verify(responses[0]!, maxAge);
  await verify(responses[1]!, maxAge);
  await verify(responses[2]!, maxAge, Buffer.alloc(0));
  f.advance(601_500);
  await verify(await fetchLocal(path), maxAge - 602);
  await verify(await fetchLocal(previewPath), maxAge - 602);
  const videoResponse = await fetchLocal(
    new URL(sentVideo.originalContentUrl).pathname,
  );
  assert.equal(videoResponse.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await videoResponse.arrayBuffer()), mp4);
  await waitFor(() => f.info.length >= 6);
  assert.deepEqual(
    f.info.sort((a, b) =>
      String(a[1]?.method).localeCompare(String(b[1]?.method)),
    ),
    [
      ...Array.from({ length: 5 }, () => [
        'line.media_served',
        { method: 'GET' },
      ]),
      ['line.media_served', { method: 'HEAD' }],
    ],
  );

  for (const invalid of [
    '/line/main/media/' + 'a'.repeat(32),
    path + '.json',
    path + '/',
  ]) {
    assert.equal((await fetchLocal(invalid)).status, 404);
  }
  const traversalStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const url = new URL(f.base);
      get(
        url,
        { path: path.replace('/media/', '/media/extra/../') },
        (response) => {
          response.resume().on('end', () => resolve(response.statusCode));
        },
      ).on('error', reject);
    },
  );
  assert.equal(traversalStatus, 404);
  assert.equal((await fetchLocal(path, 'POST')).status, 404);
  f.advance(maxAge * 1000);
  const expired = await fetchLocal(path);
  assert.equal(expired.status, 404);
  assert.equal(expired.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.info.slice(6), [
    ...Array.from({ length: 4 }, () => [
      'line.media_miss',
      { reason: 'unknown' },
    ]),
    ['line.media_miss', { reason: 'method' }],
    ['line.media_miss', { reason: 'expired' }],
  ]);
});

test('LINE queues AAC audio and hosts it with the original duration and retention', async (t) => {
  const f = await fixture(t, fakeApi(), { publicMedia: true });
  const destination = { chatId: userId, replyTo: '73' };
  await f.post([message('73')]);
  await f.waitFor(1);
  const signal = AbortSignal.timeout(3000);
  const bytes = Buffer.from('0000ftypM4A synthetic encoded audio');
  const upload = {
    ...destination,
    file: { name: 'speech.m4a', bytes, mime: 'audio/mp4' },
    audioDurationMs: 250,
    preview: () => assert.fail('LINE audio needs no preview'),
  };
  const { maxBytes } = f.adapter.capabilities.audio!;
  assert.equal(maxBytes, 20 * 1024 ** 2);
  await assert.rejects(
    f.adapter.sendAudio({ ...upload, audioDurationMs: 0 }, signal),
    /positive duration/,
  );
  await assert.rejects(
    f.adapter.sendAudio(
      {
        ...upload,
        file: { ...upload.file, bytes: Buffer.alloc(maxBytes + 1) },
      },
      signal,
    ),
    /20 MB size limit/,
  );
  const queued = await f.adapter.sendAudio(upload, signal);
  assert.equal(
    f.api.calls.find(({ path }) => path.endsWith('/reply')),
    undefined,
  );
  const receipt = await f.adapter.send(
    { ...destination, text: '' },
    { media: [queued], signal },
  );
  assert.deepEqual(receipt.parts, [
    { messageId: '1', mediaId: queued.id, text: '[audio]' },
  ]);
  const reply = f.api.calls.find(({ path }) => path.endsWith('/reply'));
  assert.equal(reply?.body?.replyToken, 'token-73');
  const [audio] = reply?.body?.messages ?? [];
  assert.equal(audio?.type, 'audio');
  const { originalContentUrl } = audio;
  assert.match(
    originalContentUrl,
    /^https:\/\/hooks\.example\.test\/line\/main\/media\/[A-Za-z0-9_-]{32}$/,
  );
  assert.deepEqual(audio, { type: 'audio', originalContentUrl, duration: 250 });
  const href = f.base + new URL(originalContentUrl).pathname;
  const response = await fetch(href);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mp4');
  assert.equal(
    response.headers.get('cache-control'),
    'public, max-age=1209600, immutable',
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  f.advance(14 * 24 * 60 * 60_000);
  assert.equal((await fetch(href)).status, 404);
});

test('LINE uses eligible web image URLs and hosts the remaining image parts', async (t) => {
  const maxLengthUrl = imageUrl.padEnd(2000, 'a');
  for (const { bytes, directParts, label, makePreview, sourceUrl } of [
    {
      label: 'HTTPS JPEG at both direct preview limits',
      bytes: Buffer.concat([
        Buffer.from('ffd8ff', 'hex'),
        Buffer.alloc(1024 ** 2 - 3),
      ]),
      sourceUrl: maxLengthUrl,
      directParts: 2,
    },
    {
      label: '3 MiB PNG',
      bytes: webPng,
      sourceUrl: imageUrl,
      directParts: 1,
      makePreview: true,
    },
    {
      label: 'HTTP PNG',
      bytes: tinyPng,
      sourceUrl: imageUrl.replace('https:', 'http:'),
      directParts: 0,
    },
    {
      label: 'URL over the length limit',
      bytes: tinyPng,
      sourceUrl: maxLengthUrl + 'a',
      directParts: 0,
    },
    {
      label: 'GIF',
      bytes: Buffer.from('GIF89a'),
      sourceUrl: imageUrl,
      directParts: 0,
      makePreview: true,
    },
    {
      label: 'WebP',
      bytes: Buffer.from('RIFF\0\0\0\0WEBP'),
      sourceUrl: imageUrl,
      directParts: 0,
      makePreview: true,
    },
    { label: 'workspace PNG', bytes: tinyPng, directParts: 0 },
  ]) {
    await t.test(label, async (t) => {
      const f = await fixture(t, fakeApi(), { publicMedia: directParts < 2 });
      const destination = { chatId: userId };
      let previews = 0;
      const queued = await f.adapter.sendImage(
        {
          ...destination,
          file: { name: 'image', bytes },
          sourceUrl,
          async preview(maxBytes) {
            assert.equal(maxBytes, 1024 ** 2);
            previews++;
            return { bytes: tinyPng, mime: 'image/png' };
          },
        },
        AbortSignal.timeout(3000),
      );
      await f.adapter.send({ ...destination, text: '' }, { media: [queued] });
      const sent = f.api.calls.at(-1)?.body?.messages?.[0];
      assert.equal(sent?.type, 'image');
      for (const [i, url] of [
        sent.originalContentUrl,
        sent.previewImageUrl,
      ].entries()) {
        if (i < directParts) assert.equal(url, sourceUrl);
        else {
          assert.match(
            url,
            /^https:\/\/hooks\.example\.test\/line\/main\/media\//,
          );
          const response = await fetch(f.base + new URL(url).pathname);
          assert.equal(response.status, 200);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), tinyPng);
        }
      }
      assert.equal(previews, makePreview ? 1 : 0);
      assert.equal(
        (await readdir(f.mediaDirectory)).length,
        (2 - directParts) * 2,
      );
      assert.deepEqual(
        f.info.filter(([event]) => event === 'line.media_direct'),
        directParts
          ? [
              [
                'line.media_direct',
                { original: true, preview: directParts === 2 },
              ],
            ]
          : [],
      );
    });
  }
});

test('LINE releases the hosted preview when a mixed image send fails', async (t) => {
  const api = fakeApi(({ path }) =>
    path.endsWith('/push') ? Response.json({}, { status: 400 }) : undefined,
  );
  const f = await fixture(t, api, { publicMedia: true });
  const destination = { chatId: userId };
  const queued = await f.adapter.sendImage(
    {
      ...destination,
      file: { name: 'picture.png', bytes: webPng },
      sourceUrl: imageUrl,
      async preview() {
        return { bytes: tinyPng, mime: 'image/png' };
      },
    },
    AbortSignal.timeout(3000),
  );
  await assert.rejects(
    f.adapter.send({ ...destination, text: '' }, { media: [queued] }),
    (error) => error instanceof SendFailure && !error.deliveryUnknown,
  );
  const sent = api.calls.at(-1)?.body?.messages?.[0];
  assert.equal(sent?.type, 'image');
  assert.equal(sent.originalContentUrl, imageUrl);
  const preview = await fetch(f.base + new URL(sent.previewImageUrl).pathname);
  assert.equal(preview.status, 404);
  assert.deepEqual(await readdir(f.mediaDirectory), []);
});

async function sendSmallImage(adapter: LineAdapter, bytes = tinyPng) {
  const destination = { chatId: userId };
  const queued = await adapter.sendImage(
    {
      ...destination,
      file: { name: 'small.png', bytes },
      preview: () => assert.fail('unexpected preview'),
    },
    AbortSignal.timeout(3000),
  );
  return adapter.send({ ...destination, text: '' }, { media: [queued] });
}

function sentMediaPaths(api: ReturnType<typeof fakeApi>) {
  const sent = api.calls.at(-1)?.body?.messages?.[0];
  assert.equal(sent?.type, 'image');
  return [sent.originalContentUrl, sent.previewImageUrl].map(
    (url) => new URL(url).pathname,
  );
}

test('LINE media survives an adapter restart and startup removes expired files', async (t) => {
  const f = await fixture(t, fakeApi(), {
    publicMedia: true,
    mediaTtlMs: 2000,
  });
  await sendSmallImage(f.adapter);
  const expiredPaths = sentMediaPaths(f.api);
  f.advance(1500);
  await sendSmallImage(f.adapter);
  const livePaths = sentMediaPaths(f.api);
  await f.adapter.stop();
  assert.equal((await readdir(f.mediaDirectory)).length, 8);

  const restarted = await fixture(t, fakeApi(), {
    publicMedia: true,
    mediaDirectory: f.mediaDirectory,
    now: 3000,
  });
  assert.deepEqual(
    (await readdir(f.mediaDirectory)).sort(),
    livePaths
      .flatMap((path) => {
        const token = path.split('/').at(-1)!;
        return [token, token + '.json'];
      })
      .sort(),
  );
  for (const path of expiredPaths)
    assert.equal((await fetch(restarted.base + path)).status, 404);
  for (const path of livePaths) {
    const response = await fetch(restarted.base + path);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('cache-control'),
      'public, max-age=1, immutable',
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), tinyPng);
  }
  assert.deepEqual(restarted.info.slice(0, 2), [
    ['line.media_miss', { reason: 'expired' }],
    ['line.media_miss', { reason: 'expired' }],
  ]);
});

test('LINE media evicts the oldest files at the size cap across restarts', async (t) => {
  const options = { publicMedia: true, mediaMaxBytes: tinyPng.length * 4 };
  const f = await fixture(t, fakeApi(), options);
  await sendSmallImage(f.adapter);
  const oldest = sentMediaPaths(f.api);
  await sendSmallImage(f.adapter);
  const newer = sentMediaPaths(f.api);
  await f.adapter.stop();

  const restarted = await fixture(t, fakeApi(), {
    ...options,
    mediaDirectory: f.mediaDirectory,
  });
  await sendSmallImage(restarted.adapter);
  const newest = sentMediaPaths(restarted.api);
  await assert.rejects(
    sendSmallImage(
      restarted.adapter,
      Buffer.concat([tinyPng, Buffer.alloc(options.mediaMaxBytes)]),
    ),
    (error) =>
      error instanceof SendFailure &&
      error.cause instanceof Error &&
      /storage size limit/.test(error.cause.message),
  );
  assert.equal((await readdir(f.mediaDirectory)).length, 8);
  for (const path of oldest)
    assert.equal((await fetch(restarted.base + path)).status, 404);
  for (const path of [...newer, ...newest])
    assert.equal(
      (await fetch(restarted.base + path, { method: 'HEAD' })).status,
      200,
    );
});

test('LINE media is released only when send failure confirms non-delivery', async (t) => {
  for (const [status, deliveryUnknown] of [
    [400, false],
    [200, true],
  ] as const) {
    const api = fakeApi(({ path }) =>
      path.endsWith('/push') ? Response.json({}, { status }) : undefined,
    );
    const f = await fixture(t, api, { publicMedia: true });
    await assert.rejects(
      sendSmallImage(f.adapter),
      (error) =>
        error instanceof SendFailure &&
        error.deliveryUnknown === deliveryUnknown,
    );
    assert.equal(
      (await readdir(f.mediaDirectory)).length,
      deliveryUnknown ? 4 : 0,
    );
    for (const path of sentMediaPaths(api)) {
      assert.equal(
        (await fetch(f.base + path, { method: 'HEAD' })).status,
        deliveryUnknown ? 200 : 404,
      );
    }
  }
});
