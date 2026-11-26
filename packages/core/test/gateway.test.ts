import type { Config } from '@tsugimori/config';
import type {
  AdapterContext,
  AdminEvent,
  AgentConnector,
  AgentRequest,
  ApprovalFeedback,
  ApprovalReaction,
  ImageLimits,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  PlatformCapabilities,
  PluginDefinition,
  TunnelProvider,
} from '@tsugimori/plugin-sdk';
import type { ScheduleRecord } from '@tsugimori/storage';

import { renderContextLine } from '@tsugimori/plugin-sdk';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import { Tracer } from '@tsugimori/trace';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';

import type { Logger } from '../src/index.ts';

import {
  decideTrigger,
  Gateway,
  PluginRegistry,
  shouldTrigger,
} from '../src/index.ts';

const adapterId = 'fake:main';
const chat = { adapterId, chatId: 'room' };

function inbound(
  messageId: string,
  text: string,
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    type: 'message',
    chatId: chat.chatId,
    chatKind: 'dm',
    messageId,
    text,
    userId: 'owner',
    ...overrides,
  };
}

function createPlatform(
  messagePrefix = 'bot',
  react?: true | PlatformAdapter['setApprovalReaction'],
  outboundPush?: PlatformCapabilities['outboundPush'],
) {
  let context: AdapterContext | undefined;
  let starts = 0;
  const sent: (OutboundMessage & { messageId: string })[] = [];
  const feedback: ApprovalFeedback[] = [];
  const reactions: {
    chatId: string;
    messageId: string;
    status: ApprovalReaction;
  }[] = [];
  const platform: PlatformAdapter = {
    id: adapterId,
    kind: 'fake',
    capabilities: { deleteEvents: true, inlineButtons: true, outboundPush },
    start(ctx) {
      context = ctx;
      starts++;
      return Promise.resolve();
    },
    stop() {
      context = undefined;
      return Promise.resolve();
    },
    send(message) {
      const messageId = `${messagePrefix}-${sent.length + 1}`;
      sent.push({ ...message, messageId });
      return Promise.resolve({ messageId, raw: { delivered: true } });
    },
    respondToApproval(response) {
      feedback.push(response);
      return Promise.resolve();
    },
  };
  if (react)
    platform.setApprovalReaction = async (message, status, signal) => {
      reactions.push({ ...message, status });
      if (typeof react === 'function') await react(message, status, signal);
    };
  return {
    platform,
    sent,
    feedback,
    reactions,
    get starts() {
      return starts;
    },
    async emit(event: Parameters<AdapterContext['emit']>[0]) {
      assert.ok(context, 'adapter attached');
      await context.emit(event);
    },
    getUser(userId: string) {
      return context?.getUser?.(userId);
    },
  };
}

async function fixture(
  t: TestContext,
  run: AgentConnector['run'],
  enableAgent = true,
  options: {
    agentOptions?: Config['agents'][number]['options'];
    agentSettings?(id: string): AgentConnector['settings'];
    compact?: AgentConnector['compact'];
    context?: Config['context'];
    describeDefaults?: AgentConnector['describeDefaults'];
    describeQuota?: AgentConnector['describeQuota'];
    describeSession?: AgentConnector['describeSession'];
    downloadAttachment?: PlatformAdapter['downloadAttachment'];
    durable?: boolean;
    envFixture?: string;
    imageLimits?: ImageLimits;
    locale?: 'en' | 'zh-TW';
    onScopedTool?: (args: unknown, userId: string) => void;
    outboundPush?: PlatformCapabilities['outboundPush'];
    plugins?: PluginDefinition[];
    previews?: { named?: TunnelProvider; quick: TunnelProvider };
    reactions?: true | PlatformAdapter['setApprovalReaction'];
    stickers?: Config['stickers'];
    thinkingLevels?: AgentConnector['thinkingLevels'];
    web?: Config['web'];
  } = {},
) {
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-gateway-'));
  const path = join(workspace, 'tsugimori.json');
  const dbPath = options.durable ? join(workspace, 'gateway.db') : ':memory:';
  const store = new SqliteStore(dbPath);
  const trace = new Tracer(store, { ringSize: 500 });
  const platform = createPlatform(
    undefined,
    options.reactions,
    options.outboundPush,
  );
  platform.platform.downloadAttachment = options.downloadAttachment;
  let agentStarts = 0;
  let agentStops = 0;
  const registry = new PluginRegistry([
    ...(options.plugins ?? []),
    {
      name: 'test',
      adapters: { fake: () => platform.platform },
      agents: {
        fake: ({ id }) => ({
          id,
          kind: 'fake',
          loop: 'external',
          imageLimits: options.imageLimits,
          compact: options.compact,
          describeDefaults: options.describeDefaults,
          describeQuota: options.describeQuota,
          describeSession: options.describeSession,
          run,
          settings: options.agentSettings?.(id),
          thinkingLevels: options.thinkingLevels,
          start() {
            agentStarts++;
            return Promise.resolve();
          },
          stop() {
            agentStops++;
            return Promise.resolve();
          },
        }),
      },
      tools: [
        {
          name: 'scoped_tool',
          description: 'A permission-gated test operation',
          schema: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
          permission: {
            action: 'test.use',
            describe: () => '🔔 Sample text\n你好😀',
            resource: (args) => {
              assert.ok(
                args &&
                  typeof args === 'object' &&
                  'id' in args &&
                  typeof args.id === 'string',
              );
              return { type: 'project', id: args.id };
            },
          },
          run(args, task) {
            options.onScopedTool?.(args, task.principal.userId);
            return Promise.resolve(task.principal.userId);
          },
        },
      ],
    },
  ]);
  const logs: Parameters<Logger>[0][] = [];
  const gateway = new Gateway({
    store,
    workspace,
    registry,
    trace,
    previews: options.previews,
    log: (entry) => logs.push(entry),
  });
  const { context: contextSettings } = options;
  const {
    locale,
    web: fixtureWeb,
    agentOptions,
    stickers: stickerSettings,
  } = options;
  const exec = options.plugins?.some((plugin) => plugin.execBackends?.length)
    ? {}
    : undefined;
  function configure(
    enabled: boolean,
    options: {
      agents?: Config['agents'];
      compactAt?: number;
      context?: Config['context'];
      model?: string;
      platform?: boolean;
    } = {},
  ) {
    return writeFile(
      path,
      JSON.stringify({
        owner: { fake: 'owner' },
        platforms:
          options.platform === false ? [] : [{ id: adapterId, kind: 'fake' }],
        agents: enabled
          ? (options.agents ?? [
              {
                id: 'test',
                kind: 'fake',
                model: options.model ?? 'first',
                compactAt: options.compactAt,
                options: agentOptions,
              },
            ])
          : [],
        defaultAgent: 'test',
        context: options.context ?? contextSettings,
        exec,
        locale,
        web: fixtureWeb,
        stickers: stickerSettings,
      }),
    );
  }

  t.after(async () => {
    try {
      await gateway.stop();
    } finally {
      store.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
  await configure(enableAgent);
  if (options.envFixture)
    await writeFile(join(workspace, '.env'), options.envFixture);
  await gateway.start();
  return {
    gateway,
    configure,
    dbPath,
    logs,
    platform,
    store,
    trace,
    path,
    get agentStarts() {
      return agentStarts;
    },
    get agentStops() {
      return agentStops;
    },
  };
}

test('chat turns apply model-specific reasoning and fall back from unsupported saved preferences', async (t) => {
  const requests: AgentRequest[] = [];
  const f = await fixture(
    t,
    async function* (request) {
      requests.push(request);
      yield { type: 'text.final', text: 'Done' };
    },
    true,
    {
      agentSettings: () => ({ thinking: ['minimal', 'low'] }),
      thinkingLevels: async (model) =>
        model === 'first' ? ['low', 'max'] : undefined,
    },
  );
  await f.platform.emit(inbound('enable-max', '/thinking max'));
  assert.equal(f.store.getChat(chat)?.thinking, 'max');
  await f.platform.emit(inbound('run-max', 'Use the saved preference'));
  await f.gateway.idle();
  assert.equal(requests.at(-1)?.thinking, 'max');

  f.store.setChatRoute(chat, { thinking: 'minimal' });
  await f.platform.emit(inbound('run-invalid', 'Use the model default'));
  await f.gateway.idle();
  assert.equal(requests.at(-1)?.thinking, undefined);
  assert.equal(f.store.getChat(chat)?.thinking, 'minimal');

  await f.platform.emit(inbound('choose-unknown', '/model unknown'));
  await f.platform.emit(inbound('run-static', 'Use the static fallback'));
  await f.gateway.idle();
  assert.equal(requests.at(-1)?.model, 'unknown');
  assert.equal(requests.at(-1)?.thinking, 'minimal');
  assert.equal(requests.length, 3);
});

test(
  'queues owner /compact, preserves the session and records compaction after the task ends',
  { timeout: 5_000 },
  async (t) => {
    const turnStarted = Promise.withResolvers<void>();
    const finishTurn = Promise.withResolvers<void>();
    let reportPostTurn: (() => void) | undefined;
    const order: string[] = [];
    const { configure, gateway, logs, platform, store, trace } = await fixture(
      t,
      async function* (request, io) {
        if (!request.resumeSessionId) {
          order.push('turn');
          turnStarted.resolve();
          await finishTurn.promise;
          yield { type: 'sessionId', sessionId: 'native-1' };
          yield {
            type: 'compaction',
            trigger: 'native',
            tokensBefore: 251_000,
            durationMs: 12,
          };
          reportPostTurn = () =>
            io.reportCompaction?.({
              type: 'compaction',
              trigger: 'post-turn',
              tokensBefore: 255_000,
              tokensAfter: 2400,
              durationMs: 20,
            });
        } else {
          assert.equal(request.resumeSessionId, 'native-1');
          order.push('resume');
        }
        yield { type: 'text.final', text: 'reply' };
      },
      true,
      {
        async compact(request) {
          order.push('compact');
          assert.equal(request.sessionId, 'native-1');
          assert.equal(request.model, 'first');
          assert.ok(request.workdir.endsWith(join(adapterId, chat.chatId)));
          assert.equal(request.signal.aborted, false);
          return { status: 'compacted', tokensBefore: 2400, tokensAfter: 600 };
        },
      },
    );
    t.after(() => finishTurn.resolve());
    await platform.emit(inbound('no-session', '/compact'));
    await gateway.idle();
    assert.equal(
      platform.sent.at(-1)?.text,
      'There is no active agent session in this chat.',
    );

    await platform.emit(inbound('allow', '/allow'));
    await platform.emit(inbound('first-turn', 'hello'));
    await turnStarted.promise;
    try {
      await platform.emit(
        inbound('member', '/compact', { userId: 'member', mentionsBot: true }),
      );
      await platform.emit(
        inbound('owner', '/compact', { replyTo: { id: 'first-turn' } }),
      );
      assert.deepEqual(order, ['turn']);
    } finally {
      finishTurn.resolve();
    }
    await gateway.idle();
    assert.deepEqual(order, ['turn', 'compact']);
    assert.equal(platform.sent.at(-1)?.text, 'Agent session compacted.');
    assert.equal(platform.sent.at(-1)?.replyTo, 'owner');
    assert.equal(
      store.getSession(chat, 'test', 'first')?.throughSeq,
      store.getMessage(chat, 'first-turn')?.seq,
    );

    assert.ok(reportPostTurn);
    reportPostTurn();
    await trace.flush();
    const spans = store
      .listChatTasks(chat)
      .flatMap(({ id }) => store.taskTrace(id))
      .filter(({ name }) => name === 'agent.compaction');
    assert.deepEqual(
      spans
        .map(({ attrs }) => [
          attrs.trigger,
          attrs.tokensBefore,
          attrs.tokensAfter,
        ])
        .sort(),
      [
        ['manual', 2400, 600],
        ['native', 251_000, null],
        ['post-turn', 255_000, 2400],
      ],
    );
    assert.equal(
      spans.find(({ attrs }) => attrs.trigger === 'native')?.durationMs,
      12,
    );

    await configure(true, { compactAt: 150_000 });
    while (!logs.some(({ event }) => event === 'config.reloaded'))
      await delay(10, undefined, { signal: t.signal });
    await platform.emit(inbound('next-turn', 'continue'));
    await gateway.idle();
    assert.deepEqual(order, ['turn', 'compact', 'resume']);
  },
);

test('localizes /compact when the selected agent has no compaction capability', async (t) => {
  const { gateway, platform } = await fixture(
    t,
    async function* () {
      assert.fail('The command must not become a normal turn');
    },
    true,
    { locale: 'zh-TW' },
  );
  await platform.emit(inbound('compact', '/compact'));
  await gateway.idle();
  assert.equal(platform.sent.at(-1)?.text, '此代理程式不支援壓縮工作階段。');
});

test(
  'owner status reads live work and session metrics without running an agent',
  { timeout: 4_000 },
  async (t) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    let runs = 0;
    const { gateway, platform, store, trace } = await fixture(
      t,
      async function* () {
        runs++;
        yield { type: 'sessionId', sessionId: 'active-native' };
        if (runs === 1) {
          yield {
            type: 'usage',
            contextTokens: 32_000,
            inputTokens: 200_000,
            outputTokens: 1_100,
          };
          entered.resolve();
          await release.promise;
          yield { type: 'compaction', trigger: 'native' };
        }
        yield { type: 'text.final', text: 'done' };
      },
      true,
      {
        compact: async () => ({
          status: 'compacted',
          tokensBefore: 32_000,
          tokensAfter: 8_000,
        }),
        context: { recentMessages: 30 },
        describeQuota: () => ({
          primary: { usedPercent: 10, windowDurationMins: 300 },
        }),
        describeSession: (id) =>
          id === 'active-native' ? { serviceTier: 'fast' } : undefined,
      },
    );
    store.setWorkspaceSettings(chat, {
      model: 'workspace-model',
      thinking: 'high',
    });
    const status = async (id: string) => {
      await platform.emit(inbound(id, '/status'));
      return platform.sent.at(-1)!.text;
    };

    await platform.emit(
      inbound('member', '/status', { userId: 'member', mentionsBot: true }),
    );
    assert.equal(platform.sent.length, 0);
    const before = await status('before');
    assert.match(before, /^Context: unknown\nQuota: 5h 90% left$/m);
    assert.doesNotMatch(before, /^Session: /m);

    await platform.emit(inbound('run', 'start work'));
    await entered.promise;
    await platform.emit(inbound('queue', 'follow up'));
    const live = await status('live');
    assert.match(live, /^Model: workspace-model · Effort: high · Fast: on$/m);
    assert.match(live, /^Context: 32k \/ 250k \(13%\)$/m);
    assert.match(live, /^Session: active for /m);
    assert.doesNotMatch(live, /^Last compaction: /m);
    assert.match(live, /^Work: running for .* \(running agent\) · 1 queued$/m);
    assert.equal(runs, 1);

    release.resolve();
    await gateway.idle();
    await platform.emit(inbound('compact-status', '/compact'));
    await gateway.idle();
    assert.match(
      await status('before-flush'),
      /^Last compaction: .* · 2 total$/m,
    );
    await trace.flush();
    const after = await status('after');
    assert.match(after, /^Context: 8k \/ 250k \(3%\)$/m);
    assert.match(after, /^Last compaction: .* · manual · 32k → 8k · 2 total$/m);
    assert.match(after, /^Session: active for /m);
    assert.doesNotMatch(after, /^Work: /m);
    await platform.emit(inbound('switch', '/model other'));
    const changed = await status('changed');
    assert.match(changed, /^Context: unknown$/m);
    assert.doesNotMatch(changed, /^Last compaction: /m);
    assert.doesNotMatch(changed, /^Session: /m);
    assert.equal(runs, 2);
  },
);

test('status caches agent defaults and refreshes them on hot reload', async (t) => {
  let defaults = {
    model: 'provider-model',
    effort: 'low',
    serviceTier: 'fast',
  };
  let reads = 0;
  const f = await fixture(
    t,
    async function* () {
      assert.fail('Status does not run the agent');
    },
    true,
    {
      describeDefaults() {
        reads++;
        return defaults;
      },
    },
  );
  const reloads = () =>
    f.logs.filter(({ event }) => event === 'config.reloaded').length;
  await until(t, () => reloads() > 0);
  const status = async (id: string) => {
    await f.platform.emit(inbound(id, '/status'));
    return f.platform.sent.at(-1)!.text;
  };

  const before = reads;
  assert.match(
    await status('route'),
    /^Model: first · Effort: low · Fast: on$/m,
  );
  f.store.setWorkspaceSettings(chat, { model: 'default' });
  defaults = { model: 'new-model', effort: 'high', serviceTier: 'default' };
  assert.match(
    await status('cached'),
    /^Model: provider-model · Effort: low · Fast: on$/m,
  );
  assert.equal(reads, before);

  const loaded = reloads();
  await f.configure(true);
  await until(t, () => reloads() > loaded);
  assert.match(
    await status('refreshed'),
    /^Model: new-model · Effort: high · Fast: off$/m,
  );
  assert.equal(f.agentStarts, 1);
  assert.equal(f.agentStops, 0);
});

test(
  'owner chat settings override reloaded agent defaults and keep a capable session',
  { timeout: 5_000 },
  async (t) => {
    const requests: AgentRequest[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        requests.push(request);
        yield {
          type: 'sessionId',
          sessionId: request.resumeSessionId ?? `session-${requests.length}`,
        };
        yield { type: 'text.final', text: 'Reply' };
      },
      true,
      {
        agentSettings: (id) =>
          id === 'legacy'
            ? { thinking: ['low'] }
            : {
                thinking: ['low', 'high'],
                serviceTiers: true,
                perTurn: ['model', 'thinking', 'serviceTier'],
              },
        context: { recentMessages: 30, summary: { enabled: false } },
        describeDefaults: () => ({
          model: 'provider-model',
          effort: 'medium',
          serviceTier: 'fast',
        }),
      },
    );
    const { gateway, platform, store } = f;
    const agents = [
      {
        id: 'test',
        kind: 'fake',
        model: 'configured-model',
        thinking: 'low',
        serviceTier: 'default',
      },
      { id: 'compatible', kind: 'fake' },
      { id: 'legacy', kind: 'fake' },
    ];
    const configure = async () => {
      const loaded = f.logs.filter(
        ({ event }) => event === 'config.reloaded',
      ).length;
      await f.configure(true, { agents });
      await until(
        t,
        () =>
          f.logs.filter(({ event }) => event === 'config.reloaded').length >
          loaded,
      );
    };
    await configure();

    let id = 0;
    const say = async (text: string, userId = 'owner') => {
      await platform.emit(
        inbound(String(++id), text, { userId, mentionsBot: true }),
      );
      await gateway.idle();
      return platform.sent.at(-1)?.text;
    };
    for (const command of ['/model member-model', '/thinking high', '/fast on'])
      assert.equal(await say(command, 'member'), undefined);
    assert.equal(store.getChat(chat)?.model, null);
    assert.equal(store.getChat(chat)?.thinking, null);
    assert.equal(store.getChat(chat)?.serviceTier, null);
    assert.equal(await say('/model'), 'Model: configured-model (agent config)');
    assert.equal(await say('/thinking'), 'Effort: low (agent config)');
    assert.equal(await say('/fast'), 'Fast: off (agent config)');
    assert.match(
      (await say('/status')) ?? '',
      /^Model: configured-model · Effort: low · Fast: off$/m,
    );
    assert.equal(
      await say('/thinking minimal'),
      'Usage: /thinking <low|high|default>',
    );
    assert.equal(await say('/fast turbo'), 'Usage: /fast <on|off|default>');
    await say('first turn');
    assert.equal(requests[0]?.serviceTier, 'default');

    await say('/model chat-model');
    await say('/thinking high');
    await say('/fast on');
    assert.equal(await say('/model'), 'Model: chat-model (this chat)');
    assert.equal(await say('/thinking'), 'Effort: high (this chat)');
    assert.equal(await say('/fast'), 'Fast: on (this chat)');
    assert.match(
      (await say('/status')) ?? '',
      /^Model: chat-model · Effort: high · Fast: on$/m,
    );
    await say('overridden turn');
    assert.equal(requests[1]?.model, 'chat-model');
    assert.equal(requests[1]?.thinking, 'high');
    assert.equal(requests[1]?.serviceTier, 'fast');
    assert.equal(requests[1]?.resumeSessionId, 'session-1');
    assert.equal(store.getSession(chat, 'test')?.model, 'configured-model');

    await say('/model default');
    await say('/thinking default');
    await say('/fast default');
    assert.equal(store.getChat(chat)?.model, null);
    assert.equal(store.getChat(chat)?.thinking, null);
    assert.equal(store.getChat(chat)?.serviceTier, null);
    await say('cleared turn');
    assert.equal(requests[2]?.model, 'configured-model');
    assert.equal(requests[2]?.thinking, 'low');
    assert.equal(requests[2]?.serviceTier, 'default');
    assert.equal(requests[2]?.resumeSessionId, 'session-1');

    agents[0]!.serviceTier = 'provider-tier';
    await configure();
    assert.equal(await say('/fast'), 'Fast: provider-tier (agent config)');
    await say('reloaded turn');
    assert.equal(requests[3]?.serviceTier, 'provider-tier');

    await say('/thinking high');
    await say('/fast off');
    assert.equal(await say('/agent compatible'), 'Agent set to compatible.');
    assert.equal(store.getChat(chat)?.thinking, 'high');
    assert.equal(store.getChat(chat)?.serviceTier, 'default');
    assert.equal(await say('/model'), 'Model: provider-model (default)');
    await say('new agent turn');
    assert.equal(requests[4]?.model, 'default');
    assert.equal(requests[4]?.serviceTier, 'default');
    assert.equal(requests[4]?.resumeSessionId, undefined);
    assert.match(
      (await say('/agent legacy')) ?? '',
      /Cleared overrides unsupported by this agent: Effort, Fast\./,
    );
    assert.equal(store.getChat(chat)?.thinking, null);
    assert.equal(store.getChat(chat)?.serviceTier, null);
    assert.equal(await say('/fast'), 'This agent does not support fast mode.');
    assert.equal(
      await say('/fast on'),
      'This agent does not support fast mode.',
    );
    assert.equal(await say('/thinking'), 'Effort: medium (default)');
    await say('legacy turn');
    assert.equal(requests[5]?.serviceTier, undefined);
    assert.equal(await say('/thinking low'), 'Effort set to low.');
    await say('new legacy session');
    assert.equal(requests[6]?.thinking, 'low');
    assert.equal(requests[6]?.resumeSessionId, undefined);
  },
);

test('localizes current settings and command usage in Traditional Chinese', async (t) => {
  const { gateway, platform } = await fixture(
    t,
    async function* () {
      assert.fail('Commands do not run the agent');
    },
    true,
    {
      locale: 'zh-TW',
      agentSettings: () => ({
        thinking: ['minimal', 'low'],
        serviceTiers: true,
      }),
    },
  );
  let id = 0;
  const say = async (text: string) => {
    await platform.emit(inbound(String(++id), text));
    await gateway.idle();
    return platform.sent.at(-1)?.text;
  };
  assert.equal(await say('/model'), '模型：first（agent 設定）');
  assert.equal(await say('/thinking'), '推理：預設（預設）');
  assert.equal(
    await say('/thinking max'),
    '用法：/thinking <minimal|low|default>',
  );
  assert.equal(await say('/fast high'), '用法：/fast <on|off|default>');
  await say('/thinking minimal');
  await say('/fast on');
  assert.equal(await say('/thinking'), '推理：minimal（此聊天室）');
  assert.equal(await say('/fast'), '快速：開（此聊天室）');
  assert.match(
    (await say('/status')) ?? '',
    /^模型：first · 推理：minimal · 快速：開$/m,
  );
});

async function until(t: TestContext, condition: () => boolean) {
  while (!condition()) await delay(10, undefined, { signal: t.signal });
}

for (const outboundPush of ['free', 'metered', 'none'] as const) {
  test(
    `uses the same pending approval line with ${outboundPush} push`,
    { timeout: 5_000 },
    async (t) => {
      const wait = new AbortController();
      const timeout = AbortSignal.timeout;
      t.mock.method(AbortSignal, 'timeout', (ms: number) =>
        ms === 120_000 ? wait.signal : timeout(ms),
      );
      const f = await fixture(
        t,
        async function* (request) {
          const tool = request.tools.find(({ name }) => name === 'scoped_tool');
          assert.ok(tool);
          yield { type: 'text.final', text: 'NO_REPLY: Approval is pending' };
          await tool.run({ id: 'pending' });
        },
        true,
        { locale: 'zh-TW', outboundPush },
      );
      await f.platform.emit(inbound('pending', 'Use the scoped tool'));
      await until(t, () =>
        f.store.listApprovals().some(({ promptMessageId }) => promptMessageId),
      );
      wait.abort();
      await f.gateway.idle();

      const [prompt, ...replies] = f.platform.sent;
      assert.ok(prompt?.approval);
      assert.deepEqual(
        replies.map(({ replyTo, text }) => ({ replyTo, text })),
        [{ replyTo: 'pending', text: '會確認是否能排入，確認後生效。' }],
      );
      assert.deepEqual(f.platform.reactions, []);
      const task = f.store
        .listChatTasks(chat)
        .find(({ sourceMessageId }) => sourceMessageId === 'pending')!;
      assert.equal(
        f.store.getTaskExecution(task.id)?.outcome.kind,
        'delivered',
      );
      assert.equal(
        f.store.getTaskExecution(task.id)?.outcome.silentReason,
        'Approval is pending',
      );
      assert.deepEqual(
        f.store.getTaskExecution(task.id)?.outcome.delivery?.parts,
        [
          { messageId: prompt!.messageId, ok: true },
          { messageId: replies[0]!.messageId, ok: true },
        ],
      );
    },
  );
}

test(
  'metered schedules deliver while post-turn approval outcomes use feedback and status',
  { timeout: 5_000 },
  async (t) => {
    let now = Date.now();
    const at = now + 60_000;
    t.mock.method(Date, 'now', () => now);
    t.mock.timers.enable({ apis: ['setInterval'] });
    let wait = new AbortController();
    const timeout = AbortSignal.timeout;
    t.mock.method(AbortSignal, 'timeout', (ms: number) =>
      ms === 120_000 ? wait.signal : timeout(ms),
    );
    const f = await fixture(
      t,
      async function* (request) {
        const command = request.context.findLast(
          ({ source }) => source === 'message',
        )?.content;
        if (!command?.startsWith('schedule ')) return;
        const tool = request.tools.find(
          ({ name }) => name === 'schedule.create',
        );
        assert.ok(tool);
        await tool.run({
          action: { kind: 'message', text: command },
          trigger: { kind: 'once', at },
          needsApproval: true,
        });
      },
      true,
      { locale: 'zh-TW', outboundPush: 'metered' },
    );
    await f.platform.emit(inbound('owner-dm', 'Register', { chatId: 'owner' }));
    await f.gateway.idle();

    for (const [request, decision] of [
      ['deliver', 'approve'],
      ['deny', 'deny'],
      ['expire', undefined],
    ] as const) {
      wait = new AbortController();
      const before = f.platform.sent.length;
      await f.platform.emit(inbound(request, `schedule ${request}`));
      await until(t, () =>
        f.store
          .listApprovals()
          .some(
            ({ promptMessageId }) =>
              promptMessageId === f.platform.sent[before]?.messageId,
          ),
      );
      const prompt = f.platform.sent[before];
      assert.ok(prompt?.approval);
      assert.equal(prompt.chatId, 'owner');
      wait.abort();
      await f.gateway.idle();
      assert.equal(
        f.platform.sent.at(-1)?.text,
        '會確認是否能排入，確認後生效。',
      );
      if (decision) {
        now++;
        await f.platform.emit(
          inbound(`decision-${request}`, decision, {
            chatId: 'owner',
            replyTo: { id: prompt.messageId },
          }),
        );
        assert.equal(f.platform.feedback.at(-1)?.decision, decision);
      }
      assert.equal(f.platform.sent.length, before + 2);
    }
    const [schedule] = f.store.listSchedules(chat);
    assert.equal(schedule?.status, 'active');
    const beforeFire = f.platform.sent.length;
    now = at;
    t.mock.timers.tick(1_000);
    await until(
      t,
      () =>
        f.platform.feedback.at(-1)?.decision === 'expired' &&
        f.store.getSchedule(schedule.id)?.status === 'done',
    );
    await until(t, () =>
      f.trace.recent.some(({ name }) => name === 'schedule.fire'),
    );
    assert.deepEqual(
      f.platform.sent.slice(beforeFire).map(({ text }) => text),
      ['schedule deliver'],
    );
    assert.equal(
      f.store.listApprovals().filter(({ status }) => status === 'expired')
        .length,
      1,
    );
    assert.equal(
      f.trace.recent.filter(
        ({ name, attrs }) =>
          name === 'outbound.send' && attrs['push.metered'] === true,
      ).length,
      4,
    );
    assert.ok(
      f.trace.recent.some(
        ({ name, attrs }) =>
          name === 'schedule.fire' &&
          attrs.scheduleId === schedule.id &&
          attrs['push.metered'] === true,
      ),
    );

    await f.platform.emit(inbound('status', '/status'));
    assert.match(f.platform.sent.at(-1)?.text ?? '', /最近核准結果：已逾時/);
  },
);

test(
  'reply-only platforms reject new schedules and record a terminal failure after capability changes',
  { timeout: 5_000 },
  async (t) => {
    let now = Date.now();
    const at = now + 60_000;
    const reason =
      'Scheduled delivery is unavailable on this platform. It only supports replies to incoming messages.';
    t.mock.method(Date, 'now', () => now);
    t.mock.timers.enable({ apis: ['setInterval'] });
    let toolError: string | undefined;
    const f = await fixture(
      t,
      async function* (request) {
        const command = request.context.findLast(
          ({ source }) => source === 'message',
        )?.content;
        if (command === 'Register') return;
        if (command === 'list schedules') {
          const list = request.tools.find(
            ({ name }) => name === 'schedule.list',
          );
          assert.ok(list);
          const result = (await list.run({})) as { summary: string };
          yield { type: 'text.final', text: result.summary };
          return;
        }
        const tool = request.tools.find(
          ({ name }) => name === 'schedule.create',
        );
        assert.ok(tool);
        try {
          await tool.run({
            action: { kind: 'message', text: 'reminder' },
            trigger: { kind: 'interval', at, minutes: 30 },
            needsApproval: command === 'approval',
          });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          toolError = error.message;
        }
      },
      true,
      { outboundPush: 'none' },
    );
    await f.platform.emit(inbound('owner-dm', 'Register', { chatId: 'owner' }));
    await f.platform.emit(inbound('reject', 'new schedule'));
    await f.gateway.idle();
    assert.equal(toolError, reason);
    assert.deepEqual(f.store.listSchedules(chat), []);
    assert.deepEqual(f.store.listApprovals(), []);

    const { capabilities } = f.platform.platform;
    capabilities.outboundPush = 'free';
    await f.platform.emit(inbound('existing', 'existing schedule'));
    await f.gateway.idle();
    const [schedule] = f.store.listSchedules(chat);
    assert.equal(schedule?.status, 'active');
    await f.platform.emit(inbound('awaiting', 'approval'));
    await until(t, () =>
      f.store.listApprovals().some(({ promptMessageId }) => promptMessageId),
    );
    const [approval] = f.store.listApprovals();
    assert.ok(approval?.promptMessageId);

    capabilities.outboundPush = 'none';
    toolError = undefined;
    await f.platform.emit(
      inbound('approve', 'approve', {
        chatId: 'owner',
        replyTo: { id: approval.promptMessageId },
      }),
    );
    await f.gateway.idle();
    assert.equal(toolError, reason);
    assert.equal(f.store.getApproval(approval.id)?.failureReason, reason);
    assert.equal(
      f.gateway.admin.approvals().approvals[0]?.failureReason,
      reason,
    );
    assert.equal(f.store.listGrants().length, 0);
    assert.equal(f.store.listSchedules(chat).length, 1);

    const sent = f.platform.sent.length;
    now = at;
    t.mock.timers.tick(1_000);
    const failed = f.store.getSchedule(schedule.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.failureReason, reason);
    assert.equal(failed?.nextDueAt, null);
    now += 60 * 60_000;
    t.mock.timers.tick(1_000);
    assert.equal(f.platform.sent.length, sent);
    const failures = f.trace.recent.filter(
      ({ name }) => name === 'schedule.push_unavailable',
    );
    assert.equal(failures.length, 3);
    assert.ok(
      failures.some(
        ({ attrs }) =>
          attrs.approvalId === approval.id && attrs.reason === reason,
      ),
    );
    assert.equal(
      failures.filter(({ attrs }) => attrs.scheduleId === schedule.id).length,
      1,
    );

    await f.platform.emit(inbound('status', '/status'));
    assert.match(
      f.platform.sent.at(-1)?.text ?? '',
      new RegExp(`#${schedule.id.slice(0, 6)} failed`),
    );
    await f.platform.emit(inbound('list', 'list schedules'));
    await f.gateway.idle();
    assert.ok(f.platform.sent.at(-1)?.text.includes(reason));
  },
);

test('trigger decisions use native owner status, allowlist, mentions and bot replies', () => {
  const dm = inbound('m', 'hello');
  const group = { ...dm, chatKind: 'group' as const };
  assert.equal(shouldTrigger(dm, true, false), true);
  assert.equal(shouldTrigger(dm, false, false), false);
  assert.equal(shouldTrigger(group, true, true), false);
  assert.equal(
    shouldTrigger({ ...group, mentionsBot: true }, true, false),
    true,
  );
  assert.equal(
    shouldTrigger({ ...group, mentionsBot: true }, false, false),
    false,
  );
  assert.equal(
    shouldTrigger({ ...group, mentionsBot: true }, false, true),
    true,
  );
  assert.equal(
    shouldTrigger({ ...group, repliesToBot: true }, false, true),
    true,
  );
  assert.equal(
    shouldTrigger({ ...group, repliesToBot: true }, true, false),
    false,
  );
});

test(
  'routes messages, reloads agent attachment in place, and resumes only the current model',
  { timeout: 5_000 },
  async (t) => {
    const requests: AgentRequest[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        requests.push(request);
        yield await Promise.resolve({ type: 'text.delta', text: 'Re' });
        yield { type: 'text.delta', text: 'ply' };
        yield { type: 'sessionId', sessionId: `native-${request.model}` };
      },
      false,
    );

    await f.platform.emit(
      inbound('ignored', 'group history', {
        chatKind: 'group',
        userId: 'member',
      }),
    );
    assert.equal(f.store.getMessage(chat, 'ignored')?.text, 'group history');
    assert.equal(f.platform.sent.length, 0);
    await f.platform.emit(inbound('zero', 'hello'));
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'No agent is attached.');

    await f.configure(true);
    await until(
      t,
      () =>
        f.agentStarts === 1 &&
        f.logs.some((entry) => entry.event === 'config.reloaded'),
    );
    await f.platform.emit(inbound('first', 'first request'));
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'Reply');
    assert.equal(f.platform.sent.at(-1)?.replyTo, 'first');
    assert.deepEqual(f.store.getMessage(chat, 'bot-2')?.raw, {
      delivered: true,
    });
    assert.equal(requests[0]?.resumeSessionId, undefined);
    assert.ok(
      requests[0]?.context.some((block) => block.content === 'group history'),
    );

    await f.platform.emit(inbound('second', 'second request'));
    await f.gateway.idle();
    assert.equal(requests[1]?.resumeSessionId, 'native-first');
    assert.deepEqual(
      requests[1]?.context
        .filter((block) => block.source !== 'system')
        .map((block) => block.content),
      ['second request'],
    );

    await f.platform.emit(inbound('model', '/model changed'));
    await f.platform.emit(inbound('third', 'new model'));
    await f.gateway.idle();
    assert.equal(requests[2]?.model, 'changed');
    assert.equal(requests[2]?.resumeSessionId, undefined);
    await f.platform.emit(inbound('reset', '/model first'));
    await f.platform.emit(inbound('fourth', 'old model again'));
    await f.gateway.idle();
    assert.equal(requests[3]?.model, 'first');
    assert.equal(requests[3]?.resumeSessionId, undefined);

    await writeFile(f.path, '{"agents":[{"id":"test","kind":"missing"}]}');
    await until(t, () =>
      f.logs.some((entry) => entry.event === 'config.reload_failed'),
    );
    await f.platform.emit(inbound('still-live', 'keep old'));
    await f.gateway.idle();
    assert.equal(requests.length, 5);
    assert.equal(f.agentStops, 0);
    await f.configure(false);
    await until(t, () => f.agentStops === 1);
    await f.platform.emit(inbound('detached', 'test detach'));
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'No agent is attached.');
    assert.equal(f.platform.starts, 1);
    assert.equal(requests.length, 5);
    assert.ok(f.trace.recent.some((span) => span.name === 'agent.first_text'));
    assert.ok(f.trace.recent.some((span) => span.name === 'outbound.send'));
  },
);

