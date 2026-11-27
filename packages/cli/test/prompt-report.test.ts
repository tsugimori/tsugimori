import { Gateway, PluginRegistry } from '@tsugimori/core';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { TraceSpan } from '../../storage/src/index.ts';

import { main } from '../src/index.ts';
import { listenForRemoval } from '../src/removal.ts';

test('prompt-report reads platform tool sizes and persisted chat metrics through the local gateway', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-prompt-report-'));
  const store = new SqliteStore(':memory:');
  const platforms = ['test:one', 'test:two'];
  const description = 'PRIVATE_TOOL_DESCRIPTION';
  const schema = {
    type: 'object',
    properties: { note: { const: 'PRIVATE_SCHEMA' } },
  };
  const registry = new PluginRegistry([
    {
      name: 'test',
      adapters: {
        test: ({ id }) => ({
          id,
          kind: 'test',
          capabilities: { reactions: id === platforms[0] },
          async start() {},
          async stop() {},
          async send() {
            return { messageId: 'sent' };
          },
          async sendReaction() {},
          tools: () => [
            {
              name: id === platforms[0] ? 'sample.one' : 'sample.two',
              description,
              schema,
              async run() {
                throw new Error('Reports must never execute tools');
              },
            },
          ],
        }),
      },
      agents: {
        test: ({ id }) => ({
          id,
          kind: 'test',
          loop: 'external',
          async *run() {},
        }),
      },
    },
  ]);
  const gateway = new Gateway({ workspace, registry, store, log: () => {} });
  const close = await listenForRemoval(workspace, {
    async plan() {
      throw new Error('Reports must never plan a removal');
    },
    async execute() {
      throw new Error('Reports must never perform a removal');
    },
    async promptReport() {
      return gateway.promptReport();
    },
  });
  t.after(async () => {
    await close();
    await gateway.stop();
    store.close();
    await rm(workspace, { recursive: true, force: true });
  });
  await writeFile(
    join(workspace, 'tsugimori.json'),
    JSON.stringify({
      platforms: platforms.map((id) => ({ id, kind: 'test' })),
      agents: [{ id: 'test-agent', kind: 'test', compactAt: 150_000 }],
    }),
  );
  await gateway.start();

  const text = 'PRIVATE_SUMMARY';
  for (const [adapterId, chatId, taskId] of [
    ['test:one', 'alpha', 'task-alpha'],
    ['test:two', 'bravo', 'task-bravo'],
    ['test:two', 'empty', 'task-empty'],
  ] as const) {
    const ref = { adapterId, chatId };
    const input = store.recordInbound(
      { ...ref, kind: 'dm', title: 'PRIVATE_TITLE' },
      { adapterId, userId: 'user', display: null },
      {
        ...ref,
        direction: 'inbound',
        messageId: 'incoming',
        text: 'PRIVATE_MESSAGE',
        userId: 'user',
        raw: null,
        replyTo: null,
        threadId: null,
      },
    );
    assert.ok(input);
    store.createTask({
      ...ref,
      id: taskId,
      agentId: 'test-agent',
      model: 'default',
      sourceMessageId: input.messageId,
      createdAt: 1000,
      startedAt: 1000,
      finishedAt: 2000,
      status: 'sent',
    });
    if (chatId === 'alpha')
      assert.ok(
        store.saveSummary({
          ...store.beginSummary(ref),
          throughSeq: input.seq,
          text,
        }),
      );
  }

  const span = (
    name: string,
    at: number,
    attrs: TraceSpan['attrs'],
    status: TraceSpan['status'] = 'ok',
  ): TraceSpan => ({
    name,
    startedAt: at,
    endedAt: at,
    durationMs: 0,
    status,
    attrs,
  });
  const run = (at: number, taskId: string, attrs: TraceSpan['attrs']) =>
    span('agent.run', at, { taskId, agentId: 'test-agent', ...attrs });
  store.writeTraceSpans([
    ...Array.from({ length: 12 }, (_, i) =>
      run(1000 + i, 'task-alpha', {
        inputTokens: 120,
        cachedInputTokens: 90,
        sessionScope: 'alpha-hash',
        instructionsHash: 'fixture-hash',
        error: 'PRIVATE_TRACE',
      }),
    ),
    run(2000, 'task-alpha', { purpose: 'summary', inputTokens: 99999 }),
    run(2000, 'task-bravo', { inputTokens: 400 }),
    run(2001, 'task-bravo', { inputTokens: null }),
    span('agent.compaction', 3000, { taskId: 'task-alpha' }),
    span('agent.compaction', 3100, { taskId: 'task-alpha' }, 'error'),
    span('session.reset', 4000, { sessionScope: 'alpha-hash' }),
    span('session.reset', 5000, {
      adapterId: 'test:two',
      chatId: 'bravo',
      sessionScope: null,
    }),
  ]);

  const output = t.mock.method(console, 'log', () => {});
  await main(['prompt-report', workspace, '--json'], registry);
  const json: ReturnType<Gateway['promptReport']> = JSON.parse(
    output.mock.calls[0]!.arguments[0],
  );
  const [one, two] = json.platforms;
  assert.equal(one?.platformId, 'test:one');
  const standard = one?.variants.find(({ modes }) =>
    modes.includes('standard'),
  );
  const scheduled = one?.variants.find(({ modes }) =>
    modes.includes('cross-target schedule'),
  );
  assert.ok(standard);
  assert.ok(standard.tools.some(({ name }) => name === 'send.reaction'));
  assert.ok(scheduled);
  assert.ok(!scheduled.tools.some(({ name }) => name === 'send.reaction'));
  assert.deepEqual(
    standard.tools.find(({ name }) => name === 'sample.one'),
    {
      name: 'sample.one',
      wireName: 'sample_one',
      descriptionChars: description.length,
      inputSchemaChars: JSON.stringify(schema).length,
      totalChars: description.length + JSON.stringify(schema).length,
    },
  );
  assert.deepEqual(
    standard.tools.map(({ totalChars }) => totalChars),
    standard.tools.map(({ totalChars }) => totalChars).sort((a, b) => b - a),
  );
  assert.equal(
    standard.totals.totalChars,
    standard.tools.reduce((sum, tool) => sum + tool.totalChars, 0),
  );
  assert.ok(
    two?.variants
      .flatMap(({ tools }) => tools)
      .some(({ name }) => name === 'sample.two'),
  );
  assert.deepEqual(json.carryOver, { enabled: true, maxChars: 4000 });
  const [alpha, bravo, empty] = json.chats;
  assert.equal(alpha?.carryOver?.chars, text.length);
  assert.equal(alpha.carryOver.estimatedTokens, 4);
  assert.equal(alpha.compactAt, 150_000);
  assert.equal(alpha.recentRuns.length, 10);
  assert.equal(alpha.recentRuns[0]?.startedAt, 1011);
  assert.equal(alpha.recentRuns[0]?.hitRatio, 0.75);
  assert.equal(alpha.compactions, 1);
  assert.equal(alpha.lastCompactionAt, 3000);
  assert.equal(alpha.lastResetAt, 4000);
  assert.equal(bravo?.lastResetAt, 5000);
  assert.equal(bravo.recentRuns[1]?.hitRatio, null);
  assert.equal(empty?.recentRuns.length, 0);
  assert.deepEqual(json.distribution.inputTokens, {
    chats: 2,
    p50: 120,
    p90: 400,
    max: 400,
  });
  assert.deepEqual(json.distribution.hitRatio, {
    chats: 1,
    p50: 0.75,
    p90: 0.75,
    max: 0.75,
  });

  await main(['prompt-report', workspace], registry);
  const human = output.mock.calls[1]!.arguments[0];
  assert.match(human, /"test:one" \/ "alpha"/);
  assert.match(human, /Summary 15 chars, \d+ serialized chars, ~4 tokens/);
  assert.match(
    human,
    /compactAt 150000, compactions 1, last compaction 1970-01-01T00:00:03\.000Z, last reset 1970-01-01T00:00:04\.000Z/,
  );
  assert.match(human, /Input tokens\t2\t120\t400\t400/);
  for (const call of output.mock.calls)
    assert.doesNotMatch(call.arguments[0], /PRIVATE_/);
});
