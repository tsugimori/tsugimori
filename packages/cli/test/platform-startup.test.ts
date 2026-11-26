import type { Logger } from '@tsugimori/core';
import type { TelegramAdapter } from '@tsugimori/platform-telegram';

import { Gateway, PluginRegistry } from '@tsugimori/core';
import telegram from '@tsugimori/platform-telegram';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';

import { main } from '../src/index.ts';

type AdapterContext = Parameters<TelegramAdapter['start']>[0];
type ScheduleRecord = Parameters<SqliteStore['createSchedule']>[0];

const adapterId = 'telegram:test';
const fallbackId = 'fake:owner';
const owner = '79';
const chat = { adapterId, chatId: owner };
const tokenEnv = 'TSUGIMORI_TEST_STARTUP_TOKEN';

const ok = (result: unknown) => Response.json({ ok: true, result });
const identity = () => ok({ id: 42, username: 'test_bot' });
const failure = (status: number, retryAfter?: number) =>
  Response.json(
    { ok: false, error_code: status, parameters: { retry_after: retryAfter } },
    { status },
  );

function waitForAbort(signal: AbortSignal) {
  return new Promise<Response>((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}

async function fixture(
  t: TestContext,
  getMe: (attempt: number, signal: AbortSignal) => Response | Promise<Response>,
  locale: 'en' | 'zh-TW' = 'en',
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  t.mock.method(Math, 'random', () => 0.5);
  process.env[tokenEnv] = '1:fake';
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-platform-start-'));
  const store = new SqliteStore(':memory:');
  const attempts: Parameters<Logger>[0][] = [];
  const sent: string[] = [];
  const notices: string[] = [];
  const spans: Parameters<SqliteStore['writeTraceSpans']>[0][number][] = [];
  const writeSpans = store.writeTraceSpans.bind(store);
  store.writeTraceSpans = (batch) => {
    spans.push(...batch);
    writeSpans(batch);
  };
  let requests = 0;
  let context: AdapterContext;
  let statusRequests = 0;
  const fallback = {
    id: fallbackId,
    kind: 'fake',
    capabilities: {},
    async start(ctx: AdapterContext) {
      context = ctx;
    },
    async stop() {},
    async send(message: Parameters<TelegramAdapter['send']>[0]) {
      assert.equal(message.chatId, owner);
      notices.push(message.text);
      return { messageId: `fallback-${notices.length}` };
    },
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    switch (new URL(String(input)).pathname.split('/').at(-1)) {
      case 'getMe':
        assert.ok(init?.signal);
        return getMe(++requests, init.signal);
      case 'getUpdates':
        assert.ok(init?.signal);
        return waitForAbort(init.signal);
      case 'sendMessage':
        sent.push(JSON.parse(String(init?.body)).text);
        return ok({ message_id: sent.length });
      case 'setMyCommands':
      case 'deleteMyCommands':
        return ok(true);
      default:
        assert.fail('Unexpected Telegram request');
    }
  };
  const deps = {
    fetch,
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  };
  const registry = new PluginRegistry([
    telegram,
    { name: 'test-fallback', adapters: { fake: () => fallback } },
  ]);
  const gateway = new Gateway({
    log: (entry) => {
      if (entry.event === 'platform.start_failed') attempts.push(entry);
    },
    registry,
    setup: deps,
    store,
    workspace,
  });
  const configure = (enabled: boolean) =>
    writeFile(
      join(workspace, 'tsugimori.json'),
      JSON.stringify({
        locale,
        owner: { [adapterId]: owner, [fallbackId]: owner },
        platforms: [
          { id: adapterId, kind: 'telegram', tokenEnv, enabled },
          { id: fallbackId, kind: 'fake' },
        ],
      }),
    );
  t.after(async () => {
    try {
      await gateway.stop();
    } finally {
      delete process.env[tokenEnv];
      store.close();
      await rm(workspace, { force: true, recursive: true });
    }
  });
  await configure(true);
  return {
    advance: async (ms: number) => {
      t.mock.timers.tick(ms);
      await turn();
      await gateway.idle();
    },
    attempts,
    configure,
    deps,
    gateway,
    notices,
    registry,
    get requests() {
      return requests;
    },
    sent,
    spans,
    status: async () => {
      await context.emit({
        type: 'message',
        chatId: owner,
        chatKind: 'dm',
        userId: owner,
        messageId: `status-${++statusRequests}`,
        text: '/status',
      });
      return notices.at(-1);
    },
    store,
    workspace,
  };
}

function schedule(
  store: SqliteStore,
  at: number,
  missed: ScheduleRecord['missed'],
) {
  const { chatId } = chat;
  const row: ScheduleRecord = {
    ...chat,
    id: `reminder-${missed}`,
    action: { kind: 'message', text: `Reminder ${missed}` },
    address: { chatId },
    target: { chatId },
    createdBy: owner,
    deliveryApprovedBy: owner,
    mentions: [],
    missed,
    nextDueAt: at,
    status: 'active',
    timezone: 'UTC',
    trigger: { kind: 'once', at },
  };
  assert.ok(store.createSchedule(row, 20));
  return row.id;
}

test('two Telegram startup 502s leave schedules due until the adapter recovers', async (t) => {
  const f = await fixture(t, (attempt) =>
    attempt <= 2 ? failure(502) : identity(),
  );
  f.store.recordInbound(
    { ...chat, kind: 'dm', title: null },
    { adapterId, userId: owner, display: null },
    {
      ...chat,
      direction: 'inbound',
      messageId: 'prior',
      raw: null,
      replyTo: null,
      text: 'Earlier message',
      threadId: null,
      userId: owner,
    },
  );
  const at = Date.now() + 100;
  const latest = schedule(f.store, at, 'latest');
  const skip = schedule(f.store, at, 'skip');
  await f.gateway.start();

  assert.equal(f.requests, 1);
  assert.match(
    (await f.status())!,
    /telegram:test retrying \(attempt 1\) · next retry /,
  );
  const doctorOutput = t.mock.method(console, 'log', () => {});
  assert.equal(
    await main(['doctor', f.workspace], f.registry, {
      ...f.deps,
      fetch: async () => failure(502),
    }),
    1,
  );
  assert.match(
    String(doctorOutput.mock.calls[0]?.arguments[0]),
    /Telegram is unavailable/,
  );

  await f.advance(875);
  assert.equal(f.requests, 2);
  assert.deepEqual(
    f.attempts.map(({ attempt, nextDelayMs }) => [attempt, nextDelayMs]),
    [
      [1, 875],
      [2, 1750],
    ],
  );
  assert.deepEqual(f.sent, []);
  assert.equal(f.store.getSchedule(latest)?.nextDueAt, at);
  assert.equal(f.store.getSchedule(skip)?.nextDueAt, at);
  await f.advance(1750);
  assert.equal(f.requests, 3);
  assert.deepEqual(f.sent, [
    `[Delayed schedule, originally due ${new Date(at).toISOString()}]\n\nReminder latest`,
  ]);
  assert.equal(f.store.getSchedule(latest)?.status, 'done');
  assert.equal(f.store.getSchedule(skip)?.status, 'done');
  assert.match(
    (await f.status())!,
    /Platforms · telegram:test running \| fake:owner running/,
  );
  await f.gateway.stop();
  assert.deepEqual(
    f.spans
      .filter(
        ({ name, attrs }) =>
          name === 'platform.start' && attrs.adapterId === adapterId,
      )
      .map(({ status }) => status),
    ['error', 'error', 'ok'],
  );
});

test('Telegram 401 stops startup retries and sends a localized owner notice once', async (t) => {
  const f = await fixture(t, () => failure(401), 'zh-TW');
  await f.gateway.start();
  await f.gateway.idle();
  assert.equal(f.requests, 1);
  assert.deepEqual(f.notices, [
    '環境檢查有問題：\nplatform/telegram:test · Telegram 機器人權杖：請檢查機器人權杖以及與 Telegram 的連線。',
  ]);
  assert.deepEqual(
    f.attempts.map(({ attempt, nextDelayMs }) => [attempt, nextDelayMs]),
    [[1, null]],
  );
  await f.advance(10 * 60_000);
  assert.equal(f.requests, 1);
  assert.equal(f.notices.length, 1);
  assert.match(
    (await f.status())!,
    /telegram:test 無法使用 · 請檢查機器人權杖/,
  );
});

test('Telegram retry-after delays the next attempt and the owner gets one outage and recovery notice', async (t) => {
  const f = await fixture(
    t,
    (attempt) => (attempt === 1 ? failure(429, 360) : identity()),
    'zh-TW',
  );
  await f.gateway.start();
  assert.equal(f.attempts[0]?.nextDelayMs, 360_000);
  await f.advance(300_000 - 1);
  assert.equal(f.notices.length, 0);
  await f.advance(1);
  assert.deepEqual(f.notices, [
    'telegram:test 已有五分鐘無法啟動，閘道器將繼續重試。',
  ]);
  await f.advance(59_999);
  assert.equal(f.requests, 1);
  assert.equal(f.notices.length, 1);
  await f.advance(1);
  assert.equal(f.requests, 2);
  assert.deepEqual(f.sent, ['telegram:test 已恢復運作。']);
  await f.advance(360_000);
  assert.equal(f.sent.length, 1);
  assert.equal(f.notices.length, 1);
});

test(
  'detaching an adapter aborts an in-flight startup retry and leaves it detached',
  { timeout: 4_000 },
  async (t) => {
    let aborted = false;
    const f = await fixture(t, (attempt, signal) => {
      if (attempt === 1) return failure(502);
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true },
      );
      return waitForAbort(signal);
    });
    await f.gateway.start();
    await f.advance(875);
    assert.equal(f.requests, 2);
    await f.configure(false);
    while (!aborted && !t.signal.aborted) await f.advance(75);
    assert.ok(aborted);
    await f.advance(600_000);
    assert.equal(f.requests, 2);
    assert.match(
      (await f.status())!,
      /^Platforms · telegram:test disabled \| fake:owner running$/m,
    );
  },
);