test(
  'deletion aborts the running agent and suppresses its eventual answer',
  { timeout: 5_000 },
  async (t) => {
    const entered = Promise.withResolvers<AbortSignal>();
    const f = await fixture(t, async function* ({ signal }) {
      entered.resolve(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      yield { type: 'text.final', text: 'late answer' };
    });
    await f.platform.emit(inbound('source', 'to be deleted'));
    const signal = await entered.promise;
    await f.platform.emit({
      type: 'delete',
      chatId: chat.chatId,
      messageId: 'source',
    });
    await f.gateway.idle();
    assert.equal(signal.aborted, true);
    assert.equal(f.store.getMessage(chat, 'source')?.deleted, true);
    assert.deepEqual(f.platform.sent, []);
  },
);

test(
  'a running task gets reply-chain supplements and unrelated turns wait',
  { timeout: 5_000 },
  async (t) => {
    const entered = Promise.withResolvers<void>();
    const wait = Promise.withResolvers<void>();
    const inputs: string[][] = [];
    const seen: string[] = [];
    const f = await fixture(t, async function* (request, io) {
      inputs.push(
        request.context
          .filter((block) => block.source === 'message')
          .map((block) => block.content),
      );
      if (inputs.length === 1) {
        entered.resolve();
        for await (const message of io.supplements) {
          seen.push(message.text);
          if (seen.length === 2) break;
        }
        await wait.promise;
      }
      yield { type: 'text.final', text: 'answer' };
      yield { type: 'sessionId', sessionId: 'native' };
    });

    await f.platform.emit(inbound('source', 'original'));
    await entered.promise;
    await f.platform.emit(inbound('queued', 'unrelated'));
    await f.platform.emit(
      inbound('one', 'first supplement', { replyTo: { id: 'source' } }),
    );
    await f.platform.emit(
      inbound('two', 'second supplement', { replyTo: { id: 'one' } }),
    );
    await until(t, () => seen.length === 2);
    assert.equal(inputs.length, 1);
    wait.resolve();
    await f.gateway.idle();
    assert.deepEqual(seen, ['first supplement', 'second supplement']);
    assert.deepEqual(inputs, [['original'], ['unrelated']]);
    assert.deepEqual(
      f.platform.sent.map((message) => message.replyTo),
      ['source', 'queued'],
    );
    await f.platform.emit(inbound('next', 'next turn'));
    await f.gateway.idle();
    assert.deepEqual(inputs.at(-1), ['next turn']);
  },
);

test(
  'tool execution requires a linked decision for each single request',
  { timeout: 5_000 },
  async (t) => {
    let runCount = 0;
    const f = await fixture(t, async function* (request) {
      runCount++;
      const tool = request.tools[0];
      assert.ok(tool);
      const result = await tool.run(
        { id: 'p' },
        {
          chat: { adapterId: 'forged', chatId: 'other' },
          principal: { adapterId: 'forged', userId: 'forged' },
          signal: request.signal,
          taskId: 'forged',
        },
      );
      yield { type: 'text.final', text: `Tool for ${String(result)}` };
    });

    await f.platform.emit(inbound('allow', '/allow'));
    await f.platform.emit(
      inbound('source', 'use tool', {
        chatKind: 'group',
        mentionsBot: true,
        userId: 'member',
      }),
    );
    await until(t, () => f.platform.sent.length === 2);
    const prompt = f.platform.sent.at(-1);
    assert.match(prompt?.text ?? '', /Approval requested/);
    assert.ok(prompt?.buttons?.[0]);
    assert.deepEqual(
      prompt.buttons.map(({ label }) => label),
      ['Approve', 'Deny'],
    );
    const content = '🔔 Sample text\n你好😀';
    assert.ok(prompt.text.endsWith('\nContent:\n' + content));
    assert.deepEqual(prompt.entities, [
      {
        type: 'pre',
        offset: prompt.text.length - content.length,
        length: content.length,
      },
    ]);
    await f.platform.emit(inbound('unlinked', '好', { chatKind: 'group' }));
    await f.platform.emit(
      inbound('forged', 'yes', {
        chatKind: 'group',
        userId: 'member',
        replyTo: { id: prompt.messageId },
      }),
    );
    assert.equal(f.platform.sent.length, 2);
    await f.platform.emit({
      type: 'callback',
      chatId: chat.chatId,
      userId: 'owner',
      callbackId: prompt.buttons[0].id,
      messageId: prompt.messageId,
    });
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'Tool for member');

    await f.platform.emit(
      inbound('second', 'use again', {
        chatKind: 'group',
        mentionsBot: true,
        userId: 'member',
      }),
    );
    await until(t, () => f.platform.sent.length === 4);
    const second = f.platform.sent.at(-1);
    assert.ok(second?.buttons?.[0]);
    await f.platform.emit(
      inbound('second-approval', 'always', {
        replyTo: { id: second.messageId },
      }),
    );
    await f.gateway.idle();
    assert.equal(runCount, 2);
    assert.equal(f.platform.sent.length, 5);
    assert.equal(f.platform.sent.at(-1)?.text, 'Tool for member');
    assert.deepEqual(
      f.store.listGrants().map(({ mode }) => mode),
      ['once', 'once'],
    );
  },
);

