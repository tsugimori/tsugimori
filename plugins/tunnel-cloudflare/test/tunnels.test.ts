import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request } from 'node:http';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';

import { NamedTunnel, QuickTunnel } from '../src/index.ts';
import { close, listen } from '../src/proxy.ts';

async function origin(t: TestContext) {
  const server = createServer((req, res) => {
    res.setHeader('Set-Cookie', [
      'welcome=1; Domain=example.test; Path=/',
      'CF_Authorization=evil; Path=/',
    ]);
    res.end(
      JSON.stringify({
        path: req.url,
        cookie: req.headers.cookie,
        jwt: req.headers['cf-access-jwt-assertion'],
      }),
    );
  });
  const port = await listen(server, 0);
  t.after(() => close(server));
  return { host: '127.0.0.1', port };
}

test('Quick Tunnel exchanges its URL token once and proxies the cookie session', async (t) => {
  const endpoint = await origin(t);
  let proxy = '';
  let stopped = false;
  const quick = new QuickTunnel({
    spawnTunnel(command, args, env) {
      assert.equal(command, 'cloudflared');
      assert.deepEqual(args.slice(0, 2), ['tunnel', '--url']);
      assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
      proxy = args[2]!;
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill() {
          stopped = true;
          queueMicrotask(() => child.emit('close', 0));
          return true;
        },
      });
      queueMicrotask(() =>
        child.stderr.write(
          'tunnel is at https://fake-preview.trycloudflare.com\n',
        ),
      );
      return child as unknown as ChildProcessByStdio<
        Writable,
        Readable,
        Readable
      >;
    },
  });
  t.after(() => quick.stop());
  const preview = await quick.open({
    endpoint,
    signal: new AbortController().signal,
    openedBy: 'member',
    ttlMs: 60000,
  });
  const link = new URL(preview.url);
  assert.equal(link.hostname, 'fake-preview.trycloudflare.com');
  assert.equal((await fetch(proxy)).status, 403);
  const first = await fetch(proxy + '/' + link.search, { redirect: 'manual' });
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('location'), '/');
  const cookie = first.headers.get('set-cookie')!;
  assert.match(cookie, /__Host-tsugimori-preview=.*Secure; HttpOnly/);
  assert.equal(
    (await fetch(proxy + '/' + link.search, { redirect: 'manual' })).status,
    403,
  );
  const response = await fetch(proxy + '/asset', {
    headers: {
      Cookie: cookie.split(';')[0]! + '; CF_Authorization=jwt; app=ok',
    },
  });
  assert.deepEqual(await response.json(), { path: '/asset', cookie: 'app=ok' });
  assert.deepEqual(response.headers.getSetCookie(), ['welcome=1; Path=/']);
  await quick.close(preview.id);
  assert.equal(stopped, true);
});

function hit(port: number, host: string, jwt?: string) {
  return new Promise<{ body: string; status: number | undefined }>(
    (resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/example',
          headers: {
            Host: host,
            ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (value: Buffer) => chunks.push(value));
          res.on('end', () =>
            resolve({
              body: Buffer.concat(chunks).toString(),
              status: res.statusCode,
            }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

test('Named Tunnel reconciles owned CNAMEs, routes authenticated hosts and closes them', async (t) => {
  const endpoint = await origin(t);
  const stale = '1'.repeat(32);
  const current = '2'.repeat(32);
  const removed: string[] = [];
  let host = '';
  const named = new NamedTunnel(
    {
      verify: async (jwt, identity) =>
        jwt === 'signed' && identity.aud === 'preview',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, 'api.cloudflare.com');
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as {
            comment: string;
            content: string;
            name: string;
            proxied: boolean;
          };
          host = body.name;
          assert.match(host, /^pv-[0-9a-f]+\.example\.test$/);
          assert.equal(body.comment, 'tsugimori');
          assert.equal(
            body.content,
            '01234567-0123-4567-89ab-0123456789ab.cfargotunnel.com',
          );
          assert.equal(body.proxied, true);
          return Response.json({ success: true, result: { id: current } });
        }
        if (init?.method === 'DELETE') {
          removed.push(url.pathname.split('/').at(-1)!);
          return Response.json({ success: true });
        }
        return Response.json({
          success: true,
          result: [
            {
              id: stale,
              name: 'pv-stale.example.test',
              comment: 'tsugimori',
              type: 'CNAME',
            },
            {
              id: '3'.repeat(32),
              name: 'pv-other.example.test',
              comment: 'someone else',
              type: 'CNAME',
            },
            {
              id: '4'.repeat(32),
              name: 'admin.example.test',
              comment: 'tsugimori',
              type: 'CNAME',
            },
            {
              id: '5'.repeat(32),
              name: 'pv-nested.sub.example.test',
              comment: 'tsugimori',
              type: 'CNAME',
            },
          ],
        });
      },
    },
    {
      access: { aud: 'preview', ownerSub: 'owner', team: 'example' },
      domain: 'example.test',
      port: 0,
      token: 'fake-token',
      tunnelId: '01234567-0123-4567-89ab-0123456789ab',
      zoneId: 'a'.repeat(32),
    },
  );
  t.after(() => named.stop());
  await named.reconcile([]);
  assert.deepEqual(removed, [stale]);
  const preview = await named.open({
    endpoint,
    openedBy: 'owner',
    signal: new AbortController().signal,
    ttlMs: 60000,
  });
  const port = await named.start();
  assert.equal((await hit(port, host)).status, 403);
  assert.equal((await hit(port, 'admin.example.test', 'signed')).status, 404);
  const response = await hit(port, host, 'signed');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { path: '/example' });
  await named.close(preview.id);
  assert.deepEqual(removed, [stale, current]);
  assert.equal((await hit(port, host, 'signed')).status, 404);
});
