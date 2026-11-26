import type {
  AdapterContext,
  AgentFactory,
  AgentRequest,
  InboundMessage,
  OutboundMessage,
  PluginDefinition,
} from '@tsugimori/plugin-sdk';
import type { TestContext } from 'node:test';

import { loadSettings } from '@tsugimori/config';
import { SetupError } from '@tsugimori/plugin-sdk';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import { Tracer } from '@tsugimori/trace';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { Logger } from '../src/index.ts';

import { Gateway, GuidedSetup, PluginRegistry } from '../src/index.ts';

const adapterId = 'chat';
const ownerId = '42';
const group = {
  chatId: '-100',
  threadId: '7',
  chatKind: 'supergroup',
} as const;

function fixturePlatform() {
  let callback: AdapterContext | undefined;
  const sent: (OutboundMessage & { messageId: string })[] = [];
  const removed: string[] = [];
  return {
    sent,
    removed,
    plugin: {
      name: 'chat',
      credentialNames: () => [],
      adapters: {
        chat: ({ id }) => ({
          id,
          kind: 'chat',
          capabilities: {},
          async start(ctx) {
            callback = ctx;
          },
          async stop() {
            callback = undefined;
          },
          async deleteMessage({ messageId }) {
            removed.push(messageId);
          },
          async send(message) {
            const messageId = String(sent.length + 100);
            sent.push({ ...message, messageId });
            return { messageId };
          },
        }),
      },
    } satisfies PluginDefinition,
    async receive(
      messageId: string,
      text: string,
      overrides: Partial<InboundMessage> = {},
    ) {
      assert.ok(callback);
      await callback.emit({
        chatId: ownerId,
        chatKind: 'dm',
        type: 'message',
        userId: ownerId,
        messageId,
        text,
        ...overrides,
      });
    },
  };
}