for (const mode of ['reload', 'restart'] as const) {
  test(
    `a pending schedule stays actionable after gateway ${mode}`,
    { timeout: 5_000 },
    async (t) => {
      t.mock.method(Date, 'now', () => Date.parse('2026-11-26T11:59:00+08:00'));
      const f = await fixture(
        t,
        async function* (request) {
          if (request.context.at(-1)?.content !== 'Schedule a reminder') return;
          const tool = request.tools.find(
            ({ name }) => name === 'schedule.create',
          );
          assert.ok(tool);
          await tool.run({
            action: { kind: 'message', text: 'Recurring reminder' },
            trigger: { kind: 'interval', at: Date.now() + 60_000, minutes: 30 },
          });
        },
        true,
        { durable: mode === 'restart' },
      );
      await f.platform.emit(
        inbound('owner-dm', 'Hello', { chatId: 'owner', mentionsBot: false }),
      );
      const topic = {
        chatKind: 'group' as const,
        chatTitle: 'Test group',
        threadId: '8',
      };
      await f.platform.emit(inbound('allow-topic', '/allow', topic));
      await f.platform.emit(
        inbound('original', 'Schedule a reminder', {
          ...topic,
          mentionsBot: true,
          userId: 'member',
        }),
      );
      await until(t, () =>
        f.store.listApprovals().some(({ promptMessageId }) => promptMessageId),
      );
      const [approval] = f.store.listApprovals();
      const prompt = f.platform.sent.find(
        ({ messageId }) => messageId === approval?.promptMessageId,
      );
      assert.ok(approval && prompt?.buttons?.[0]);
      assert.equal(approval.status, 'pending');
      assert.equal(prompt.chatId, 'owner');
      assert.match(prompt.text, /^Mentions: none$/m);
      assert.ok(
        prompt.text
          .split('\n')
          .includes('When: from today 12:00, every 30 minutes'),
      );
      assert.match(
        prompt.text,
        /^Reason: This will send recurring messages to the group\.$/m,
      );
      const scope = { ...chat, chatId: chat.chatId + '_8' };

      let store = f.store;
      let platform = f.platform;
      let gateway = f.gateway;
      try {
        if (mode === 'reload') {
          await f.configure(false);
          await until(
            t,
            () =>
              f.agentStops === 1 &&
              f.logs.some(({ event }) => event === 'config.reloaded'),
          );
        } else {
          await f.gateway.stop();
          await f.configure(false);
          store = new SqliteStore(f.dbPath);
          platform = createPlatform('restarted');
          gateway = new Gateway({
            log: () => {},
            registry: new PluginRegistry([
              { name: 'test', adapters: { fake: () => platform.platform } },
            ]),
            store,
            workspace: join(f.path, '..'),
          });
          await gateway.start();
        }
        assert.equal(store.getTask(approval.taskId)?.status, 'cancelled');
        assert.equal(store.getApproval(approval.id)?.status, 'pending');
        assert.equal(
          store.getApproval(approval.id)?.expiresAt,
          approval.expiresAt,
        );
        assert.deepEqual(store.listSchedules(scope), []);
        if (mode === 'reload') {
          await platform.emit({
            type: 'callback',
            chatId: 'owner',
            userId: 'owner',
            callbackId: prompt.buttons[0].id,
            messageId: prompt.messageId,
          });
        } else {
          await platform.emit(
            inbound('accept-schedule', 'yes', {
              chatId: 'owner',
              replyTo: { id: prompt.messageId },
            }),
          );
        }
        const [schedule] = store.listSchedules(scope);
        assert.ok(schedule);
        assert.equal(schedule.createdBy, 'member');
        assert.equal(schedule.deliveryApprovedBy, 'owner');
        assert.equal(store.getApproval(approval.id)?.status, 'approved');
        assert.equal(
          platform.feedback.at(-1)?.pre?.length,
          'Recurring reminder'.length,
        );
        const outcome = platform.sent.at(-1);
        assert.equal(
          outcome?.text,
          `Schedule #${schedule.id.slice(0, 6)} was created. It runs from today 12:00, every 30 minutes.`,
        );
        assert.equal(outcome?.chatId, chat.chatId);
        assert.equal(outcome?.threadId, '8');
        assert.equal(outcome?.replyTo, 'original');
        await platform.emit(
          inbound('repeated-decision', 'yes', {
            chatId: 'owner',
            replyTo: { id: prompt.messageId },
          }),
        );
        assert.equal(store.listSchedules(scope).length, 1);
        assert.equal(store.listGrants().length, 1);
      } finally {
        if (gateway !== f.gateway) {
          await gateway.stop();
          store.close();
        }
      }
    },
  );
}

test(
  'schedule expiry edits the approval prompt, notifies the original topic and rejects late presses',
  { timeout: 5_000 },
  async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const due = now + 30_000;
    const f = await fixture(
      t,
      async function* (request) {
        if (request.context.at(-1)?.content !== 'Schedule a reminder') return;
        const tool = request.tools.find(
          ({ name }) => name === 'schedule.create',
        );
        assert.ok(tool);
        await assert.rejects(
          tool.run({
            action: { kind: 'message', text: 'Reminder' },
            trigger: { kind: 'interval', at: due, minutes: 30 },
          }),
          /Schedule approval expired/,
        );
        yield { type: 'text.final', text: '' };
      },
      true,
      { locale: 'zh-TW', reactions: true },
    );
    await f.platform.emit(inbound('owner-dm', 'Hello', { chatId: 'owner' }));
    const topic = { chatKind: 'group' as const, threadId: '8' };
    await f.platform.emit(inbound('allow-topic', '/allow', topic));
    await f.platform.emit(
      inbound('original', 'Schedule a reminder', {
        ...topic,
        mentionsBot: true,
        userId: 'member',
      }),
    );
    await until(t, () => f.platform.reactions.length === 1);
    const original = { chatId: chat.chatId, messageId: 'original' };
    assert.deepEqual(f.platform.reactions, [
      { ...original, status: 'pending' },
    ]);
    const [approval] = f.store.listApprovals();
    assert.ok(approval?.continuation?.kind === 'schedule');
    const prompt = f.platform.sent.find(
      ({ messageId }) => messageId === approval.promptMessageId,
    );
    assert.ok(prompt?.buttons?.[0]);
    const ref = approval.continuation.change.schedule.id.slice(0, 6);
    assert.equal(approval.expiresAt, due);
    assert.equal(prompt.chatId, 'owner');
    now = due;
    await until(t, () =>
      f.platform.sent.some(
        ({ text }) => text === `排程請求 #${ref} 已逾時，未獲同意。`,
      ),
    );
    const notice = f.platform.sent.at(-1);
    assert.equal(notice?.chatId, chat.chatId);
    assert.equal(notice?.threadId, '8');
    assert.equal(notice?.replyTo, 'original');
    assert.deepEqual(f.platform.reactions.at(-1), {
      ...original,
      status: 'expired',
    });
    assert.equal(f.store.getApproval(approval.id)?.status, 'expired');
    assert.ok(f.trace.recent.some(({ name }) => name === 'approval.expired'));
    const [edit] = f.platform.feedback;
    assert.equal(edit?.chatId, 'owner');
    assert.equal(edit?.messageId, prompt.messageId);
    assert.equal(edit?.prompt, prompt.text);
    assert.equal(edit?.decisionText, '⌛ 已逾時');

    await f.platform.emit({
      type: 'callback',
      chatId: 'owner',
      userId: 'owner',
      callbackId: prompt.buttons[0].id,
      messageId: prompt.messageId,
      queryId: 'late',
    });
    await f.gateway.idle();
    const [, late] = f.platform.feedback;
    assert.equal(late?.notice, '已逾時');
    assert.equal(late?.queryId, 'late');
    assert.equal(late?.decisionText, undefined);
    assert.equal(f.platform.sent.at(-1), notice);
    assert.deepEqual(f.store.listGrants(), []);
    assert.deepEqual(f.store.listSchedules({ ...chat, chatId: 'room_8' }), []);
  },
);

test(
  'a metered platform without buttons accepts a quoted text approval',
  { timeout: 5_000 },
  async (t) => {
    const calls: unknown[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        const tool = request.tools.find(({ name }) => name === 'scoped_tool');
        assert.ok(tool);
        await tool.run({ id: 'text-approval' });
      },
      true,
      {
        outboundPush: 'metered',
        onScopedTool: (args, userId) => calls.push({ args, userId }),
      },
    );
    f.platform.platform.capabilities.inlineButtons = false;
    const group = { chatKind: 'group' as const };
    await f.platform.emit(inbound('allow-text-approval', '/allow', group));
    await f.platform.emit(
      inbound('request-text-approval', 'Use the scoped tool', {
        ...group,
        mentionsBot: true,
        userId: 'member',
      }),
    );
    await until(t, () =>
      f.store.listApprovals().some(({ promptMessageId }) => promptMessageId),
    );
    const prompt = f.platform.sent.find(({ approval }) => approval);
    assert.ok(prompt);
    assert.equal(prompt.buttons, undefined);
    assert.match(prompt.text, /Reply directly.*approve.*deny/);
    await f.platform.emit(
      inbound('approve-by-quote', 'approve', {
        ...group,
        replyTo: { id: prompt.messageId },
      }),
    );
    await f.gateway.idle();
    assert.deepEqual(calls, [
      { args: { id: 'text-approval' }, userId: 'member' },
    ]);
  },
);

test(
  'a detached framework tool runs once with the original arguments and requester',
  { timeout: 5_000 },
  async (t) => {
    const calls: unknown[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        const tool = request.tools.find(({ name }) => name === 'scoped_tool');
        assert.ok(tool);
        await tool.run({ id: 'original-scope' });
      },
      true,
      { onScopedTool: (args, userId) => calls.push({ args, userId }) },
    );
    const group = { chatKind: 'group' as const };
    await f.platform.emit(inbound('allow-tools', '/allow', group));
    await f.platform.emit(
      inbound('use-tool', 'Use the scoped tool', {
        ...group,
        mentionsBot: true,
        userId: 'member',
      }),
    );
    await until(t, () =>
      f.store.listApprovals().some(({ promptMessageId }) => promptMessageId),
    );
    const [approval] = f.store.listApprovals();
    assert.ok(approval?.promptMessageId);
    await f.configure(false);
    await until(t, () =>
      f.logs.some(({ event }) => event === 'config.reloaded'),
    );
    const replyTo = approval.promptMessageId;
    assert.equal(f.store.getApproval(approval.id)?.status, 'pending');
    await f.platform.emit(
      inbound('tool-yes', 'yes', { ...group, replyTo: { id: replyTo } }),
    );
    await f.platform.emit(
      inbound('tool-yes-again', 'yes', { ...group, replyTo: { id: replyTo } }),
    );
    assert.deepEqual(calls, [
      { args: { id: 'original-scope' }, userId: 'member' },
    ]);
    assert.equal(
      f.platform.sent.at(-1)?.text,
      'The approved action completed.',
    );
    assert.equal(f.platform.sent.at(-1)?.replyTo, 'use-tool');
  },
);

for (const mode of ['reaction', 'fallback', 'answer'] as const) {
  test(
    `a generic approval timeout ends the turn with ${mode} feedback`,
    { timeout: 5_000 },
    async (t) => {
      const wait = new AbortController();
      const timeout = AbortSignal.timeout;
      t.mock.method(AbortSignal, 'timeout', (ms: number) =>
        ms === 120_000 ? wait.signal : timeout(ms),
      );
      let toolResult: unknown;
      let turnSignal: AbortSignal | undefined;
      const f = await fixture(
        t,
        async function* (request) {
          const tool = request.tools.find(({ name }) => name === 'scoped_tool');
          assert.ok(tool);
          turnSignal = request.signal;
          if (mode === 'answer')
            yield { type: 'text.final', text: 'The independent answer is 42.' };
          toolResult = await tool.run({ id: 'test' });
          if (mode === 'answer')
            await new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else
                request.signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
            });
          yield {
            type: 'text.final',
            text: 'I sent the request and am waiting for approval.',
          };
        },
        true,
        {
          plugins:
            mode === 'answer'
              ? [
                  {
                    name: 'tool-result-hook',
                    hooks: {
                      'tool.after': {
                        mode: 'sync',
                        timeoutMs: 200,
                        run: () => delay(10),
                      },
                    },
                  },
                ]
              : undefined,
          reactions:
            mode === 'fallback'
              ? undefined
              : async (_, status) => {
                  if (mode === 'reaction' && status === 'pending')
                    throw new Error('Reaction unavailable');
                },
        },
      );
      await f.platform.emit(inbound('original', 'Use the scoped tool'));
      await until(t, () =>
        f.store.listApprovals().some(({ promptMessageId }) => promptMessageId),
      );
      const [approval] = f.store.listApprovals();
      assert.ok(approval?.promptMessageId);
      assert.equal(f.platform.sent.length, 1);
      const original = { chatId: chat.chatId, messageId: 'original' };
      if (mode !== 'fallback')
        assert.deepEqual(f.platform.reactions, [
          { ...original, status: 'pending' },
        ]);
      wait.abort();
      await f.gateway.idle();
      assert.ok(turnSignal?.aborted);
      assert.deepEqual(toolResult, {
        pending: true,
        summary:
          "I'll check whether this can be scheduled; it takes effect once confirmed.",
        instruction:
          'The framework handles pending approval feedback. Do not mention the pending approval in your reply.',
      });
      assert.deepEqual(
        f.platform.sent.slice(1).map(({ text }) => text),
        mode === 'answer'
          ? ['The independent answer is 42.']
          : mode === 'fallback'
            ? [
                "I'll check whether this can be scheduled; it takes effect once confirmed.",
              ]
            : [],
      );
      assert.equal(f.store.getApproval(approval.id)?.status, 'pending');
      if (mode === 'reaction') {
        assert.ok(
          f.logs.some(({ event }) => event === 'approval.reaction_failed'),
        );
        assert.ok(
          f.trace.recent.some(
            ({ name, status }) =>
              name === 'approval.reaction' && status === 'error',
          ),
        );
      }
      await f.platform.emit(
        inbound('deny', 'deny', { replyTo: { id: approval.promptMessageId } }),
      );
      assert.equal(f.store.getApproval(approval.id)?.status, 'denied');
      assert.deepEqual(
        f.platform.reactions,
        mode === 'fallback'
          ? []
          : [
              { ...original, status: 'pending' },
              { ...original, status: 'denied' },
            ],
      );
      assert.equal(f.platform.sent.at(-1)?.text, 'The request was denied.');
    },
  );
}

test(
  'a platform can detach and reattach while the gateway remains running',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t, async function* () {
      yield await Promise.resolve({ type: 'text.final', text: 'answer' });
    });
    const reloads = () =>
      f.logs.filter((entry) => entry.event === 'config.reloaded').length;
    const initial = reloads();
    await f.configure(true, { platform: false });
    await until(t, () => reloads() > initial);
    await assert.rejects(
      f.platform.emit(inbound('detached', 'cannot arrive')),
      /adapter attached/,
    );
    assert.equal(f.agentStarts, 1);
    assert.equal(f.agentStops, 0);

    await f.configure(true);
    await until(t, () => f.platform.starts === 2 && reloads() > initial + 1);
    await f.platform.emit(inbound('reattached', 'can arrive'));
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'answer');
  },
);

test(
  'supplements still reach an agent that cannot read them while streaming',
  { timeout: 5_000 },
  async (t) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: AgentRequest[] = [];
    const f = await fixture(t, async function* (request) {
      requests.push(request);
      if (requests.length === 1) {
        entered.resolve();
        await release.promise;
      }
      yield { type: 'sessionId', sessionId: 'native' };
      yield {
        type: 'text.final',
        text: requests.length === 1 ? 'First' : 'Supplement',
      };
    });
    await f.platform.emit(inbound('original', 'original'));
    await entered.promise;
    await f.platform.emit(
      inbound('supplement', 'more detail', { replyTo: { id: 'original' } }),
    );
    release.resolve();
    await f.gateway.idle();
    assert.equal(requests[1]?.resumeSessionId, 'native');
    assert.deepEqual(
      requests[1]?.context.map((block) => block.content),
      ['more detail'],
    );
    assert.deepEqual(
      f.platform.sent.map((message) => message.text),
      ['First\n\nSupplement'],
    );
  },
);

test(
  'topic history, workspaces and approvals stay scoped while edits update text',
  { timeout: 5_000 },
  async (t) => {
    const requests: AgentRequest[] = [];
    let approvals = 0;
    const f = await fixture(t, async function* (request, io) {
      requests.push(request);
      if (request.context.at(-1)?.content === 'approve something') {
        const approved = await io.requestApproval({
          action: 'test.topic',
          resource: { type: 'global' },
        });
        if (approved) approvals++;
      }
      yield { type: 'text.final', text: 'answer' };
    });
    const room = {
      chatId: '-1001',
      chatKind: 'supergroup' as const,
      mentionsBot: true,
    };
    await f.platform.emit(
      inbound('info', 'old text', {
        ...room,
        threadId: '7',
        userId: 'member',
        mentionsBot: false,
      }),
    );
    await f.platform.emit(
      inbound('info', 'edited text', {
        ...room,
        threadId: '7',
        edited: true,
        userId: 'member',
      }),
    );
    await f.platform.emit(
      inbound('info', 'second topic', {
        ...room,
        threadId: '8',
        userId: 'member',
        mentionsBot: false,
      }),
    );
    assert.equal(requests.length, 0);
    await f.platform.emit(
      inbound('source', 'approve something', { ...room, threadId: '7' }),
    );
    await until(t, () => f.platform.sent.length === 1);
    const prompt = f.platform.sent[0];
    assert.ok(prompt?.buttons?.[0]);
    const callback = {
      type: 'callback' as const,
      chatId: room.chatId,
      userId: 'owner',
      messageId: prompt.messageId,
      callbackId: prompt.buttons[0].id,
    };
    await f.platform.emit({ ...callback, threadId: '8' });
    assert.equal(approvals, 0);
    await f.platform.emit({ ...callback, threadId: '7' });
    await f.gateway.idle();
    assert.equal(approvals, 1);
    await f.platform.emit(
      inbound('source', 'next one', { ...room, threadId: '8' }),
    );
    await f.gateway.idle();

    assert.ok(requests[0]?.workdir.endsWith('/-1001_7'));
    assert.ok(requests[1]?.workdir.endsWith('/-1001_8'));
    assert.ok(
      requests[0]?.context.some((block) => block.content === 'edited text'),
    );
    assert.equal(
      requests[0]?.context.some((block) =>
        ['old text', 'second topic'].includes(block.content),
      ),
      false,
    );
    assert.ok(
      requests[1]?.context.some((block) => block.content === 'second topic'),
    );
    assert.equal(
      requests[1]?.context.some((block) => block.content === 'edited text'),
      false,
    );
    assert.deepEqual(
      f.platform.sent.map((message) => [message.chatId, message.threadId]),
      [
        ['-1001', '7'],
        ['-1001', '7'],
        ['-1001', '8'],
      ],
    );
  },
);

