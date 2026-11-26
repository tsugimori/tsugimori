import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderFixtures } from '../scripts/ssr.mjs';

test('Svelte server rendering covers the console components', async (t) => {
  await renderFixtures(async (fixtures) => {
    await t.test(
      'JSON objects and arrays expand as a tree and plain text stays raw',
      () => {
        const tree = fixtures.json(
          JSON.stringify({
            key: { inner: [true, 123, null] },
            longArray: Array.from({ length: 52 }, () => 'item'),
          }),
        );
        assert.match(tree, /樹狀/);
        assert.match(tree, /class="json-key">key:/);
        assert.match(tree, /class="json-scalar">true/);
        assert.match(tree, /還有 2 項/);
        assert.match(tree, /aria-pressed="true"/);
        const raw = fixtures.json(
          'first line …[omitted 123 chars]… last line',
          true,
        );
        assert.match(raw, /<pre class="code err">/);
        assert.match(raw, /class="omit"/);
        assert.match(raw, /omitted 123 chars|省略/);
        assert.doesNotMatch(raw, /樹狀/);
        assert.doesNotMatch(fixtures.json('null'), /樹狀/);
      },
    );

    await t.test(
      'stored tool results and timeline messages render as escaped text',
      () => {
        for (const html of [
          fixtures.json(fixtures.payload),
          fixtures.json(JSON.stringify({ key: fixtures.payload })),
          fixtures.timeline(),
        ]) {
          assert.doesNotMatch(html, /<(?:script|img)\b/i);
          assert.match(html, /&lt;script/);
          assert.match(html, /&lt;img/);
        }
      },
    );

    await t.test(
      'agent cards, chat details and Taipei time include the expected fields',
      () => {
        const agent = fixtures.agentCard().replace(/<!--.*?-->/g, '');
        for (const label of [
          'Claude Agent SDK',
          '執行中 1',
          '預設模型',
          'opus',
          '2 個聊天室',
          '失敗 1',
          '已登入',
          '#task-fixture-completed',
          '42.1 s',
        ])
          assert.ok(agent.includes(label), label);
        const details = fixtures
          .details()
          .replace(/<!--.*?-->/g, '')
          .replace(/\s+/g, ' ');
        for (const label of [
          '推理 高',
          '快速 開',
          '#1,240 / #1,284',
          '96%',
          '待核准 (1)',
          'exec.run',
          '每日 09:00 晨報',
          '白名單 是',
          '訊息 1,284',
        ])
          assert.ok(details.includes(label), label);
        const time = fixtures.time();
        assert.equal(time.yesterday, '昨天');
        assert.equal(time.relative, '3 分鐘前');
        assert.equal(time.absolute, '2026-11-26 14:00:22');
        assert.match(time.html, /title="2026-11-26 14:00:22 \(Asia\/Taipei\)"/);
        assert.match(time.html, /datetime="2026-11-26T06:00:22.000Z"/);
      },
    );
  });
});
