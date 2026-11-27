import type { AdminEvent, AdminReader } from '@tsugimori/plugin-sdk';
import type { KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { NamedTunnel } from '../../tunnel-cloudflare/src/index.ts';
import { createFixtureReader } from '../scripts/fixtures.ts';
import { AdminServer, createAccessVerifier } from '../src/index.ts';

function accessJwt(
  key: KeyObject,
  claims: Record<string, unknown> = {},
  kid = 'first',
) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid });
  const body = encode({
    aud: ['app'],
    exp: 200,
    iss: 'https://example.cloudflareaccess.com',
    ...claims,
  });
  const data = `${header}.${body}`;
  const signature = sign('RSA-SHA256', Buffer.from(data), key);
  return `${data}.${signature.toString('base64url')}`;
}

test('Access JWTs require a valid key, audience, expiry, and owner identity', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const second = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let now = 100_000;
  let requests = 0;
  let jwk = {
    ...publicKey.export({ format: 'jwk' }),
    alg: 'RS256',
    kid: 'first',
  };
  const verify = createAccessVerifier({
    now: () => now,
    fetch: async (url) => {
      assert.equal(
        url,
        'https://example.cloudflareaccess.com/cdn-cgi/access/certs',
      );
      requests++;
      return Response.json({ keys: [jwk] });
    },
  });
  const identity = {
    team: 'example',
    aud: 'app',
    ownerEmail: 'owner@example.test',
  };
  function token(
    claims: Record<string, unknown> = {},
    kid = 'first',
    key = privateKey,
  ) {
    return accessJwt(key, { email: identity.ownerEmail, ...claims }, kid);
  }
  assert.equal(await verify(token(), identity), 'owner');
  assert.equal(await verify(token({ aud: ['other'] }), identity), false);
  assert.equal(
    await verify(token({ email: 'other@example.test' }), identity),
    false,
  );
  assert.equal(await verify(token({ exp: 99 }), identity), false);
  assert.equal(
    await verify(token({}, 'first', second.privateKey), identity),
    false,
  );
  assert.equal(requests, 1);
  now += 6000;
  jwk = {
    ...second.publicKey.export({ format: 'jwk' }),
    alg: 'RS256',
    kid: 'second',
  };
  assert.equal(
    await verify(token({}, 'second', second.privateKey), identity),
    'owner',
  );
  assert.equal(requests, 2);

  // Service token JWTs carry the client ID in common_name and no email.
  const service = (claims: Record<string, unknown> = {}) =>
    token(
      {
        email: undefined,
        sub: '',
        type: 'app',
        common_name: 'viewer.access',
        ...claims,
      },
      'second',
      second.privateKey,
    );
  const viewers = { ...identity, viewerServiceTokens: ['viewer.access'] };
  assert.equal(await verify(service(), identity), false);
  assert.equal(await verify(service(), viewers), 'viewer');
  assert.equal(await verify(service({ aud: 'app' }), viewers), 'viewer');
  assert.equal(await verify(service({ aud: 'other' }), viewers), false);
  assert.equal(
    await verify(service({ common_name: 'other.access' }), viewers),
    false,
  );
  assert.equal(
    await verify(service({ email: 'other@example.test' }), viewers),
    false,
  );
  assert.equal(await verify(service({ sub: 'someone' }), viewers), false);
  assert.equal(await verify(service({ aud: ['other'] }), viewers), false);
  assert.equal(
    await verify(token({}, 'second', second.privateKey), viewers),
    'owner',
  );
});

