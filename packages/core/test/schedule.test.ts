import type { ScheduleRecord } from '@tsugimori/storage';

import { Scheduler } from '@tsugimori/scheduler';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const minute = 60_000;

test('a restarted scheduler claims only the latest missed fire and preserves its next due time', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const at = 10 * minute;
  let now = at + 3 * minute + 100;
  const schedule: ScheduleRecord = {
    adapterId: 'fake',
    chatId: 'room',
    address: { chatId: 'room' },
    target: { chatId: 'room' },
    action: { kind: 'message', text: 'Reminder' },
    trigger: { kind: 'interval', minutes: 1, at },
    timezone: 'UTC',
    createdBy: 'owner',
    deliveryApprovedBy: 'owner',
    id: 'id',
    mentions: [],
    status: 'active',
    missed: 'latest',
    nextDueAt: at,
  };
  assert.equal(store.createSchedule(schedule, 5), true);
  const delivered: { delayed: boolean; dueAt: number }[] = [];
  function scheduler() {
    const service = new Scheduler({
      attachedAdapters: () => ['fake'],
      approve: async () => undefined,
      canSchedule: () => true,
      deliver: async (_schedule, run, delayed) => {
        delivered.push({ dueAt: run.dueAt, delayed });
        return 'sent';
      },
      logError: (event) => assert.fail(event),
      model: () => 'test',
      now: () => now,
      owner: () => 'owner',
      settings: () => ({ timezone: 'UTC' }),
      store,
    });
    service.start();
    t.after(() => service.stop());
    return service;
  }

  const first = scheduler();
  await first.idle();
  first.stop();
  assert.deepEqual(delivered, [{ dueAt: at + 3 * minute, delayed: true }]);
  const second = scheduler();
  await second.idle();
  assert.equal(delivered.length, 1);
  assert.equal(store.getSchedule(schedule.id)?.nextDueAt, at + 4 * minute);
  now = at + 4 * minute + 100;
  second.tick();
  await second.idle();
  assert.deepEqual(delivered.at(-1), {
    dueAt: at + 4 * minute,
    delayed: false,
  });
});
