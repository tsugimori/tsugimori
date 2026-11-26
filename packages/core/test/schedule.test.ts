import type { ScheduleRecord } from '@tsugimori/storage';

import { Auth } from '@tsugimori/auth';
import { Scheduler } from '@tsugimori/scheduler';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import { Ajv } from 'ajv';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approvalPrompt } from '../src/approval-messages.ts';

const minute = 60_000;

test('approval reasons deduplicate program text and retain the generic fallback', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const chat = { adapterId: 'fake', chatId: 'room' };
  const prompt = (reasons: ('agent' | 'delivery')[], agentReason?: string) =>
    approvalPrompt({
      chat,
      locale: 'zh-TW',
      request: {
        action: 'schedule.create',
        resource: { type: 'chat', ...chat },
      },
      schedule: {
        address: chat,
        agentReason,
        content: '提醒',
        deliveryKey: 'delivery',
        dueAt: 60_000,
        id: 'schedule',
        kind: 'message',
        operation: 'create',
        reasons,
        recipients: [{ userId: '42', name: '小林' }],
        reuseGrant: false,
        target: chat,
        timezone: 'UTC',
      },
      store,
      useButtons: true,
    })
      .text.split('\n')
      .filter((line) => line.startsWith('原因：'));
  assert.deepEqual(prompt(['agent', 'delivery'], '會提及特定的人。'), [
    '原因：會提及特定的人',
  ]);
  assert.deepEqual(prompt(['agent'], '  '), ['原因：代理程式要求主人審核。']);
  assert.deepEqual(prompt(['agent'], '需要使用大量資源。'), [
    '原因：需要使用大量資源。',
  ]);
});

test('a recurring group approval identifies the delivery and lack of mentions in both locales', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const chat = { adapterId: 'fake', chatId: 'room' };
  const now = Date.UTC(2026, 10, 26, 11, 45);
  const dueAt = Date.UTC(2026, 10, 26, 12);
  const until = Date.UTC(2026, 10, 26, 23);
  for (const [locale, mentions, reason, interval, cron] of [
    [
      'zh-TW',
      '對象：不提及任何人',
      '原因：會定時在群組發訊息',
      '時間：今天 12:00 起，每小時',
      '時間：今天 12:00 起，每天 12:00–23:00 每小時整點，到今天 23:00 為止',
    ],
    [
      'en',
      'Mentions: none',
      'Reason: This will send recurring messages to the group.',
      'When: from today 12:00, hourly',
      'When: from today 12:00, hourly 12:00–23:00 daily, until today 23:00',
    ],
  ] as const) {
    for (const [repeat, expected] of [
      [{ minutes: 60 }, interval],
      [{ cron: '0 12-23 * * *' }, cron],
    ] as const) {
      const prompt = approvalPrompt({
        chat,
        locale,
        now,
        request: {
          action: 'schedule.create',
          resource: { type: 'chat', ...chat },
        },
        schedule: {
          address: chat,
          content: '提醒',
          deliveryKey: 'delivery',
          dueAt,
          id: 'schedule',
          kind: 'message',
          operation: 'create',
          reasons: ['delivery'],
          recipients: [],
          repeat,
          reuseGrant: false,
          target: chat,
          timezone: 'UTC',
          until: 'cron' in repeat ? until : undefined,
        },
        store,
        useButtons: false,
      });
      const lines = prompt.text.split('\n');
      assert.ok(lines.includes(mentions));
      assert.ok(lines.includes(reason));
      assert.ok(lines.includes(expected), prompt.text);
      assert.deepEqual(prompt.entities, [
        { type: 'pre', offset: prompt.text.length - 2, length: 2 },
      ]);
      assert.ok(prompt.text.endsWith('\n提醒'));
    }
  }
});