test('listed Access users can read the console while named previews require the owner', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const otherKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey;
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    alg: 'RS256',
    kid: 'first',
  };
  const verify = createAccessVerifier({
    now: () => 100_000,
    fetch: async () => Response.json({ keys: [jwk] }),
  });
  const access = {
    aud: 'app',
    team: 'example',
    ownerEmail: 'owner@example.test',
    viewerEmails: ['Viewer@Example.test', 'owner@example.test'],
  };
  const viewer = { email: 'vIeWeR@example.TEST', sub: 'viewer-id' };
  const owner = { email: access.ownerEmail, sub: 'owner-id' };
  const viewerJwt = accessJwt(privateKey, viewer);
  assert.equal(await verify(viewerJwt, access), 'viewer');
  assert.equal(await verify(accessJwt(privateKey, owner), access), 'owner');

  const { reader } = createFixtureReader();
  let errors = 0;
  const admin = new AdminServer(
    { reader, verify, logError: () => errors++ },
    { access, listen: '127.0.0.1:0' },
  );
  const { port } = await admin.start();
  t.after(() => admin.stop());
  const read = (path: string, jwt: string, method = 'GET') =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Cf-Access-Jwt-Assertion': jwt },
      method,
    });
  const chat = reader.chats()[0]!;
  const query = new URLSearchParams({
    adapter: chat.adapterId,
    id: chat.chatId,
  });
  for (const path of [`/api/chat?${query}`, '/api/tasks']) {
    const response = await read(path, viewerJwt);
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.equal((await read('/api/tasks', viewerJwt, 'POST')).status, 405);

  const denied = [
    accessJwt(privateKey, { ...viewer, email: 'unlisted@example.test' }),
    accessJwt(privateKey, { ...viewer, exp: 99 }),
    accessJwt(privateKey, { ...viewer, nbf: 101 }),
    accessJwt(privateKey, { ...viewer, aud: ['other'] }),
    accessJwt(privateKey, {
      ...viewer,
      iss: 'https://other.cloudflareaccess.com',
    }),
    accessJwt(privateKey, { ...viewer, sub: undefined }),
    accessJwt(privateKey, { ...viewer, sub: '' }),
    accessJwt(privateKey, { ...viewer, common_name: 'viewer.access' }),
    accessJwt(otherKey, viewer),
  ];
  for (const jwt of denied) {
    const response = await read('/api/tasks', jwt);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'forbidden' });
  }
  assert.equal(errors, 0);

  const origin = createServer((_request, response) => response.end('preview'));
  await once(origin.listen(0, '127.0.0.1'), 'listening');
  t.after(() => origin[Symbol.asyncDispose]());
  const named = new NamedTunnel(
    {
      verify,
      fetch: async () =>
        Response.json({ success: true, result: { id: 'a'.repeat(32) } }),
    },
    {
      access: { ...access, aud: 'preview' },
      domain: 'example.test',
      port: 0,
      token: 'test-token',
      tunnelId: '01234567-0123-4567-89ab-0123456789ab',
      zoneId: 'b'.repeat(32),
    },
  );
  t.after(() => named.stop());
  const preview = await named.open({
    endpoint: {
      host: '127.0.0.1',
      port: (origin.address() as AddressInfo).port,
    },
    openedBy: 'owner',
    signal: new AbortController().signal,
    ttlMs: 60_000,
  });
  const previewPort = await named.start();
  const openPreview = (claims: typeof viewer) =>
    new Promise<number | undefined>((resolve, reject) => {
      const request = get(
        {
          hostname: '127.0.0.1',
          port: previewPort,
          headers: {
            Host: new URL(preview.url).host,
            'Cf-Access-Jwt-Assertion': accessJwt(privateKey, {
              ...claims,
              aud: ['preview'],
            }),
          },
        },
        (response) => {
          response.on('error', reject);
          response.on('end', () => resolve(response.statusCode));
          response.resume();
        },
      );
      request.on('error', reject);
    });
  assert.equal(await openPreview(viewer), 403);
  assert.equal(await openPreview(owner), 200);
});

