import type { MediaUpload } from '@tsugimori/plugin-sdk';
import type { AdapterStartScenario } from '@tsugimori/plugin-sdk/contract-test';
import type { TestContext } from 'node:test';

import { platformHome } from '@tsugimori/plugin-sdk';
import { checkAdapterContract } from '@tsugimori/plugin-sdk/contract-test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import type { Socket } from '../src/trouter.ts';
import type { Data, Wait } from '../src/wire.ts';

import { credentialStore } from '../src/credentials.ts';
import { createTeamsAdapter } from '../src/index.ts';
import { listen } from '../src/trouter.ts';
import { prepareImage } from '../src/upload.ts';

class FakeSocket extends EventTarget implements Socket {
  readyState = 1;
  readonly sent: string[] = [];

  send(frame: string) {
    this.sent.push(frame);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  receive(frame: string) {
    this.dispatchEvent(new MessageEvent('message', { data: frame }));
  }
  event(name: string, args: unknown = {}) {
    this.receive(`5:::${JSON.stringify({ name, args: [args] })}`);
  }
  connect() {
    this.receive('1::');
    this.event('trouter.connected', {
      surl: 'https://unit.trouter.teams.microsoft.com:3443/v4/f/synthetic',
      ttl: 180,
    });
  }
}

test('Trouter registers and renews, acks after delivery, and repairs on loss and reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const sockets: { socket: FakeSocket; url: URL }[] = [];
  const registrations: Data[] = [];
  const events: Data[] = [];
  const recovery: boolean[] = [];
  const backoff: number[] = [];
  const connections: AbortSignal[] = [];
  const ready = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const token = {
    account: '8:self',
    token: 'synthetic-skype',
    expiresAt: Date.now() + 3600_000,
  };
  const job = listen(
    {
      authorize: async () => token,
      invalidate: () => assert.fail('unexpected invalidation'),
      registered(signal) {
        connections.push(signal);
        ready.resolve();
      },
      fetch: async (url, init) => {
        assert.equal(
          String(url),
          'https://teams.microsoft.com/registrar/prod/v2/registrations',
        );
        assert.equal(init?.method, 'POST');
        assert.equal(
          new Headers(init?.headers).get('X-Skypetoken'),
          token.token,
        );
        assert.equal(init?.redirect, 'error');
        registrations.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      },
      socket(url) {
        const socket = new FakeSocket();
        sockets.push({ socket, url });
        return socket;
      },
      warn() {},
      async catchUp(_signal, lost) {
        recovery.push(lost);
      },
      async receive(body) {
        events.push(body);
        await delivered.promise;
      },
    },
    'endpoint-id',
    abort.signal,
    async (wait) => {
      backoff.push(wait);
    },
  );
  await flush();
  const first = sockets[0]!;
  assert.equal(first.url.hostname, 'go.trouter.teams.microsoft.com');
  assert.equal(first.url.pathname, '/v4/c');
  assert.equal(first.url.searchParams.get('epid'), 'endpoint-id');
  first.socket.connect();
  await ready.promise;
  assert.match(first.socket.sent[0]!, /^5:::.+"name":"user.authenticate"/);
  assert.deepEqual(registrations[0], {
    registrationId: 'endpoint-id',
    nodeId: '',
    clientDescription: {
      appId: 'TeamsCDLWebWorker',
      aesKey: '',
      languageId: 'en-US',
      platform: '1415',
      templateKey: 'TeamsCDLWebWorker_2.7',
      platformUIVersion: '1415/1.0.0.0',
      productContext: 'TFL',
    },
    transports: {
      TROUTER: [
        {
          context: '',
          path: 'https://unit.trouter.teams.microsoft.com:3443/v4/f/synthetic',
          ttl: 180,
        },
      ],
    },
  });
  const body = { resourceType: 'NewMessage', resource: { id: '123' } };
  first.socket.receive(
    `3:::${JSON.stringify({
      id: 9,
      url: '/messaging',
      body: gzipSync(JSON.stringify(body)).toString('base64'),
      headers: { 'X-Microsoft-Skype-Content-Encoding': 'gzip' },
    })}`,
  );
  await flush();
  assert.deepEqual(events, [body]);
  assert.equal(first.socket.sent.length, 1);
  first.socket.receive('2::');
  assert.equal(first.socket.sent.at(-1), '2::');
  delivered.resolve();
  await flush();
  assert.equal(first.socket.sent.at(-1), '3:::{"id":9,"status":200,"body":""}');
  first.socket.event('trouter.message_loss', {
    droppedIndicators: ['fixture'],
  });
  await flush();
  assert.deepEqual(recovery, [true]);
  assert.equal(
    first.socket.sent.at(-1),
    '5:::{"name":"trouter.processed_message_loss","args":[{"droppedIndicators":["fixture"]}]}',
  );
  for (let step = 0; step < 5; step++) {
    first.socket.receive('2::');
    t.mock.timers.tick(30_000);
    await flush();
  }
  assert.equal(registrations.length, 2);
  assert.deepEqual(registrations[1], registrations[0]);
  assert.equal(connections.length, 1);

  first.socket.event('trouter.reconnect', {
    target: 'host',
    url: 'wss://next.trouter.skype.com/v4/c',
  });
  await flush();
  assert.equal(first.socket.readyState, 3);
  const second = sockets[1]!;
  assert.equal(second.url.hostname, 'next.trouter.skype.com');
  second.socket.connect();
  await flush();
  assert.deepEqual(recovery, [true, false]);
  assert.equal(registrations.length, 3);
  assert.equal(connections.length, 2);
  assert.equal(connections[0]?.aborted, true);
  assert.equal(connections[1]?.aborted, false);

  second.socket.event('trouter.reconnect', {
    target: 'host',
    url: 'https://next.trouter.skype.com.invalid',
  });
  await flush();
  const third = sockets[2]!;
  assert.equal(third.url.hostname, 'next.trouter.skype.com');
  third.socket.connect();
  await flush();
  assert.deepEqual(recovery, [true, false, false]);

  for (let step = 0; step < 3; step++) {
    t.mock.timers.tick(30_000);
    await flush();
  }
  assert.equal(third.socket.readyState, 3);
  assert.equal(sockets.length, 4);
  assert.deepEqual(backoff, [1000, 1000, 1000]);
  abort.abort();
  await job;
  assert.equal(sockets[3]?.socket.readyState, 3);
});