test('cron tools accept a delayed start and the scheduler delivers only eligible occurrences', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const chat = { adapterId: 'fake', chatId: 'owner' };
  const principal = { adapterId: chat.adapterId, userId: 'owner' };
  store.recordInbound(
    { ...chat, kind: 'dm', title: 'Owner' },
    { ...principal, display: 'Owner' },
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
  let now = Date.UTC(2026, 10, 26, 10);
  const noon = Date.UTC(2026, 10, 26, 12);
  const from = noon + 30 * minute;
  const firstDueAt = noon + 60 * minute;
  const until = noon + 120 * minute;
  const delivered: number[] = [];
  const scheduler = new Scheduler({
    attachedAdapters: () => ['fake'],
    approve: async () => assert.fail('Self-delivery needs no approval'),
    canSchedule: () => true,
    deliver: async (_schedule, run) => {
      delivered.push(run.dueAt);
      return 'sent';
    },
    logError: (event) => assert.fail(event),
    model: () => 'test',
    now: () => now,
    owner: () => principal.userId,
    settings: () => ({ timezone: 'UTC' }),
    store,
  });
  const task = { chat, principal, taskId: 'task', signal: t.signal };
  const tools = new Map(scheduler.tools().map((tool) => [tool.name, tool]));
  const create = tools.get('schedule.create')!;
  const update = tools.get('schedule.update')!;
  const list = tools.get('schedule.list')!;
  const input = {
    action: { kind: 'message', text: 'Reminder' },
    trigger: { kind: 'cron', expr: '0 * * * *', from, until },
  };
  const ajv = new Ajv();
  assert.ok(ajv.compile(create.schema)(input));
  await assert.rejects(
    create.run({ ...input, trigger: { ...input.trigger, until: from } }, task),
    /Cron from must be earlier than until/,
  );
  const result = await create.run(input, task);
  const [schedule] = store.listSchedules(chat);
  assert.ok(schedule);
  const id = schedule.id.slice(0, 6);
  assert.deepEqual(result, {
    ok: true,
    ref: id,
    status: 'scheduled',
    summary:
      'from today 13:00, hourly at :00, until today 14:00 in Owner, remind Owner: Reminder',
  });
  assert.ok(ajv.compile(update.schema)({ ...input, id }));
  await assert.rejects(
    update.run(
      { ...input, id, trigger: { ...input.trigger, from: until + 1 } },
      task,
    ),
    /Cron from must be earlier than until/,
  );
  assert.equal(schedule.nextDueAt, firstDueAt);
  assert.deepEqual(schedule.trigger, { ...input.trigger, firstDueAt });

  scheduler.start();
  t.after(() => scheduler.stop());
  for (const time of [noon, from, firstDueAt - 1]) {
    now = time;
    scheduler.tick();
    await scheduler.idle();
    assert.deepEqual(delivered, []);
  }
  now = firstDueAt;
  scheduler.tick();
  await scheduler.idle();
  assert.deepEqual(delivered, [firstDueAt]);
  assert.equal(store.getSchedule(schedule.id)?.nextDueAt, until);
  assert.deepEqual(await list.run({}, task), {
    ok: true,
    summary: `#${id} from today 13:00, hourly at :00, until today 14:00 · next due today 14:00 Owner Reminder`,
  });
  now = until;
  scheduler.tick();
  await scheduler.idle();
  assert.deepEqual(delivered, [firstDueAt, until]);
  assert.equal(store.getSchedule(schedule.id)?.status, 'done');
});

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