const payload = '<script>alert(1)</script> "><img src=x onerror=alert(1)>';
const ref = { adapterId: 'telegram:main', chatId: 'room' };
const headers = { 'Cf-Access-Jwt-Assertion': 'trusted' };
const tool = {
  args: '{"name":"example"}',
  callId: 'call',
  endedAt: 2,
  name: 'fixture.call',
  result: JSON.stringify({ payload }),
  seq: 11,
  startedAt: 1,
  status: 'error' as const,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tsugimori-web-'));
  const listeners = new Set<(event: AdminEvent) => void>();
  const chat = {
    ...ref,
    title: payload,
    allowlisted: false,
    kind: 'dm',
    platform: 'telegram',
    threadId: '66',
    lastActivity: null,
    messageCount: 1,
    pendingApprovals: 0,
    activeTask: null,
    lastTaskStatus: null,
    latestSeq: 1,
    route: { isDefault: true },
    summary: null,
  };
  const reader: AdminReader = {
    agents: () => [],
    workspace: () => ({ locale: 'zh-TW', timezone: 'Asia/Taipei' }),
    overview: () => ({
      webhook: { state: 'unconfigured' },
      records: { bytes: 0, maxBytes: 2147483648 },
      chats: [chat],
      totals: { chats: 1, tasksToday: 4, failedToday: 2, pendingApprovals: 0 },
    }),
    task: async (id) =>
      id === 'task'
        ? {
            task: {
              ...ref,
              id,
              createdAt: 1,
              agentId: 'agent',
              model: 'resolved',
              startedAt: 2,
              finishedAt: 3,
              status: 'sent',
              tools: [],
            },
            events: [
              { kind: 'text', at: 2, seq: 1, data: { text: 'Agent reply' } },
            ],
            context: [
              { kind: 'new', title: 'Owner message', ref: '1', text: payload },
              {
                kind: 'new',
                title: 'message · owner',
                ref: '2',
                text: '[sticker]',
                message: {
                  at: 2,
                  id: 'sticker-message',
                  sender: { id: 'owner', name: null },
                  attachments: [
                    {
                      index: 0,
                      kind: 'sticker',
                      set: '11537',
                      stickerId: '52002734',
                      keywords: [
                        'over board',
                        'Sparkle',
                        'emo',
                        'Satisfied',
                        'good',
                      ],
                    },
                  ],
                },
              },
            ],
            outcome: { kind: 'delivered' },
            output: 'Agent reply',
          }
        : undefined,
    messageRaw: (requested, seq) =>
      requested.adapterId === ref.adapterId &&
      requested.chatId === ref.chatId &&
      seq === 1
        ? { payload }
        : undefined,
    pendingApprovals: () => 0,
    approvals: () => ({ approvals: [], grants: [] }),
    chat: (requested, before) =>
      requested.chatId === ref.chatId
        ? {
            chat,
            older: before === undefined ? 2 : undefined,
            tasks: [],
            messages: [
              {
                deleted: false,
                direction: 'inbound',
                displayName: payload,
                userId: 'u',
                recordedAt: 1,
                seq: before === undefined ? 2 : 1,
                text: payload,
              },
            ],
          }
        : undefined,
    chats: () => [chat],
    tasks: createFixtureReader().reader.tasks,
    trace: () => undefined,
    toolCall: (task, seq) =>
      task === 'task' && seq === tool.seq ? tool : undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const server = new AdminServer(
    {
      reader,
      uiDirectory: directory,
      pingMs: 25,
      verify: async (jwt) =>
        jwt === 'trusted' ? 'owner' : jwt === 'viewer' ? 'viewer' : false,
    },
    {
      listen: '127.0.0.1:0',
      access: { aud: 'app', team: 'example', ownerSub: '123' },
    },
  );
  const { port } = await server.start();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    directory,
    emit: (event: AdminEvent) => {
      for (const listener of listeners) listener(event);
    },
    stop: async () => {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
      assert.equal(listeners.size, 0);
    },
  };
}