test(
  'history tools scope reads and searches to the task topic and page through original text',
  { timeout: 5_000 },
  async (t) => {
    let checked: Promise<void> | undefined;
    const f = await fixture(t, async function* (request) {
      checked = verify(request);
      await checked;
      yield { type: 'text.final', text: 'History inspected' };
    });
    const room = { chatId: '-1001', chatKind: 'group', threadId: '7' } as const;
    const topic = { adapterId, chatId: '-1001_7' };
    const original = `${'x'.repeat(6_000)} NeedLE%_ at the end`;
    const oversized = '😀"\n'.repeat(13_000);
    const firstTime = Date.UTC(2026, 0, 1, 17);
    let now = firstTime;
    t.mock.method(Date, 'now', () => now);
    await f.platform.emit(
      inbound('first', original, {
        ...room,
        userId: 'member',
        userDisplay: 'Jamie',
      }),
    );
    now += 1_000;
    await f.platform.emit(
      inbound('other-topic', 'needle%_ in a different topic', {
        ...room,
        threadId: '8',
      }),
    );
    await f.platform.emit(
      inbound('other-chat', 'needle%_ in a different group', {
        ...room,
        chatId: '-1002',
      }),
    );
    await f.platform.emit(
      inbound('dm', 'needle%_ in a DM', { chatId: 'member', userId: 'member' }),
    );
    const otherAdapter = { ...topic, adapterId: 'fake:other' };
    const foreign = f.store.recordInbound(
      { ...otherAdapter, kind: 'group', title: null },
      { adapterId: otherAdapter.adapterId, userId: 'member', display: null },
      {
        ...otherAdapter,
        direction: 'inbound',
        messageId: 'foreign',
        userId: 'member',
        threadId: '7',
        replyTo: null,
        text: 'needle%_ on another adapter',
        raw: null,
      },
    )!;
    await f.platform.emit(inbound('deleted', 'needle%_ removed', room));
    await f.platform.emit({ type: 'delete', ...room, messageId: 'deleted' });
    await f.platform.emit(inbound('large', oversized, room));
    await f.platform.emit(
      inbound('literal', 'needlexy without punctuation', room),
    );
    f.store.recordOutbound({
      ...topic,
      direction: 'outbound',
      messageId: 'sent',
      replyTo: null,
      threadId: '7',
      userId: null,
      text: 'Another needle%_ match',
      raw: null,
    });

    const first = f.store.getMessage(topic, 'first')!.seq;
    const large = f.store.getMessage(topic, 'large')!.seq;
    const literal = f.store.getMessage(topic, 'literal')!.seq;
    const sent = f.store.getMessage(topic, 'sent')!.seq;
    const verify = async (request: AgentRequest) => {
      const search = request.tools.find(
        ({ name }) => name === 'history.search',
      );
      const read = request.tools.find(({ name }) => name === 'history.read');
      assert.ok(search && read);
      interface Page {
        messages: {
          direction: string;
          displayName: string | null;
          seq: number;
          text: string;
          textOffset?: number;
          time: string;
          userId: string | null;
        }[];
        next?: Record<string, number>;
        truncated: boolean;
        trust: string;
      }
      const query = { query: 'needle%_', limit: 1 };
      const newest = (await search.run(query)) as Page;
      assert.equal(newest.trust, 'untrusted');
      assert.equal(newest.truncated, false);
      assert.equal(newest.messages[0]?.seq, sent);
      assert.equal(newest.messages[0]?.direction, 'outbound');
      assert.equal(newest.messages[0]?.userId, null);
      assert.ok(newest.next);
      const older = (await search.run({ ...query, ...newest.next })) as Page;
      assert.equal(older.next, undefined);
      assert.deepEqual(
        older.messages.map(({ seq }) => seq),
        [first],
      );
      assert.match(older.messages[0]!.text, /NeedLE%_ at the end/);
      const bySender = (await search.run({
        query: 'needle%_',
        userId: 'member',
      })) as Page;
      assert.deepEqual(bySender.messages, older.messages);
      const byTime = (await search.run({
        query: 'needle%_',
        fromTime: firstTime,
        toTime: firstTime,
      })) as Page;
      assert.deepEqual(byTime.messages, older.messages);
      await assert.rejects(
        search.run({ ...query, limit: 51 }),
        /Invalid tool arguments/,
      );
      await assert.rejects(
        search.run({ ...query, chatId: room.chatId }),
        /Invalid tool arguments/,
      );

      const found = (await read.run({ seq: first })) as Page;
      assert.deepEqual(found.messages, [
        {
          seq: first,
          direction: 'inbound',
          displayName: 'Jamie',
          id: 'first',
          at: firstTime,
          sender: { id: 'member', name: 'Jamie' },
          attachments: [],
          replyTo: undefined,
          time: '2026-01-02, 01:00:00 GMT+8',
          userId: 'member',
          text: original,
        },
      ]);
      assert.deepEqual(
        ((await read.run({ seq: foreign.seq })) as Page).messages,
        [],
      );
      await assert.rejects(
        read.run({ seq: first, threadId: '8' }),
        /Invalid tool arguments/,
      );

      const range = (await read.run({ seq: first, throughSeq: sent })) as Page;
      assert.deepEqual(
        range.messages.map(({ seq }) => seq),
        [first],
      );
      assert.equal(range.truncated, true);
      assert.equal(range.next?.seq, large);
      let page = range;
      let recovered = '';
      const seen: number[] = [];
      for (let i = 0; page.next && i < 5; i++) {
        page = (await read.run(page.next)) as Page;
        assert.ok(JSON.stringify(page).length <= 40_000);
        for (const message of page.messages) {
          if (message.seq === large) {
            assert.equal(message.textOffset ?? 0, recovered.length);
            assert.equal(message.text.isWellFormed(), true);
            recovered += message.text;
          } else seen.push(message.seq);
        }
      }
      assert.equal(page.next, undefined);
      assert.equal(recovered, oversized);
      assert.deepEqual(seen, [literal, sent]);
    };
    await f.platform.emit(
      inbound('trigger', 'Look up the conversation', {
        ...room,
        mentionsBot: true,
      }),
    );
    await f.gateway.idle();
    assert.ok(checked, 'the chat turn can call the history tools');
    await checked;
  },
);

test(
  'summary character caps preserve short excerpts and catch up at the saved cursor',
  { timeout: 5_000 },
  async (t) => {
    const summaries: AgentRequest[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        if (request.purpose !== 'summary') return;
        summaries.push(request);
        yield {
          type: 'text.final',
          text: summaries.length === 1 ? 's'.repeat(400) : 'Caught up',
        };
      },
      true,
      {
        context: { recentMessages: 2, summary: { minMessages: 2 } },
      },
    );
    const reloads = () =>
      f.logs.filter(({ event }) => event === 'config.reloaded').length;
    await until(t, () => reloads() > 0);
    const loaded = reloads();
    await f.configure(true, {
      context: {
        recentMessages: 2,
        summary: { minMessages: 2, maxMessageChars: 500, maxBatchChars: 1_000 },
      },
    });
    await until(t, () => reloads() > loaded);
    const original = `HEAD${'a'.repeat(13_000)}TAIL`;
    const group = { chatKind: 'group' } as const;
    const short = 'short excerpt';
    const medium = 'm'.repeat(500);
    for (const [id, text] of [
      ['short', short],
      ['long', original],
      ['medium', medium],
      ['another-short', short],
      ['remaining', medium],
      ['recent', 'Recently said'],
    ] as const)
      await f.platform.emit(inbound(id, text, group));
    const long = f.store.getMessage(chat, 'long')!;
    const savedCursors: number[] = [];
    const saveSummary = f.store.saveSummary.bind(f.store);
    t.mock.method(
      f.store,
      'saveSummary',
      (summary: Parameters<typeof saveSummary>[0]) => {
        savedCursors.push(summary.throughSeq);
        return saveSummary(summary);
      },
    );
    await f.platform.emit(
      inbound('trigger', 'Summarize later', { ...group, mentionsBot: true }),
    );
    await f.gateway.idle();
    await until(t, () => f.store.getSummary(chat)?.text === 'Caught up');
    assert.equal(summaries.length, 2);
    assert.deepEqual(savedCursors, [
      long.seq,
      f.store.getMessage(chat, 'another-short')!.seq,
    ]);
    const excerpts = (request: AgentRequest) =>
      request.context
        .filter(({ source }) => source === 'message')
        .map(({ content }) => (JSON.parse(content) as { text: string }).text);
    const [untouched, shortened] = excerpts(summaries[0]!);
    assert.equal(untouched, short);
    assert.ok(shortened && shortened.length <= 500);
    const match = shortened.match(
      /^(HEADa*)…\[omitted ([\d,]+) chars, message #(\d+)\]…(a*TAIL)$/,
    );
    assert.ok(match);
    const [, head, count, seq, tail] = match;
    assert.equal(Number(seq), long.seq);
    assert.equal(
      Number(count!.replaceAll(',', '')),
      original.length - head!.length - tail!.length,
    );
    assert.ok(Math.abs(head!.length - 2 * tail!.length) <= 2);
    assert.deepEqual(excerpts(summaries[1]!), [medium, short]);
    assert.equal(f.store.getMessage(chat, 'long')?.text, original);
    assert.match(
      summaries[0]!.context[0]!.content,
      /sender, topic and message number/,
    );
    assert.ok(summaries.every(({ tools }) => tools.length === 0));
  },
);

test(
  'summaries run after delivery and fresh turns keep the summary cutoff and raw window',
  { timeout: 5000 },
  async (t) => {
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const summaryRequest = Promise.withResolvers<AgentRequest>();
    const prompts: AgentRequest[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        if (request.purpose === 'summary') {
          summaryRequest.resolve(request);
          await release.promise;
          yield { type: 'text.final', text: '近期對話摘要' };
          return;
        }
        prompts.push(request);
        yield { type: 'text.final', text: 'Chat reply' };
      },
      true,
      {
        context: {
          recentMessages: 2,
          summary: { minMessages: 3, model: 'economy' },
        },
        locale: 'zh-TW',
      },
    );

    const group = { chatKind: 'group' as const };
    await f.platform.emit(inbound('sticker', '', group));
    await f.platform.emit(inbound('history-1', 'First old message', group));
    await f.platform.emit(inbound('service', '　', group));
    await f.platform.emit(inbound('history-2', 'Recent message', group));
    await f.platform.emit(
      inbound('current-1', 'Answer this', { ...group, mentionsBot: true }),
    );
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'Chat reply');
    const summary = await summaryRequest.promise;
    assert.equal(summary.model, 'economy');
    assert.equal(summary.tools.length, 0);
    assert.match(
      summary.context[0]?.content ?? '',
      /Traditional Chinese \(Taiwan, zh-TW\)/,
    );
    assert.equal(
      summary.context.filter(({ source }) => source === 'message').length,
      1,
    );
    assert.match(summary.context.at(-1)?.content ?? '', /First old message/);
    assert.equal(f.store.getSummary(chat)?.text, '');
    release.resolve();
    await until(t, () => f.store.getSummary(chat)?.text === '近期對話摘要');
    await f.platform.emit(
      inbound('current-2', 'Follow up', { ...group, mentionsBot: true }),
    );
    await f.gateway.idle();
    assert.deepEqual(
      prompts
        .at(-1)
        ?.context.filter(
          ({ source }) => source === 'summary' || source === 'message',
        )
        .map(({ content }) => content),
      [
        '近期對話摘要',
        'Recent message',
        'Answer this',
        'Chat reply',
        'Follow up',
      ],
    );
  },
);

test(
  'summary threshold, effort and timeout use defaults and hot reload while each batch stays capped',
  { timeout: 5000 },
  async (t) => {
    const timeout = t.mock.method(AbortSignal, 'timeout');
    const summaries: AgentRequest[] = [];
    const prompts: AgentRequest[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        if (request.purpose === 'summary') {
          summaries.push(request);
          yield { type: 'text.final', text: `Summary ${summaries.length}` };
        } else {
          prompts.push(request);
        }
      },
      true,
      { context: { recentMessages: 2 } },
    );
    const group = { chatKind: 'group' as const };
    const history = Array.from({ length: 20 }, (_, i) => `History ${i}`);
    for (const message of history)
      await f.platform.emit(inbound(message, message, group));
    const turn = async (id: string) => {
      await f.platform.emit(inbound(id, id, { ...group, mentionsBot: true }));
      await f.gateway.idle();
      await setImmediate();
    };
    const messages = (request: AgentRequest) =>
      request.context.filter(({ source }) => source === 'message');

    await turn('Below threshold');
    assert.equal(summaries.length, 0);
    assert.deepEqual(
      messages(prompts[0]!).map(({ content }) => content),
      [...history, 'Below threshold'],
    );

    await turn('At threshold');
    await until(t, () => f.store.getSummary(chat)?.text === 'Summary 1');
    assert.equal(summaries.length, 1);
    assert.equal(messages(summaries[0]!).length, 20);
    assert.equal(summaries[0]?.thinking, 'low');
    assert.ok(timeout.mock.calls.some(({ arguments: [ms] }) => ms === 120_000));

    const reloads = () =>
      f.logs.filter(({ event }) => event === 'config.reloaded').length;
    await until(t, () => reloads() > 0);
    const loaded = reloads();
    await f.configure(true, {
      context: {
        recentMessages: 2,
        summary: {
          maxMessages: 30,
          minIntervalMinutes: 0,
          minMessages: 41,
          thinking: 'medium',
          timeoutMs: 45_000,
        },
      },
    });
    await until(t, () => reloads() > loaded);
    for (let i = 0; i < 39; i++)
      await f.platform.emit(inbound(`More ${i}`, `More ${i}`, group));
    await turn('Below new threshold');
    assert.equal(summaries.length, 1);

    await turn('At new threshold');
    await until(t, () => f.store.getSummary(chat)?.text === 'Summary 2');
    assert.equal(summaries.length, 2);
    assert.equal(messages(summaries[1]!).length, 30);
    assert.equal(summaries[1]?.thinking, 'medium');
    assert.ok(timeout.mock.calls.some(({ arguments: [ms] }) => ms === 45_000));
  },
);

test(
  'summary rechecks once at the end of the interval with the latest queued backlog',
  { timeout: 5000 },
  async (t) => {
    const summaries: AgentRequest[] = [];
    const prompts: AgentRequest[] = [];
    const firstSummary = 'x'.repeat(4_000);
    const f = await fixture(
      t,
      async function* (request) {
        if (request.purpose === 'summary') {
          summaries.push(request);
          yield {
            type: 'text.final',
            text: summaries.length === 1 ? firstSummary + 'overflow' : 'Second',
          };
        } else {
          prompts.push(request);
        }
      },
      true,
      { context: { recentMessages: 2 } },
    );
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const group = { chatKind: 'group' as const };
    const turn = async (id: string) => {
      await f.platform.emit(inbound(id, id, { ...group, mentionsBot: true }));
      await f.gateway.idle();
      await setImmediate();
    };
    const messages = (request: AgentRequest) =>
      request.context.filter(({ source }) => source === 'message');

    for (let i = 0; i < 205; i++)
      await f.platform.emit(inbound(`History ${i}`, `History ${i}`, group));
    assert.equal(f.store.beginSummary(chat).updatedAt, null);
    await turn('First turn');
    assert.equal(summaries.length, 1);
    assert.equal(messages(summaries[0]!).length, 200);
    assert.equal(f.store.getSummary(chat)?.text, firstSummary);
    assert.equal(f.store.getSummary(chat)?.updatedAt, 0);

    for (let i = 0; i < 54; i++)
      await f.platform.emit(inbound(`Backlog ${i}`, `Backlog ${i}`, group));
    await turn('Second turn');
    assert.equal(summaries.length, 1);
    assert.equal(messages(prompts.at(-1)!).length, 42);
    assert.equal(messages(prompts.at(-1)!)[0]?.content, 'Backlog 13');

    const intervalMs = 15 * 60_000;
    t.mock.timers.tick(intervalMs - 1);
    await f.platform.emit(inbound('Backlog 54', 'Backlog 54', group));
    await turn('Third turn');
    assert.equal(summaries.length, 1);

    const getSummary = t.mock.method(f.store, 'getSummary');
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(summaries.length, 2);
    assert.equal(getSummary.mock.callCount(), 1);
    assert.match(messages(summaries[1]!).at(-1)?.content ?? '', /Second turn/);
    assert.equal(f.store.getSummary(chat)?.text, 'Second');
    assert.equal(f.store.getSummary(chat)?.updatedAt, intervalMs);

    getSummary.mock.resetCalls();
    t.mock.timers.tick(intervalMs);
    await setImmediate();
    assert.equal(getSummary.mock.callCount(), 0);
    assert.equal(summaries.length, 2);
  },
);

test(
  'summary catches up without waiting while a full batch remains',
  { timeout: 5000 },
  async (t) => {
    const summaries: AgentRequest[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        if (request.purpose === 'summary') {
          summaries.push(request);
          yield { type: 'text.final', text: `Summary ${summaries.length}` };
        }
      },
      true,
      { context: { recentMessages: 2 } },
    );
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const group = { chatKind: 'group' as const };
    const messages = (request: AgentRequest) =>
      request.context.filter(({ source }) => source === 'message');

    for (let i = 0; i < 450; i++)
      await f.platform.emit(inbound(`History ${i}`, `History ${i}`, group));
    await f.platform.emit(
      inbound('Turn', 'Turn', { ...group, mentionsBot: true }),
    );
    await f.gateway.idle();
    await until(t, () => f.store.getSummary(chat)?.text === 'Summary 2');
    await setImmediate();
    assert.equal(summaries.length, 2);
    assert.equal(messages(summaries[0]!).length, 200);
    assert.equal(messages(summaries[1]!).length, 200);
    assert.equal(
      JSON.parse(messages(summaries[1]!)[0]!.content).text,
      'History 200',
    );
  },
);

