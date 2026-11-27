import type { SetupContext } from '@tsugimori/plugin-sdk';
import type { TestContext } from 'node:test';

import { platformHome } from '@tsugimori/plugin-sdk';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LoginRequired, microsoftAuth, teamsSession } from '../src/auth.ts';
import { credentialName, credentialStore } from '../src/credentials.ts';
import { checks, teamsLogin } from '../src/setup.ts';

const account = '8:live:.cid.fixture';
const token = `header.${Buffer.from(JSON.stringify({ skypeid: account.slice(2) })).toString('base64url')}.signature`;
const skypeToken = {
  region: 'us',
  tokens: { skypeToken: { skypetoken: token, expiresIn: 3600 } },
  profile: { displayName: 'Teams Fixture' },
};

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), 'teams-auth-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const home = platformHome(workspace, 'teams-home');
  return { workspace, home, credentials: credentialStore(workspace, home) };
}

test('setup shows only the verification URL and user code and saves a confirmed account', async (t) => {
  const { workspace, home, credentials } = await fixture(t);
  const shown: string[] = [];
  const prompted: string[] = [];
  const recorded: string[] = [];
  let polls = 0;
  let answer = 'no';
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const form = init?.body as URLSearchParams;
    if (url.host === 'login.microsoftonline.com') {
      assert.equal(
        form.get('client_id'),
        '8ec6bc83-69c8-4392-8f08-b3c986009232',
      );
      if (url.pathname === '/common/oauth2/devicecode') {
        assert.equal(form.get('resource'), 'https://api.spaces.skype.com');
        polls = 0;
        return Response.json({
          device_code: 'private-device',
          user_code: 'FIXTURE',
          verification_url: 'https://www.microsoft.com/link',
          interval: 5,
        });
      }
      if (url.pathname === '/common/oauth2/token') {
        assert.equal(form.get('code'), 'private-device');
        assert.equal(
          form.get('grant_type'),
          'urn:ietf:params:oauth:grant-type:device_code',
        );
        if (++polls === 1)
          return Response.json(
            { error: 'authorization_pending' },
            { status: 400 },
          );
        if (polls === 2)
          return Response.json({ error: 'slow_down' }, { status: 400 });
        return Response.json({ refresh_token: 'first-refresh' });
      }
      assert.equal(url.pathname, '/consumers/oauth2/v2.0/token');
      assert.equal(
        form.get('scope'),
        'service::api.fl.spaces.skype.com::MBI_SSL openid profile offline_access',
      );
      assert.equal(form.get('refresh_token'), 'first-refresh');
      if (!new Headers(init?.headers).has('Origin'))
        return Response.json(
          { error_description: 'AADSTS9002327 (redact this)' },
          { status: 400 },
        );
      assert.equal(
        new Headers(init?.headers).get('Origin'),
        'https://teams.live.com',
      );
      return Response.json({
        access_token: 'private-access',
        refresh_token: 'rotated-refresh',
      });
    }
    assert.equal(
      url.href,
      'https://teams.live.com/api/auth/v1.0/authz/consumer',
    );
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer private-access',
    );
    return Response.json(skypeToken);
  };
  let config = {
    id: 'teams-home',
    kind: 'teams',
    options: { accountMri: '8:old', custom: true },
  };
  const context = {
    entry: config,
    workspace,
    fetch,
    arch: 'x64',
    platform: 'linux',
    credential: () => undefined,
    install: async () => assert.fail('unexpected install'),
    runCommand: async () => assert.fail('unexpected command'),
    runCheck: async () => assert.fail('unexpected check'),
    testTurn: async () => assert.fail('unexpected test turn'),
    writeEnv: async () => assert.fail('unexpected environment write'),
    signal: AbortSignal.timeout(2000),
    show: async (text: string) => {
      shown.push(text);
    },
    prompt: async ({ text, choices }) => {
      assert.deepEqual(
        choices?.map(({ value }) => value),
        ['yes', 'no'],
      );
      prompted.push(text);
      return answer;
    },
    writeConfig: ({ entry }) => {
      config = { ...config, ...entry } as typeof config;
    },
    recordCredential: (name: string) => {
      recorded.push(name);
    },
  } satisfies SetupContext;
  const waits: number[] = [];
  const step = teamsLogin(async (ms) => {
    waits.push(ms);
  });
  await assert.rejects(step.run(context), /account was declined/);
  assert.equal(await credentials.read(), undefined);
  assert.equal(config.options.accountMri, '8:old');
  assert.deepEqual(recorded, []);
  answer = 'yes';
  await step.run(context);
  assert.deepEqual(config.options, { accountMri: account, custom: true });
  assert.match(
    prompted[0]!,
    /Teams Fixture \(8:live:\.cid\.fixture\).*from 8:old/,
  );
  assert.deepEqual(shown, [
    'Open https://www.microsoft.com/link and enter code FIXTURE.',
    'Open https://www.microsoft.com/link and enter code FIXTURE.',
  ]);
  assert.deepEqual(waits, [5000, 5000, 10000, 5000, 5000, 10000]);
  assert.deepEqual(recorded, [credentialName]);
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, credentialName))).mode & 0o777, 0o600);
  assert.equal((await credentials.read())?.refreshToken, 'rotated-refresh');
  const [check] = await checks({
    ...context,
    entry: config,
    startup: true,
    fetch: async () => assert.fail('network during startup check'),
  });
  assert.equal(check?.login, 'signed-in');
});