test('gates HTML, assets, API and SSE and serves only manifest assets', async (t) => {
  const f = await fixture();
  t.after(f.stop);
  await mkdir(join(f.directory, '_nuxt'));
  await mkdir(join(f.directory, 'tasks'));
  await writeFile(
    join(f.directory, 'index.html'),
    '<!doctype html><title>Admin SPA</title>',
  );
  await writeFile(join(f.directory, '200.html'), '<title>Admin SPA</title>');
  await writeFile(
    join(f.directory, 'tasks', 'index.html'),
    '<title>Tasks</title>',
  );
  await writeFile(
    join(f.directory, 'files.json'),
    JSON.stringify([
      'index.html',
      '200.html',
      'tasks/index.html',
      '_nuxt/abcABC12.js',
      '_nuxt/ui.abcABC12.woff2',
      '_nuxt/builds/latest.json',
    ]),
  );
  await mkdir(join(f.directory, '_nuxt', 'builds'));
  await writeFile(join(f.directory, '_nuxt', 'abcABC12.js'), 'app()');
  await writeFile(join(f.directory, '_nuxt', 'private.js'), 'not in manifest');
  await writeFile(
    join(f.directory, '_nuxt', 'ui.abcABC12.woff2'),
    'font fixture',
  );
  await writeFile(join(f.directory, '_nuxt', 'builds', 'latest.json'), '{}');

  for (const route of [
    '/',
    '/_nuxt/abcABC12.js',
    '/api/workspace',
    '/api/events',
  ]) {
    for (const jwt of [undefined, 'invalid']) {
      const denied = await fetch(f.url + route, {
        headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {},
      });
      assert.equal(denied.status, 403);
      assert.notEqual(denied.headers.get('content-type'), 'text/event-stream');
      await denied.text();
    }
  }
  // Read-only viewers (listed Access service tokens) can load the console.
  const viewer = await fetch(f.url + '/api/workspace', {
    headers: { 'Cf-Access-Jwt-Assertion': 'viewer' },
  });
  assert.equal(viewer.status, 200);
  await viewer.text();
  for (const route of ['/', '/chat/telegram%3Amain/room/66', '/unknown']) {
    const response = await fetch(f.url + route, { headers });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Admin SPA/);
    assert.equal(
      response.headers.get('content-security-policy'),
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  }
  assert.match(
    await (await fetch(f.url + '/tasks', { headers })).text(),
    /Tasks/,
  );
  const font = await fetch(f.url + '/_nuxt/ui.abcABC12.woff2', { headers });
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  const metadata = await fetch(f.url + '/_nuxt/builds/latest.json', {
    headers,
  });
  assert.match(metadata.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(metadata.headers.get('cache-control'), 'no-store');
  const asset = await fetch(f.url + '/_nuxt/abcABC12.js', { headers });
  assert.equal(await asset.text(), 'app()');
  assert.equal(
    asset.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );
  for (const path of [
    '/_nuxt/missing.js',
    '/_nuxt/private.js',
    '/_nuxt/app-456.css',
    '/_nuxt/../index.html',
    '/_nuxt/%2e%2e/index.html',
    '/_nuxt/..%2findex.html',
  ]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get({ host: '127.0.0.1', port: f.port, path, headers }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 404, path);
  }
  assert.equal((await fetch(f.url, { headers, method: 'POST' })).status, 405);
});

test('offers the APIs before the UI is built and redirects bookmarked routes', async (t) => {
  const f = await fixture();
  t.after(f.stop);
  const index = await fetch(f.url + '/', { headers });
  assert.equal(index.status, 503);
  assert.match(await index.text(), /UI is not built/);
  const conversation = await fetch(
    f.url + '/api/chat?adapter=telegram%3Amain&id=room',
    { headers },
  );
  assert.equal(conversation.headers.get('cache-control'), 'no-store');
  assert.equal(
    conversation.headers.get('content-type'),
    'application/json; charset=utf-8',
  );
  assert.equal((await conversation.json()).messages[0].text, payload);
  const result = await fetch(f.url + '/api/tool-call?task=task&seq=11', {
    headers,
  });
  assert.deepEqual(await result.json(), tool);
  assert.equal(
    (await fetch(f.url + '/api/tool-call?task=missing&seq=11', { headers }))
      .status,
    404,
  );
  const taskUrl = f.url + '/api/task?id=task';
  const rawUrl =
    f.url + '/api/message-raw?adapter=telegram%3Amain&chat=room&seq=1';
  for (const url of [taskUrl, rawUrl])
    assert.equal((await fetch(url)).status, 403);
  const execution = await (await fetch(taskUrl, { headers })).json();
  assert.equal(execution.task.model, 'resolved');
  assert.equal(execution.context[0].text, payload);
  assert.equal(execution.context[1].text, '[sticker]');
  assert.deepEqual(execution.context[1].message.attachments[0].keywords, [
    'over board',
    'Sparkle',
    'emo',
    'Satisfied',
    'good',
  ]);
  assert.equal(execution.events[0].data.text, execution.output);
  assert.deepEqual(await (await fetch(rawUrl, { headers })).json(), {
    payload,
  });
  assert.equal(
    (await fetch(rawUrl.replace('seq=1', 'seq=no'), { headers })).status,
    400,
  );
  assert.equal(
    (await fetch(rawUrl.replace('chat=room', 'chat=wrong'), { headers }))
      .status,
    404,
  );
  for (const [previous, next] of [
    [
      '/chat?adapter=telegram%3Amain&id=room&before=12',
      '/chat/telegram%3Amain/room?before=12',
    ],
    ['/trace?task=task', '/task/task'],
    ['/trace/t%2F1?before=12', '/task/t%2F1?before=12'],
    ['/agents', '/#agents'],
    ['/chats', '/chat'],
    ['/approvals', '/ops'],
    ['/schedules', '/ops'],
  ]) {
    const response = await fetch(f.url + previous, {
      headers,
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), next);
  }
});

test('chat history works through authorized links without JavaScript', async (t) => {
  const f = await fixture();
  t.after(f.stop);
  await writeFile(
    join(f.directory, 'index.html'),
    '<!doctype html><html><body></body></html>',
  );
  await writeFile(
    join(f.directory, 'files.json'),
    JSON.stringify(['index.html']),
  );
  const url = f.url + '/chat/telegram%3Amain/room/66';
  const app = await fetch(url, { headers });
  assert.match(await app.text(), /<noscript>.*view=history#newest/);
  assert.equal((await fetch(url + '?view=history')).status, 403);

  const newest = await fetch(url + '?view=history', { headers });
  assert.equal(newest.status, 200);
  assert.equal(newest.headers.get('cache-control'), 'no-store');
  const html = await newest.text();
  assert.doesNotMatch(html, /<(?:script|img)\b/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /id="m-2"/);
  assert.match(html, /view=history&amp;before=2#newest/);

  const earlier = await fetch(url + '?view=history&before=2', { headers });
  const earlierHtml = await earlier.text();
  assert.match(earlierHtml, /id="m-1"/);
  assert.match(earlierHtml, /已到最早的訊息/);
});

async function open(url: string, last?: string) {
  const response = await fetch(url + '/api/events', {
    headers: {
      ...headers,
      ...(last === undefined ? {} : { 'Last-Event-ID': last }),
    },
  });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.equal(response.headers.get('content-encoding'), null);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    cancel: () => reader.cancel(),
    async until(pattern: RegExp) {
      let match: RegExpMatchArray | null;
      while (!(match = buffer.match(pattern))) {
        const { value, done } = await reader.read();
        if (done) assert.fail(`Stream ended waiting for ${pattern}: ${buffer}`);
        buffer += decoder.decode(value, { stream: true });
      }
      buffer = buffer.slice(match.index! + match[0].length);
      return match;
    },
    async end() {
      while (!(await reader.read()).done) {
        /* drain buffered frames */
      }
    },
  };
}

test(
  'SSE flushes, pings, replays, resets after gaps, and closes on reload',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture();
    t.after(f.stop);
    const first = await open(f.url);
    const [, initial] = await first.until(
      /id: (\d+)\nevent: ready\ndata: {}\n\n/,
    );
    await first.until(/: ping\n\n/);
    f.emit({ kind: 'message', ...ref, seq: 1, direction: 'inbound' });
    const [, message] = await first.until(
      /id: (\d+)\nevent: message\ndata: [^\n]+\n\n/,
    );
    assert.ok(Number(message) > Number(initial));
    await first.cancel();
    f.emit({
      kind: 'task',
      ...ref,
      id: 'x',
      status: 'running',
      agentId: 'a',
      model: 'm',
      startedAt: 1,
      endedAt: null,
    });
    f.emit({
      kind: 'tool',
      taskId: 'x',
      seq: 11,
      name: 'fixture.call',
      status: 'ok',
      startedAt: 1,
      endedAt: 2,
    });
    f.emit({ kind: 'approval', ...ref, id: 'pending', status: 'pending' });
    f.emit({ kind: 'summary', ...ref, throughSeq: 1 });
    const resumed = await open(f.url, message);
    await resumed.until(/event: task\n/);
    await resumed.until(
      /event: tool\ndata: {"taskId":"x","seq":11,"name":"fixture.call","status":"ok","startedAt":1,"endedAt":2}\n/,
    );
    await resumed.until(/event: approval\n/);
    await resumed.until(/event: summary\n/);
    await resumed.cancel();
    for (let i = 0; i < 496; i++) {
      f.emit({
        kind: 'tool',
        taskId: 'x',
        seq: i + 12,
        name: 'a'.repeat(256),
        status: 'ok',
        startedAt: 1,
        endedAt: 2,
      });
    }
    const full = await open(f.url, message);
    await full.until(/"seq":507,/);
    await full.cancel();
    for (let i = 0; i < 501; i++)
      f.emit({ kind: 'message', ...ref, seq: i + 2, direction: 'inbound' });
    const stale = await open(f.url, message);
    await stale.until(/event: reset\ndata: {}\n\n/);
    f.emit({ kind: 'reload' });
    await stale.until(/event: reset\ndata: {}\n\n/);
    await stale.end();
  },
);

test(
  'SSE evicts the oldest of nine streams and closes all when stopped',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture();
    t.after(f.stop);
    const streams = [];
    for (let i = 0; i < 9; i++) streams.push(await open(f.url));
    await streams[0]!.end();
    f.emit({ kind: 'chat', ...ref });
    await Promise.all(
      streams.slice(1).map((stream) => stream.until(/event: chat\n/)),
    );
    await f.stop();
    await Promise.all(streams.slice(1).map((stream) => stream.end()));
  },
);