test(
  'a different DM requires linked native recipient approval and scheduled agents use the task pipeline',
  { timeout: 6000 },
  async (t) => {
    const seen: AgentRequest[] = [];
    const f = await fixture(t, async function* (request) {
      seen.push(request);
      const message = request.context
        .filter(({ source }) => source === 'message')
        .at(-1)?.content;
      if (message === 'Create recipient reminder') {
        const tool = request.tools.find(
          ({ name }) => name === 'schedule.create',
        );
        const result = await tool?.run({
          action: { kind: 'message', text: '**Recipient reminder**' },
          trigger: { kind: 'once', at: Date.now() + 300 },
          targetChatId: 'recipient-dm',
          needsApproval: false,
        });
        assert.equal((result as { status: string }).status, 'scheduled');
        yield { type: 'text.final', text: 'Recipient reminder scheduled' };
      } else if (message === 'Create agent run') {
        await request.tools
          .find(({ name }) => name === 'schedule.create')
          ?.run({
            action: {
              kind: 'agent',
              prompt: 'Report now',
              model: 'scheduled-model',
            },
            trigger: { kind: 'once', at: Date.now() + 300 },
          });
        yield { type: 'text.final', text: 'Agent job scheduled' };
      } else if (message === '[Scheduled task] Report now') {
        yield { type: 'text.final', text: 'Agent job delivered' };
      }
    });
    const recipient = { chatId: 'recipient-dm', userId: 'recipient' };
    await f.platform.emit(inbound('declare-dm', 'Hello', recipient));
    await f.platform.emit(inbound('allow', '/allow'));
    await f.platform.emit(
      inbound('schedule-recipient', 'Create recipient reminder', {
        chatKind: 'group',
        userId: 'member',
        mentionsBot: true,
      }),
    );
    await until(t, () =>
      f.platform.sent.some(({ chatId }) => chatId === recipient.chatId),
    );
    const prompt = f.platform.sent.find(
      ({ chatId }) => chatId === recipient.chatId,
    );
    assert.ok(prompt?.buttons?.[0]);
    assert.equal(f.store.listSchedules(chat).length, 0);
    await f.platform.emit(inbound('unlinked-approval', 'yes', recipient));
    await f.platform.emit({
      type: 'callback',
      chatId: recipient.chatId,
      messageId: prompt.messageId,
      callbackId: prompt.buttons[0].id,
      userId: 'impostor',
    });
    assert.equal(f.store.listSchedules(chat).length, 0);
    await f.platform.emit({
      type: 'callback',
      chatId: recipient.chatId,
      messageId: prompt.messageId,
      callbackId: prompt.buttons[0].id,
      userId: recipient.userId,
    });
    await f.gateway.idle();
    assert.equal(
      f.store.listSchedules(chat)[0]?.deliveryApprovedBy,
      recipient.userId,
    );
    await f.platform.emit(inbound('schedule-agent', 'Create agent run'));
    await f.gateway.idle();
    await until(
      t,
      () =>
        f.platform.sent.some(({ text }) => text === 'Agent job delivered') &&
        f.platform.sent.some(
          ({ chatId, text }) =>
            chatId === recipient.chatId && text === '**Recipient reminder**',
        ),
    );
    assert.equal(
      f.platform.sent.find(({ text }) => text === '**Recipient reminder**')
        ?.format,
      undefined,
    );
    assert.equal(
      f.platform.sent.find(({ text }) => text === 'Agent job scheduled')
        ?.format,
      'markdown',
    );
    await f.gateway.idle();
    const scheduledTask = f.store
      .listChatTasks(chat)
      .find(({ sourceMessageId }) => sourceMessageId.startsWith('schedule:'));
    assert.ok(scheduledTask);
    assert.equal(f.store.triggerForTask(scheduledTask)?.reason, 'scheduled');
    const scheduled = f.platform.sent.find(
      ({ text }) => text === 'Agent job delivered',
    );
    assert.equal(scheduled?.format, 'markdown');
    assert.equal(scheduled.allowTextMentions, false);
    assert.equal(seen.at(-1)?.model, 'scheduled-model');
    assert.ok(f.trace.recent.some(({ name }) => name === 'inbound.scheduled'));
  },
);

test(
  'localizes a pending schedule and its approval, then delivers the captured mention ranges without extra text',
  { timeout: 6000 },
  async (t) => {
    const wait = new AbortController();
    const pendingReaction = Promise.withResolvers<void>();
    t.after(() => pendingReaction.resolve());
    const timeout = AbortSignal.timeout;
    t.mock.method(AbortSignal, 'timeout', (ms: number) =>
      ms === 120_000 ? wait.signal : timeout(ms),
    );
    const realNow = Date.now;
    let advance = 0;
    t.mock.method(Date, 'now', () => realNow() + advance);
    const text = '😀 [原稿名稱](tg://user?id=79)，請和 @other_user 一起喝水。';
    const deliveredText = '😀 原稿名稱，請和 @other_user 一起喝水。';
    let result: unknown;
    let at = 0;
    const f = await fixture(
      t,
      async function* (request) {
        if (
          request.context.filter(({ source }) => source === 'message').at(-1)
            ?.content !== 'Schedule this'
        )
          return;
        const tool = request.tools.find(
          ({ name }) => name === 'schedule.create',
        );
        assert.match(
          tool?.description ?? '',
          /mentions as native platform user IDs/,
        );
        at = Date.now() + 121_500;
        assert.ok(
          request.context.some(
            ({ source, content }) =>
              source === 'system' &&
              content.includes('only when the user asks to manage'),
          ),
        );
        result = await tool?.run({
          action: { kind: 'message', text },
          mentions: ['80'],
          trigger: { kind: 'once', at },
          needsApproval: true,
          reason: '提醒 Telegram ID 79\n可能打擾開會。',
        });
        yield { type: 'text.final', text: '已送出，等待管理員同意' };
      },
      true,
      {
        locale: 'zh-TW',
        reactions: async (_, status) => {
          if (status === 'pending') await pendingReaction.promise;
        },
      },
    );
    await f.platform.emit(
      inbound('owner-dm', 'Register', {
        chatId: 'owner',
        userDisplay: '管理員',
      }),
    );
    const group = { chatKind: 'group' as const, chatTitle: '測試聊天室' };
    await f.platform.emit(
      inbound('member-1', 'Hi', {
        ...group,
        userId: '79',
        userDisplay: '小林',
        userUsername: 'old_username',
      }),
    );
    await f.platform.emit(
      inbound('member-2', 'Hi', {
        ...group,
        userId: '80',
        userDisplay: '小白',
      }),
    );
    await f.platform.emit(
      inbound('schedule', 'Schedule this', {
        ...group,
        mentionsBot: true,
        userDisplay: '管理員',
      }),
    );
    await until(t, () => f.platform.reactions.length === 1);
    const original = { chatId: chat.chatId, messageId: 'schedule' };
    assert.deepEqual(f.platform.reactions, [
      { ...original, status: 'pending' },
    ]);
    const prompt = f.platform.sent.find(({ buttons }) => Boolean(buttons));
    assert.ok(prompt);
    assert.equal(prompt.chatId, 'owner');
    assert.deepEqual(
      prompt.buttons?.map(({ label }) => label),
      ['同意', '拒絕'],
    );
    assert.equal(prompt.parseTextMentions, false);
    const lines = prompt.text.split('\n');
    assert.equal(lines[0], '🔔 需要你同意：排程提醒');
    assert.ok(lines.includes('位置：測試聊天室'));
    assert.ok(lines.includes('對象：@小林、@小白、＠other_user'));
    assert.ok(lines.includes('發起：管理員'));
    const clock = new Intl.DateTimeFormat('zh-TW', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Asia/Taipei',
    }).format(at);
    assert.ok(lines.includes('時間：今天 ' + clock + '（一次）'));
    assert.deepEqual(lines.slice(-2), ['內容：', deliveredText]);
    const pre = {
      offset: prompt.text.length - deliveredText.length,
      length: deliveredText.length,
    };
    assert.deepEqual(prompt.entities, [
      {
        type: 'mention',
        userId: '79',
        offset: prompt.text.indexOf('@小林'),
        length: 3,
      },
      {
        type: 'mention',
        userId: '80',
        offset: prompt.text.indexOf('@小白'),
        length: 3,
      },
      { ...pre, type: 'pre' },
    ]);
    assert.deepEqual(
      lines.filter((line) => line.startsWith('原因：')),
      ['原因：會提及特定的人；提醒 小林 可能打擾開會。'],
    );
    assert.doesNotMatch(prompt.text, /代理程式提供的理由|代理程式要求主人審核/);
    assert.doesNotMatch(lines.join('\n'), /tg:\/\/|"kind"|room/);
    const [approval] = f.store.listApprovals();
    assert.equal(approval?.expiresAt, at);
    assert.ok(Object.is(result, undefined));
    const sentBeforeTimeout = f.platform.sent.length;
    advance = 120_000;
    wait.abort();
    await f.gateway.idle();
    const pending = result as {
      instruction: string;
      ok: boolean;
      pending: boolean;
      ref: string;
      status: string;
      summary: string;
    };
    assert.equal(pending.pending, true);
    assert.equal(pending.status, 'pending_approval');
    assert.match(
      pending.instruction,
      /framework handles pending approval feedback.*Do not mention/,
    );
    assert.match(pending.ref, /^[a-f0-9]{6}$/);
    assert.match(pending.summary, /^已送出，等待管理員同意/);
    assert.doesNotMatch(pending.summary, /tg:\/\/|mentions|\b79\b|\b80\b/);
    assert.equal(f.platform.sent.length, sentBeforeTimeout);
    assert.equal(f.store.getApproval(approval.id)?.status, 'pending');
    await f.platform.emit(
      inbound('unlinked-schedule-approval', '允許一次', { chatId: 'owner' }),
    );
    assert.equal(f.store.listSchedules(chat).length, 0);
    const decide = f.platform.emit(
      inbound('linked-schedule-approval', '一律允許', {
        chatId: 'owner',
        replyTo: { id: prompt.messageId },
      }),
    );
    await until(
      t,
      () => f.store.getApproval(approval.id)?.status === 'approved',
    );
    assert.equal(f.platform.reactions.length, 1);
    assert.equal(f.platform.sent.length, sentBeforeTimeout);
    pendingReaction.resolve();
    await decide;
    await f.gateway.idle();
    assert.equal(f.platform.feedback.at(-1)?.decisionText, '✅ 已同意');
    assert.deepEqual(
      f.store.listGrants().map(({ mode }) => mode),
      ['once'],
    );
    assert.deepEqual(f.platform.feedback.at(-1)?.pre, pre);
    const schedule = f.store.listSchedules(chat)[0];
    assert.equal(schedule?.deliveryApprovedBy, 'owner');
    assert.deepEqual(f.platform.reactions.at(-1), {
      ...original,
      status: 'approved',
    });
    assert.equal(f.platform.sent.at(-1)?.text, `已建立排程 #${pending.ref}。`);
    assert.equal(f.platform.sent.at(-1)?.replyTo, 'schedule');
    assert.deepEqual(schedule?.mentions, ['79', '80']);
    assert.equal(pending.ref, schedule?.id.slice(0, 6));
    assert.deepEqual(schedule?.action, {
      kind: 'message',
      text: deliveredText,
      mentions: [
        {
          userId: '79',
          displayName: '小林',
          ranges: [{ offset: 3, length: 4 }],
        },
        { userId: '80', displayName: '小白', ranges: [] },
      ],
    });
    await f.platform.emit(
      inbound('member-1-rename', 'Hello again', {
        ...group,
        userId: '79',
        userDisplay: '小林',
        userUsername: 'new_username',
      }),
    );
    assert.equal(f.platform.getUser('79')?.username, 'new_username');
    await until(t, () =>
      f.platform.sent.some((message) => message.text === deliveredText),
    );
    const delivered = f.platform.sent.find(
      (message) => message.text === deliveredText,
    );
    assert.equal(delivered?.chatId, chat.chatId);
    assert.deepEqual(delivered?.entities, [
      { type: 'mention', userId: '79', offset: 3, length: 4 },
    ]);
  },
);

test(
  'guide.read confines reads to workspace Markdown and records capped, redacted results',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t, async function* ({ tools }) {
      const guide = tools.find(({ name }) => name === 'guide.read');
      assert.ok(guide);
      const read = (path: string) => guide.run({ path });
      assert.deepEqual(await read('writing/code.md'), {
        path: 'writing/code.md',
        content: 'Review the diff. token=fixture-credential',
      });
      for (const path of [
        '.env',
        '.hidden/x.md',
        'data/x.md',
        'agents/x.md',
        'runtime/x.md',
        'chats/a/b/rules/x.md',
        'node_modules/x.md',
        '../x.md',
        'a/../AGENTS.md',
        'writing/./code.md',
        'writing//code.md',
        '/writing/code.md',
        'writing\\code.md',
        'writing/\0code.md',
        'writing/code.txt',
        'writing/escape.md',
        'linked/code.md',
        'writing/directory.md',
      ]) {
        assert.deepEqual(await read(path), { error: 'forbidden' }, path);
      }
      assert.deepEqual(await read('missing.md'), { error: 'not_found' });
      assert.deepEqual(await read('writing/large.md'), {
        path: 'writing/large.md',
        content: 'x'.repeat(65_535) + '\n[truncated: 65538 bytes total]',
      });
      yield { type: 'text.final', text: 'Reviewed.' };
    });
    const workspace = dirname(f.path);
    const outside = await mkdtemp(join(tmpdir(), 'tsugimori-guide-outside-'));
    t.after(() => rm(outside, { force: true, recursive: true }));
    await mkdir(join(workspace, 'writing/directory.md'), { recursive: true });
    await writeFile(
      join(workspace, 'writing/code.md'),
      'Review the diff. token=fixture-credential',
    );
    await writeFile(
      join(workspace, 'writing/large.md'),
      'x'.repeat(65_535) + '界',
    );
    await writeFile(join(outside, 'code.md'), 'Outside the workspace');
    await symlink(
      join(outside, 'code.md'),
      join(workspace, 'writing/escape.md'),
    );
    await symlink(outside, join(workspace, 'linked'));
    await f.platform.emit(inbound('guide', 'Read the guidelines'));
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'Reviewed.');
    const task = f.gateway.admin.chat(chat)?.tasks[0];
    assert.ok(task);
    const calls = f.store.taskToolCalls([task.id]);
    assert.equal(calls[0]?.name, 'guide.read');
    assert.match(calls[0]?.result ?? '', /\[redacted\]/);
    assert.doesNotMatch(calls[0]?.result ?? '', /fixture-credential/);
    assert.match(calls.at(-1)?.result ?? '', /truncated \d+ bytes/);
  },
);

test(
  'memory.propose edits only after linked owner approval and keeps unrelated file bytes',
  { timeout: 5_000 },
  async (t) => {
    const wait = new AbortController();
    const timeout = AbortSignal.timeout;
    t.mock.method(AbortSignal, 'timeout', (ms: number) =>
      ms === 120_000 ? wait.signal : timeout(ms),
    );
    const proposals = {
      add: {
        action: 'add',
        text: 'Uses Taipei time',
        reason: 'New preference',
      },
      replace: {
        action: 'replace',
        match: 'Uses Taipei time',
        text: 'Uses UTC',
        reason: 'Preference changed',
      },
      remove: {
        action: 'remove',
        match: 'Uses UTC',
        reason: 'Preference expired',
      },
    };
    const results: unknown[] = [];
    let invalid = 0;
    const f = await fixture(
      t,
      async function* (request) {
        const tool = request.tools.find(
          ({ name }) => name === 'memory.propose',
        );
        assert.ok(tool);
        const action = request.context.at(-1)?.content as
          keyof typeof proposals | 'invalid';
        if (action === 'invalid') {
          await assert.rejects(
            tool.run({ ...proposals.remove, match: 'uses UTC' }),
            /No MEMORY.md bullet exactly matches/,
          );
          await assert.rejects(
            tool.run({ ...proposals.add, text: 'one\ntwo' }),
            /single line/,
          );
          await assert.rejects(
            tool.run({ ...proposals.add, text: 'a'.repeat(501) }),
            /Invalid tool arguments/,
          );
          invalid++;
        } else {
          results.push(await tool.run(proposals[action]));
        }
        yield { type: 'text.final', text: 'NO_REPLY' };
      },
      true,
      { outboundPush: 'metered' },
    );
    f.platform.platform.capabilities.inlineButtons = false;
    const group = { chatKind: 'group' as const };
    await f.platform.emit(inbound('allow-memory', '/allow', group));
    const path = join(dirname(f.path), 'MEMORY.md');
    const request = (action: string) =>
      f.platform.emit(
        inbound(`proposal-${action}`, action, {
          ...group,
          userId: 'member',
          mentionsBot: true,
        }),
      );
    const approval = async (count: number) => {
      await until(
        t,
        () =>
          f.platform.sent.filter(({ approval }) => approval).length === count,
      );
      const prompt = f.platform.sent.filter(({ approval }) => approval).at(-1)!;
      await until(
        t,
        () =>
          f.store.findApprovalByPrompt(chat, prompt.messageId) !== undefined,
      );
      assert.match(prompt.text, /Update long-term memory \(MEMORY.md\)/);
      return prompt;
    };
    const decide = (id: string, replyTo: string, userId = 'owner') =>
      f.platform.emit(
        inbound(id, 'approve', { ...group, replyTo: { id: replyTo }, userId }),
      );

    await request('add');
    const add = await approval(1);
    assert.match(add.text, /\+ - Uses Taipei time\n\nReason: New preference/);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    await decide('member-approval', add.messageId, 'member');
    assert.equal(
      f.store.findApprovalByPrompt(chat, add.messageId)?.status,
      'pending',
    );
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    await decide('owner-add', add.messageId);
    await f.gateway.idle();
    assert.equal(
      await readFile(path, 'utf8'),
      '# MEMORY.md\n\n- Uses Taipei time\n',
    );
    assert.equal(f.platform.sent.at(-1)?.replyTo, 'owner-add');

    const surroundings = Buffer.from([
      0xef, 0xbb, 0xbf, 0x23, 0x20, 0xc3, 0x0d, 0x0a,
    ]);
    const suffix = Buffer.from('Other notes without a newline');
    await writeFile(
      path,
      Buffer.concat([
        surroundings,
        Buffer.from('- Uses Taipei time\r\n'),
        suffix,
      ]),
    );
    await request('replace');
    const replace = await approval(2);
    assert.match(replace.text, /- - Uses Taipei time\n\+ - Uses UTC/);
    await decide('owner-replace', replace.messageId);
    await f.gateway.idle();
    assert.deepEqual(
      await readFile(path),
      Buffer.concat([surroundings, Buffer.from('- Uses UTC\r\n'), suffix]),
    );

    await request('invalid');
    await f.gateway.idle();
    assert.equal(invalid, 1);
    assert.equal(f.store.listApprovals().length, 2);

    await request('remove');
    const remove = await approval(3);
    assert.match(remove.text, /- - Uses UTC/);
    wait.abort();
    await f.gateway.idle();
    assert.equal(
      f.store.findApprovalByPrompt(chat, remove.messageId)?.status,
      'pending',
    );
    assert.equal(
      f.platform.sent.at(-1)?.text,
      'The memory update is waiting for owner approval.',
    );
    await decide('owner-remove', remove.messageId);
    await f.gateway.idle();
    assert.deepEqual(
      await readFile(path),
      Buffer.concat([surroundings, suffix]),
    );
    assert.deepEqual(results.slice(0, 2), [
      { path: 'MEMORY.md' },
      { path: 'MEMORY.md' },
    ]);
    assert.equal((results[2] as { pending: boolean }).pending, true);
  },
);

test(
  'approved memory commits push only MEMORY.md and preserve the local edit on push failure',
  { timeout: 8_000 },
  async (t) => {
    const results: unknown[] = [];
    const f = await fixture(
      t,
      async function* (request) {
        const tool = request.tools.find(
          ({ name }) => name === 'memory.propose',
        );
        assert.ok(tool);
        results.push(
          await tool.run({
            action: 'add',
            text: request.context.at(-1)?.content,
            reason: 'Owner requested it',
          }),
        );
        yield { type: 'text.final', text: 'NO_REPLY' };
      },
      true,
      { locale: 'zh-TW' },
    );
    const remote = await mkdtemp(join(tmpdir(), 'tsugimori-memory-remote-'));
    t.after(() => rm(remote, { force: true, recursive: true }));
    const workspace = dirname(f.path);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    git(remote, 'init', '--bare', '--quiet', '--initial-branch=main');
    git(workspace, 'init', '--quiet', '--initial-branch=main');
    git(workspace, 'remote', 'add', 'origin', remote);
    await writeFile(join(workspace, 'staged.txt'), 'Unrelated staged content');
    git(workspace, 'add', 'staged.txt');

    const add = async (index: number, text: string) => {
      await f.platform.emit(inbound(`memory-${index}`, text));
      await until(
        t,
        () =>
          f.platform.sent.filter(({ approval }) => approval).length === index,
      );
      const prompt = f.platform.sent.filter(({ approval }) => approval).at(-1)!;
      await until(
        t,
        () =>
          f.store.findApprovalByPrompt(chat, prompt.messageId) !== undefined,
      );
      const callbackId = prompt.buttons?.[0]?.id;
      assert.ok(callbackId);
      assert.match(prompt.text, /更新長期記憶（MEMORY\.md）/);
      await f.platform.emit({
        type: 'callback',
        chatId: chat.chatId,
        userId: 'owner',
        callbackId,
        messageId: prompt.messageId,
        queryId: `approve-${index}`,
      });
      await f.gateway.idle();
    };
    await add(1, 'First memory');
    assert.deepEqual(results[0], { path: 'MEMORY.md' });
    assert.equal(
      git(remote, 'show', 'main:MEMORY.md'),
      '# MEMORY.md\n\n- First memory\n',
    );
    assert.equal(
      git(workspace, 'diff', '--cached', '--name-only'),
      'staged.txt\n',
    );
    assert.match(
      git(remote, 'log', '-1', '--format=%an <%ae>%n%B'),
      /^tsugimori <tsugimori@localhost>\nmemory: add via tsugimori\n\nReason: Owner requested it\nApprover native ID: owner/,
    );
    assert.equal(git(remote, 'ls-tree', '--name-only', 'main'), 'MEMORY.md\n');

    git(workspace, 'config', '--local', 'user.name', 'Memory Owner');
    git(workspace, 'config', '--local', 'user.email', 'owner@example.test');
    git(workspace, 'remote', 'set-url', 'origin', join(remote, 'missing.git'));
    await add(2, 'Second memory');
    const expected = '# MEMORY.md\n\n- First memory\n- Second memory\n';
    assert.equal(
      await readFile(join(workspace, 'MEMORY.md'), 'utf8'),
      expected,
    );
    assert.equal(git(workspace, 'show', 'HEAD:MEMORY.md'), expected);
    assert.equal(
      git(workspace, 'log', '-1', '--format=%an <%ae>'),
      'Memory Owner <owner@example.test>\n',
    );
    assert.match(
      f.platform.sent.at(-1)?.text ?? '',
      /^已寫入，但推送失敗：push to origin failed/,
    );
    assert.ok(f.logs.some(({ event }) => event === 'memory.git_failed'));
    assert.match(
      (results[1] as { warning: string }).warning,
      /push to origin failed/,
    );
  },
);

