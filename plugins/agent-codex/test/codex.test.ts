import type { AgentIO, AgentRequest } from '@tsugimori/plugin-sdk';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CodexAgent } from '../src/index.ts';

const fakeServer = String.raw`
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';

const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const threads = new Map();
const approvals = new Map();
let next = 0;
let initialized = false;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  const answer = (result) => write({ id, result });
  if (method === 'initialize') {
    assert.equal(params.clientInfo.name, 'tsugimori');
    answer({});
  } else if (method === 'initialized') {
    initialized = true;
  } else if (method === 'thread/start' || method === 'thread/resume') {
    assert.ok(initialized);
    assert.equal(params.cwd, '/tmp/work');
    assert.equal(params.config.model_auto_compact_token_limit, Number(process.env.TEST_CODEX_COMPACT_AT ?? 250000));
    const scoped = Array.isArray(params.environments);
    if (scoped) {
      assert.deepEqual(params.runtimeWorkspaceRoots, ['/tmp/work']);
      assert.deepEqual(params.environments, []);
      assert.equal(params.sandbox, 'read-only');
      assert.equal(params.config.permissions, undefined);
      assert.equal(params.approvalPolicy, 'never');
      if (!params.threadId)
        assert.equal(params.dynamicTools[0].name, 'schedule_list');
    } else {
      assert.equal(params.sandbox, 'workspace-write');
      assert.equal(params.approvalPolicy, 'on-request');
    }
    const threadId = params.threadId ?? 'thread-' + ++next;
    threads.set(threadId, { scoped, resumed: method === 'thread/resume' });
    if (params.threadId) assert.equal(params.excludeTurns, true);
    answer({ thread: { id: threadId } });
  } else if (method === 'thread/compact/start') {
    const { threadId } = params;
    assert.ok(threads.get(threadId)?.resumed);
    if (process.env.TEST_CODEX_NO_COMPACT) {
      write({ id, error: { code: -32601, message: 'Method not found' } });
      continue;
    }
    const turnId = 'turn-' + ++next;
    const notify = (method, params) => write({ method, params: { threadId, turnId, ...params } });
    const item = { type: 'contextCompaction', id: 'compact-' + turnId };
    notify('turn/started', { turn: { id: turnId, status: 'inProgress' } });
    answer({});
    notify('item/started', { item, startedAtMs: 100 });
    notify('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 30, inputTokens: 0, outputTokens: 0 } } });
    notify('item/completed', { item, completedAtMs: 120 });
    notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [item] } });
  } else if (method === 'turn/start') {
    const threadId = params.threadId;
    const thread = threads.get(threadId);
    assert.ok(thread);
    if (thread.scoped) {
      assert.deepEqual(params.environments, []);
      assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    } else assert.deepEqual(params.sandboxPolicy, {
      type: 'workspaceWrite', writableRoots: ['/tmp/work'], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    });
    assert.equal(params.model, 'fake-model');
    assert.equal(params.effort, 'low');
    const blocks = params.input[0].text.split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(blocks.map(({ source }) => source), thread.resumed ? ['message'] : ['rule', 'message']);
    const input = blocks.at(-1).content;
    const turnId = 'turn-' + ++next;
    const notify = (method, parameters) => write({
      method, params: { threadId, turnId, ...parameters },
    });
    const item = { type: 'agentMessage', id: 'reply-' + turnId, text: 'pong', phase: 'final_answer' };
    const finish = () => {
      notify('item/agentMessage/delta', { delta: 'po', itemId: item.id });
      notify('item/agentMessage/delta', { delta: 'ng', itemId: item.id });
      notify('item/completed', { item });
      notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 7, outputTokens: 2 } } });
      notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [item] } });
    };
    if (input === 'crash') {
      answer({ turn: { id: turnId, status: 'inProgress' } });
      process.exit(3);
    }
    if (input === 'wait') {
      // A cancellation can arrive between dispatching turn/start and receiving its ID.
      setTimeout(() => answer({ turn: { id: turnId, status: 'inProgress' } }), 30);
      continue;
    }
    if (input === 'auto compact') {
      const item = { type: 'contextCompaction', id: 'compact-' + turnId };
      notify('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 800, inputTokens: 700, outputTokens: 100 } } });
      notify('item/started', { item, startedAtMs: 100 });
      notify('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 100, inputTokens: 0, outputTokens: 0 } } });
      notify('item/completed', { item, completedAtMs: 110 });
    }
    if (input === 'scheduled tools') {
      answer({ turn: { id: turnId, status: 'inProgress' } });
      approvals.set('dynamic-1', (result) => {
        assert.deepEqual(result, { success: true, contentItems: [{ type: 'inputText', text: '["cached"]' }] });
        finish();
      });
      write({ id: 'dynamic-1', method: 'item/tool/call', params: { threadId, turnId, tool: 'schedule_list', arguments: {} } });
      continue;
    }
    if (input === 'approvals') {
      answer({ turn: { id: turnId, status: 'inProgress' } });
      const tool = { id: 'command-1', type: 'commandExecution', command: 'printf pong' };
      notify('item/started', { item: tool });
      const methods = ['commandExecution', 'fileChange', 'permissions'];
      let remaining = methods.length;
      for (const [index, name] of methods.entries()) {
        const approvalId = 'server-' + index;
        approvals.set(approvalId, (result) => {
          if (name === 'commandExecution') assert.deepEqual(result, { decision: 'accept' });
          if (name === 'fileChange') assert.deepEqual(result, { decision: 'decline' });
          if (name === 'permissions') assert.deepEqual(result, {
            permissions: { network: { enabled: true } }, scope: 'turn',
          });
          if (--remaining === 0) {
            notify('item/completed', { item: { ...tool, status: 'completed' } });
            finish();
          }
        });
        write({ id: approvalId, method: 'item/' + name + '/requestApproval', params: {
          threadId, turnId, itemId: tool.id, cwd: '/tmp/work',
          permissions: { network: { enabled: true }, fileSystem: null },
        } });
      }
    } else {
      // Some frames can be read before the turn/start response settles.
      finish();
      answer({ turn: { id: turnId, status: 'inProgress' } });
    }
  } else if (method === 'turn/interrupt') {
    process.send?.('interrupted');
    answer({});
  } else if (typeof id === 'string') {
    const approve = approvals.get(id);
    assert.ok(approve);
    approve(result);
    approvals.delete(id);
  } else {
    throw new Error('Unexpected method');
  }
}
`;

