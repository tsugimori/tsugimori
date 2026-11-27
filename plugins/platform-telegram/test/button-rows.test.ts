import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buttonRows } from '../src/button-rows.ts';

test('Telegram sizes rows by the longest label in each row', () => {
  const labels = (length: number, count: number) =>
    Array.from({ length: count }, () => ({ label: '界'.repeat(length) }));
  for (const [length, capacity] of [
    [8, 4],
    [9, 3],
    [14, 3],
    [15, 2],
    [22, 2],
    [23, 1],
  ] as const) {
    const buttons = labels(length, capacity + 1);
    assert.deepEqual(buttonRows(buttons), [
      buttons.slice(0, capacity),
      buttons.slice(capacity),
    ]);
  }

  const buttons = [
    ...labels(8, 3),
    ...labels(15, 1),
    ...labels(8, 1),
    ...labels(23, 1),
  ];
  assert.deepEqual(buttonRows(buttons), [
    buttons.slice(0, 3),
    buttons.slice(3, 5),
    buttons.slice(5),
  ]);
  assert.deepEqual(buttonRows([]), []);
  assert.deepEqual(buttonRows(buttons, true), [
    buttons.slice(0, 4),
    buttons.slice(4),
  ]);
});