test(
  'records single-line NO_REPLY reasons and delivers other replies',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t, async function* (request) {
      const text = request.context.at(-1)!.content;
      if (text === 'silent') {
        for (const part of [' ', 'NO_', 'REP', 'LY', '\n'])
          yield { type: 'text.delta', text: part };
      } else {
        yield { type: 'text.final', text };
      }
    });
    await f.platform.emit(inbound('skipped', 'silent'));
    await f.gateway.idle();
    assert.equal(f.platform.sent.length, 0);
    const task = f.gateway.admin.chat(chat)?.tasks[0];
    assert.equal(task?.status, 'completed');
    assert.equal(task?.silent, true);
    assert.ok(
      f.store.taskTrace(task!.id).some(({ attrs }) => attrs.reply === 'silent'),
    );
    assert.equal(f.gateway.admin.trace(task!.id)?.task.silent, true);
    assert.ok(
      f.store
        .listChatMessages(chat)
        .every(({ direction }) => direction === 'inbound'),
    );

    assert.equal(
      (await f.gateway.admin.task(task!.id))?.outcome?.silentReason,
      '',
    );
    await f.platform.emit(
      inbound('reason', 'NO_REPLY:  Addressed to a human   '),
    );
    await f.gateway.idle();
    const reasonTask = f.store
      .listChatTasks(chat)
      .find(({ sourceMessageId }) => sourceMessageId === 'reason');
    assert.ok(reasonTask);
    const reasonRecord = await f.gateway.admin.task(reasonTask.id);
    assert.equal(reasonRecord?.outcome?.silentReason, 'Addressed to a human');
    assert.equal(reasonRecord?.output, 'NO_REPLY:  Addressed to a human   ');
    assert.equal(f.platform.sent.length, 0);

    for (const [id, text] of [
      ['punctuated', 'NO_REPLY.'],
      ['longer', 'NO_REPLY is a marker'],
      ['multiline', 'NO_REPLY: first\nsecond'],
    ]) {
      await f.platform.emit(inbound(id!, text!));
      await f.gateway.idle();
      assert.equal(f.platform.sent.at(-1)?.text, text);
    }
    assert.deepEqual(
      f.platform.sent.map(({ text }) => text),
      ['NO_REPLY.', 'NO_REPLY is a marker', 'NO_REPLY: first\nsecond'],
    );
    assert.ok(
      f.gateway.admin
        .chat(chat)
        ?.tasks.filter(({ id }) => id !== task?.id && id !== reasonTask.id)
        .every(({ silent }) => silent === false),
    );
  },
);

test(
  'chat workspace edits are recorded under the member native ID',
  { timeout: 5000 },
  async (t) => {
    let workdir = '';
    const f = await fixture(t, async function* (request) {
      workdir = request.workdir;
      await writeFile(
        join(workdir, 'rules', 'member.md'),
        'Conversation convention',
      );
      yield { type: 'text.final', text: 'Saved rule' };
    });
    await f.platform.emit(inbound('allow', '/allow'));
    await f.platform.emit(
      inbound('edit-rule', 'Save this convention', {
        chatKind: 'group',
        userId: 'member',
        mentionsBot: true,
      }),
    );
    await f.gateway.idle();
    assert.equal(f.platform.sent.at(-1)?.text, 'Saved rule');
    const commit = execFileSync(
      'git',
      ['-C', workdir, 'log', '-1', '--format=%an', '--', 'rules/member.md'],
      { encoding: 'utf8' },
    );
    assert.equal(commit.trim(), 'member');
  },
);

test(
  'preview selection uses the platform owner and requires a port from that chat execution',
  { timeout: 5000 },
  async (t) => {
    let next = 0;
    const opened: { id: string; provider: string; ttlMs: number }[] = [];
    const closed: string[] = [];
    function provider(id: string): TunnelProvider {
      return {
        id,
        async open({ ttlMs }) {
          const preview = {
            id: `preview-${++next}`,
            provider: id,
            expiresAt: new Date(Date.now() + ttlMs),
            url: `https://${id}.example.test/?token=credential`,
          };
          opened.push({ id: preview.id, provider: id, ttlMs });
          return preview;
        },
        async reconcile() {},
        async close(previewId) {
          closed.push(previewId);
        },
      };
    }
    const controller = new AbortController();
    const plugin: PluginDefinition = {
      name: 'fake-exec',
      execBackends: [
        {
          id: 'local-sandbox',
          async start() {
            const ports = new Set<number>();
            return {
              async exposePort(port) {
                if (!ports.has(port)) throw new Error('unknown sandbox port');
                return {
                  host: '127.0.0.1',
                  port: 12345,
                  closed: controller.signal,
                };
              },
              async readFile() {
                return new Uint8Array();
              },
              async run(_cmd, { backgroundPort }) {
                if (backgroundPort) ports.add(backgroundPort);
                return { exitCode: null, stdout: '', stderr: '' };
              },
              async stop() {
                controller.abort();
              },
              async writeFile() {},
            };
          },
        },
      ],
    };
    const f = await fixture(
      t,
      async function* (request) {
        const open = request.tools.find(({ name }) => name === 'preview.open');
        assert.ok(open);
        await assert.rejects(open.run({ port: 8787, ttl: 1 }));
        await request.tools
          .find(({ name }) => name === 'exec.run')
          ?.run({ cmd: ['fake-app'], backgroundPort: 3000 });
        await open.run({ port: 3000, ttl: 1440 });
        yield { type: 'text.final', text: 'Preview created' };
      },
      true,
      {
        plugins: [plugin],
        previews: { quick: provider('quick'), named: provider('named') },
      },
    );
    await f.platform.emit(inbound('allow', '/allow'));
    const group = { chatKind: 'group' as const, mentionsBot: true };
    await f.platform.emit(
      inbound('member-preview', 'Start preview', {
        ...group,
        userId: 'member',
      }),
    );
    await f.gateway.idle();
    await f.platform.emit(inbound('owner-preview', 'Start preview', group));
    await f.gateway.idle();
    assert.deepEqual(
      opened.map(({ provider, ttlMs }) => [provider, ttlMs]),
      [
        ['quick', 3600000],
        ['named', 3600000],
      ],
    );
    assert.ok(
      f.store.listPreviews().every(({ url }) => !url.includes('token')),
    );
    await f.platform.emit(inbound('owner-close', '/preview close', group));
    const menu = f.platform.sent.at(-1);
    assert.ok(menu?.buttons?.length);
    assert.deepEqual(menu.buttons.map(({ label }) => label).sort(), [
      'preview-1',
      'preview-2',
    ]);
    await f.platform.emit({
      type: 'callback',
      chatId: chat.chatId,
      messageId: menu.messageId,
      callbackId: menu.buttons.find(({ label }) => label === 'preview-1')!.id,
      queryId: 'close-preview',
      userId: 'owner',
    });
    assert.equal(f.platform.feedback.at(-1)?.decisionText, 'Preview closed.');
    assert.deepEqual(closed, ['preview-1']);
    controller.abort();
    await until(t, () => f.store.listPreviews().length === 0);
    assert.deepEqual(closed, ['preview-1', 'preview-2']);
  },
);

test(
  'recurring approval covers the same schedule and delivery within resource limits',
  { timeout: 5_000 },
  async (t) => {
    type ReminderInput = {
      id?: string;
      minutes?: number;
      recipient?: string;
      text?: string;
    };
    const results = new Map<string, { ref: string; status: string }>();
    const inputs = new Map<string, ReminderInput>();
    const at = Date.now() + 60_000;
    const f = await fixture(
      t,
      async function* (request) {
        const command = request.context
          .filter(({ source }) => source === 'message')
          .at(-1)?.content;
        if (!command) return;
        const input = inputs.get(command);
        if (!input) return;
        const tool = request.tools.find(
          ({ name }) =>
            name === (input.id ? 'schedule.update' : 'schedule.create'),
        );
        assert.ok(tool);
        const result = (await tool.run({
          ...(input.id ? { id: input.id } : {}),
          action: {
            kind: 'message',
            text: input.text ?? '喝水',
          },
          mentions: [input.recipient ?? '79'],
          trigger: { kind: 'interval', at, minutes: input.minutes ?? 30 },
        })) as { ref: string; status: string };
        results.set(command, result);
        yield { type: 'text.final', text: result.status };
      },
      true,
      { locale: 'zh-TW' },
    );
    const group = {
      chatKind: 'group' as const,
      chatTitle: 'Development',
      mentionsBot: true,
    };
    async function submit(
      message: string,
      input: ReminderInput,
      userId = 'member',
    ) {
      inputs.set(message, input);
      await f.platform.emit(inbound(message, message, { ...group, userId }));
    }
    const prompts = () =>
      f.platform.sent.filter(({ buttons }) => buttons?.length);
    async function decide(
      prompt: ReturnType<typeof prompts>[number],
      choice: number,
    ) {
      const button = prompt.buttons?.[choice];
      assert.ok(button);
      await f.platform.emit({
        type: 'callback',
        chatId: chat.chatId,
        callbackId: button.id,
        messageId: prompt.messageId,
        userId: 'owner',
      });
    }
    await f.platform.emit(inbound('allow-reminders', '/allow', group));
    await submit('Create reminder', {});
    await until(t, () => prompts().length === 1);
    const [first] = prompts();
    assert.ok(first);
    assert.deepEqual(
      first.buttons?.map(({ label }) => label),
      ['同意', '拒絕'],
    );
    assert.equal(results.has('Create reminder'), false);
    assert.equal(f.store.listSchedules(chat).length, 0);
    await decide(first, 0);
    await f.gateway.idle();
    assert.equal(results.get('Create reminder')?.status, 'scheduled');
    assert.equal(f.platform.feedback[0]?.decisionText, '✅ 已同意');
    const [schedule] = f.store.listSchedules(chat);
    assert.ok(schedule);
    const [grant] = f.store.listGrants();
    assert.equal(grant?.mode, 'once');
    assert.ok(grant.consumedAt);
    assert.equal(grant.scope.type, 'schedule');
    assert.equal(grant.scope.id, schedule.id);

    await submit('Create identical reminder', {});
    await until(t, () => prompts().length === 2);
    assert.equal(results.has('Create identical reminder'), false);
    const duplicate = prompts()[1];
    assert.ok(duplicate);
    await decide(duplicate, 1);
    assert.equal(f.platform.feedback.at(-1)?.decisionText, '❌ 已拒絕');
    assert.equal(f.store.listSchedules(chat).length, 1);

    await submit(
      'Edit text and cadence',
      { id: schedule.id, minutes: 45, text: '休息一下' },
      'owner',
    );
    await until(
      t,
      () => prompts().length > 2 || results.has('Edit text and cadence'),
    );
    assert.equal(prompts().length, 2);
    await f.gateway.idle();
    assert.equal(results.get('Edit text and cadence')?.status, 'scheduled');

    await submit('Edit recipient', { id: schedule.id, recipient: '80' });
    await until(t, () => prompts().length === 3);
    const changedRecipient = prompts()[2];
    assert.ok(changedRecipient);
    await decide(changedRecipient, 1);
    await f.gateway.idle();
    assert.deepEqual(f.store.getSchedule(schedule.id)?.mentions, ['79']);

    await submit('Edit below the minimum interval', {
      id: schedule.id,
      minutes: 1,
    });
    await until(t, () => prompts().length === 4);
    const highFrequency = prompts()[3];
    assert.ok(highFrequency);
    assert.match(highFrequency.text, /執行間隔可能短於設定的下限/);
    await decide(highFrequency, 1);
    await f.gateway.idle();
    assert.deepEqual(f.store.getSchedule(schedule.id)?.trigger, {
      kind: 'interval',
      at,
      minutes: 45,
    });
    assert.equal(f.store.listSchedules(chat).length, 1);
  },
);

test(
  'a delayed legacy fixed reminder converts its link and keeps all other text',
  { timeout: 4_000 },
  async (t) => {
    const f = await fixture(
      t,
      async function* () {
        yield { type: 'text.final', text: 'Unexpected agent run' };
      },
      false,
    );
    await f.platform.emit(
      inbound('allow-old-reminders', '/allow', { chatKind: 'group' }),
    );
    const at = Date.now() - 60_000;
    assert.ok(
      f.store.createSchedule(
        {
          ...chat,
          action: {
            kind: 'message',
            text: '🔔 [月光](tg://user?id=79)，喝水！\n**保留原文**',
          },
          address: { chatId: chat.chatId },
          target: { chatId: chat.chatId },
          createdBy: 'owner',
          deliveryApprovedBy: 'owner',
          id: 'legacy',
          mentions: [],
          missed: 'latest',
          nextDueAt: at,
          status: 'active',
          timezone: 'UTC',
          trigger: { kind: 'once', at },
        },
        20,
      ),
    );
    const note = `[Delayed schedule, originally due ${new Date(at).toISOString()}]\n\n`;
    const expected = note + '🔔 月光，喝水！\n**保留原文**';
    await until(t, () => f.platform.sent.some(({ text }) => text === expected));
    assert.deepEqual(f.platform.sent.at(-1)?.entities, [
      { type: 'mention', offset: note.length + 3, length: 2, userId: '79' },
    ]);
  },
);

test('commands addressed to another bot are recorded without running an agent', async (t) => {
  let runs = 0;
  const f = await fixture(t, async function* () {
    runs++;
    yield { type: 'text.final', text: 'Agent reply' };
  });
  Object.assign(f.platform.platform, { botIdentity: { username: 'our_bot' } });
  const event = inbound('foreign', '/status@other_bot args', {
    mentionsBot: true,
    repliesToBot: true,
  });
  await f.platform.emit(event);
  await f.gateway.idle();
  assert.equal(f.store.getMessage(chat, event.messageId)?.text, event.text);
  assert.equal(runs, 0);
  assert.deepEqual(f.platform.sent, []);
});

test('records and redacts framework and external tool details without changing agent history', async (t) => {
  const envValue = 'fixture workspace phrase';
  const processValue = 'fixture process phrase';
  const previous = process.env.FIXTURE_TOOL_ENV;
  process.env.FIXTURE_TOOL_ENV = processValue;
  t.after(() => {
    if (previous === undefined) delete process.env.FIXTURE_TOOL_ENV;
    else process.env.FIXTURE_TOOL_ENV = previous;
  });
  const secrets = [
    envValue,
    processValue,
    'exampleBearer123',
    'sk-fixture-token',
    'ghp_fixturetoken',
    'xoxb-fixture',
    'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl',
    'af'.repeat(16),
    'aB9+'.repeat(8),
    'named value',
    'nested value',
  ];
  const original = {
    note: `${envValue}; ${processValue}; Bearer exampleBearer123; sk-fixture-token; ghp_fixturetoken; xoxb-fixture; host console.example.test; eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl; key=${secrets[7]}; secret=${secrets[8]}`,
    apiKey: 'named value',
    nested: { PASSWORD: 'nested value' },
  };
  const f = await fixture(
    t,
    async function* (request) {
      if (request.purpose === 'summary') {
        assert.ok(!JSON.stringify(request.context).includes('head-before-cap'));
        return;
      }
      const tool = request.tools.find(({ name }) => name === 'fixture.echo')!;
      assert.deepEqual(
        await tool.run(original, undefined, 'framework-1'),
        original,
      );
      await assert.rejects(
        tool.run(null, undefined, 'framework-invalid'),
        /Invalid tool arguments/,
      );
      yield { type: 'tool.started', callId: 'native-1', name: 'native.read' };
      yield {
        type: 'tool.input',
        callId: 'native-1',
        args: { authorization: 'named value', data: envValue },
      };
      yield {
        type: 'tool.finished',
        callId: 'native-1',
        name: 'native.read',
        status: 'error',
        result:
          'head-before-cap ' +
          'x'.repeat(400) +
          ` ${processValue} tail-after-cap`,
      };
      yield { type: 'usage', inputTokens: 14, outputTokens: 3 };
      yield { type: 'text.final', text: 'finished' };
    },
    true,
    {
      envFixture: `FIXTURE_PASSWORD="${envValue}"
`,
      web: { toolDetails: { maxChars: 200 } },
      agentOptions: { customEnv: 'FIXTURE_TOOL_ENV' },
      plugins: [
        {
          name: 'echo',
          tools: [
            {
              name: 'fixture.echo',
              description: 'Echo',
              schema: { type: 'object' },
              run: async (args) => args,
            },
          ],
        },
      ],
    },
  );
  await f.platform.emit(
    inbound('capture', 'Capture this', { userDisplay: 'Owner name' }),
  );
  await f.gateway.idle();
  const [task] = f.store.listChatTasks(chat);
  assert.ok(task);
  const calls = f.store.taskToolCalls([task.id]);
  assert.deepEqual(
    calls.map(({ callId, status }) => [callId, status]),
    [
      ['framework-1', 'ok'],
      ['framework-invalid', 'error'],
      ['native-1', 'error'],
    ],
  );
  assert.ok(
    calls.every(
      ({ startedAt, endedAt }) => endedAt !== null && endedAt >= startedAt,
    ),
  );
  const [echo, invalid, native] = calls;
  assert.match(echo!.args!, /\[redacted\]/);
  assert.match(echo!.args!, /console\.example\.test/);
  assert.match(invalid!.result!, /Invalid tool arguments/);
  assert.match(native!.args!, /"authorization": "\[redacted\]"/);
  assert.match(
    f.gateway.admin.toolCall(task.id, native!.seq)!.result!,
    /^head-before-cap .*…\[omitted \d+ chars\]….*\[redacted\] tail-after-cap$/,
  );
  for (const { args, result } of calls) {
    assert.ok(Buffer.byteLength(args ?? '') <= 64 * 1024);
    assert.ok(Buffer.byteLength(result ?? '') <= 64 * 1024);
    for (const secret of secrets) {
      assert.ok(!args?.includes(secret));
      assert.ok(!result?.includes(secret));
    }
  }
  assert.deepEqual(
    f.store.listChatMessages(chat).map(({ text }) => text),
    ['finished', 'Capture this'],
  );
  const view = f.gateway.admin.chat(chat)!;
  assert.equal(
    view.messages.find(({ direction }) => direction === 'inbound')?.displayName,
    'Owner name',
  );
  assert.equal(view.tasks[0]?.sourceSeq, view.messages.at(-1)?.seq);
  assert.equal(view.tasks[0]?.inputTokens, 14);
  assert.equal(view.tasks[0]?.tools.length, 3);
  const preview = view.tasks[0]?.tools.find(
    ({ name }) => name === 'native.read',
  );
  assert.equal(preview?.argsPreview, 'authorization: [redacted]');
  assert.equal(preview?.args, null);
  assert.equal(preview?.result, null);
  const { chats, totals } = f.gateway.admin.overview(Date.now());
  assert.deepEqual(totals, {
    chats: 1,
    tasksToday: 1,
    failedToday: 0,
    pendingApprovals: 0,
  });
  assert.equal(chats[0]?.messageCount, 2);
});