const emptySupplements = async function* () {};
const io: AgentIO = {
  requestApproval: () => Promise.resolve(false),
  supplements: emptySupplements(),
};

async function collect<T>(iterable: AsyncIterable<T>) {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function request(
  text: string,
  signal = new AbortController().signal,
  resumeSessionId?: string,
): AgentRequest {
  return {
    context: [
      { source: 'rule', trust: 'trusted', content: 'trusted context' },
      { source: 'message', trust: 'owner', content: text },
    ],
    model: 'fake-model',
    thinking: 'low',
    signal,
    workdir: '/tmp/work',
    tools: [],
    resumeSessionId,
  };
}

test(
  'passes Codex compaction config and tracks automatic and manual compaction',
  { timeout: 5_000 },
  async (t) => {
    const agent = new CodexAgent(
      {
        spawn(_command, _args, options) {
          return spawn(
            process.execPath,
            ['--input-type=module', '--eval', fakeServer],
            {
              ...options,
              env: { ...options.env, TEST_CODEX_COMPACT_AT: '150000' },
            },
          );
        },
      },
      'codex',
      { compactAt: 150_000 },
    );
    t.after(() => agent.stop());
    const input = request('auto compact');
    const events = await collect(agent.run(input, io));
    assert.deepEqual(
      events.filter(({ type }) => type === 'compaction'),
      [
        {
          type: 'compaction',
          trigger: 'auto',
          tokensBefore: 800,
          tokensAfter: 100,
          durationMs: 10,
        },
      ],
    );
    const session = events.find((event) => event.type === 'sessionId');
    assert.ok(session);
    assert.deepEqual(
      await agent.compact({ ...input, sessionId: session.sessionId }),
      {
        status: 'compacted',
        tokensBefore: 100,
        tokensAfter: 30,
        durationMs: 20,
      },
    );
  },
);

test(
  'maps Codex method-not-found to unsupported compaction',
  { timeout: 5_000 },
  async (t) => {
    const agent = new CodexAgent(
      {
        spawn(_command, _args, options) {
          return spawn(
            process.execPath,
            ['--input-type=module', '--eval', fakeServer],
            {
              ...options,
              env: { ...options.env, TEST_CODEX_NO_COMPACT: '1' },
            },
          );
        },
      },
      'codex',
    );
    t.after(() => agent.stop());
    assert.deepEqual(
      await agent.compact({ ...request(''), sessionId: 'thread-1' }),
      { status: 'unsupported' },
    );
  },
);

test(
  'streams Codex turns, resumes native threads and answers all three approval methods',
  { timeout: 5_000 },
  async (t) => {
    let spawns = 0;
    const agent = new CodexAgent(
      {
        spawn(command, args, options) {
          spawns++;
          assert.equal(command, 'fake-codex');
          assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
          assert.equal(options.env?.CODEX_HOME, '/tmp/fake-codex-home');
          return spawn(
            process.execPath,
            ['--input-type=module', '--eval', fakeServer],
            options,
          );
        },
      },
      'codex:example',
      { command: 'fake-codex', codexHome: '/tmp/fake-codex-home' },
    );
    t.after(() => agent.stop());
    await agent.start();

    const seen: string[] = [];
    const events = await collect(
      agent.run(request('approvals'), {
        ...io,
        async requestApproval(approval) {
          seen.push(approval.action);
          assert.equal(approval.resource.type, 'project');
          assert.ok(approval.description?.includes('/tmp/work'));
          return approval.action !== 'codex.file_change';
        },
      }),
    );
    assert.deepEqual(seen, [
      'codex.command',
      'codex.file_change',
      'codex.permissions',
    ]);
    assert.deepEqual(
      events
        .filter((event) => event.type === 'text.delta')
        .map((event) => event.text),
      ['po', 'ng'],
    );
    assert.deepEqual(events.at(-1), { type: 'text.final', text: 'pong' });
    assert.ok(
      events.some(
        (event) => event.type === 'tool.started' && event.name === 'command',
      ),
    );
    assert.ok(
      events.some(
        (event) => event.type === 'tool.finished' && event.status === 'ok',
      ),
    );
    assert.ok(
      events.some((event) => event.type === 'usage' && event.inputTokens === 7),
    );
    const native = events.find((event) => event.type === 'sessionId');
    assert.ok(native);
    const [resumed, separate] = await Promise.all([
      collect(agent.run(request('new turn', undefined, native.sessionId), io)),
      collect(agent.run(request('second conversation'), io)),
    ]);
    assert.deepEqual(resumed[0], native);
    assert.notDeepEqual(separate[0], native);
    assert.deepEqual(resumed.at(-1), { type: 'text.final', text: 'pong' });
    assert.deepEqual(separate.at(-1), { type: 'text.final', text: 'pong' });
    assert.equal(spawns, 1);
  },
);

test(
  'interrupts an aborted turn and reconnects after a process crash',
  { timeout: 5_000 },
  async (t) => {
    let spawns = 0;
    const interrupted = Promise.withResolvers<void>();
    const agent = new CodexAgent(
      {
        spawn(_command, _args, options) {
          spawns++;
          const child = spawn(
            process.execPath,
            ['--input-type=module', '--eval', fakeServer],
            {
              ...options,
              stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
            },
          );
          child.on('message', (message) => {
            if (message === 'interrupted') interrupted.resolve();
          });
          return child;
        },
      },
      'codex',
    );
    t.after(() => agent.stop());
    await agent.start();
    const controller = new AbortController();
    const iterator = agent
      .run(request('wait', controller.signal), io)
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value.type, 'sessionId');
    const pending = iterator.next();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await interrupted.promise;

    await assert.rejects(
      collect(agent.run(request('crash'), io)),
      /Codex app-server exited/,
    );
    const resumed = await collect(agent.run(request('after crash'), io));
    assert.deepEqual(resumed.at(-1), { type: 'text.final', text: 'pong' });
    assert.equal(spawns, 2);
    await agent.stop();
    await delay(300);
    assert.equal(spawns, 2);
  },
);

