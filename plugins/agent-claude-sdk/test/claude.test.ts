import type {
  SDKMessage,
  SDKRateLimitInfo,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentCompactionEvent,
  AgentIO,
  AgentRequest,
} from '@tsugimori/plugin-sdk';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ClaudeAgent } from '../src/index.ts';

async function collect<T>(iterable: AsyncIterable<T>) {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function request(
  workdir: string,
  signal = new AbortController().signal,
): AgentRequest {
  return {
    context: [
      { source: 'rule', trust: 'trusted', content: 'trusted rule' },
      { source: 'rule', trust: 'member', content: 'member rule' },
      { source: 'summary', trust: 'member', content: 'stored context' },
      { source: 'message', trust: 'owner', content: 'reply pong' },
    ],
    model: 'fake-model',
    thinking: 'low',
    signal,
    workdir,
    tools: [],
  };
}

const noSupplements = async function* () {};
const io: AgentIO = {
  requestApproval: () => Promise.resolve(false),
  supplements: noSupplements(),
};

function frame(value: Record<string, unknown>) {
  return { session_id: 'claude-native', ...value } as SDKMessage;
}

const success = frame({
  type: 'result',
  subtype: 'success',
  result: 'pong',
  usage: { input_tokens: 9, output_tokens: 1 },
});

test('Claude caches only plan quota windows and merges sparse updates independently', async () => {
  let quota: SDKRateLimitInfo;
  const agent = new ClaudeAgent(
    {
      async *query() {
        yield frame({ type: 'rate_limit_event', rate_limit_info: quota });
        yield success;
      },
    },
    'claude',
    null,
  );
  const update = async (info: SDKRateLimitInfo) => {
    quota = info;
    await collect(agent.run(request(tmpdir()), io));
    return agent.describeQuota();
  };
  assert.equal(agent.describeQuota(), undefined);
  assert.equal(
    await update({ rateLimitType: 'seven_day_opus', status: 'rejected' }),
    undefined,
  );
  const primary = {
    usedPercent: 25,
    resetsAt: 1_800_000_000,
    windowDurationMins: 300,
  };
  const secondary = {
    usedPercent: 24,
    resetsAt: 1_800_100_000,
    windowDurationMins: 10_080,
  };
  assert.deepEqual(
    await update({
      rateLimitType: 'five_hour',
      status: 'allowed',
      utilization: 0.25,
      resetsAt: primary.resetsAt,
    }),
    { primary },
  );
  assert.deepEqual(
    await update({
      rateLimitType: 'seven_day',
      status: 'allowed_warning',
      utilization: 24,
      resetsAt: secondary.resetsAt,
    }),
    { primary, secondary },
  );
  assert.deepEqual(
    await update({ rateLimitType: 'five_hour', status: 'rejected' }),
    { primary, secondary, rateLimitReachedType: 'five_hour' },
  );
  const nextSecondary = { ...secondary, resetsAt: 1_800_200_000 };
  assert.deepEqual(
    await update({
      rateLimitType: 'seven_day',
      status: 'allowed',
      resetsAt: nextSecondary.resetsAt,
    }),
    { primary, secondary: nextSecondary, rateLimitReachedType: 'five_hour' },
  );
  assert.deepEqual(
    await update({
      rateLimitType: 'five_hour',
      status: 'allowed',
      utilization: 0,
    }),
    { primary: { ...primary, usedPercent: 0 }, secondary: nextSecondary },
  );
});

test('Claude reports configured defaults and tracks SDK init metadata per session', async () => {
  let sessionId = 'first';
  const deps = {
    async *query() {
      yield frame({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        model: 'claude-sonnet-4-6',
        effort: 'medium',
      });
      yield { ...success, session_id: sessionId };
    },
  };
  const input = { ...request(tmpdir()), model: 'default', thinking: undefined };
  const agent = new ClaudeAgent(deps, 'claude', null);
  assert.deepEqual(agent.listModels(), ['sonnet', 'opus', 'haiku']);
  assert.deepEqual(agent.describeDefaults(), {});
  assert.equal(agent.describeSession('first'), undefined);
  await collect(agent.run(input, io));
  const observed = { model: 'claude-sonnet-4-6', effort: 'medium' };
  assert.deepEqual(agent.describeDefaults(), observed);
  assert.deepEqual(agent.describeSession('first'), observed);
  assert.equal(agent.describeSession('other'), undefined);

  sessionId = 'summary';
  await collect(
    agent.run({ ...input, model: 'claude-haiku-4-5', purpose: 'summary' }, io),
  );
  assert.deepEqual(agent.describeDefaults(), observed);
  assert.equal(agent.describeSession('summary'), undefined);

  const configured = { model: 'claude-opus-4-8', effort: 'high' };
  const pinned = new ClaudeAgent(deps, 'claude', null, configured);
  assert.deepEqual(pinned.describeDefaults(), configured);
  await collect(
    pinned.run(
      { ...input, model: configured.model, thinking: configured.effort },
      io,
    ),
  );
  assert.deepEqual(pinned.describeDefaults(), configured);
  assert.deepEqual(pinned.describeSession('summary'), observed);
});

test('Claude applies model, effort and fast mode to a resumed query', async () => {
  const optionsSeen: unknown[] = [];
  const agent = new ClaudeAgent(
    {
      async *query({ options }) {
        const settings = options?.settings;
        optionsSeen.push({
          model: options?.model,
          effort: options?.effort,
          fastMode:
            typeof settings === 'object' ? settings.fastMode : undefined,
          resume: options?.resume,
        });
        yield frame({ type: 'system', subtype: 'init' });
        yield success;
      },
    },
    'claude',
    null,
  );
  const initial = { ...request(tmpdir()), serviceTier: 'fast' };
  await collect(agent.run(initial, io));
  const resumed = { ...initial, resumeSessionId: 'claude-native' };
  await collect(
    agent.run(
      { ...resumed, model: 'other', thinking: 'max', serviceTier: 'default' },
      io,
    ),
  );
  await collect(
    agent.run(
      {
        ...resumed,
        model: 'default',
        thinking: undefined,
        serviceTier: 'codex-only-tier',
      },
      io,
    ),
  );
  assert.deepEqual(optionsSeen, [
    { model: 'fake-model', effort: 'low', fastMode: true, resume: undefined },
    { model: 'other', effort: 'max', fastMode: false, resume: 'claude-native' },
    {
      model: undefined,
      effort: undefined,
      fastMode: undefined,
      resume: 'claude-native',
    },
  ]);
});

test('Claude keeps normal tools for ephemeral queries and discards their session metadata', async () => {
  const agent = new ClaudeAgent(
    {
      async *query({ options }) {
        assert.equal(options?.persistSession, false);
        assert.equal(options?.resume, undefined);
        assert.ok(
          Array.isArray(options?.tools) && options.tools.includes('Read'),
        );
        yield frame({ type: 'system', subtype: 'init', model: 'fake-model' });
        yield success;
      },
    },
    'claude',
    null,
  );
  const events = await collect(
    agent.run({ ...request(tmpdir()), ephemeral: true }, io),
  );
  assert.deepEqual(events.at(-1), { type: 'text.final', text: 'pong' });
  assert.equal(agent.describeSession('claude-native'), undefined);
});

test(
  'Claude isolates settings, routes tool permissions and streams typed SDK events',
  { timeout: 5_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'tsugimori-claude-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workdir = join(root, 'chat');
    await mkdir(workdir);
    await writeFile(join(workdir, 'inside.txt'), 'example');
    await writeFile(join(root, 'outside.txt'), 'example');
    await symlink('../outside.txt', join(workdir, 'link.txt'));
    const approvals: string[] = [];
    const agent = new ClaudeAgent(
      {
        async *query({ options, prompt }) {
          assert.ok(options?.canUseTool);
          assert.ok(options.abortController);
          assert.equal(options.cwd, workdir);
          assert.equal(options.model, 'fake-model');
          assert.equal(options.effort, 'low');
          assert.deepEqual(options.settingSources, []);
          assert.deepEqual(options.skills, []);
          assert.equal(options.permissionMode, 'default');
          assert.equal(options.sandbox?.allowUnsandboxedCommands, false);
          assert.equal(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '400000');
          assert.match(String(options.systemPrompt), /trusted rule/);
          assert.doesNotMatch(String(options.systemPrompt), /member rule/);
          if (options.resume) {
            assert.equal(options.resume, 'claude-native');
            assert.doesNotMatch(String(prompt), /member rule|stored context/);
          } else
            assert.match(String(prompt), /member rule[\s\S]*stored context/);

          const control = {
            signal: options.abortController.signal,
            toolUseID: 'tool-1',
            requestId: 'request-1',
          };
          const allowed = await options.canUseTool(
            'Read',
            { file_path: 'inside.txt' },
            control,
          );
          const denied = await options.canUseTool(
            'Read',
            { file_path: 'link.txt' },
            control,
          );
          const bash = await options.canUseTool(
            'Bash',
            { command: 'pwd' },
            control,
          );
          assert.equal(allowed?.behavior, 'allow');
          assert.equal(denied?.behavior, 'deny');
          assert.equal(bash?.behavior, 'allow');

          yield frame({
            type: 'system',
            subtype: 'init',
            model: 'claude-resolved',
            effort: 'high',
          });
          yield frame({
            type: 'stream_event',
            parent_tool_use_id: null,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'thinking_delta',
                thinking: 'Visible Claude thought',
              },
            },
          });
          yield await Promise.resolve(
            frame({
              type: 'assistant',
              parent_tool_use_id: null,
              message: {
                content: [
                  { type: 'thinking', thinking: 'Visible Claude thought' },
                  { type: 'redacted_thinking', data: 'Excluded thought' },
                  {
                    type: 'tool_use',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'pwd' },
                  },
                ],
              },
            }),
          );
          yield frame({
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-1',
                  is_error: false,
                  content: 'sample output',
                },
              ],
            },
          });
          yield frame({
            type: 'stream_event',
            parent_tool_use_id: null,
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'pong' },
            },
          });
          yield frame({
            type: 'result',
            subtype: 'success',
            result: 'pong',
            usage: { input_tokens: 9, output_tokens: 1 },
          });
        },
      },
      'claude',
    );
    const input = request(workdir);
    const host = {
      ...io,
      async requestApproval(
        approval: Parameters<AgentIO['requestApproval']>[0],
      ) {
        approvals.push(approval.action);
        assert.equal(approval.resource.type, 'project');
        return approval.action === 'claude.Bash';
      },
    };
    const first = await collect(agent.run(input, host));
    const second = await collect(
      agent.run({ ...input, resumeSessionId: 'claude-native' }, host),
    );
    assert.deepEqual(approvals, [
      'claude.Read',
      'claude.Bash',
      'claude.Read',
      'claude.Bash',
    ]);
    assert.deepEqual(first, [
      { type: 'sessionId', sessionId: 'claude-native' },
      { type: 'model', model: 'claude-resolved', reasoning: 'high' },
      { type: 'reasoning', text: 'Visible Claude thought' },
      {
        type: 'tool.started',
        callId: 'tool-1',
        name: 'Bash',
        args: { command: 'pwd' },
      },
      {
        type: 'tool.finished',
        callId: 'tool-1',
        name: 'Bash',
        status: 'ok',
        result: 'sample output',
      },
      { type: 'text.delta', text: 'pong' },
      { type: 'usage', contextTokens: 10, inputTokens: 9, outputTokens: 1 },
      { type: 'text.final', text: 'pong' },
    ]);
    assert.deepEqual(second, first);
  },
);