test('disabled tool details keep names in trace and skip argument and result storage', async (t) => {
  const f = await fixture(
    t,
    async function* (request) {
      const tool = request.tools.find(({ name }) => name === 'fixture.echo')!;
      await tool.run('hidden framework data');
      yield {
        type: 'tool.started',
        callId: 'native',
        name: 'native.read',
        args: 'hidden native data',
      };
      yield {
        type: 'tool.finished',
        callId: 'native',
        name: 'native.read',
        status: 'ok',
        result: 'hidden native result',
      };
      yield { type: 'text.final', text: 'finished' };
    },
    true,
    {
      web: { toolDetails: { enabled: false } },
      plugins: [
        {
          name: 'echo',
          tools: [
            {
              name: 'fixture.echo',
              description: 'Echo',
              schema: { type: 'string' },
              run: async (args) => args,
            },
          ],
        },
      ],
    },
  );
  await f.platform.emit(inbound('capture-disabled', 'Capture this'));
  await f.gateway.idle();
  const [task] = f.store.listChatTasks(chat);
  assert.ok(task);
  assert.deepEqual(f.store.taskToolCalls([task.id]), []);
  const view = f.gateway.admin.trace(task.id)!;
  assert.deepEqual(
    view.task.tools.map(({ name, args, result }) => [name, args, result]),
    [
      ['fixture.echo', null, null],
      ['native.read', null, null],
    ],
  );
  assert.doesNotMatch(JSON.stringify(view), /hidden/);
});

test(
  'framework tool records pending and denied status with a linked approval',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, async function* (request) {
      const tool = request.tools.find(({ name }) => name === 'scoped_tool')!;
      await assert.rejects(
        tool.run({ id: 'requires-approval' }, undefined, 'gated'),
        /permission denied/,
      );
      yield { type: 'text.final', text: 'finished' };
    });
    await f.platform.emit(inbound('gated-trigger', 'Use the scoped tool'));
    await until(t, () =>
      f.store.listApprovals().some(({ promptMessageId }) => promptMessageId),
    );
    const [record] = f.store.listApprovals();
    assert.ok(record?.promptMessageId);
    const pending = f.store.taskToolCalls([record.taskId])[0];
    assert.equal(pending?.status, 'pending-approval');
    assert.equal(pending?.endedAt, null);
    assert.equal(pending?.approvalId, record.id);
    assert.match(
      f.gateway.admin.approvals().approvals[0]!.args!,
      /requires-approval/,
    );
    await f.platform.emit(
      inbound('gated-deny', 'deny', {
        replyTo: { id: record.promptMessageId },
      }),
    );
    await f.gateway.idle();
    assert.equal(f.store.taskToolCalls([record.taskId])[0]?.status, 'denied');
    assert.equal(f.gateway.admin.approvals().approvals[0]?.status, 'denied');
  },
);

test('admin overview uses indexed activity and trims previews across 1,000 chats', async (t) => {
  const f = await fixture(t, async function* () {
    yield { type: 'text.final', text: 'fixture' };
  });
  const now = Date.now();
  for (let i = 0; i < 1000; i++) {
    const ref = { adapterId, chatId: 'room-' + i };
    f.store.recordInbound(
      { ...ref, kind: 'group', title: 'Room ' + i },
      { adapterId, userId: 'fixture-user', display: 'Fixture sender' },
      {
        ...ref,
        messageId: 'message-' + i,
        direction: 'inbound',
        userId: 'fixture-user',
        replyTo: null,
        threadId: null,
        text: '文'.repeat(100),
        raw: null,
      },
    );
    f.store.createTask({
      ...ref,
      id: 'task-' + i,
      sourceMessageId: 'message-' + i,
      agentId: 'test',
      model: 'fixture-model',
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      status: 'running',
    });
  }
  const started = performance.now();
  const overview = f.gateway.admin.overview(Date.now(), 'test');
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `Overview took ${Math.round(elapsed)} ms`);
  assert.equal(overview.totals.chats, 1000);
  assert.equal(overview.totals.tasksToday, 1000);
  assert.equal(overview.chats.length, 200);
  assert.deepEqual(overview.chats[0]?.preview, {
    sender: 'Fixture sender',
    text: '文'.repeat(79) + '…',
  });
  const [agent] = f.gateway.admin.agents(Date.now());
  assert.equal(agent?.chats, 1000);
  assert.equal(agent?.active, 1000);
  assert.equal(agent?.recent.length, 3);
  assert.equal(agent?.login, 'unknown');
});

test('admin subscriptions receive committed activity with no message or tool contents', async (t) => {
  const f = await fixture(t, async function* () {
    yield { type: 'text.final', text: 'fixture' };
  });
  const events: AdminEvent[] = [];
  const unsubscribe = f.gateway.admin.subscribe((event) => {
    if (event.kind === 'message')
      assert.equal(
        f.store.listChatMessages(chat).some(({ seq }) => seq === event.seq),
        true,
      );
    if (event.kind === 'task')
      assert.equal(f.store.getTask(event.id)?.status, event.status);
    events.push(event);
  });
  const message = f.store.recordInbound(
    { ...chat, kind: 'group', title: 'Room' },
    { adapterId, userId: 'fixture-user', display: 'Fixture' },
    {
      ...chat,
      messageId: 'message',
      direction: 'inbound',
      userId: 'fixture-user',
      replyTo: null,
      threadId: null,
      text: 'private message',
      raw: null,
    },
  )!;
  const now = Date.now();
  f.store.createTask({
    ...chat,
    id: 'task',
    sourceMessageId: 'message',
    agentId: 'test',
    model: 'fixture',
    status: 'running',
    createdAt: now,
    startedAt: now,
    finishedAt: null,
  });
  const seq = f.store.createToolCall({
    taskId: 'task',
    name: 'tool',
    callId: 'call',
    startedAt: now,
    endedAt: null,
    args: 'private args',
    result: null,
    status: null,
    approvalId: null,
  })!;
  assert.equal(f.gateway.admin.overview(now).chats[0]?.currentTool, 'tool');
  f.store.createApproval({
    ...chat,
    id: 'approval',
    taskId: 'task',
    action: 'tool',
    requester: 'fixture-user',
    resource: { type: 'global' },
    status: 'pending',
    requestedAt: now,
    approverId: null,
    continuation: null,
    expiresAt: now + 1000,
    decidedAt: null,
    decidedBy: null,
    promptFormat: null,
    promptMessageId: null,
  });
  f.store.updateToolCall(seq, {
    status: 'ok',
    endedAt: now + 1,
    result: 'private result',
  });
  f.store.cancelApproval('approval', now + 2);
  const summary = f.store.beginSummary(chat);
  f.store.saveSummary({
    ...summary,
    throughSeq: message.seq,
    text: 'private summary',
  });
  f.store.setChatRoute(chat, { thinking: 'high' });
  f.store.updateTask('task', { status: 'completed', finishedAt: now + 3 });
  const schedule: ScheduleRecord = {
    ...chat,
    id: 'scheduled',
    address: { chatId: chat.chatId },
    target: { chatId: chat.chatId },
    action: { kind: 'message', text: 'private schedule' },
    trigger: { kind: 'once', at: now },
    nextDueAt: now,
    status: 'active',
    timezone: 'UTC',
    missed: 'latest',
    createdBy: 'fixture-user',
    deliveryApprovedBy: null,
    mentions: [],
  };
  const run = {
    scheduleId: schedule.id,
    dueAt: now,
    startedAt: now,
    finishedAt: null,
    status: 'claimed' as const,
  };
  assert.equal(f.store.createSchedule(schedule, Infinity), true);
  assert.equal(f.store.claimScheduleRun(schedule, run, null), true);
  f.store.finishScheduleRun({ ...run, status: 'sent', finishedAt: now + 4 });
  assert.deepEqual(
    events.filter((event) => event.kind === 'schedule'),
    [
      { kind: 'schedule', id: schedule.id, status: 'active', lastRun: null },
      { kind: 'schedule', id: schedule.id, status: 'done', lastRun: now },
      { kind: 'schedule', id: schedule.id, status: 'done', lastRun: now },
    ],
  );

  assert.deepEqual(
    events.map((event) => event.kind),
    [
      'message',
      'task',
      'tool',
      'approval',
      'tool',
      'approval',
      'summary',
      'chat',
      'task',
      'schedule',
      'schedule',
      'schedule',
    ],
  );
  assert.doesNotMatch(JSON.stringify(events), /private/);
  assert.equal(f.gateway.admin.toolCall('task', seq)?.result, 'private result');
  assert.equal(f.gateway.admin.chat(chat)?.tasks[0]?.tools[0]?.result, null);
  await f.configure(true, { model: 'reloaded-model' });
  await until(t, () => events.some((event) => event.kind === 'reload'));
  const afterReload = events.length;
  unsubscribe();
  f.store.setChatRoute(chat, { thinking: 'low' });
  assert.equal(events.length, afterReload);
});

test(
  'records the input, transcript, resolved model and delivery, including a supplement',
  { timeout: 5_000 },
  async (t) => {
    const waiting = Promise.withResolvers<void>();
    const f = await fixture(
      t,
      async function* (request, io) {
        if (request.purpose) return;
        yield { type: 'sessionId', sessionId: 'session-demo' };
        yield { type: 'model', model: 'resolved-test', reasoning: 'high' };
        yield { type: 'reasoning', text: 'Consider ' };
        yield { type: 'reasoning', text: 'sk-fixture-reasoning' };
        yield { type: 'text.delta', text: 'Checking ' };
        yield { type: 'text.delta', text: 'the request' };
        yield {
          type: 'tool.started',
          name: 'fake.tool',
          callId: 'call',
          args: 'sk-args-secret ' + '界'.repeat(23_000),
        };
        yield {
          type: 'tool.finished',
          name: 'fake.tool',
          callId: 'call',
          status: 'ok',
          result: 'sk-result-secret ' + '界'.repeat(23_000),
        };
        waiting.resolve();
        for await (const addition of io.supplements) {
          assert.equal(addition.text, 'One more detail');
          break;
        }
        yield { type: 'text.final', text: 'Done sk-fixture-output' };
      },
      true,
      { durable: true },
    );
    const group = { chatKind: 'group', userId: 'member' } as const;
    await f.platform.emit(inbound('summarized', 'Summarized message', group));
    await f.platform.emit(inbound('history', 'Historical message', group));
    const historical = f.store.getMessage(chat, 'history')!;
    const first = f.store.beginSummary(chat);
    assert.ok(
      f.store.saveSummary({
        ...first,
        text: 'Earlier summary',
        throughSeq: historical.seq - 1,
      }),
    );
    const summary = f.store.getSummary(chat)!;
    f.store.setChatRoute(chat, { model: 'default' });
    await f.platform.emit(
      inbound('request', 'Check this', {
        chatKind: 'group',
        mentionsBot: true,
      }),
    );
    await waiting.promise;

    const task = f.store.listChatTasks(chat)[0]!;
    assert.equal(task.model, 'resolved-test');
    await until(t, () => f.store.getTaskEvents(task.id).length === 3);
    const reopened = new SqliteStore(f.dbPath);
    try {
      assert.equal(reopened.getTaskExecution(task.id), undefined);
      assert.deepEqual(
        reopened.getTaskEvents(task.id).map(({ kind }) => kind),
        ['reasoning', 'text', 'tool'],
      );
    } finally {
      reopened.close();
    }

    await f.platform.emit(
      inbound('history', 'Edited later', { ...group, edited: true }),
    );
    await f.platform.emit(
      inbound('extra', 'One more detail', {
        chatKind: 'group',
        mentionsBot: true,
        replyTo: { id: 'request' },
      }),
    );
    await f.gateway.idle();
    const execution = await f.gateway.admin.task(task.id);
    assert.ok(execution);
    assert.equal(execution.task.model, 'resolved-test');
    assert.deepEqual(execution.agent, {
      agentId: 'test',
      kind: 'fake',
      model: 'resolved-test',
      requestedModel: 'default',
      reasoning: 'high',
    });
    assert.deepEqual(
      execution.input?.map(({ content }) => content),
      ['Check this', 'One more detail'],
    );
    assert.equal(execution.refs?.summary?.revision, summary.revision);
    assert.deepEqual(execution.refs?.history.seqs, [historical.seq]);
    assert.equal(execution.refs?.session.sessionId, 'session-demo');
    assert.equal(
      execution.context.find(({ kind }) => kind === 'history')?.text,
      'Historical message',
    );
    assert.equal(
      execution.context.find(({ kind }) => kind === 'summary')?.text,
      'Earlier summary',
    );
    assert.equal(execution.trigger?.reason, 'mention');
    assert.deepEqual(
      execution.events.map(({ kind }) => kind),
      ['reasoning', 'text', 'tool', 'supplement', 'text'],
    );
    assert.deepEqual(execution.events[0]?.data, {
      text: 'Consider [redacted]',
    });
    assert.deepEqual(execution.events[1]?.data, {
      text: 'Checking the request',
    });
    const event = execution.events.find(({ kind }) => kind === 'tool');
    assert.ok(event?.kind === 'tool');
    assert.ok(event.tool?.args?.includes('[redacted]'));
    assert.ok((event.tool?.result?.length ?? 0) <= 4000);
    const call = f.store.taskToolCalls([task.id])[0]!;
    for (const detail of [call.args!, call.result!]) {
      assert.ok(Buffer.byteLength(detail) <= 64 * 1024);
      assert.match(detail, /^\[redacted\] 界+…\[truncated \d+ bytes\]$/);
    }
    assert.equal(execution.output, 'Done [redacted]');
    assert.deepEqual(execution.supplements, [
      { messageId: 'extra', at: execution.events[3]!.at, afterEventSeq: 3 },
    ]);
    assert.deepEqual(execution.outcome?.delivery?.parts, [
      { messageId: f.platform.sent.at(-1)!.messageId, ok: true },
    ]);
    assert.equal(execution.outcome?.kind, 'delivered');
    assert.ok(execution.timing?.firstTokenMs !== undefined);
  },
);

test('stores trigger reasons for skipped messages, duplicates, deletions and commands without private raw data', async (t) => {
  const f = await fixture(t, async function* () {});
  const dm = inbound('normal', 'text');
  const group = { ...dm, chatKind: 'group' as const };
  for (const [message, owner, allowlisted, reason, triggered] of [
    [dm, true, false, 'dm-owner', true],
    [{ ...group, mentionsBot: true }, false, true, 'mention', true],
    [{ ...group, repliesToBot: true }, false, true, 'reply-to-bot', true],
    [{ ...group, mentionsBot: true }, false, false, 'not-allowlisted', false],
    [group, false, true, 'not-addressed', false],
    [
      { ...group, addressedToOther: true },
      true,
      true,
      'addressed-to-other',
      false,
    ],
    [
      { ...group, botMessage: true, mentionsBot: true },
      false,
      true,
      'mention',
      true,
    ],
  ] as const) {
    assert.deepEqual(decideTrigger(message, owner, allowlisted), {
      triggered,
      reason,
    });
    assert.equal(shouldTrigger(message, owner, allowlisted), triggered);
  }
  const raw = { text: 'standby', attachments: '界'.repeat(1000) };
  const skipped = inbound('skip', 'standby', {
    chatKind: 'group',
    userId: 'member',
    raw,
  });
  await f.platform.emit(skipped);
  await f.platform.emit(skipped);
  const saved = f.store.getMessage(chat, 'skip')!;
  assert.deepEqual(f.gateway.admin.messageRaw(chat, saved.seq), raw);
  assert.equal(
    f.gateway.admin.chat(chat)?.messages[0]?.trigger?.reason,
    'not-addressed',
  );
  await f.platform.emit({
    type: 'delete',
    chatId: chat.chatId,
    messageId: 'skip',
  });
  await f.platform.emit(
    inbound('private', '/pair fixture-code', {
      raw: { text: '/pair fixture-code' },
    }),
  );
  await f.gateway.idle();
  const command = f.store.getMessage(chat, 'private')!;
  assert.equal(command.text, '/pair [redacted]');
  assert.equal(f.gateway.admin.messageRaw(chat, command.seq), null);
  assert.deepEqual(
    f.gateway.admin
      .chat(chat)
      ?.messages.filter(({ direction }) => direction === 'inbound')
      .map(({ trigger }) => trigger?.reason),
    ['command', 'deleted'],
  );
  assert.deepEqual(
    f.trace.recent
      .filter(({ name }) => name === 'trigger.decided')
      .map(({ attrs }) => [attrs.reason, attrs.triggered]),
    [
      ['not-addressed', false],
      ['duplicate', false],
      ['deleted', false],
      ['command', true],
    ],
  );
  assert.equal(f.store.listChatTasks(chat).length, 0);
});

test(
  'guided chat setup logs a redacted unexpected error and keeps the generic reply',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t, async function* () {}, true, {
      plugins: [
        {
          name: 'failing-setup',
          agents: {
            broken: ({ id }) => ({
              id,
              kind: 'broken',
              loop: 'external',
              async *run() {},
            }),
          },
          setupSteps: [
            {
              id: 'check',
              title: 'Check the connector',
              run() {
                throw new Error('Connector broke with sk-fixture-secret');
              },
            },
          ],
        },
      ],
    });
    await f.platform.emit(
      inbound('setup', '/add agent broken --id demo-broken'),
    );
    await until(t, () =>
      f.platform.sent.some(({ text }) =>
        text.startsWith('Setup could not complete.'),
      ),
    );
    assert.deepEqual(
      f.logs.find(({ event }) => event === 'setup.failed'),
      {
        level: 'error',
        event: 'setup.failed',
        adapterId,
        category: 'agent',
        kind: 'broken',
        step: 'check',
        error: 'Error: Connector broke with [redacted]',
      },
    );
    const span = f.trace.recent.find(
      ({ name, status }) => name === 'setup.step' && status === 'error',
    );
    assert.equal(span?.attrs.error, 'Error: Connector broke with [redacted]');
  },
);

test('renders an old quoted file and downloads only attachments in the current chat', async (t) => {
  const requests: AgentRequest[] = [];
  const downloads: string[] = [];
  const f = await fixture(
    t,
    async function* (request) {
      requests.push(request);
      const tool = request.tools.find(({ name }) => name === 'attachment.get');
      assert.ok(tool);
      const saved = (await tool.run({ messageId: 'original', index: 0 })) as {
        mime: string;
        path: string;
        size: number;
      };
      assert.equal(saved.mime, 'application/pdf');
      assert.equal(saved.size, 3);
      assert.ok(saved.path.startsWith(request.workdir + '/'));
      assert.equal(await readFile(saved.path, 'utf8'), 'PDF');
      const embedded = (await tool.run({
        messageId: 'never-seen',
        index: 0,
      })) as { path: string };
      assert.equal(await readFile(embedded.path, 'utf8'), 'PDF');
      await assert.rejects(
        tool.run({ messageId: 'other-chat-file', index: 0 }),
        /not found in this conversation/,
      );
      yield { type: 'text.final', text: 'pong' };
    },
    true,
    {
      context: { recentMessages: 1, summary: { enabled: false } },
      downloadAttachment: async ({ fileId }) => {
        assert.ok(fileId);
        downloads.push(fileId);
        return { bytes: Buffer.from('PDF'), mime: 'application/pdf' };
      },
    },
  );
  const file = {
    index: 0,
    kind: 'file',
    fileId: 'remote-original',
    name: 'record.pdf',
    mime: 'application/pdf',
    size: 3,
  } as const;
  await f.platform.emit(
    inbound('other-chat-file', '', {
      chatId: 'another-room',
      userId: 'member',
      attachments: [file],
    }),
  );
  await f.platform.emit(
    inbound('original', '', {
      userId: 'member',
      userDisplay: 'Ada',
      at: 1,
      attachments: [file],
    }),
  );
  await f.platform.emit(
    inbound('snapshot', 'Old reply', {
      userId: 'member',
      replyTo: {
        id: 'never-seen',
        text: '',
        attachments: [{ ...file, fileId: 'remote-snapshot' }],
      },
    }),
  );
  await f.platform.emit(
    inbound('latest', 'What does this say?', {
      at: 2,
      userDisplay: 'Owner',
      replyTo: { id: 'original', quote: 'part' },
    }),
  );
  await f.gateway.idle();
  const context = requests[0]?.context
    .filter((block) => block.source === 'message')
    .map(renderContextLine);
  assert.equal(context?.length, 1);
  assert.deepEqual(JSON.parse(context![0]!), {
    source: 'message',
    trust: 'owner',
    content: 'What does this say?',
    id: 'latest',
    at: 2,
    sender: { id: 'owner', name: 'Owner' },
    replyTo: {
      id: 'original',
      text: '[file]',
      sender: { id: 'member', name: 'Ada' },
      attachments: [
        {
          index: 0,
          kind: 'file',
          name: 'record.pdf',
          mime: 'application/pdf',
          size: 3,
        },
      ],
      quote: 'part',
    },
    attachments: [],
  });
  assert.deepEqual(downloads, ['remote-original', 'remote-snapshot']);
  assert.equal(f.store.getMessage(chat, 'original')?.text, '[file]');
  const task = f.store
    .listChatTasks(chat)
    .find(({ sourceMessageId }) => sourceMessageId === 'latest');
  assert.ok(task);
  assert.deepEqual(
    f.store.taskToolCalls([task.id]).map(({ name, status }) => [name, status]),
    [
      ['attachment.get', 'ok'],
      ['attachment.get', 'ok'],
      ['attachment.get', 'error'],
    ],
  );
});