test('adapter reports rejected refresh as login required and stops repeatedly', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'teams-rejected-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const home = platformHome(workspace, 'teams');
  await credentialStore(workspace, home).save({
    account: '8:self',
    refreshToken: 'fixture',
    displayName: 'Offline fixture',
  });
  const adapter = createTeamsAdapter(
    {
      fetch: async () =>
        Response.json({ error: 'invalid_grant' }, { status: 400 }),
      socket: () =>
        assert.fail('Rejected credentials must never open a WebSocket'),
    },
    { id: 'teams', account: '8:self', workspace, home },
  );
  await assert.rejects(
    adapter.start({ emit: async () => {} }),
    /Teams sign-in required/,
  );
  assert.equal(adapter.login, 'required');
  await Promise.all([adapter.stop(), adapter.stop()]);
  await adapter.stop();
});

test('adapter waits for gateway readiness before delivery and cancels that wait on stop', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'teams-readiness-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const home = platformHome(workspace, 'teams');
  await credentialStore(workspace, home).save({
    account: '8:self',
    refreshToken: 'fixture',
    displayName: 'Offline fixture',
  });
  let nextSocket = Promise.withResolvers<FakeSocket>();
  const adapter = createTeamsAdapter(
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.host === 'login.microsoftonline.com')
          return Response.json({ access_token: 'fake-access' });
        if (url.host === 'teams.microsoft.com') return new Response(null);
        assert.equal(url.pathname, '/api/auth/v1.0/authz/consumer');
        const claims = Buffer.from(
          JSON.stringify({ skypeid: 'self' }),
        ).toString('base64url');
        return Response.json({ skypeToken: `header.${claims}.signature` });
      },
      socket() {
        const socket = new FakeSocket();
        nextSocket.resolve(socket);
        return socket;
      },
    },
    { id: 'teams', account: '8:self', workspace, home },
  );
  t.after(() => adapter.stop());

  const frame = `3:::${JSON.stringify({
    id: 9,
    url: '/messaging',
    body: JSON.stringify({
      resourceType: 'NewMessage',
      resource: {
        id: '123',
        conversationid: '8:peer',
        from: '8:peer',
        messagetype: 'Text',
        content: 'Hi',
      },
    }),
  })}`;
  let emissions = 0;
  const ready = Promise.withResolvers<void>();
  const emit = async () => {
    emissions++;
  };
  const starting = adapter.start({ ready: ready.promise, emit });
  const first = await nextSocket.promise;
  first.connect();
  await starting;
  first.receive(frame);
  await flush();
  assert.equal(emissions, 0);
  assert.equal(first.sent.length, 1);
  ready.resolve();
  await flush();
  assert.equal(emissions, 1);
  assert.equal(first.sent.at(-1), '3:::{"id":9,"status":200,"body":""}');
  await adapter.stop();

  const halted = new AbortController();
  nextSocket = Promise.withResolvers<FakeSocket>();
  const restarting = adapter.start({
    ready: new Promise(() => {}),
    emit,
    signal: halted.signal,
  });
  const second = await nextSocket.promise;
  second.connect();
  await restarting;
  second.receive(frame);
  await flush();
  halted.abort();
  await adapter.stop();
  assert.equal(second.readyState, 3);
  assert.equal(emissions, 1);
});