test(
  'scoped Codex threads expose framework tools and resume with the same tool definitions',
  { timeout: 5000 },
  async (t) => {
    const agent = new CodexAgent(
      {
        spawn(_command, _args, options) {
          return spawn(
            process.execPath,
            ['--input-type=module', '--eval', fakeServer],
            options,
          );
        },
      },
      'codex',
    );
    t.after(() => agent.stop());
    let calls = 0;
    const scoped: AgentRequest = {
      ...request('scheduled tools'),
      sandbox: {
        workdir: '/tmp/work',
        writable: ['/tmp/work'],
        network: 'none',
        denyRead: ['/tmp/work/.git'],
      },
      tools: [
        {
          name: 'schedule.list',
          description: 'List schedules',
          schema: { type: 'object' },
          async run(args) {
            assert.deepEqual(args, {});
            calls++;
            return ['cached'];
          },
        },
      ],
    };
    const events = await collect(agent.run(scoped, io));
    const first = events.find((event) => event.type === 'sessionId');
    assert.ok(first);
    assert.equal(calls, 1);
    assert.equal(agent.acceptsSession(first.sessionId, scoped.tools), true);
    assert.equal(agent.acceptsSession(first.sessionId, []), false);
    const resumed = await collect(
      agent.run({ ...scoped, resumeSessionId: first.sessionId }, io),
    );
    assert.deepEqual(resumed.at(0), first);
    assert.equal(calls, 2);
  },
);