async function fixture(
  t: TestContext,
  registry: PluginRegistry,
  extra: object = {},
) {
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-guided-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(
    join(workspace, 'tsugimori.json'),
    JSON.stringify({
      owner: { [adapterId]: ownerId },
      platforms: [{ id: adapterId, kind: 'chat' }],
      ...extra,
    }),
  );
  const store = new SqliteStore(join(workspace, 'state.db'));
  const trace = new Tracer(store, { ringSize: 256 });
  const logs: Parameters<Logger>[0][] = [];
  const gateway = new Gateway({
    setup: {
      runCommand: async (command) => {
        assert.deepEqual(command, ['git', '--version']);
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    },
    registry,
    workspace,
    store,
    trace,
    log: (entry) => logs.push(entry),
  });
  t.after(async () => {
    await gateway.stop();
    store.close();
  });
  await gateway.start();
  return { workspace, store, gateway, trace, logs };
}

async function until<T>(find: () => T | undefined) {
  const signal = AbortSignal.timeout(4_000);
  for (;;) {
    const value = find();
    if (value !== undefined) return value;
    await delay(10, undefined, { signal });
  }
}

test('guided chat setup uses the original topic for progress and consumes secrets only in owner DM', async (t) => {
  const platform = fixturePlatform();
  const credential = '123456789:fake_token_long_enough_for_filtering';
  let attached = 0;
  const registry = new PluginRegistry([
    platform.plugin,
    {
      name: 'builtin',
      checks: ({ credential: get }) => [
        {
          id: 'token',
          status: get('FAKE_TOKEN') === credential ? 'ok' : 'fail',
          title: 'Token',
          detail: 'Fake credential check',
        },
      ],
      adapters: {
        new: ({ id }, ctx) => {
          assert.equal(ctx.credential('FAKE_TOKEN'), credential);
          return {
            id,
            kind: 'new',
            capabilities: {},
            async start() {
              attached++;
            },
            async stop() {},
            async send() {
              return { messageId: 'new' };
            },
          };
        },
      },
      setupSteps: [
        {
          id: 'token',
          title: 'Verify token',
          async run(ctx) {
            const value = await ctx.prompt({
              text: 'Enter token.',
              secret: true,
            });
            assert.equal(value, credential);
            await ctx.writeEnv('FAKE_TOKEN', value);
            ctx.writeConfig({ entry: { tokenEnv: 'FAKE_TOKEN' } });
          },
        },
        {
          id: 'owner',
          title: 'Set owner',
          async run(ctx) {
            const ownerId = await ctx.prompt({ text: 'Enter owner ID.' });
            ctx.writeConfig({ ownerId });
          },
        },
      ],
    },
  ]);
  const f = await fixture(t, registry);
  await platform.receive('member-add', '/add platform new --id attached', {
    ...group,
    userId: '43',
  });
  assert.equal(
    platform.sent.filter(({ text }) => text.includes('Enter token.')).length,
    0,
  );
  await platform.receive('owner-add', '/add platform new --id attached', group);
  const secret = await until(() =>
    platform.sent.find(({ text }) => text.startsWith('Enter token.')),
  );
  assert.equal(secret.chatId, ownerId);
  assert.equal(secret.threadId, undefined);
  await platform.receive('group-token', credential, {
    ...group,
    replyTo: secret.messageId,
    raw: { credential },
  });
  await platform.receive('stranger-token', credential, {
    userId: '43',
    chatId: '43',
    replyTo: secret.messageId,
    raw: { credential },
  });
  assert.equal(attached, 0);
  await platform.receive('owner-token', credential, {
    replyTo: secret.messageId,
    raw: { credential },
  });
  const owner = await until(() =>
    platform.sent.find(({ text }) => text.startsWith('Enter owner ID.')),
  );
  assert.equal(owner.chatId, group.chatId);
  assert.equal(owner.threadId, group.threadId);
  assert.equal(owner.replyTo, 'owner-add');
  await platform.receive('owner-answer', ownerId, {
    ...group,
    replyTo: owner.messageId,
  });
  const done = await until(() =>
    platform.sent.find(({ text }) => text === 'attached is attached.'),
  );
  assert.equal(done.threadId, group.threadId);
  assert.equal(done.replyTo, 'owner-add');
  assert.equal(attached, 1);
  assert.equal(
    (await loadSettings(f.workspace, registry)).owner.attached,
    ownerId,
  );
  await platform.receive('late-token', 'arbitrary secret input', {
    replyTo: secret.messageId,
    raw: { credential },
  });
  assert.deepEqual(platform.removed, [
    'group-token',
    'stranger-token',
    'owner-token',
    'late-token',
  ]);
  for (const [chatId, messageId] of [
    ['-100_7', 'group-token'],
    ['43', 'stranger-token'],
    ['42', 'owner-token'],
    ['42', 'late-token'],
  ] as const)
    assert.equal(
      f.store.getMessage({ adapterId, chatId }, messageId),
      undefined,
    );
  assert.ok(
    !JSON.stringify([
      platform.sent,
      f.logs,
      f.trace.recent,
      f.store.getSetupRun('["add","platform","attached"]'),
    ]).includes(credential),
  );
});

test('runtime isolates agent and execution failures and keeps owner-visible chat working', async (t) => {
  const platform = fixturePlatform();
  const requests: AgentRequest[] = [];
  const createAgent: AgentFactory = ({ id }) => {
    assert.notEqual(id, 'bad');
    return {
      id,
      implementation: 'Test Connector',
      kind: 'agent',
      loop: 'external',
      async *run(request) {
        requests.push(request);
        yield await Promise.resolve({
          type: 'text.final',
          text: 'Still working.',
        });
      },
    };
  };
  const registry = new PluginRegistry([
    platform.plugin,
    {
      name: 'agents',
      credentialNames: () => [],
      checks: ({ entry }) => [
        {
          id: 'login',
          title: 'Login',
          status: entry.id === 'bad' ? 'fail' : 'ok',
          detail: 'Sign in first.',
          localized: { 'zh-TW': { title: '代理程式登入', hint: '請先登入。' } },
          capabilities: ['agent'],
        },
      ],
      agents: {
        agent: Object.assign(createAgent, { implementation: 'Test SDK' }),
      },
    },
    {
      name: 'sandbox',
      checks: () => [
        {
          id: 'bubblewrap',
          title: 'Bubblewrap',
          status: 'fail',
          detail: 'Missing bwrap.',
          localized: {
            'zh-TW': { title: 'Bubblewrap', hint: '請安裝 bwrap。' },
          },
          capabilities: ['exec'],
        },
      ],
      execBackends: [
        {
          id: 'local-sandbox',
          async start() {
            assert.fail('Missing exec backend must stay disabled');
          },
        },
      ],
    },
  ]);
  const f = await fixture(t, registry, {
    agents: [
      { id: 'bad', kind: 'agent' },
      {
        id: 'good',
        kind: 'agent',
        options: { codexHome: 'custom-codex', claudeHome: 'custom-claude' },
      },
    ],
    defaultAgent: 'bad',
    locale: 'zh-TW',
    exec: {},
    context: { summary: { enabled: false } },
  });
  assert.deepEqual(platform.sent[0]?.text.split('\n'), [
    '環境檢查有問題：',
    'core · Git：請執行 tsugimori setup 查看安裝指令。',
    'exec/local-sandbox · Bubblewrap：請安裝 bwrap。',
    'agent/bad · 代理程式登入：請先登入。',
  ]);
  assert.equal(platform.sent[0]?.chatId, ownerId);
  await platform.receive('status', '/status');
  const status = platform.sent.at(-1)?.text ?? '';
  assert.match(
    status,
    /^chat、good · Test Connector 運作中\nbad · Test SDK 無法使用 · 請先登入。$/m,
  );
  assert.match(status, /^Agent：bad · Test SDK$/m);
  assert.match(status, /^沙箱已停用 · 環境檢查 3 項未通過$/m);
  assert.match(status, /^🔴 tsugimori/u);
  await platform.receive('unavailable', 'Hello');
  await f.gateway.idle();
  assert.equal(
    platform.sent.at(-1)?.text,
    'agent/bad · 代理程式登入：請先登入。',
  );
  await platform.receive('route', '/agent good');
  assert.equal(platform.sent.at(-1)?.text, '已切換到代理程式 good。');
  await platform.receive('works', 'Hello');
  await f.gateway.idle();
  assert.equal(platform.sent.at(-1)?.text, 'Still working.');
  assert.equal(
    platform.sent.filter(({ text }) => text.startsWith('環境檢查有問題：'))
      .length,
    1,
  );
  assert.equal(requests[0]?.toolsDisabled, true);
  assert.ok(!requests[0]?.tools.some((tool) => tool.name.startsWith('exec.')));
  for (const name of [
    '.env',
    'agents',
    'agents/good/home',
    'custom-codex',
    'custom-claude',
  ])
    assert.ok(requests[0]?.sandbox?.denyRead.includes(join(f.workspace, name)));
  assert.ok(!(await readdir(requests[0]!.workdir)).includes('.git'));
});

test('completed steps and the setup lease survive reopening SQLite', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-resume-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'tsugimori.json'), '{}');
  const db = join(workspace, 'state.db');
  let executions = 0;
  const blocked = Promise.withResolvers<void>();
  const registry = new PluginRegistry([
    {
      name: 'resume',
      agents: {
        trial: () => {
          assert.fail('Should not start during setup');
        },
      },
      setupSteps: [
        {
          id: 'first',
          title: 'First',
          run(ctx) {
            executions++;
            ctx.writeConfig({ entry: { model: 'm' } });
          },
        },
        {
          id: 'second',
          title: 'Second',
          async run(ctx) {
            await ctx.prompt({ text: 'Continue?' });
          },
        },
      ],
    },
  ]);
  const request = {
    category: 'agent',
    id: 'target',
    kind: 'trial',
    mode: 'add',
  } as const;
  const show = async () => {};
  const signal = AbortSignal.timeout(5_000);
  const store = new SqliteStore(db);
  const concurrent = new SqliteStore(db);
  const run = new GuidedSetup({ store, registry, workspace }).run(request, {
    signal,
    show,
    async prompt() {
      await blocked.promise;
      throw new SetupError('Interrupted');
    },
  });
  const startRejected = assert.rejects(run, /Interrupted/);
  const key = '["add","agent","target"]';
  await until(() =>
    concurrent.getSetupRun(key)?.step === 1 ? true : undefined,
  );
  await assert.rejects(
    new GuidedSetup({ store: concurrent, registry, workspace }).run(request, {
      signal,
      show,
      prompt: async () => 'yes',
    }),
    /Another setup/,
  );
  blocked.resolve();
  await startRejected;
  store.close();
  concurrent.close();
  const reopened = new SqliteStore(db);
  t.after(() => reopened.close());
  await new GuidedSetup({ store: reopened, registry, workspace }).run(request, {
    signal,
    show,
    prompt: async () => 'yes',
  });
  assert.equal(executions, 1);
  assert.equal((await loadSettings(workspace, registry)).agents[0]?.model, 'm');
  assert.equal(reopened.getSetupRun(key)?.status, 'complete');
});
