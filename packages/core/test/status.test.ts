import type { AgentDefaults } from '@tsugimori/plugin-sdk';
import type { ScheduleRecord, TraceSpan } from '@tsugimori/storage';

import { parseConfig } from '@tsugimori/config';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { statusCard } from '../src/status.ts';
import { gatewayVersion } from '../src/version.ts';

const chat = { adapterId: 'telegram:main', chatId: 'room_9' };
const other = { ...chat, chatId: 'elsewhere' };
const target = { chatId: 'room', threadId: '9' };
const now = Date.UTC(2026, 10, 26, 2, 5, 6);

const snapshots = {
  en: [
    ['Gateway', `v${gatewayVersion}`, 'up 1m 5s'].filter(Boolean).join(' · '),
    'Started · 2026-11-26 10:04:01 (Asia/Taipei)',
    'This chat · Agent codex | Model test-model | Effort high',
    'Context · 12,000 / 24,000 tokens (50%)',
    'Last compaction · 2026-11-26 10:03:51 · post-turn · 48,000 → 12,000 tokens',
    'Summary · 2 messages · updated 2026-11-26 10:04:48',
    'Work · running for 7s (running agent) · 1 queued · 2 running total',
    'Approvals · 1 here / 2 total · next expiry 2026-11-26 10:06:21',
    'Schedules · 2 active · #abcdef · next due 2026-11-26 10:06:36 · *raw* 1234567890123456789012🙂…',
    'Platforms · telegram:main running | telegram:backup retrying (attempt 2) · next retry 2026-11-26 10:05:36 | telegram:old unavailable · Token rejected.',
    'Agents · codex running | claude disabled',
    'Exec sandbox · enabled',
    'Health · 1 failing check · Telegram token',
  ],
  'zh-TW': [
    ['閘道器', `v${gatewayVersion}`, '已運作 1 分鐘 5 秒']
      .filter(Boolean)
      .join(' · '),
    '啟動時間 · 2026-11-26 10:04:01 (Asia/Taipei)',
    '此聊天室 · Agent codex｜模型 test-model｜推理強度 high',
    '上下文 · 12,000 / 24,000 tokens (50%)',
    '上次壓縮 · 2026-11-26 10:03:51 · 回合後 · 48,000 → 12,000 tokens',
    '對話摘要 · 涵蓋 2 則訊息 · 更新時間 2026-11-26 10:04:48',
    '工作 · 已執行 7 秒（代理程式執行中） · 1 則排隊中 · 共 2 個任務執行中',
    '待核准 · 此聊天室 1 件／共 2 件 · 最早到期 2026-11-26 10:06:21',
    '排程 · 2 項啟用 · #abcdef · 下次執行 2026-11-26 10:06:36 · *raw* 1234567890123456789012🙂…',
    '平台 · telegram:main 運作中 | telegram:backup 重試中（第 2 次） · 下次重試 2026-11-26 10:05:36 | telegram:old 無法使用 · 權杖遭拒。',
    '代理程式 · codex 運作中 | claude 已停用',
    '執行沙箱 · 已啟用',
    '環境檢查 · 1 項未通過 · Telegram 權杖',
  ],
};