test(
  'passes the Claude threshold and compacts the resumed session with the native slash command',
  { timeout: 5_000 },
  async () => {
    const agent = new ClaudeAgent(
      {
        async *query({ options, prompt }) {
          assert.equal(options?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '275000');
          const manual = prompt === '/compact';
          if (manual) {
            assert.equal(options?.resume, 'claude-native');
            assert.deepEqual(options?.tools, []);
          } else {
            assert.match(String(prompt), /reply pong/);
          }
          yield await Promise.resolve(
            frame({
              type: 'system',
              subtype: 'init',
              slash_commands: ['compact'],
            }),
          );
          yield frame({
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: {
              trigger: manual ? 'manual' : 'auto',
              pre_tokens: 125_000,
              post_tokens: 600,
              duration_ms: 15,
            },
          });
          yield frame({
            type: 'result',
            subtype: 'success',
            result: 'Complete',
            usage: { input_tokens: 9, output_tokens: 1 },
          });
        },
      },
      'claude',
      null,
      { compactAt: 125_000 },
    );
    const input = request(tmpdir());
    const events = await collect(agent.run(input, io));
    assert.deepEqual(
      events.filter(({ type }) => type === 'compaction'),
      [
        {
          type: 'compaction',
          trigger: 'native',
          status: 'ok',
          tokensBefore: 125_000,
          tokensAfter: 600,
          durationMs: 15,
        },
      ],
    );
    assert.deepEqual(
      await agent.compact({ ...input, sessionId: 'claude-native' }),
      {
        status: 'compacted',
        tokensBefore: 125_000,
        tokensAfter: 600,
        durationMs: 15,
      },
    );
  },
);