test('schedule summaries and short references use the current chat, locale, and permissions', async (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const chat = { adapterId: 'fake', chatId: 'room' };
  const principal = { adapterId: 'fake', userId: '10' };
  const now = Date.parse('2026-11-26T07:42:00+08:00');
  store.recordInbound(
    { ...chat, kind: 'group', title: 'Development' },
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
  let locale: 'en' | 'zh-TW' = 'zh-TW';
  const auth = new Auth({ store, now: () => now });
  store.createTask({
    ...chat,
    id: 'task',
    sourceMessageId: 'request',
    status: 'running',
    agentId: 'test',
    model: 'test',
    createdAt: now,
    startedAt: now,
    finishedAt: null,
  });
  let waitForDecision = false;
  const scheduler = new Scheduler({
    attachedAdapters: () => ['fake'],
    approve: async (task, request, change) => {
      if (!waitForDecision) return { approvedBy: '20' };
      auth.createApproval(
        chat,
        task.taskId,
        task.principal.userId,
        {
          action: 'schedule.create',
          resource: {
            type: 'schedule',
            id: request.id,
            deliveryKey: request.deliveryKey,
          },
        },
        { continuation: { kind: 'schedule', change } },
      );
      return { pending: true };
    },
    canSchedule: () => true,
    deliver: async () => 'sent',
    logError: (event) => assert.fail(event),
    model: () => 'test',
    now: () => now,
    owner: () => '10',
    settings: () => ({ locale, timezone: 'Asia/Taipei' }),
    store,
  });
  const tools = new Map(scheduler.tools().map((tool) => [tool.name, tool]));
  const task = { chat, principal, taskId: 'task', signal: t.signal };
  const run = (name: string, args: unknown, context = task) =>
    tools.get('schedule.' + name)!.run(args, context);
  const result = (await run('create', {
    action: { kind: 'message', text: '[月光](tg://user?id=20)，記得喝水' },
    trigger: { kind: 'once', at: now + 2 * minute },
  })) as { ok: boolean; ref: string; status: string; summary: string };
  const [schedule] = store.listSchedules(chat);
  assert.ok(schedule);
  assert.deepEqual(result, {
    ok: true,
    summary: '2 分鐘後（07:44）在 Development 提醒 月光：記得喝水',
    status: 'scheduled',
    ref: schedule.id.slice(0, 6),
  });
  assert.deepEqual(await run('list', {}), {
    ok: true,
    summary: `#${result.ref} 今天 07:44 月光 記得喝水`,
  });
  await assert.rejects(
    run(
      'pause',
      { id: result.ref },
      { ...task, principal: { ...principal, userId: '20' } },
    ),
    /unavailable/,
  );
  await assert.rejects(
    run(
      'pause',
      { id: result.ref },
      { ...task, chat: { ...chat, chatId: 'room_8' } },
    ),
    /unavailable/,
  );
  const other = {
    ...schedule,
    id: result.ref + 'ab-0000-4000-8000-000000000000',
  };
  assert.equal(store.createSchedule({ ...other, chatId: 'room_8' }, 20), true);
  assert.match(
    (
      (await run('pause', {
        id: '#' + result.ref.toUpperCase(),
      })) as typeof result
    ).summary,
    /^已暫停：/,
  );
  assert.equal(store.getSchedule(schedule.id)?.status, 'paused');
  assert.equal(store.getSchedule(other.id)?.status, 'active');
  locale = 'en';
  assert.deepEqual(await run('pause', { id: result.ref, paused: false }), {
    ...result,
    summary: 'In 2 min (07:44) in Development, remind 月光: 記得喝水',
  });
  assert.equal(
    store.createSchedule(
      { ...other, id: result.ref + 'cd-0000-4000-8000-000000000000' },
      20,
    ),
    true,
  );
  await assert.rejects(run('cancel', { id: result.ref }), /ambiguous/);
  assert.equal(store.getSchedule(schedule.id)?.status, 'active');
  assert.equal(
    ((await run('cancel', { id: schedule.id })) as typeof result).status,
    'cancelled',
  );
  assert.equal(store.getSchedule(schedule.id)?.status, 'cancelled');

  waitForDecision = true;
  const pending = (await run('create', {
    action: { kind: 'message', text: '[月光](tg://user?id=20)，休息一下' },
    trigger: { kind: 'once', at: now + 3 * minute },
  })) as typeof result;
  assert.equal(pending.status, 'pending_approval');
  const listed = (await run('list', {})) as { summary: string };
  assert.ok(
    listed.summary.includes(
      `#${pending.ref} Today 07:45 月光 休息一下 (Awaiting approval)`,
    ),
  );
  assert.equal(
    ((await run('cancel', { id: pending.ref })) as typeof result).status,
    'cancelled',
  );
  assert.equal(store.listApprovals()[0]?.status, 'cancelled');
  assert.ok(
    store.listSchedules(chat).every(({ id }) => !id.startsWith(pending.ref)),
  );
});
