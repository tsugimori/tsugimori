import type { AdminReader } from '@tsugimori/plugin-sdk';

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import { AdminServer, createAccessVerifier } from '../src/index.ts';

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
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const data =
      encode({ alg: 'RS256', kid }) +
      '.' +
      encode({
        aud: ['app'],
        email: identity.ownerEmail,
        exp: 200,
        iss: 'https://example.cloudflareaccess.com',
        ...claims,
      });
    return (
      data +
      '.' +
      sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')
    );
  }
  assert.equal(await verify(token(), identity), true);
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
    true,
  );
  assert.equal(requests, 2);
});

test('admin requires the assertion header and escapes displayed data', async (t) => {
  const reader: AdminReader = {
    approvals: () => ({ approvals: [], grants: [] }),
    chat: () => undefined,
    chats: () => [
      {
        adapterId: 'fake',
        chatId: '1',
        title: '<script>',
        allowlisted: false,
        kind: 'dm',
      },
    ],
    trace: () => undefined,
  };
  const admin = new AdminServer(
    { reader, verify: async (jwt) => jwt === 'trusted' },
    {
      listen: '127.0.0.1:0',
      access: { aud: 'app', team: 'example', ownerSub: '123' },
    },
  );
  const { port } = await admin.start();
  t.after(() => admin.stop());
  const url = `http://127.0.0.1:${port}/`;
  assert.equal(
    (
      await fetch(url, {
        headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.test' },
      })
    ).status,
    403,
  );
  const headers = { 'Cf-Access-Jwt-Assertion': 'trusted' };
  assert.match(await (await fetch(url, { headers })).text(), /&lt;script&gt;/);
  assert.equal((await fetch(url, { headers, method: 'POST' })).status, 405);
});