test('Claude manual compaction distinguishes unsupported commands from sessions without a compaction boundary', async () => {
  for (const supported of [false, true]) {
    const agent = new ClaudeAgent(
      {
        async *query() {
          yield await Promise.resolve(
            frame({
              type: 'system',
              subtype: 'init',
              slash_commands: supported ? ['compact'] : [],
            }),
          );
          yield frame({
            type: 'result',
            subtype: 'success',
            result: 'Not enough messages to compact.',
          });
        },
      },
      'claude',
      null,
    );
    assert.deepEqual(
      await agent.compact({ ...request(tmpdir()), sessionId: 'claude-native' }),
      {
        status: supported ? 'skipped' : 'unsupported',
      },
    );
  }
});

test(
  'Claude compacts in the background and queues resumed messages in order',
  { timeout: 5_000 },
  async (t) => {
    const compactStarted = Promise.withResolvers<void>();
    const finishCompact = Promise.withResolvers<void>();
    const finishSecond = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const traced = Promise.withResolvers<AgentCompactionEvent>();
    const order: string[] = [];
    const agent = new ClaudeAgent(
      {
        async *query({ options, prompt }) {
          const requiredWindow = options?.resume ? '300000' : '400000';
          assert.equal(
            options?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
            requiredWindow,
          );
          if (prompt === '/compact') {
            assert.equal(options?.resume, 'claude-native');
            order.push('compact started');
            compactStarted.resolve();
            await finishCompact.promise;
            order.push('compact finished');
            yield frame({
              type: 'system',
              subtype: 'compact_boundary',
              compact_metadata: {
                trigger: 'manual',
                pre_tokens: 260_010,
                post_tokens: 4_500,
                duration_ms: 15,
              },
            });
          } else {
            const { content } = JSON.parse(String(prompt).split('\n').at(-1)!);
            order.push(content);
            if (content === 'second') {
              secondStarted.resolve();
              await finishSecond.promise;
            }
            // Only the newest model call's context should count, including cache reads.
            const cached = content === 'first' ? 260_000 : 10_000;
            yield frame({
              type: 'stream_event',
              parent_tool_use_id: null,
              event: {
                type: 'message_start',
                message: {
                  model: 'fake-model',
                  usage: {
                    input_tokens: 8,
                    cache_read_input_tokens: cached,
                    output_tokens: 0,
                  },
                },
              },
            });
            yield frame({
              type: 'stream_event',
              parent_tool_use_id: null,
              event: {
                type: 'message_delta',
                usage: { output_tokens: 2 },
              },
            });
          }
          yield frame({
            type: 'result',
            subtype: 'success',
            result: 'reply',
            num_turns: 2,
            usage: { input_tokens: 600_000, output_tokens: 10 },
            modelUsage: {
              'subagent-model': { contextWindow: 50_000 },
              'fake-model': { contextWindow: 300_000 },
            },
          });
        },
      },
      'claude',
      null,
    );
    t.after(async () => {
      finishCompact.resolve();
      finishSecond.resolve();
      await agent.stop();
    });
    const input = request(tmpdir());
    const turn = (content: string, resumeSessionId?: string) =>
      agent.run(
        {
          ...input,
          context: [{ source: 'message', trust: 'owner', content }],
          resumeSessionId,
        },
        {
          ...io,
          reportCompaction: traced.resolve,
        },
      );

    const first = await collect(turn('first'));
    assert.deepEqual(
      first.find(({ type }) => type === 'usage'),
      {
        type: 'usage',
        contextTokens: 260_010,
        contextWindow: 300_000,
        inputTokens: 600_000,
        outputTokens: 10,
      },
    );
    assert.ok(
      first.some(
        (event) => event.type === 'text.final' && event.text === 'reply',
      ),
    );
    await compactStarted.promise;
    const second = collect(turn('second', 'claude-native'));
    const third = collect(turn('third', 'claude-native'));
    const shared = agent.compact({ ...input, sessionId: 'claude-native' });
    await delay(0);
    assert.deepEqual(order, ['first', 'compact started']);
    finishCompact.resolve();
    await secondStarted.promise;
    assert.deepEqual(order, [
      'first',
      'compact started',
      'compact finished',
      'second',
    ]);
    finishSecond.resolve();
    await Promise.all([second, third]);
    assert.deepEqual(order, [
      'first',
      'compact started',
      'compact finished',
      'second',
      'third',
    ]);
    assert.deepEqual(await shared, {
      status: 'compacted',
      shared: true,
      tokensBefore: 260_010,
      tokensAfter: 4_500,
      durationMs: 15,
    });
    assert.deepEqual(await traced.promise, {
      type: 'compaction',
      trigger: 'post-turn',
      status: 'ok',
      tokensBefore: 260_010,
      tokensAfter: 4_500,
      durationMs: 15,
    });
  },
);