async function adapterFixture(
  t: TestContext,
  respond: typeof globalThis.fetch,
  wait?: Wait,
  scenario: AdapterStartScenario = 'normal',
) {
  const workspace = await mkdtemp(join(tmpdir(), 'teams-phase-2-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const home = platformHome(workspace, 'teams');
  const account = '8:self';
  await credentialStore(workspace, home).save({
    account,
    refreshToken: 'fixture',
    displayName: 'Offline fixture',
  });
  const sockets: FakeSocket[] = [];
  const warnings: string[] = [];
  const entered = Promise.withResolvers<void>();
  let startupCalls = 0;
  let messagingEndpoint: string | null = null;
  const adapter = createTeamsAdapter(
    {
      wait,
      socket(url) {
        messagingEndpoint = url.searchParams.get('epid');
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.connect());
        return socket;
      },
      fetch(input, init) {
        const url = new URL(String(input));
        if (url.hostname === 'login.microsoftonline.com') {
          startupCalls++;
          if (scenario === 'failed')
            return Promise.resolve(
              Response.json({ error: 'invalid_grant' }, { status: 400 }),
            );
          if (scenario === 'pending') {
            const signal = init?.signal;
            assert.ok(signal);
            entered.resolve();
            return new Promise<Response>((_resolve, reject) => {
              signal.throwIfAborted();
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
            });
          }
          return Promise.resolve(
            Response.json({ access_token: 'fake-access' }),
          );
        }
        if (url.hostname === 'teams.microsoft.com')
          return Promise.resolve(new Response(null));
        if (url.pathname === '/api/auth/v1.0/authz/consumer') {
          const claims = Buffer.from(
            JSON.stringify({ skypeid: account }),
          ).toString('base64url');
          return Promise.resolve(
            Response.json({ skypeToken: `header.${claims}.signature` }),
          );
        }
        return respond(input, init);
      },
    },
    { id: 'teams', account, workspace, home },
  );
  t.after(() => adapter.stop());
  return {
    adapter,
    sockets,
    warnings,
    startupCalls: () => startupCalls,
    startupEntered: entered.promise,
    get messagingEndpoint() {
      return messagingEndpoint;
    },
  };
}

async function connectedAdapter(
  t: TestContext,
  respond: typeof globalThis.fetch,
  wait?: Wait,
) {
  const fixture = await adapterFixture(t, respond, wait);
  await fixture.adapter.start({
    emit: async () => {},
    logWarning: (event) => fixture.warnings.push(event),
  });
  return fixture;
}

function media(bytes: Uint8Array, name: string): MediaUpload {
  return {
    chatId: '8:peer',
    file: { bytes, name },
    preview: async () =>
      assert.fail('Teams native upload uses the original image'),
  };
}

test('Teams reads JPEG, PNG, GIF, and WebP display dimensions with pixel limits', () => {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000032000000190',
    'hex',
  );
  const gif = Buffer.from('47494638396120039001', 'hex');
  const jpeg = Buffer.from('ffd8ffc0000b080190032001011100', 'hex');
  const webp = Buffer.from(
    '524946461600000057454250565038580a000000000000001f03008f0100',
    'hex',
  );
  for (const [subtype, bytes] of Object.entries({ png, gif, jpeg, webp })) {
    assert.deepEqual(prepareImage(media(bytes, 'picture').file), {
      subtype,
      width: 800,
      height: 400,
    });
  }
  png.writeUInt32BE(150_000, 16);
  assert.throws(
    () => prepareImage(media(png, 'too large').file),
    /25 million pixels/,
  );
  assert.throws(
    () =>
      prepareImage(
        media(new Uint8Array(5 * 1024 ** 2 + 1), 'too many bytes').file,
      ),
    /5 MiB/,
  );
});

