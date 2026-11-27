import { platformHome } from '@tsugimori/plugin-sdk';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import type { Socket } from '../src/trouter.ts';
import type { Data } from '../src/wire.ts';

import { credentialStore } from '../src/credentials.ts';
import { createTeamsAdapter } from '../src/index.ts';
import { listen } from '../src/trouter.ts';

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
      registered: ready.resolve,
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