test('refresh coalesces, atomically rotates the stored grant, and stops after rejection', async (t) => {
  const { credentials } = await fixture(t);
  const signal = AbortSignal.timeout(2000);
  await credentials.save({
    account,
    refreshToken: 'initial',
    displayName: 'Fixture',
  });
  let now = Date.now();
  let grants = 0;
  let authorizations = 0;
  const pending = Promise.withResolvers<void>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).includes('/authz/consumer')) {
      authorizations++;
      return Response.json(skypeToken);
    }
    const form = init?.body as URLSearchParams;
    grants++;
    if (grants === 1) {
      assert.equal(form.get('refresh_token'), 'initial');
      await pending.promise;
      return Response.json({
        access_token: 'access',
        refresh_token: 'rotated',
      });
    }
    assert.equal(form.get('refresh_token'), 'rotated');
    return Response.json(
      {
        error: 'invalid_grant',
        error_description: 'never include the service body',
      },
      { status: 400 },
    );
  };
  const session = teamsSession(
    microsoftAuth(fetch, () => now),
    credentials,
    account,
    signal,
    () => now,
  );
  const first = session.get();
  const concurrent = session.get();
  assert.equal(first, concurrent);
  pending.resolve();
  assert.equal((await first).region, 'us');
  assert.equal((await session.get()).account, account);
  assert.equal(grants, 1);
  assert.equal(authorizations, 1);
  assert.equal((await credentials.read())?.refreshToken, 'rotated');
  now += 3500 * 1000;
  await assert.rejects(session.get(), LoginRequired);
  assert.equal(session.required, true);
  assert.equal(await credentials.read(), undefined);
  await assert.rejects(session.get(), LoginRequired);
  assert.equal(grants, 2);
});

test('Graph and chat token grants share rotation while Graph consent failures keep chat signed in', async (t) => {
  const { credentials } = await fixture(t);
  const signal = AbortSignal.timeout(3000);
  await credentials.save({
    account,
    refreshToken: 'first',
    displayName: 'Fixture',
  });
  const received: string[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).includes('/authz/consumer')) {
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        'Bearer chat-access',
      );
      return Response.json(skypeToken);
    }
    const form = init?.body as URLSearchParams;
    const graph =
      form.get('scope') === 'https://graph.microsoft.com/Files.ReadWrite';
    received.push(`${graph ? 'graph' : 'chat'}:${form.get('refresh_token')}`);
    if (received.length === 1) {
      started.resolve();
      await release.promise;
      return Response.json({
        access_token: 'graph-access',
        refresh_token: 'second',
      });
    }
    if (!graph)
      return Response.json({
        access_token: 'chat-access',
        refresh_token: 'third',
      });
    return Response.json({ error: 'consent_required' }, { status: 400 });
  };
  const session = teamsSession(
    microsoftAuth(fetch),
    credentials,
    account,
    signal,
  );
  const graph = session.getGraph();
  assert.equal(session.getGraph(), graph);
  await started.promise;
  const chat = session.get();
  assert.deepEqual(received, ['graph:first']);
  release.resolve();
  assert.equal((await graph).token, 'graph-access');
  assert.equal((await chat).token, token);
  assert.deepEqual(received, ['graph:first', 'chat:second']);
  assert.equal((await credentials.read())?.refreshToken, 'third');
  session.invalidateGraph('graph-access');
  await assert.rejects(session.getGraph(), /Graph file access was denied/);
  assert.deepEqual(received, ['graph:first', 'chat:second', 'graph:third']);
  assert.equal(session.required, false);
  assert.equal((await session.get()).token, token);
  assert.equal((await credentials.read())?.refreshToken, 'third');
});