test(
  'Claude propagates cancellation to the SDK abort controller',
  { timeout: 5_000 },
  async () => {
    const started = Promise.withResolvers<void>();
    const agent = new ClaudeAgent(
      {
        async *query({ options }) {
          assert.ok(options?.abortController);
          started.resolve();
          yield await delay(5_000, frame({ type: 'system' }), {
            signal: options.abortController.signal,
          });
        },
      },
      'claude',
    );
    const controller = new AbortController();
    const running = collect(
      agent.run(request(tmpdir(), controller.signal), io),
    );
    await started.promise;
    controller.abort();
    await assert.rejects(running, { name: 'AbortError' });
  },
);

test('Claude sends native base64 image blocks with the new user message', async () => {
  const agent = new ClaudeAgent(
    {
      async *query({ prompt, options }) {
        assert.equal(options?.resume, 'claude-native');
        assert.ok(typeof prompt !== 'string');
        const messages = await collect(prompt);
        assert.deepEqual(
          messages.map(({ message }) => message),
          [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    source: 'message',
                    trust: 'owner',
                    content: 'reply pong',
                  }),
                },
                {
                  type: 'text',
                  text: JSON.stringify({ messageId: 'photo', index: 0 }),
                },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'AQID',
                  },
                },
              ],
            },
          ],
        );
        yield success;
      },
    },
    'claude',
    null,
  );
  await collect(
    agent.run(
      {
        ...request(tmpdir()),
        resumeSessionId: 'claude-native',
        images: [
          {
            mime: 'image/png',
            data: 'AQID',
            source: { messageId: 'photo', index: 0 },
          },
        ],
      },
      io,
    ),
  );
});
