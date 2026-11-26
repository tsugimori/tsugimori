import type { Config } from '@tsugimori/config';
import type {
  AdapterContext,
  AgentConnector,
  AgentRequest,
  ApprovalFeedback,
  ApprovalReaction,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  PlatformCapabilities,
  PluginDefinition,
  TunnelProvider,
} from '@tsugimori/plugin-sdk';

import { SqliteStore } from '@tsugimori/storage-sqlite';
import { Tracer } from '@tsugimori/trace';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';

import type { Logger } from '../src/index.ts';

import { Gateway, PluginRegistry, shouldTrigger } from '../src/index.ts';

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
    agentSettings?(id: string): AgentConnector['settings'];
    compact?: AgentConnector['compact'];
    context?: Config['context'];
    describeDefaults?: AgentConnector['describeDefaults'];
    describeQuota?: AgentConnector['describeQuota'];
    describeSession?: AgentConnector['describeSession'];
    durable?: boolean;
    locale?: 'en' | 'zh-TW';
    onScopedTool?: (args: unknown, userId: string) => void;
    outboundPush?: PlatformCapabilities['outboundPush'];
    plugins?: PluginDefinition[];
    previews?: { named?: TunnelProvider; quick: TunnelProvider };
    reactions?: true | PlatformAdapter['setApprovalReaction'];
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
          compact: options.compact,
          describeDefaults: options.describeDefaults,
          describeQuota: options.describeQuota,
          describeSession: options.describeSession,
          run,
          settings: options.agentSettings?.(id),
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
  const locale = options.locale;
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
              },
            ])
          : [],
        defaultAgent: 'test',
        context: options.context ?? contextSettings,
        exec,
        locale,
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
        inbound('owner', '/compact', { replyTo: 'first-turn' }),
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
            replyTo: prompt.messageId,
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
        replyTo: approval.promptMessageId,
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
      inbound('one', 'first supplement', { replyTo: 'source' }),
    );
    await f.platform.emit(
      inbound('two', 'second supplement', { replyTo: 'one' }),
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
        replyTo: prompt.messageId,
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
      inbound('second-approval', 'always', { replyTo: second.messageId }),
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
              replyTo: prompt.messageId,
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
            replyTo: prompt.messageId,
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
        replyTo: prompt.messageId,
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
    await f.platform.emit(inbound('tool-yes', 'yes', { ...group, replyTo }));
    await f.platform.emit(
      inbound('tool-yes-again', 'yes', { ...group, replyTo }),
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
        inbound('deny', 'deny', { replyTo: approval.promptMessageId }),
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
      inbound('supplement', 'more detail', { replyTo: 'original' }),
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
        replyTo: prompt.messageId,
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
    await f.platform.emit(
      inbound('owner-close', '/preview close preview-1', group),
    );
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
