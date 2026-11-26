import type {
  SetupContext,
  WebhookConfig,
  WebhookProviderContext,
} from '@tsugimori/plugin-sdk';

import { SetupError, WebhookProviderError } from '@tsugimori/plugin-sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import plugin from '../src/index.ts';

const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const dnsId = 'c'.repeat(32);
const tunnelId = '12345678-0000-0000-0000-000000000001';
const secondId = '12345678-0000-0000-0000-000000000002';
const hostname = 'hooks.team.example.com';
const token = 'fake-cloudflare-api-token';
const tokenEnv = 'CLOUDFLARE_API_TOKEN';
const listen = '[::1]:9876';
const tunnelPath = `/accounts/${accountId}/cfd_tunnel/${tunnelId}`;
const dnsPath = `/zones/${zoneId}/dns_records`;
const content = tunnelId + '.cfargotunnel.com';

const provider = plugin.webhookProviders?.find(({ id }) => id === 'cloudflare');
assert.ok(provider);

interface Call {
  body?: Record<string, unknown>;
  method: string;
  path: string;
  query: URLSearchParams;
}

function fixtures(respond: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, 'https://api.cloudflare.com');
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer ' + token,
    );
    assert.equal(init?.redirect, 'error');
    const call = {
      method: init?.method ?? 'GET',
      path: parsed.pathname.replace(/^\/client\/v4/, ''),
      query: parsed.searchParams,
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined,
    };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Response) return result;
    return Response.json({ success: true, result });
  };
  return { fetch, calls };
}

function setupCase(fetch: typeof globalThis.fetch, selected?: string) {
  let config: WebhookConfig = { provider: 'cloudflare' };
  const credentials = new Map<string, string>();
  const questions: Parameters<SetupContext['prompt']>[0][] = [];
  const ctx: SetupContext = {
    entry: { id: 'webhooks', kind: 'cloudflare' },
    locale: 'zh-TW',
    arch: process.arch,
    platform: process.platform,
    workspace: '/unused',
    signal: new AbortController().signal,
    fetch,
    credential: (name) => credentials.get(name),
    get webhooks() {
      return config;
    },
    writeConfig: ({ webhooks }) => {
      config = { ...config, ...webhooks };
    },
    writeEnv: async (key, value) => {
      credentials.set(key, value);
    },
    async prompt(options) {
      questions.push(options);
      if (options.secret) return token;
      return options.choices ? selected! : hostname.toUpperCase();
    },
    install: async () => assert.fail('Unexpected install'),
    runCheck: async () => assert.fail('Unexpected check'),
    runCommand: async () => assert.fail('Unexpected command'),
    show: async () => {},
    recordCredential: () => assert.fail('Unexpected external credential'),
    testTurn: async () => assert.fail('Unexpected test turn'),
  };
  return { ctx, credentials, questions };
}

test('Cloudflare setup verifies the secret, discovers the longest zone, and selects among healthy tunnels', async () => {
  for (const entries of [
    [
      { id: tunnelId, name: 'One', status: 'healthy' },
      { id: secondId, name: 'Two', status: 'down' },
    ],
    [
      { id: tunnelId, name: 'One', status: 'healthy' },
      { id: secondId, name: 'Two', status: 'healthy' },
    ],
  ]) {
    const multiple = entries.every(({ status }) => status === 'healthy');
    const selected = multiple ? secondId : tunnelId;
    const zones: string[] = [];
    const { fetch } = fixtures(({ path, query, method }) => {
      assert.equal(method, 'GET');
      if (path === '/user/tokens/verify') return { status: 'active' };
      if (path === '/zones') {
        const name = query.get('name')!;
        zones.push(name);
        return name === 'team.example.com'
          ? [{ id: zoneId, name, account: { id: accountId } }]
          : [];
      }
      if (path === `/accounts/${accountId}/cfd_tunnel`) {
        assert.equal(query.get('is_deleted'), 'false');
        return entries;
      }
      assert.equal(path, `/accounts/${accountId}/cfd_tunnel/${selected}`);
      return { remote_config: true };
    });
    const { ctx, credentials, questions } = setupCase(fetch, selected);
    for (const step of provider.setupSteps) await step.run(ctx);
    assert.deepEqual(zones, [hostname, 'team.example.com']);
    assert.equal(questions[0]?.secret, true);
    assert.equal(credentials.get(tokenEnv), token);
    assert.deepEqual(ctx.webhooks?.cloudflare, {
      hostname,
      zoneId,
      accountId,
      tunnelId: selected,
      tokenEnv,
    });
    assert.deepEqual(
      questions[2]?.choices?.map(({ label }) => label),
      multiple ? ['One', 'Two'] : undefined,
    );
  }
});

test('Cloudflare discovery reports missing and locally managed tunnels', async () => {
  for (const local of [false, true]) {
    const { fetch } = fixtures(({ path, query }) => {
      if (path === '/user/tokens/verify') return { status: 'active' };
      if (path === '/zones')
        return [
          { id: zoneId, name: query.get('name'), account: { id: accountId } },
        ];
      if (path === `/accounts/${accountId}/cfd_tunnel`)
        return local
          ? [{ id: tunnelId, name: 'Local', status: 'healthy' }]
          : [];
      assert.equal(path, tunnelPath);
      return { remote_config: false };
    });
    const { ctx } = setupCase(fetch);
    await assert.rejects(
      async () => {
        for (const step of provider.setupSteps) await step.run(ctx);
      },
      (error) =>
        error instanceof SetupError &&
        (local
          ? /本機設定檔.*one\.dash\.cloudflare\.com.*Migrate/.test(
              error.message,
            )
          : /找不到可用的 Cloudflare Tunnel/.test(error.message)),
    );
  }
});

