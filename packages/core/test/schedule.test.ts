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

test('one-time group delivery checks native IDs, user links, and usernames independently', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const chat = { adapterId: 'fake', chatId: 'room' };
  const principal = { adapterId: 'fake', userId: '10' };
  store.recordInbound(
    { ...chat, kind: 'group', title: 'Room' },
    { ...principal, display: 'Sender' },
    {
      ...chat,
      direction: 'inbound',
      messageId: 'request',
      raw: null,
      replyTo: null,
      text: 'Schedule this',
      threadId: null,
      userId: principal.userId,
    },
  );
  const reasons: (readonly string[])[] = [];
  const scheduler = new Scheduler({
    attachedAdapters: () => ['fake'],
    approve: async (_task, request) => {
      reasons.push(request.reasons);
      return undefined;
    },
    canSchedule: () => true,
    deliver: async () => 'sent',
    logError: (event) => assert.fail(event),
    model: () => 'test',
    now: () => 0,
    owner: () => '10',
    settings: () => ({ timezone: 'UTC' }),
    store,
  });
  const create = scheduler
    .tools()
    .find(({ name }) => name === 'schedule.create');
  assert.ok(create);
  const task = { chat, principal, taskId: 'task', signal: t.signal };
  for (const { text, mentions } of [
    { text: 'Reminder', mentions: ['20'] },
    { text: '[Reader](tg://user?id=20), reminder' },
    { text: '@some_user, reminder' },
  ]) {
    await assert.rejects(
      create.run(
        {
          action: { kind: 'message', text },
          mentions,
          trigger: { kind: 'once', at: 60_000 },
        },
        task,
      ),
      /Schedule approval denied/,
    );
  }
  assert.deepEqual(reasons, [['delivery'], ['delivery'], ['delivery']]);
  assert.equal(store.listSchedules(chat).length, 0);
  await create.run(
    {
      action: { kind: 'message', text: 'Group reminder' },
      trigger: { kind: 'once', at: 60_000 },
    },
    task,
  );
  assert.equal(store.listSchedules(chat).length, 1);
});
