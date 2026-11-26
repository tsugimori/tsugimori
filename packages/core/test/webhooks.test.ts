import type { OutboundMessage, PlatformFactory } from '@tsugimori/plugin-sdk';
import type { TestContext } from 'node:test';

import { loadConfig, loadSettings } from '@tsugimori/config';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Gateway, PluginRegistry } from '../src/index.ts';
import { probePath, WebhookListener } from '../src/webhook-listener.ts';
import { Webhooks } from '../src/webhooks.ts';

async function freeAddress() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return '127.0.0.1:' + address.port;
}

const publicUrl = 'https://hooks.example.com/forward';

function forward(
  address: string,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) {
  const path = new URL(String(input)).pathname.slice('/forward'.length);
  return fetch('http://' + address + path, {
    ...init,
    headers: { connection: 'close' },
  });
}

test('webhook listener starts lazily, routes exact paths, and closes when idle', async (t) => {
  const listen = await freeAddress();
  const listener = new WebhookListener();
  t.after(() => listener.stop());
  await listener.configure(listen);
  assert.equal(listener.isListening(), false);
  const signal = new AbortController().signal;
  const route: Parameters<WebhookListener['register']>[1] = (_req, res) => {
    res.writeHead(200).end('route');
  };
  const first = await listener.register('/example/one/', route, signal);
  await assert.rejects(
    listener.register('/example/one', route, signal),
    /already registered/,
  );
  const second = await listener.register('/example/two/', route, signal);
  const request = (path: string) => fetch('http://' + listen + path);
  for (const path of ['/example/one', '/example/one/?q=1', '/example/two/']) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'route');
  }
  for (const path of [
    '/example/one/other',
    '/unknown',
    probePath + 'not-pending',
  ]) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '');
  }
  await first();
  await first();
  assert.equal((await request('/example/one')).status, 404);
  assert.equal(listener.isListening(), true);
  await second();
  assert.equal(listener.isListening(), false);
});

test('ingress probes require the pending nonce, classify failures, and release the listener', async (t) => {
  const listen = await freeAddress();
  const registry = new PluginRegistry();
  let response: typeof fetch = async () => new Response('other body');
  let timeout = new AbortController().signal;
  const logs: string[] = [];
  const ingress = new Webhooks({
    registry,
    workspace: '/unused',
    timeout: () => timeout,
    fetch: (...args) => response(...args),
    log: ({ event }) => logs.push(event),
  });
  t.after(() => ingress.stop());
  const workspace = await workspaceWith(t, {
    webhooks: { provider: 'manual', publicBaseUrl: publicUrl, listen },
  });
  await ingress.configure(await loadConfig(workspace, registry));
  assert.equal(ingress.status().state, 'checking');
  assert.equal((await ingress.check()).reasonCode, 'wrong_target');
  for (const status of [404, 302]) {
    response = async (_url, init) => {
      assert.equal(init?.redirect, 'manual');
      return new Response('wrong', { status });
    };
    assert.match(
      (await ingress.check()).reason ?? '',
      new RegExp('HTTP ' + status),
    );
  }
  response = async () => {
    throw new Error('connect failed');
  };
  assert.equal((await ingress.check()).reasonCode, 'unreachable');
  const timedOut = new AbortController();
  timeout = timedOut.signal;
  response = async () => {
    timedOut.abort(new DOMException('Timed out', 'TimeoutError'));
    return new Promise<Response>(() => {});
  };
  assert.match((await ingress.check()).reason ?? '', /timeout/);
  timeout = new AbortController().signal;
  let publicProbe = '';
  response = async (input, init) => {
    publicProbe = String(input);
    const nonce = new URL(publicProbe).pathname.split('/').at(-1)!;
    assert.equal(Buffer.from(nonce, 'base64url').length, 32);
    const result = await forward(listen, input, init);
    assert.equal(result.headers.get('content-type'), 'text/plain');
    assert.equal((await forward(listen, input, init)).status, 404);
    return result;
  };
  assert.equal((await ingress.check(true)).state, 'ok');
  assert.equal(logs.at(-1), 'webhook.check_ok');
  assert.equal(ingress.url('/example/one/'), undefined);
  const release = await ingress.register(
    '/example/one/',
    (_req, res) => res.end(),
    new AbortController().signal,
  );
  assert.equal(ingress.url('/example/one/'), publicUrl + '/example/one/');
  assert.equal((await forward(listen, publicProbe)).status, 404);
  await release();
  await assert.rejects(forward(listen, publicProbe));
});

test('pending probe nonces expire after 60 seconds and the listener caps concurrent probes', async (t) => {
  const listen = await freeAddress();
  let now = 0;
  const listener = new WebhookListener({ now: () => now });
  t.after(() => listener.stop());
  await listener.configure(listen);
  const ready = Promise.withResolvers<void>();
  const request = Promise.withResolvers<void>();
  const signal = new AbortController().signal;
  let requests = 0;
  const fake: typeof fetch = async (input, init) => {
    if (++requests === 4) ready.resolve();
    await request.promise;
    return forward(listen, input, init);
  };
  const probes = Array.from({ length: 4 }, () =>
    listener.probe(publicUrl, fake, signal),
  );
  await ready.promise;
  await assert.rejects(
    listener.probe(publicUrl, fake, signal),
    /another probe/,
  );
  now = 60_000;
  request.resolve();
  for (const result of await Promise.all(probes))
    assert.deepEqual(result, { ok: false, status: 404 });
  assert.equal(listener.isListening(), false);
});

