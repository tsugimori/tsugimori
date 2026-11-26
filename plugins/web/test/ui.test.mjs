import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderMarkdown } from '../ui/app/lib/markdown.ts';
import { taskLanes } from '../ui/app/lib/timeline.ts';

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

test('model lane fills the gaps between overlapping tool calls', () => {
  const { model, tools } = taskLanes(
    {
      tools: [
        { startedAt: 10, endedAt: 40 },
        { startedAt: 30, endedAt: 60 },
      ],
    },
    0,
    100,
  );
  assert.deepEqual(model, [
    { left: 0, width: 10 },
    { left: 60, width: 40 },
  ]);
  assert.deepEqual(
    tools.map(({ left, width }) => ({ left, width })),
    [
      { left: 10, width: 30 },
      { left: 30, width: 30 },
    ],
  );
});