test('offers the first four album images once and removes explicitly downloaded images', async (t) => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    t.skip('ffmpeg is unavailable on PATH');
    return;
  }
  const photo = execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=red:s=80x40',
    '-frames:v',
    '1',
    '-threads',
    '1',
    '-c:v',
    'png',
    '-f',
    'image2pipe',
    'pipe:1',
  ]);
  const requests: AgentRequest[] = [];
  const downloads: string[] = [];
  let explicitPath: string | undefined;
  const f = await fixture(
    t,
    async function* (request) {
      requests.push(request);
      if (!request.resumeSessionId) {
        const tool = request.tools.find(
          ({ name }) => name === 'attachment.get',
        );
        assert.ok(tool);
        const saved = (await tool.run({ messageId: 'album-0', index: 5 })) as {
          path: string;
        };
        assert.deepEqual(await readFile(saved.path), photo);
        explicitPath = saved.path;
      }
      yield { type: 'sessionId', sessionId: 'visual-session' };
      yield { type: 'text.final', text: 'pong' };
    },
    true,
    {
      imageLimits: { maxEdge: 16, maxBytes: 2_000 },
      downloadAttachment: async ({ fileId }) => {
        assert.ok(fileId);
        downloads.push(fileId);
        return { bytes: photo, mime: 'image/png' };
      },
    },
  );
  for (let i = 0; i < 6; i++) {
    await f.platform.emit(
      inbound(`album-${i}`, '', {
        albumId: 'photos',
        attachments: [{ index: 0, kind: 'image', fileId: `photo-${i}` }],
      }),
    );
  }
  await f.gateway.idle();
  assert.equal(requests.length, 1);
  assert.deepEqual(
    requests[0]?.images?.map(({ source }) => source?.index),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    requests[0]?.context.at(-1)?.message?.attachments.map(({ index }) => index),
    [0, 1, 2, 3, 4, 5],
  );
  assert.ok(
    requests[0]?.images?.every(
      ({ data }) => Buffer.from(data, 'base64').length < 2_000,
    ),
  );
  assert.ok(explicitPath);
  await assert.rejects(readFile(explicitPath), { code: 'ENOENT' });
  assert.ok(
    f.trace.recent.some(
      ({ name, durationMs }) => name === 'media.prepare' && durationMs > 0,
    ),
  );
  await f.platform.emit(
    inbound('next', 'Read the album', { replyTo: { id: 'album-0' } }),
  );
  await f.gateway.idle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.resumeSessionId, 'visual-session');
  assert.equal(requests[1]?.images, undefined);
  assert.deepEqual(downloads, [
    'photo-0',
    'photo-1',
    'photo-2',
    'photo-3',
    'photo-5',
  ]);

  await f.platform.emit(
    inbound('fresh', '', {
      attachments: [{ index: 0, kind: 'image', fileId: 'fresh-photo' }],
    }),
  );
  await f.gateway.idle();
  assert.equal(requests[2]?.resumeSessionId, 'visual-session');
  assert.deepEqual(
    requests[2]?.images?.map(({ source }) => source),
    [{ messageId: 'fresh', index: 0 }],
  );
});

test('send tools require advertised capabilities and keep files and reactions in the current conversation', async (t) => {
  const offered: string[][] = [];
  let uploads = 0;
  const f = await fixture(
    t,
    async function* (request) {
      offered.push(
        request.tools
          .map(({ name }) => name)
          .filter((name) => name.startsWith('send.')),
      );
      if (offered.length === 1) {
        yield { type: 'text.final', text: 'no media' };
        return;
      }
      const file = request.tools.find(({ name }) => name === 'send.file');
      const reaction = request.tools.find(
        ({ name }) => name === 'send.reaction',
      );
      assert.ok(file && reaction);
      const path = join(request.workdir, 'note.txt');
      await writeFile(path, 'report');
      await writeFile(join(request.workdir, 'large.txt'), Buffer.alloc(17));
      await symlink('/dev/null', join(request.workdir, 'outside'));
      await assert.rejects(
        file.run({ path: 'outside' }),
        /accessible chat workspace/,
      );
      await assert.rejects(
        file.run({ path: 'https://example.test/file' }),
        /accessible chat workspace/,
      );
      await assert.rejects(file.run({ path: 'large.txt' }), /size limit/);
      await assert.rejects(
        file.run({ path, attachment: { messageId: 'source', index: 0 } }),
        /Invalid tool arguments/,
      );
      await assert.rejects(
        file.run({ attachment: { messageId: 'foreign', index: 0 } }),
        /not found in this conversation/,
      );
      await assert.rejects(
        reaction.run({ emoji: '👍', messageId: 'foreign' }),
        /unavailable in this conversation/,
      );
      assert.deepEqual(
        await reaction.run({ emoji: '👍' }, undefined, 'reaction'),
        { messageId: 'source' },
      );
      assert.deepEqual(await file.run({ path }, undefined, 'disk'), {
        messageId: 'upload-1',
        messageIds: ['upload-1'],
      });
      assert.deepEqual(
        await file.run(
          { attachment: { messageId: 'source', index: 0 } },
          undefined,
          'attachment',
        ),
        { messageId: 'upload-2', messageIds: ['upload-2'] },
      );
      yield { type: 'text.final', text: 'Here is the report.' };
    },
    true,
    {
      downloadAttachment: async ({ fileId }, _signal, limit) => {
        assert.equal(fileId, 'attachment-in-this-topic');
        assert.equal(limit, 16);
        return { bytes: Buffer.from('report'), mime: 'text/plain' };
      },
    },
  );
  const platform = f.platform.platform;
  platform.sendFile = async ({ chatId, threadId, replyTo, file }) => {
    assert.deepEqual(
      { chatId, threadId, replyTo },
      { chatId: chat.chatId, threadId: '17', replyTo: 'source' },
    );
    assert.equal(file.name, 'note.txt');
    assert.equal(Buffer.from(file.bytes).toString(), 'report');
    return { messageId: 'upload-' + ++uploads };
  };
  platform.sendReaction = async ({ chatId, threadId, messageId, emoji }) => {
    assert.deepEqual(
      { chatId, threadId, messageId, emoji },
      { chatId: chat.chatId, threadId: '17', messageId: 'source', emoji: '👍' },
    );
  };
  await f.platform.emit(inbound('capabilities', 'Which tools are offered?'));
  await f.gateway.idle();
  assert.deepEqual(offered, [[]]);
  platform.capabilities.files = { maxBytes: 16 };
  platform.capabilities.reactions = true;
  const attachment = {
    index: 0,
    kind: 'file',
    name: 'note.txt',
    size: 6,
  } as const;
  await f.platform.emit(
    inbound('foreign', '', {
      userId: 'other',
      chatId: 'elsewhere',
      attachments: [{ ...attachment, fileId: 'foreign-file' }],
    }),
  );
  await f.platform.emit(
    inbound('source', 'Send this report', {
      threadId: '17',
      attachments: [{ ...attachment, fileId: 'attachment-in-this-topic' }],
    }),
  );
  await f.gateway.idle();
  assert.deepEqual(offered[1], ['send.reaction', 'send.file']);
  const thread = { ...chat, chatId: chat.chatId + '_17' };
  const task = f.store.listChatTasks(thread)[0]!;
  assert.equal(task.status, 'sent');
  const calls = f.store.taskToolCalls([task.id]);
  assert.equal(calls.length, 9);
  for (const [callId, result] of [
    ['reaction', 'source'],
    ['disk', 'upload-1'],
    ['attachment', 'upload-2'],
  ]) {
    const call = calls.find((call) => call.callId === callId);
    assert.equal(call?.status, 'ok');
    assert.equal(JSON.parse(call.result!).messageId, result);
  }
  assert.deepEqual(
    f.store
      .getTaskExecution(task.id)
      ?.outcome.delivery?.parts.map(({ messageId }) => messageId),
    ['source', 'upload-1', 'upload-2', 'bot-2'],
  );
  assert.equal(f.store.getMessage(thread, 'upload-1')?.replyTo, 'source');
  assert.equal(f.platform.sent.at(-1)?.text, 'Here is the report.');
});

test('media-only rounds record queued IDs with their tool call and complete immediate sends without text', async (t) => {
  const f = await fixture(t, async function* (request) {
    const tool = request.tools.find(({ name }) => name === 'send.sticker')!;
    const source = request.context.findLast(
      ({ source }) => source === 'message',
    )?.content;
    await tool.run({ fileId: source }, undefined, 'sticker-call');
    yield { type: 'text.final', text: 'NO_REPLY' };
  });
  const platform = f.platform.platform;
  platform.capabilities.stickers = true;
  platform.sendSticker = async ({ fileId }) =>
    fileId === 'queued'
      ? { queued: true, id: 'queued-handle' }
      : { messageId: 'immediate-sticker' };
  const send = platform.send.bind(platform);
  platform.send = async (message, options) => {
    if (!options?.media?.length) return send(message);
    assert.equal(message.text, '');
    assert.equal(message.replyTo, 'queue-round');
    assert.deepEqual(
      options.media.map(({ id }) => id),
      ['queued-handle'],
    );
    return {
      messageId: 'queued-sticker',
      parts: [
        {
          messageId: 'queued-sticker',
          mediaId: 'queued-handle',
          text: '[sticker]',
        },
      ],
    };
  };
  await f.platform.emit(inbound('queue-round', 'queued'));
  await f.gateway.idle();
  await f.platform.emit(inbound('immediate-round', 'immediate'));
  await f.gateway.idle();
  const tasks = f.store.listChatTasks(chat);
  assert.equal(tasks.length, 2);
  for (const [source, messageId] of [
    ['queue-round', 'queued-sticker'],
    ['immediate-round', 'immediate-sticker'],
  ]) {
    const task = tasks.find(
      ({ sourceMessageId }) => sourceMessageId === source,
    )!;
    assert.equal(task.status, 'sent');
    const execution = f.store.getTaskExecution(task.id);
    assert.equal(execution?.outcome.kind, 'delivered');
    assert.deepEqual(execution.outcome.delivery?.parts, [
      { messageId, ok: true },
    ]);
    const [call] = f.store.taskToolCalls([task.id]);
    assert.equal(call?.name, 'send.sticker');
    assert.equal(call.status, 'ok');
    assert.equal(JSON.parse(call.result!).messageId, messageId);
  }
  assert.deepEqual(f.platform.sent, []);
});

test(
  'sticker indexing deduplicates in the background, shares descriptions across chats and honors owner blocks',
  { timeout: 10000 },
  async (t) => {
    if (spawnSync('ffmpeg', ['-version']).status !== 0) {
      t.skip('ffmpeg is unavailable');
      return;
    }
    const modelStarted = Promise.withResolvers<void>();
    const allowIndex = Promise.withResolvers<void>();
    const chatStarted = Promise.withResolvers<void>();
    const setCalls: string[] = [];
    const searches: unknown[] = [];
    let modelCalls = 0;
    const bytes = execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-filter_threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=32x32',
      '-frames:v',
      '1',
      '-threads',
      '1',
      '-c:v',
      'png',
      '-f',
      'image2pipe',
      'pipe:1',
    ]);
    const f = await fixture(
      t,
      async function* (request) {
        if (request.purpose === 'sticker-index') {
          modelCalls++;
          assert.equal(request.model, 'test-cheap');
          assert.equal(request.thinking, 'low');
          assert.equal(request.tools.length, 0);
          assert.equal(request.images?.length, 1);
          assert.equal(request.images[0]?.mime, 'image/jpeg');
          assert.doesNotMatch(
            JSON.stringify(request.context),
            /private-origin/,
          );
          modelStarted.resolve();
          await allowIndex.promise;
          yield {
            type: 'usage',
            inputTokens: 24,
            outputTokens: 7,
            costUsd: 0.0001,
          };
          yield {
            type: 'text.final',
            text: '["Happy red animal waves","Sleepy red animal yawns"]',
          };
          return;
        }
        chatStarted.resolve();
        const search = request.tools.find(
          ({ name }) => name === 'sticker.search',
        )!;
        searches.push(await search.run({ query: 'happy', limit: 3 }));
        yield { type: 'text.final', text: 'Done' };
      },
      true,
      {
        stickers: { model: 'test-cheap' },
        agentSettings: () => ({ thinking: ['minimal', 'low'] }),
        thinkingLevels: async (model) => {
          assert.equal(model, 'test-cheap');
          return ['low', 'medium', 'high', 'xhigh', 'max'];
        },
        imageLimits: { maxBytes: 100_000, maxEdge: 512 },
        downloadAttachment: async () => ({ bytes, mime: 'image/png' }),
      },
    );
    t.after(() => allowIndex.resolve());
    f.platform.platform.capabilities.stickers = true;
    const incoming = {
      kind: 'sticker',
      index: 0,
      fileId: 'file-one',
      emoji: '😀',
      set: 'Surprise_Set',
      stickerFormat: 'static',
    } as const;
    f.platform.platform.getStickerSet = async (name) => {
      setCalls.push(name);
      return [
        { ...incoming, uniqueId: 'one' },
        {
          ...incoming,
          index: 1,
          fileId: 'file-two',
          emoji: '😴',
          uniqueId: 'two',
        },
      ];
    };
    const sendUnaddressed = (
      id: string,
      chatId: string,
      set = incoming.set as string,
    ) =>
      f.platform.emit(
        inbound(id, '', {
          chatId,
          chatKind: 'group',
          userId: 'private-sender',
          chatTitle: 'private-title',
          attachments: [{ ...incoming, set }],
        }),
      );
    await sendUnaddressed('sticker-a', 'private-origin');
    await modelStarted.promise;
    await sendUnaddressed('sticker-b', 'second-origin');
    await f.platform.emit(
      inbound('search-early', 'Search for a happy sticker'),
    );
    await chatStarted.promise;
    await f.gateway.idle();
    assert.equal(modelCalls, 1);
    assert.deepEqual(searches, [[]]);
    assert.deepEqual(setCalls, ['surprise_set']);
    allowIndex.resolve();
    for (
      let i = 0;
      i < 100 && !f.store.hasStickerSet('surprise_set', adapterId);
      i++
    )
      await delay(10);
    assert.ok(f.store.hasStickerSet('surprise_set', adapterId));
    await f.platform.emit(inbound('search-late', 'Search now'));
    await f.gateway.idle();
    assert.deepEqual(searches.at(-1), [
      {
        fileId: 'file-one',
        emoji: '😀',
        description: 'Happy red animal waves',
      },
    ]);
    assert.deepEqual(f.store.getStickerDescriptions('surprise_set'), [
      { uniqueId: 'one', description: 'Happy red animal waves' },
      { uniqueId: 'two', description: 'Sleepy red animal yawns' },
    ]);
    const usage = f.trace.recent.find(
      ({ name, attrs }) =>
        name === 'agent.usage' && attrs.purpose === 'sticker-index',
    );
    assert.equal(usage?.attrs.inputTokens, 24);
    assert.equal(usage?.attrs.costUsd, 0.0001);
    await f.platform.emit(
      inbound('not-owner', '/sticker block surprise_set', { userId: 'member' }),
    );
    assert.equal(f.store.isStickerSetBlocked('surprise_set'), false);
    await f.platform.emit(inbound('block', '/sticker block surprise_set'));
    await f.platform.emit(
      inbound('block-unknown', '/sticker block never_seen'),
    );
    await sendUnaddressed('sticker-c', 'private-origin', 'never_seen');
    await f.platform.emit(inbound('search-blocked', 'Search again'));
    await f.gateway.idle();
    assert.deepEqual(searches.at(-1), []);
    assert.deepEqual(setCalls, ['surprise_set']);
    await f.platform.emit(
      inbound('list-group', '/sticker', { chatKind: 'group' }),
    );
    assert.doesNotMatch(f.platform.sent.at(-1)!.text, /surprise_set/);
    await f.platform.emit(inbound('list-dm', '/sticker'));
    assert.match(
      f.platform.sent.at(-1)!.text,
      /surprise_set · 2 stickers · blocked/,
    );
    await f.platform.emit(inbound('unblock', '/sticker unblock SURPRISE_SET'));
    assert.equal(f.store.searchStickers(adapterId, 'happy', 1).length, 1);
  },
);

test(
  'sticker failures record a sanitized error and retry only after ten minutes',
  { timeout: 10_000 },
  async (t) => {
    if (spawnSync('ffmpeg', ['-version']).status !== 0) {
      t.skip('ffmpeg is unavailable');
      return;
    }
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=',
      'base64',
    );
    const errorMessage = 'Sticker model rejected the request';
    let modelCalls = 0;
    const f = await fixture(
      t,
      async function* (request) {
        assert.equal(request.purpose, 'sticker-index');
        assert.equal(request.model, 'default');
        assert.equal(Object.hasOwn(request, 'thinking'), false);
        if (++modelCalls === 1) {
          const { data, mime } = request.images![0]!;
          const windowsFile = String.raw`C:\workspace\internal sticker.png`;
          throw new Error(
            `${errorMessage} token=fake-token '${workspaceFile}' '${windowsFile}' data:${mime};base64,${data} ${request.context[0]!.content}\nprivate continuation`,
          );
        }
        yield { type: 'text.final', text: '["A happy sticker"]' };
      },
      true,
      {
        stickers: { model: 'default' },
        agentSettings: () => ({ thinking: ['minimal', 'low'] }),
        thinkingLevels: async (model) => {
          assert.equal(model, 'default');
          return undefined;
        },
        imageLimits: { maxBytes: 100_000, maxEdge: 512 },
        downloadAttachment: async () => ({ bytes, mime: 'image/png' }),
      },
    );
    const workspaceFile = join(dirname(f.path), 'internal image.png');
    const sticker = {
      kind: 'sticker',
      index: 0,
      fileId: 'retry-file',
      uniqueId: 'retry-unique',
      set: 'Retry_Set',
      stickerFormat: 'static',
    } as const;
    let fetches = 0;
    f.platform.platform.getStickerSet = async () => {
      fetches++;
      return [sticker];
    };
    const observe = (id: string) =>
      f.platform.emit(
        inbound(id, '', {
          chatKind: 'group',
          userId: 'member',
          attachments: [sticker],
        }),
      );
    const failed = () =>
      f.logs.find(({ event }) => event === 'sticker.index_failed');
    await observe('first');
    await until(t, () => !!failed());
    const message = failed()?.error;
    assert.ok(message);
    assert.ok(message.includes(errorMessage));
    assert.ok(message.length <= 300);
    assert.doesNotMatch(
      message,
      /fake-token|internal image|internal sticker|data:image|base64|Describe the first|private continuation|\r|\n/,
    );
    const span = f.trace.recent.find(({ name }) => name === 'sticker.index');
    assert.equal(span?.status, 'error');
    assert.equal(span?.attrs.error, message);
    assert.equal(f.store.hasStickerSet('retry_set', adapterId), false);

    t.mock.timers.tick(10 * 60_000 - 1);
    await observe('too-early');
    await setImmediate();
    assert.equal(fetches, 1);
    assert.equal(modelCalls, 1);

    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(fetches, 1);
    await observe('after-backoff');
    await until(t, () => f.store.hasStickerSet('retry_set', adapterId));
    assert.equal(fetches, 2);
    assert.equal(modelCalls, 2);
  },
);
