import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Cron } from '../src/cron.ts';

test('cron finds both folded times and skips nonexistent local times', () => {
  const zone = 'America/New_York';
  const fold = new Cron('30 1 * * *', zone);
  const first = Date.parse('2026-11-01T05:30:00Z');
  const second = Date.parse('2026-11-01T06:30:00Z');
  assert.equal(fold.next(first - 1), first);
  assert.equal(fold.next(first), second);
  assert.equal(fold.latest(second), second);
  const gap = new Cron('30 2 * * *', zone);
  assert.equal(
    gap.next(Date.parse('2026-03-08T00:00:00Z')),
    Date.parse('2026-03-09T06:30:00Z'),
  );
  assert.equal(new Cron('*/5 * * * *', zone).tooFrequent(first, 15), true);
  assert.throws(() => new Cron('0 1 2 3', zone), /five fields/);
  assert.throws(() => new Cron('*/0 * * * *', zone), /range/);
});