test('task list authenticates viewers, validates filters, and returns opaque cursors', async (t) => {
  const f = await fixture();
  t.after(f.stop);
  const url = f.url + '/api/tasks';
  assert.equal((await fetch(url)).status, 403);
  const viewer = { 'Cf-Access-Jwt-Assertion': 'viewer' };
  const first = await fetch(url + '?limit=1', { headers: viewer });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const page = await first.json();
  assert.equal(page.tasks.length, 1);
  assert.match(page.nextCursor, /^[\w-]+$/);
  const next = await fetch(
    url + '?' + new URLSearchParams({ limit: '1', cursor: page.nextCursor }),
    { headers },
  );
  assert.equal(next.status, 200);
  const nextPage = await next.json();
  assert.equal(nextPage.tasks.length, 1);
  assert.notEqual(nextPage.tasks[0].id, page.tasks[0].id);
  assert.ok(nextPage.tasks[0].createdAt <= page.tasks[0].createdAt);

  const filtered = await fetch(
    url +
      '?' +
      new URLSearchParams({
        status: 'completed',
        platform: 'telegram',
        chat: JSON.stringify(['telegram', '-1000000000123']),
        agent: 'claude-sdk',
        since: new Date(page.tasks[0].createdAt - 10 * 60_000).toISOString(),
        before: new Date(page.tasks[0].createdAt).toISOString(),
        q: '健康檢查',
      }),
    { headers },
  );
  assert.equal(filtered.status, 200);
  const matches = await filtered.json();
  assert.deepEqual(
    matches.tasks.map((row: { id: string }) => row.id),
    ['fixture-completed'],
  );
  assert.equal(matches.nextCursor, null);

  for (const query of [
    'limit=101',
    'limit=0',
    'limit=1.5',
    'status=bad',
    'sort=unknown',
    'sort=',
    'chat=room',
    'cursor=invalid',
    'before=yesterday',
    'since=2026-02-30',
    'since=2026-11-28&before=2026-11-27',
  ]) {
    const result = await fetch(url + '?' + query, { headers });
    assert.equal(result.status, 400, query);
    assert.deepEqual(await result.json(), { error: 'invalidTaskFilter' });
  }
  assert.equal(
    (await fetch(url, { method: 'POST', headers: viewer })).status,
    405,
  );
});