function context(fetch: typeof globalThis.fetch): WebhookProviderContext {
  return {
    config: {
      provider: 'cloudflare',
      cloudflare: { accountId, hostname, tunnelId, zoneId, tokenEnv },
    },
    listen,
    credential: (key) => (key === tokenEnv ? token : undefined),
    workspace: '/unused',
    signal: new AbortController().signal,
    fetch,
  };
}

test('Cloudflare ensure preserves the other ingress rules and settings and creates or updates owned DNS', async () => {
  const admin = {
    hostname: 'admin.example.com',
    service: 'http://localhost:8787',
    originRequest: { access: { required: true } },
  };
  const fallback = { service: 'http://localhost:8788' };
  const other = {
    hostname: 'other.example.com',
    service: 'https://localhost:1234',
  };
  const webhook = { hostname, service: 'http://' + listen };
  const existing = { hostname, service: 'http://localhost:1111' };
  const marked = {
    id: dnsId,
    type: 'CNAME',
    name: hostname,
    content: 'old.cfargotunnel.com',
    comment: 'tsugimori webhook',
  };
  const desired = {
    type: 'CNAME',
    name: hostname,
    content,
    proxied: true,
    ttl: 1,
    comment: 'tsugimori webhook',
  };
  for (const { ingress, records, rules, method } of [
    {
      ingress: [admin, other],
      records: [],
      rules: [admin, other, webhook, { service: 'http_status:404' }],
      method: 'POST',
    },
    {
      ingress: [admin, existing, other, fallback],
      records: [marked],
      rules: [admin, webhook, other, fallback],
      method: 'PATCH',
    },
    {
      ingress: [admin, webhook, other, fallback],
      records: [desired],
      rules: [],
      method: undefined,
    },
  ]) {
    const originRequest = { connectTimeout: 15 };
    const { fetch, calls } = fixtures(({ method, path, query }) => {
      if (method !== 'GET') return {};
      if (path === tunnelPath)
        return { remote_config: true, status: 'healthy' };
      if (path === dnsPath) {
        assert.equal(query.get('name.exact'), hostname);
        return records;
      }
      assert.equal(path, tunnelPath + '/configurations');
      return { config: { originRequest, ingress } };
    });
    assert.deepEqual(await provider.ensure(context(fetch)), {
      baseUrl: 'https://' + hostname,
    });
    const mutations = calls.filter((call) => call.method !== 'GET');
    if (!method) {
      assert.deepEqual(mutations, []);
      continue;
    }
    assert.deepEqual(
      mutations.map((call) => call.method),
      ['PUT', method],
    );
    assert.deepEqual(mutations[0]?.body, {
      config: { originRequest, ingress: rules },
    });
    assert.equal(
      mutations[1]?.path,
      dnsPath + (method === 'PATCH' ? '/' + dnsId : ''),
    );
    assert.deepEqual(mutations[1]?.body, desired);
  }
});

test('Cloudflare ensure leaves conflicting DNS and ingress unchanged', async () => {
  const { fetch, calls } = fixtures(({ path }) => {
    if (path === tunnelPath) return { remote_config: true };
    assert.equal(path, dnsPath);
    return [
      {
        id: dnsId,
        type: 'A',
        name: hostname,
        content: '192.0.2.1',
        comment: 'someone else',
      },
    ];
  });
  await assert.rejects(
    provider.ensure(context(fetch)),
    (error) =>
      error instanceof WebhookProviderError &&
      error.code === 'dns_conflict' &&
      error.zh?.includes('沒有覆寫') === true,
  );
  assert.ok(calls.every(({ method }) => method === 'GET'));
});

test('Cloudflare provider checks token, tunnel, ingress, and DNS; API failures redact the token', async () => {
  const { fetch } = fixtures(({ path }) => {
    if (path === '/user/tokens/verify') return { status: 'active' };
    if (path === tunnelPath) return { remote_config: true, status: 'healthy' };
    if (path === tunnelPath + '/configurations')
      return {
        config: { ingress: [{ hostname, service: 'http://' + listen }] },
      };
    assert.equal(path, dnsPath);
    return [{ type: 'CNAME', name: hostname, content, proxied: true }];
  });
  const items = await provider.checks(context(fetch));
  assert.equal(items.length, 4);
  assert.ok(items.every(({ status }) => status === 'ok'));
  const failure = fixtures(() =>
    Response.json(
      {
        success: false,
        errors: [
          {
            code: 1001,
            message: 'Invalid ' + token,
            additional: 'private response',
          },
        ],
      },
      { status: 403 },
    ),
  );
  await assert.rejects(
    provider.ensure(context(failure.fetch)),
    (error) =>
      error instanceof Error &&
      error.message.includes('1001 Invalid [redacted]') &&
      !error.message.includes(token) &&
      !error.message.includes('private response'),
  );
});
