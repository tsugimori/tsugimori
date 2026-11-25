import type { TraceSpan } from '@tsugimori/storage';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Tracer } from '../src/index.ts';

test('queues synchronous and asynchronous spans and flushes them as a batch', async () => {
  const batches: TraceSpan[][] = [];
  const trace = new Tracer(
    {
      writeTraceSpans: (spans) => {
        batches.push([...spans]);
      },
    },
    { ringSize: 2 },
  );
  assert.equal(
    trace.span('first', {}, () => 1),
    1,
  );
  assert.equal(
    await trace.span('second', { agent: 'fake' }, () => Promise.resolve(2)),
    2,
  );
  assert.throws(
    () =>
      trace.span('third', {}, () => {
        throw new Error('test');
      }),
    /test/,
  );
  assert.equal(batches.length, 0);
  assert.deepEqual(
    trace.recent.map(({ name }) => name),
    ['second', 'third'],
  );
  await trace.flush();
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0]?.map(({ name, status }) => [name, status]),
    [
      ['first', 'ok'],
      ['second', 'ok'],
      ['third', 'error'],
    ],
  );
  assert.ok(
    batches[0]?.every(
      (span) => span.durationMs >= 0 && span.endedAt >= span.startedAt,
    ),
  );
});