async function workspaceWith(t: TestContext, config: object) {
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-webhooks-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'tsugimori.json'), JSON.stringify(config));
  return workspace;
}

test('owner webhook setup saves only after a successful probe and gates the LINE add flow', async (t) => {
  const listen = await freeAddress();
  // The legacy address also applies when the webhook section has not been set up yet.
  const workspace = await workspaceWith(t, {
    locale: 'zh-TW',
    owner: { chat: 'owner' },
    platforms: [
      { id: 'chat', kind: 'chat' },
      { id: 'legacy', kind: 'line', enabled: false, listen },
    ],
  });
  const store = new SqliteStore(':memory:');
  const sent: (OutboundMessage & { id: string })[] = [];
  const started =
    Promise.withResolvers<
      Parameters<Awaited<ReturnType<PlatformFactory>>['start']>[0]
    >();
  const makeLine: PlatformFactory = ({ id }) => ({
    id,
    kind: 'line',
    capabilities: {},
    async start() {},
    async stop() {},
    async send() {
      assert.fail('Unexpected LINE send');
    },
  });
  makeLine.requires = ['webhook'];
  const registry = new PluginRegistry([
    {
      name: 'chat',
      adapters: {
        chat: ({ id }) => ({
          id,
          kind: 'chat',
          capabilities: { inlineButtons: true },
          async respondToApproval() {},
          async start(ctx) {
            started.resolve(ctx);
          },
          async stop() {},
          async send(outbound) {
            const id = String(sent.length + 1);
            sent.push({ ...outbound, id });
            return { messageId: id };
          },
        }),
      },
    },
    {
      name: 'line',
      adapters: { line: makeLine },
      setupSteps: [
        { id: 'channel', title: 'Configure LINE', asks: [], run() {} },
      ],
    },
  ]);
  let routed = false;
  const gateway = new Gateway({
    registry,
    store,
    workspace,
    log: () => {},
    setup: {
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      fetch: (url, init) =>
        routed
          ? forward(listen, url, init)
          : Promise.resolve(new Response(null, { status: 404 })),
    },
  });
  t.after(async () => {
    await gateway.stop();
    store.close();
  });
  await gateway.start();
  const { emit } = await started.promise;
  let id = 0;
  const receive = (text: string, replyTo?: string, userId = 'owner') =>
    emit({
      type: 'message',
      userId,
      chatId: 'owner',
      chatKind: 'dm',
      messageId: 'in-' + ++id,
      text,
      replyTo: replyTo ? { id: replyTo } : undefined,
    });
  await receive('/webhook setup manual', undefined, 'other');
  assert.equal(sent.length, 0);
  await receive('/add platform');
  assert.ok(
    sent
      .at(-1)
      ?.buttons?.flat()
      .some(({ label }) => label === 'line（需先設定 webhook）'),
  );
  const key = JSON.stringify(['add', 'platform', 'new-line']);
  await receive('/add platform line --id new-line');
  const blocked = sent.at(-1);
  assert.match(blocked?.text ?? '', /LINE 需要.*未設定/);
  assert.deepEqual(
    blocked?.buttons?.flat().map(({ label }) => label),
    ['設定 webhook', '重新檢查'],
  );
  assert.equal(store.getSetupRun(key), undefined);

  const find = async (predicate: (value: (typeof sent)[number]) => boolean) => {
    const signal = AbortSignal.timeout(3000);
    for (;;) {
      const value = sent.find(predicate);
      if (value) return value;
      await delay(5, undefined, { signal });
    }
  };
  const setup = async () => {
    const previous = sent.length;
    await receive('/webhook setup manual');
    const prompt = await find(
      ({ id, text }) =>
        Number(id) > previous && text.includes('會轉送到閘道器'),
    );
    await receive(publicUrl, prompt.id);
  };
  await setup();
  await find(({ text }) => text.includes('HTTP 404'));
  assert.equal((await loadSettings(workspace, registry)).webhooks, undefined);
  routed = true;
  await setup();
  await find(({ text }) => text.includes('公開路由驗證通過'));
  assert.deepEqual((await loadSettings(workspace, registry)).webhooks, {
    provider: 'manual',
    listen,
    publicBaseUrl: publicUrl,
  });
  assert.equal(gateway.admin.overview(Date.now()).webhook.state, 'ok');
  await receive('/add platform');
  assert.ok(
    sent
      .at(-1)
      ?.buttons?.flat()
      .some(({ label }) => label === 'line'),
  );
  await receive('/add platform line --id new-line');
  await find(({ text }) => text.includes('new-line 已接上'));
  assert.equal(store.getSetupRun(key)?.status, 'complete');
});