for (const locale of ['en', 'zh-TW'] as const) {
  test(`renders the full owner status card in ${locale}`, (t) => {
    t.mock.method(Date, 'now', () => now - 18_000);
    const store = new SqliteStore(':memory:');
    t.after(() => store.close());
    prepareStore(store);

    const failure = {
      target: 'platform/telegram:old',
      id: 'token',
      title: 'Telegram token',
      status: 'fail' as const,
      detail: 'Token rejected.',
      localized: { 'zh-TW': { title: 'Telegram 權杖', hint: '權杖遭拒。' } },
    };
    const compacted: TraceSpan = {
      name: 'agent.compaction',
      attrs: {
        contextTokens: 12_000,
        trigger: 'post-turn',
        tokensBefore: 48_000,
        tokensAfter: 12_000,
      },
      durationMs: 300,
      startedAt: now - 75_300,
      endedAt: now - 75_000,
      status: 'ok',
    };
    const deps: Parameters<typeof statusCard>[0] = {
      runtime: {
        config: parseConfig(JSON.stringify({ locale })),
        environmentReports: [failure],
        attachments: {
          platforms: [
            { id: 'telegram:main', state: 'running' },
            {
              id: 'telegram:backup',
              state: 'retrying',
              attempt: 2,
              retryAt: now + 30_000,
            },
            { id: 'telegram:old', state: 'unavailable', failure },
          ],
          agents: [
            { id: 'codex', state: 'running' },
            { id: 'claude', state: 'disabled' },
          ],
        },
      },
      startedAt: now - 65_000,
      sandboxEnabled: true,
      store,
      tasks: {
        status: () => ({
          agentId: 'codex',
          model: 'test-model',
          thinking: 'high',
          defaults: { model: 'gpt-6.2-sol', effort: 'medium' },
          compactAt: 24_000,
          sessionScope: 'test-session',
          running: { startedAt: now - 7_000, stage: 'agent' },
          queued: 1,
          totalRunning: 2,
        }),
      },
      trace: { latestSessionSpan: () => compacted },
    };
    const card = statusCard(deps, chat, target, now);
    assert.deepEqual(card.text.split('\n'), snapshots[locale]);
    assert.equal(card.parseTextMentions, false);
    assert.deepEqual(
      card.entities.map(({ type, offset, length }) => [
        type,
        card.text.slice(offset, offset + length),
      ]),
      snapshots[locale].map((line) => ['bold', line.split(' · ')[0]]),
    );

    const schedule = store.getSchedule('abcdef-next');
    assert.ok(schedule);
    const firstDueAt = Date.UTC(2026, 10, 26, 1, 6);
    assert.ok(
      store.updateSchedule(
        {
          ...schedule,
          nextDueAt: Date.UTC(2026, 10, 26, 2, 6),
          timezone: 'UTC',
          trigger: { kind: 'cron', expr: '6 * * * *', firstDueAt },
        },
        schedule,
        10,
      ),
    );
    const recurring = statusCard(deps, chat, target, now).text;
    assert.ok(
      recurring.includes(
        locale === 'zh-TW'
          ? '#abcdef · 今天 01:06 起，每小時第 06 分鐘 · 下次執行 今天 02:06'
          : '#abcdef · from today 01:06, hourly at :06 · next due today 02:06',
      ),
      recurring,
    );
  });

  test(`labels known and unknown chat defaults in ${locale}`, (t) => {
    const store = new SqliteStore(':memory:');
    t.after(() => store.close());
    const zh = locale === 'zh-TW';
    const chatLine = (defaults: AgentDefaults | undefined, thinking?: string) =>
      statusCard(
        {
          runtime: {
            config: parseConfig(JSON.stringify({ locale })),
            environmentReports: [],
            attachments: { agents: [], platforms: [] },
          },
          startedAt: now,
          sandboxEnabled: false,
          store,
          tasks: {
            status: () => ({
              agentId: 'codex',
              model: 'default',
              thinking,
              defaults,
              compactAt: undefined,
              sessionScope: undefined,
              running: undefined,
              queued: 0,
              totalRunning: 0,
            }),
          },
          trace: { latestSessionSpan: () => undefined },
        },
        chat,
        target,
        now,
      ).text.split('\n')[2];
    assert.equal(
      chatLine({ model: 'gpt-6.2-sol', effort: 'high' }),
      zh
        ? '此聊天室 · Agent codex｜模型 gpt-6.2-sol（預設）｜推理強度 high（預設）'
        : 'This chat · Agent codex | Model gpt-6.2-sol (default) | Effort high (default)',
    );
    assert.equal(
      chatLine(undefined),
      zh
        ? '此聊天室 · Agent codex｜模型 預設｜推理強度 預設'
        : 'This chat · Agent codex | Model default | Effort default',
    );
    assert.equal(
      chatLine({ model: 'gpt-6.2-sol' }, 'low'),
      zh
        ? '此聊天室 · Agent codex｜模型 gpt-6.2-sol（預設）｜推理強度 low'
        : 'This chat · Agent codex | Model gpt-6.2-sol (default) | Effort low',
    );
  });

  test(`omits empty status sections in ${locale}`, (t) => {
    const store = new SqliteStore(':memory:');
    t.after(() => store.close());
    const card = statusCard(
      {
        runtime: {
          config: parseConfig(JSON.stringify({ locale, timezone: 'UTC' })),
          environmentReports: [],
          attachments: { agents: [], platforms: [] },
        },
        startedAt: now,
        sandboxEnabled: false,
        store,
        tasks: {
          status: () => ({
            agentId: undefined,
            model: undefined,
            thinking: undefined,
            defaults: undefined,
            compactAt: undefined,
            sessionScope: undefined,
            running: undefined,
            queued: 0,
            totalRunning: 0,
          }),
        },
        trace: {
          latestSessionSpan: () => assert.fail('No session to look up'),
        },
      },
      chat,
      target,
      now,
    );
    const zh = locale === 'zh-TW';
    assert.deepEqual(card.text.split('\n'), [
      [
        zh ? '閘道器' : 'Gateway',
        `v${gatewayVersion}`,
        zh ? '已運作 0 秒' : 'up 0s',
      ]
        .filter(Boolean)
        .join(' · '),
      zh
        ? '啟動時間 · 2026-11-26 02:05:06 (UTC)'
        : 'Started · 2026-11-26 02:05:06 (UTC)',
      zh ? '執行沙箱 · 已停用' : 'Exec sandbox · disabled',
      zh ? '環境檢查 · 全部正常' : 'Health · all checks passed',
    ]);
  });
}

