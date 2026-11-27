import type { TraceSpan } from '@tsugimori/storage';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentTiming } from '../src/agent-timing.ts';

function span(
  name: string,
  startedAt: number,
  endedAt = startedAt,
  attrs: TraceSpan['attrs'] = {},
): TraceSpan {
  return {
    name,
    startedAt,
    endedAt,
    attrs,
    durationMs: endedAt - startedAt,
    status: 'ok',
  };
}

test('sequential tools leave model gaps before each call and the final reply', () => {
  const first = span('agent.tool', 4100, 6200);
  const second = span('tool.run', 8900, 11_300);
  const timing = agentTiming(
    [
      second,
      span('agent.run', 0, 14_100),
      first,
      span('agent.usage', 4100, 4100, {
        inputTokens: 51_800,
        outputTokens: 208,
      }),
      span('agent.usage', 14_100, 14_100, { outputTokens: 155 }),
    ],
    new Map([
      [first, 1],
      [second, 2],
    ]),
  );
  assert.deepEqual(timing, {
    agentMs: 14_100,
    modelMs: 9600,
    toolMs: 4500,
    modelGaps: [
      {
        startedAt: 0,
        endedAt: 4100,
        nextToolSeq: 1,
        inputTokens: 51_800,
        outputTokens: 208,
      },
      { startedAt: 6200, endedAt: 8900, nextToolSeq: 2 },
      {
        startedAt: 11_300,
        endedAt: 14_100,
        nextToolSeq: undefined,
        outputTokens: 155,
      },
    ],
  });
});

test('parallel tool spans use their union and are clipped to the agent run', () => {
  const spans = [
    span('agent.run', 1000, 6000),
    span('agent.tool', 500, 1500),
    span('tool.run', 2500, 4500),
    span('agent.tool', 2800, 4000),
    span('agent.tool', 4300, 5500),
    span('agent.tool', 5600, 10_000),
  ];
  assert.deepEqual(agentTiming(spans, new Map()), {
    agentMs: 5000,
    modelMs: 1100,
    toolMs: 3900,
    modelGaps: [
      { startedAt: 1500, endedAt: 2500, nextToolSeq: undefined },
      { startedAt: 5500, endedAt: 5600, nextToolSeq: undefined },
    ],
  });
});

test('runs without tools are fully model time and unrelated spans are excluded', () => {
  const spans = [
    span('agent.run', 0, 1500),
    span('agent.run', 4000, 5000),
    span('agent.run', 6000, 7000, { purpose: 'summary' }),
    span('tool.run', 2000, 3000),
  ];
  assert.deepEqual(agentTiming(spans, new Map()), {
    agentMs: 2500,
    modelMs: 2500,
    toolMs: 0,
    modelGaps: [
      { startedAt: 0, endedAt: 1500, nextToolSeq: undefined },
      { startedAt: 4000, endedAt: 5000, nextToolSeq: undefined },
    ],
  });
  assert.equal(agentTiming(spans.slice(2), new Map()), undefined);
});

test('short gaps are hidden and usage goes only to the gap containing it', () => {
  const spans = [
    span('agent.run', 100, 1000),
    span('tool.run', 150, 500),
    span('agent.usage', 140, 140, { inputTokens: 1 }),
    span('agent.usage', 300, 300, { inputTokens: 2 }),
    span('agent.usage', 500, 500, { inputTokens: 3, outputTokens: 4 }),
    span('agent.usage', 750, 750, { inputTokens: 5 }),
    span('agent.usage', 950, 950, { purpose: 'summary', outputTokens: 6 }),
    span('agent.usage', 1100, 1100, { outputTokens: 10 }),
  ];
  assert.deepEqual(agentTiming(spans, new Map()), {
    agentMs: 900,
    modelMs: 550,
    toolMs: 350,
    modelGaps: [
      {
        startedAt: 500,
        endedAt: 1000,
        nextToolSeq: undefined,
        inputTokens: 5,
        outputTokens: 4,
      },
    ],
  });
});