test('Teams queues inline images with a single caption receipt and sends original files', async (t) => {
  const calls: string[] = [];
  const messages: Data[] = [];
  let object = 0;
  const { adapter } = await connectedAdapter(t, async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method} ${url.pathname}`);
    assert.equal(init?.redirect, 'error');
    if (url.hostname === 'api.asm.skype.com') {
      assert.match(
        new Headers(init?.headers).get('Authorization') ?? '',
        /^skype_token /,
      );
      if (init?.method === 'POST') {
        object++;
        assert.deepEqual(JSON.parse(String(init.body)), {
          type: object === 3 ? 'sharing/file' : 'pish/image',
          ...(object === 3 ? {} : { sharingMode: 'Inline' }),
          filename: object === 3 ? 'a & b.pdf' : 'picture<.png',
          permissions: { '8:peer': ['read'] },
        });
        return Response.json({ id: `object-${object}` });
      }
      assert.ok(init?.body instanceof Uint8Array);
      assert.equal(init.body.byteLength, object === 3 ? 3 : 24);
      return new Response(null);
    }
    assert.equal(url.hostname, 'teams.live.com');
    messages.push(JSON.parse(String(init?.body)));
    return Response.json({
      OriginalArrivalTime: String(100 + messages.length),
    });
  });
  const signal = AbortSignal.timeout(3000);
  const picture = media(
    Buffer.from('89504e470d0a1a0a0000000d494844520000032000000190', 'hex'),
    'picture<.png',
  );
  const first = await adapter.sendImage!(picture, signal);
  const second = await adapter.sendImage!(picture, signal);
  assert.ok('queued' in first && 'queued' in second);
  assert.deepEqual(calls, []);
  await assert.rejects(
    adapter.send(
      { chatId: '8:other', text: 'Caption' },
      { media: [first], signal },
    ),
    /belongs to a different reply/,
  );
  const receipt = await adapter.send(
    { chatId: '8:peer', text: 'A **caption**', format: 'markdown' },
    { media: [first, second], signal },
  );
  assert.deepEqual(receipt, {
    messageId: '101',
    parts: [
      {
        messageId: '101',
        mediaIds: [first.id, second.id],
        text: 'A **caption**',
      },
    ],
  });
  await assert.rejects(
    adapter.send({ chatId: '8:peer', text: '' }, { media: [first], signal }),
    /belongs to a different reply/,
  );
  assert.deepEqual(
    await adapter.sendFile!(media(Buffer.from('pdf'), 'a & b.pdf'), signal),
    { messageId: '102' },
  );
  assert.deepEqual(calls, [
    'POST /v1/objects/',
    'PUT /v1/objects/object-1/content/imgpsh',
    'POST /v1/objects/',
    'PUT /v1/objects/object-2/content/imgpsh',
    'POST /api/chatsvc/consumer/v1/users/ME/conversations/8%3Apeer/messages',
    'POST /v1/objects/',
    'PUT /v1/objects/object-3/content/original',
    'POST /api/chatsvc/consumer/v1/users/ME/conversations/8%3Apeer/messages',
  ]);
  const [image, file] = messages;
  assert.equal(image?.messagetype, 'RichText/Html');
  assert.deepEqual(image?.amsreferences, ['object-1', 'object-2']);
  assert.match(
    String(image?.content),
    /^<p>A <strong>caption<\/strong><\/p><p><img /,
  );
  assert.match(
    String(image?.content),
    /object-1\/views\/imgo.*itemscope="png" width="400" height="200" alt="picture&lt;.png"/,
  );
  assert.equal(file?.messagetype, 'RichText/Media_GenericFile');
  assert.deepEqual(file?.amsreferences, ['object-3']);
  assert.match(
    String(file?.content),
    /^<URIObject type="File.1" uri="https:\/\/api.asm.skype.com\/v1\/objects\/object-3"><Title>a &amp; b.pdf<\/Title>.*<FileSize v="3"\/>/,
  );
});

test('Teams reacts with native keys and limits edits and deletes to the signed-in account', async (t) => {
  const methods: string[] = [];
  const quote =
    '<blockquote itemtype="http://schema.skype.com/Reply" itemid="111"><p>Old quote</p></blockquote>';
  const quoted = '[{"messageId":"111"}]';
  const { adapter } = await connectedAdapter(t, async (input, init) => {
    const url = new URL(String(input));
    methods.push(
      `${init?.method} ${url.pathname.split('/messages/')[1]}${url.search}`,
    );
    if (init?.method === 'GET')
      return Response.json({
        id: url.pathname.split('/').at(-1),
        conversationid: '8:peer',
        fromId: url.pathname.endsWith('/124') ? '8:peer' : '8:self',
        content: quote + '<p>Original</p>',
        properties: { qtdMsgs: quoted },
        messagetype: 'RichText/Html',
      });
    if (url.searchParams.get('name') === 'emotions') {
      const { emotions } = JSON.parse(String(init?.body));
      assert.equal(emotions.key, 'heart');
      assert.equal(typeof emotions.value, 'number');
    } else if (init?.method === 'PUT') {
      const value = JSON.parse(String(init.body));
      assert.equal(value.content, quote + '<p>Updated</p>');
      assert.equal(value.properties.qtdMsgs, quoted);
    }
    return new Response(null);
  });
  const signal = AbortSignal.timeout(2000);
  const destination = { chatId: '8:peer', messageId: '123' };
  await adapter.sendReaction!({ ...destination, emoji: '❤️' }, signal);
  await assert.rejects(
    adapter.sendReaction!({ ...destination, emoji: '🥑' }, signal),
    /unsupported by Teams/,
  );
  await adapter.updateChoices!(
    { ...destination, buttons: [], text: 'Updated' },
    signal,
  );
  await adapter.deleteMessage!(destination);
  await assert.rejects(
    adapter.deleteMessage!({ ...destination, messageId: '124' }),
    /its own messages/,
  );
  await assert.rejects(
    adapter.updateChoices!({
      ...destination,
      messageId: '124',
      buttons: [],
      text: 'Denied',
    }),
    /its own messages/,
  );
  assert.deepEqual(methods, [
    'PUT 123/properties?name=emotions',
    'GET 123',
    'PUT 123',
    'GET 123',
    'DELETE 123?behavior=softDelete',
    'GET 124',
    'GET 124',
  ]);
});

function controlledWait() {
  const pauses: { ms: number; resume(): void; signal: AbortSignal }[] = [];
  const wait: Wait = (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.throwIfAborted();
      signal.addEventListener('abort', abort, { once: true });
      pauses.push({
        ms,
        signal,
        resume() {
          signal.removeEventListener('abort', abort);
          resolve();
        },
      });
    });
  return { pauses, wait };
}

test('Teams typing refreshes every four seconds and stops on caller abort', async (t) => {
  const { pauses, wait } = controlledWait();
  let controls = 0;
  const { adapter, warnings } = await connectedAdapter(
    t,
    async (input, init) => {
      assert.match(String(input), /\/conversations\/8%3Apeer\/messages$/);
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        content: '',
        contenttype: 'Application/Message',
        messagetype: 'Control/Typing',
      });
      controls++;
      return new Response(null);
    },
    wait,
  );
  const caller = new AbortController();
  t.after(() => caller.abort());
  adapter.typing!({ chatId: '8:peer' }, caller.signal);
  await flush();
  assert.equal(controls, 1);
  assert.equal(pauses[0]?.ms, 4000);
  pauses[0]?.resume();
  await flush();
  assert.equal(controls, 2);
  assert.equal(pauses[1]?.ms, 4000);
  caller.abort();
  pauses[1]?.resume();
  await flush();
  assert.equal(controls, 2);
  assert.deepEqual(warnings, []);
});

test('Teams publishes and refreshes an isolated presence endpoint, repairs it, and cleans up', async (t) => {
  const { pauses, wait } = controlledWait();
  const methods: string[] = [];
  let endpoint: string | null = null;
  let activities = 0;
  const f = await connectedAdapter(
    t,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/messages'))
        return Response.json({ messages: [] });
      assert.equal(url.hostname, 'teams.live.com');
      assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      assert.match(headers.get('X-Skypetoken') ?? '', /^header\./);
      assert.equal(headers.get('X-MS-Client-Consumer-Type'), 'teams4life');
      const headerId = headers.get('x-ms-endpoint-id');
      endpoint ??= headerId;
      assert.equal(headerId, endpoint);
      assert.notEqual(endpoint, f.messagingEndpoint);
      assert.match(endpoint ?? '', /^[\da-f-]{36}$/i);
      const path = url.pathname.slice('/ups/global/v1/me/'.length);
      methods.push(`${init?.method} ${path}`);
      if (init?.method === 'PUT') {
        assert.deepEqual(JSON.parse(String(init.body)), {
          id: endpoint,
          availability: 'Available',
          activity: 'Available',
          deviceType: 'Web',
          activityReporting: 'Direct',
        });
      } else if (init?.method === 'POST') {
        assert.deepEqual(JSON.parse(String(init.body)), {
          endpointId: endpoint,
          isActive: true,
        });
        activities++;
        if (activities === 1)
          return new Response(null, {
            status: 429,
            headers: { 'Retry-After': '90' },
          });
        if (activities === 2) return new Response(null, { status: 404 });
      } else {
        assert.equal(path, `endpoints/${endpoint}`);
        return new Response(null, { status: 404 });
      }
      return new Response(null);
    },
    wait,
  );
  assert.equal(methods.length, 0);
  await assert.rejects(
    f.adapter.setPresence!({ state: 'busy' }),
    /Unsupported Teams presence state/,
  );
  await f.adapter.setPresence!({ state: 'online' });
  await flush();
  assert.deepEqual(methods, ['PUT endpoints/']);
  assert.equal(pauses[0]?.ms, 60_000);
  pauses[0]?.resume();
  await flush();
  assert.equal(pauses[1]?.ms, 90_000);
  pauses[1]?.resume();
  await flush();
  assert.deepEqual(methods, [
    'PUT endpoints/',
    'POST reportmyactivity/',
    'POST reportmyactivity/',
    'PUT endpoints/',
  ]);
  assert.equal(pauses[2]?.ms, 60_000);
  f.sockets[0]?.event('trouter.reconnect', {
    target: 'host',
    url: 'wss://next.trouter.skype.com/v4/c',
  });
  await flush();
  assert.equal(pauses[2]?.signal.aborted, true);
  assert.equal(pauses[3]?.ms, 1000);
  pauses[3]?.resume();
  await flush();
  assert.equal(f.sockets.length, 2);
  assert.deepEqual(methods.slice(-2), ['PUT endpoints/', 'PUT endpoints/']);
  await f.adapter.setPresence!({ state: 'offline' });
  await f.adapter.stop();
  assert.equal(methods.at(-1), `DELETE endpoints/${endpoint}`);
  assert.equal(
    methods.filter((method) => method.startsWith('DELETE')).length,
    1,
  );
  assert.equal(pauses[4]?.signal.aborted, true);
  assert.deepEqual(f.warnings, [
    'teams.presence_refresh_failed',
    'teams.presence_refresh_failed',
  ]);
});

test(
  'Teams conforms to the platform contract',
  { timeout: 5000 },
  async (t) => {
    const chatId = '8:peer';
    await checkAdapterContract({
      message: { chatId, text: 'Contract message' },
      media: {
        images: media(
          Buffer.from(
            '89504e470d0a1a0a0000000d494844520000032000000190',
            'hex',
          ),
          'test.png',
        ),
        files: media(Buffer.from('test'), 'test.txt'),
      },
      oversizedError: /uploads require/i,
      startupError: /Teams sign-in required/,
      async create(scenario) {
        const { pauses, wait } = controlledWait();
        const typed = Promise.withResolvers<void>();
        let typingCalls = 0;
        let deliveries = 0;
        const fixture = await adapterFixture(
          t,
          async (input, init) => {
            const url = new URL(String(input));
            if (url.hostname === 'api.asm.skype.com') {
              deliveries++;
              if (init?.method === 'POST')
                return Response.json({ id: 'object' });
              return new Response(null);
            }
            assert.match(url.pathname, /\/conversations\/8%3Apeer\/messages$/);
            const body = JSON.parse(String(init?.body));
            if (body.messagetype === 'Control/Typing') {
              typingCalls++;
              typed.resolve();
              return new Response(null);
            }
            return Response.json({ OriginalArrivalTime: String(++deliveries) });
          },
          wait,
          scenario,
        );
        return {
          ...fixture,
          deliveryCount: () => deliveries,
          async receive() {
            const socket = fixture.sockets[0];
            assert.ok(socket);
            for (const [id, from, resourceType] of [
              [101, '8:self', 'NewMessage'],
              [102, '8:peer', 'NewMessage'],
              [103, '8:peer', 'MessageRemoved'],
            ] as const) {
              socket.receive(
                '3:::' +
                  JSON.stringify({
                    id,
                    url: '/messaging',
                    body: JSON.stringify({
                      resourceType,
                      resource: {
                        id: String(id),
                        conversationid: chatId,
                        from,
                        messagetype: 'Text',
                        content: 'Hello',
                      },
                    }),
                  }),
              );
            }
            await flush();
            assert.ok(
              socket.sent.some((frame) =>
                frame.includes('"id":103,"status":200'),
              ),
            );
            return {
              messageId: '102',
              ownEcho: { disposition: 'ignored', messageId: '101' },
            };
          },
          typing: {
            calls: () => typingCalls,
            waitForCall: () => typed.promise,
            async tick() {
              await flush();
              for (const pause of pauses.filter(({ ms }) => ms === 4000))
                pause.resume();
              await flush();
            },
          },
        };
      },
    });
  },
);
