import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderMarkdown } from '../ui/app/lib/markdown.ts';
import { modelGapsByEvent, taskLanes } from '../ui/app/lib/timeline.ts';

test('markdown renders formatting and escapes stored HTML and unsafe URLs', () => {
  const html = renderMarkdown(
    [
      '**Title**',
      '',
      '<script>alert(1)</script><img src=x onerror=alert(1)>',
      '',
      '[unsafe](javascript:alert%281%29) [obfuscated](java&#115;cript:alert%281%29)',
      '',
      '[reference](https://example.test/path?a=1&b=2)',
      '',
      '![external image](https://example.test/asset)',
    ].join('\n'),
  );
  assert.match(html, /<strong>Title<\/strong>/);
  assert.match(html, /&lt;script&gt;|&lt;img/);
  assert.match(html, /href="https:\/\/example.test\/path\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /<(?:script|img)\b|href="(?:javascript|java&)/i);
});

test('timeline lanes position trace model gaps and tool calls on the task clock', () => {
  const { model, tools } = taskLanes(
    {
      agentTiming: {
        modelGaps: [
          { startedAt: 15, endedAt: 20 },
          { startedAt: 60, endedAt: 90 },
        ],
      },
      tools: [
        { startedAt: 20, endedAt: 40 },
        { startedAt: 30, endedAt: 60 },
      ],
    },
    0,
    100,
  );
  assert.deepEqual(model, [
    { at: 15, width: 5, tone: 'model' },
    { at: 60, width: 30, tone: 'model' },
  ]);
  assert.deepEqual(
    tools.map(({ at, width }) => ({ at, width })),
    [
      { at: 20, width: 20 },
      { at: 30, width: 30 },
    ],
  );
});

test('model labels attach to the associated tool and the first chunk of the final reply', () => {
  const first = { startedAt: 100, endedAt: 500, nextToolSeq: 3 };
  const last = { startedAt: 750, endedAt: 1300 };
  const rows = modelGapsByEvent(
    [first, last],
    [
      { seq: 1, kind: 'reasoning', at: 200, data: { text: 'Reasoning' } },
      { seq: 2, kind: 'tool', at: 499, data: { toolSeq: 3 } },
      { seq: 3, kind: 'text', at: 800, data: { text: 'Earlier text' } },
      { seq: 4, kind: 'text', at: 1100, data: { text: 'First chunk' } },
      { seq: 5, kind: 'text', at: 1100, data: { text: 'Second chunk' } },
    ],
  );
  assert.deepEqual(
    [...rows],
    [
      [2, [first]],
      [4, [last]],
    ],
  );
});