test('task list follows cursors in each sort order', async (t) => {
  const f = await fixture();
  t.after(f.stop);
  const url = f.url + '/api/tasks?';
  const newest = [
    'fixture-running',
    'fixture-completed',
    'fixture-silent',
    'fixture-failed',
    'fixture-task-1',
    'fixture-task-2',
    'fixture-task-3',
    'fixture-task-4',
  ];
  const orders = {
    newest,
    oldest: [...newest].reverse(),
    duration: [newest[1], ...newest.slice(3), newest[2], newest[0]],
  };
  for (const [sort, expected] of Object.entries(orders)) {
    const params = new URLSearchParams({ limit: '1', sort });
    for (const [index, id] of expected.entries()) {
      const response = await fetch(url + params, { headers });
      assert.equal(response.status, 200);
      const { tasks, nextCursor } = await response.json();
      assert.deepEqual(
        tasks.map((row: { id: string }) => row.id),
        [id],
        sort,
      );
      if (index === expected.length - 1) assert.equal(nextCursor, null);
      else {
        assert.equal(typeof nextCursor, 'string');
        params.set('cursor', nextCursor);
        if (index === 0) {
          const other = new URLSearchParams(params);
          other.set('sort', sort === 'newest' ? 'oldest' : 'newest');
          assert.equal((await fetch(url + other, { headers })).status, 400);
        }
      }
    }
  }
});