function prepareStore(store: SqliteStore) {
  for (const [index, ref] of [chat, other, chat, chat].entries()) {
    const result = store.recordInbound(
      { ...ref, kind: 'group', title: null },
      { adapterId: ref.adapterId, userId: 'owner', display: null },
      {
        ...ref,
        direction: 'inbound',
        messageId: String(index),
        raw: null,
        replyTo: null,
        text: 'message',
        threadId: null,
        userId: 'owner',
      },
    );
    if (index === 2) {
      assert.ok(result);
      store.saveSummary({
        ...store.beginSummary(chat),
        text: 'Summary',
        throughSeq: result.seq,
      });
    }
  }
  const taskId = 'test-task';
  store.createTask({
    ...chat,
    id: taskId,
    sourceMessageId: '0',
    agentId: 'codex',
    model: 'test-model',
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    status: 'running',
  });
  for (const [index, [ref, expiresAt]] of (
    [
      [chat, now + 120_000],
      [other, now + 75_000],
      [chat, now - 1],
    ] as const
  ).entries()) {
    store.createApproval({
      ...ref,
      id: String(index),
      taskId,
      action: 'test.use',
      resource: { type: 'global' },
      requester: 'owner',
      approverId: 'owner',
      continuation: null,
      promptMessageId: null,
      promptFormat: null,
      decidedBy: null,
      decidedAt: null,
      status: 'pending',
      expiresAt,
    });
  }
  const schedule: ScheduleRecord = {
    ...other,
    id: 'abcdef-next',
    action: { kind: 'message', text: '*raw* 1234567890123456789012🙂\nmore' },
    address: { chatId: other.chatId },
    target,
    createdBy: 'owner',
    deliveryApprovedBy: null,
    mentions: [],
    missed: 'latest',
    nextDueAt: now + 90_000,
    status: 'active',
    timezone: 'Asia/Taipei',
    trigger: { kind: 'once', at: now + 90_000 },
  };
  assert.ok(store.createSchedule(schedule, 10));
  assert.ok(
    store.createSchedule(
      { ...schedule, id: 'later', nextDueAt: now + 120_000 },
      10,
    ),
  );
  assert.ok(
    store.createSchedule(
      { ...schedule, id: 'paused', nextDueAt: now + 10_000, status: 'paused' },
      10,
    ),
  );
  assert.ok(
    store.createSchedule(
      {
        ...schedule,
        id: 'main-thread',
        nextDueAt: now + 1,
        target: { chatId: 'room' },
      },
      10,
    ),
  );
}
