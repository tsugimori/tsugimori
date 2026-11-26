import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentIO, AgentRequest } from '@tsugimori/plugin-sdk';

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
          assert.equal(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '250000');
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

          yield await Promise.resolve(
            frame({
              type: 'assistant',
              parent_tool_use_id: null,
              message: {
                content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }],
              },
            }),
          );
          yield frame({
            type: 'user',
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 'tool-1', is_error: false },
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
      { type: 'tool.started', callId: 'tool-1', name: 'Bash' },
      { type: 'tool.finished', callId: 'tool-1', name: 'Bash', status: 'ok' },
      { type: 'text.delta', text: 'pong' },
      { type: 'usage', inputTokens: 9, outputTokens: 1 },
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
          assert.equal(options?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '125000');
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
          trigger: 'auto',
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
