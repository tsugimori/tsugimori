import type { AgentDefaults, AgentQuota } from '@tsugimori/plugin-sdk';
import type { ScheduleRecord, TraceSpan } from '@tsugimori/storage';

import { parseConfig } from '@tsugimori/config';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { statusCard } from '../src/status.ts';

type Dependencies = Parameters<typeof statusCard>[0];
type Work = ReturnType<Dependencies['tasks']['status']>;

const chat = { adapterId: 'telegram:main', chatId: 'room_9' };
const other = { ...chat, chatId: 'elsewhere' };
const target = { chatId: 'room', threadId: '9' };
const now = localTime(13, 33, 52);
const startedAt = localTime(13, 29, 12);
const compactedAt = localTime(13, 3, 45);

const fullSnapshots = {
  en: [
    '🟢 tsugimori c731004 · up 4m (started 13:29)',
    '',
    '💬 This chat',
    'Agent: Codex App Server',
    'Model: default · Effort: default · Fast: default',
    'Context: 24k / 250k (10%)',
    'Quota: weekly 86% left, resets 12/02 07:16',
    'Session: active for 31m',
    'Last compaction: 13:03 · post-turn · 48k → 12k · 3 total',
    'Summary: 60 messages, updated 13:03',
    'Work: running for 7s (running agent) · 1 queued',
    'Approvals: 1 here / 2 total, earliest expiry 13:40',
    'Schedules: 2 active, next 13:40 #abcdef *raw* 1234567890123456789012🙂…',
    '',
    '🖥 System',
    'Webhook: Unconfigured',
    'telegram:main, Codex App Server running',
    'Sandbox enabled · checks passing',
  ],
  'zh-TW': [
    '🟢 tsugimori c731004 · 已運作 4 分鐘（13:29 啟動）',
    '',
    '💬 此聊天室',
    'Agent：Codex App Server',
    '模型：預設 · 推理：預設 · 快速：預設',
    '上下文：24k / 250k（10%）',
    '額度：每週剩 86%，12/02 07:16 重置',
    '對話：已持續 31 分鐘',
    '上次壓縮：13:03 · 回合後 · 48k → 12k · 共 3 次',
    '摘要：60 則訊息，13:03 更新',
    '工作：執行中 7 秒（代理程式執行中） · 1 則排隊',
    '待核准：此聊天室 1 件／共 2 件，最早 13:40 到期',
    '排程：2 項啟用，下次 13:40 #abcdef *raw* 1234567890123456789012🙂…',
    '',
    '🖥 系統',
    'Webhook：未設定',
    'telegram:main、Codex App Server 運作中',
    '沙箱已啟用 · 環境檢查正常',
  ],
};

const labels = {
  en: [
    'tsugimori',
    'This chat',
    'Agent',
    'Model',
    'Effort',
    'Fast',
    'Context',
    'Quota',
    'Session',
    'Last compaction',
    'Summary',
    'Work',
    'Approvals',
    'Schedules',
    'System',
    'Webhook',
  ],
  'zh-TW': [
    'tsugimori',
    '此聊天室',
    'Agent',
    '模型',
    '推理',
    '快速',
    '上下文',
    '額度',
    '對話',
    '上次壓縮',
    '摘要',
    '工作',
    '待核准',
    '排程',
    '系統',
    'Webhook',
  ],
};

const codex = {
  id: 'codex',
  implementation: 'Codex App Server',
  kind: 'codex',
  state: 'running',
} as const;

const weekly: AgentQuota = {
  primary: {
    usedPercent: 14,
    windowDurationMins: 10_080,
    resetsAt: Date.UTC(2026, 11, 1, 23, 16) / 1_000,
  },
};

for (const locale of ['en', 'zh-TW'] as const) {
  const zh = locale === 'zh-TW';

  test(`renders the healthy status card in ${locale}`, (t) => {
    const store = new SqliteStore(':memory:');
    t.after(() => store.close());
    const deps = dependencies(store, locale, { quota: weekly });
    const card = statusCard(deps, chat, target, now);
    const expected = fullSnapshots[locale];
    assert.deepEqual(card.text.split('\n'), [
      ...expected.slice(0, 8),
      ...expected.slice(-5),
    ]);
  });

  test(`renders the full status card with chat activity in ${locale}`, (t) => {
    t.mock.method(Date, 'now', () => compactedAt);
    const store = new SqliteStore(':memory:');
    t.after(() => store.close());
    prepareStore(store);
    const deps = dependencies(store, locale, {
      quota: weekly,
      running: { startedAt: now - 7_000, stage: 'agent' },
      queued: 1,
    });
    const context = deps.trace.latestSessionSpan;
    deps.trace = {
      latestSessionSpan: (scope, kind) =>
        kind === 'compaction'
          ? span('agent.compaction', compactedAt, {
              trigger: 'post-turn',
              tokensBefore: 48_000,
              tokensAfter: 12_000,
            })
          : context(scope, kind),
      sessionHistory: () => ({
        compactions: 3,
        createdAt: now - (30 * 60 + 54) * 1_000,
      }),
    };
    const card = statusCard(deps, chat, target, now);
    assert.deepEqual(card.text.split('\n'), fullSnapshots[locale]);
    assert.equal(card.parseTextMentions, false);
    assert.deepEqual(
      card.entities.map(({ type, offset, length }) => [
        type,
        card.text.slice(offset, offset + length),
      ]),
      labels[locale].map((label) => ['bold', label]),
    );

    const schedule = store.getSchedule('abcdef-next');
    assert.ok(schedule);
    assert.ok(
      store.updateSchedule(
        {
          ...schedule,
          timezone: 'UTC',
          trigger: {
            kind: 'cron',
            expr: '40 * * * *',
            firstDueAt: localTime(12, 40),
          },
        },
        schedule,
        10,
      ),
    );
    assert.deepEqual(
      statusCard(deps, chat, target, now).text.split('\n'),
      fullSnapshots[locale],
    );
  });

  test(`shows degraded components and aliased agent names in ${locale}`, (t) => {
    const store = new SqliteStore(':memory:');
    t.after(() => store.close());
    const deps = dependencies(store, locale, { agentId: 'claude' });
    const attachments: Dependencies['runtime']['attachments'] = {
      platforms: [
        { id: 'telegram:main', state: 'running' },
        {
          id: 'telegram:backup',
          state: 'retrying',
          attempt: 2,
          retryAt: localTime(13, 40),
        },
        { id: 'telegram:new', state: 'starting' },
      ],
      agents: [
        { ...codex },
        {
          id: 'claude',
          kind: 'claude-sdk',
          implementation: 'Claude Agent SDK',
          state: 'running',
        },
        { id: 'custom', kind: 'other', state: 'disabled' },
      ],
    };
    const runtime = { ...deps.runtime, attachments };
    const render = () =>
      statusCard({ ...deps, runtime }, chat, target, now).text;
    assert.match(render(), /^🟡 tsugimori/u);
    assert.ok(
      render().includes(
        zh
          ? 'Agent：claude · Claude Agent SDK'
          : 'Agent: claude · Claude Agent SDK',
      ),
    );
    assert.deepEqual(
      render().split('\n').slice(-7),
      zh
        ? [
            '🖥 系統',
            'Webhook：未設定',
            'telegram:main、Codex App Server、claude · Claude Agent SDK 運作中',
            'telegram:backup 重試中（第 2 次），下次 13:40',
            'telegram:new 啟動中',
            'custom · other 已停用',
            '沙箱已啟用 · 環境檢查正常',
          ]
        : [
            '🖥 System',
            'Webhook: Unconfigured',
            'telegram:main, Codex App Server, claude · Claude Agent SDK running',
            'telegram:backup retrying (attempt 2), next retry 13:40',
            'telegram:new starting',
            'custom · other disabled',
            'Sandbox enabled · checks passing',
          ],
    );

    attachments.platforms.splice(1);
    runtime.environmentReports = ['git', 'exec'].map((id) => ({
      detail: `${id} is unavailable.`,
      target: 'core',
      id,
      title: id,
      status: 'fail',
    }));
    assert.match(render(), /^🟡 tsugimori/u);
    assert.ok(
      render().endsWith(zh ? '環境檢查 2 項未通過' : '2 checks failing'),
    );
    attachments.agents[0] = { ...codex, state: 'unavailable' };
    assert.match(render(), /^🔴 tsugimori/u);
    assert.ok(
      render()
        .split('\n')
        .includes(
          zh ? 'Codex App Server 無法使用' : 'Codex App Server unavailable',
        ),
    );
  });

  test(`labels known and unknown chat settings in ${locale}`, (t) => {
    const store = new SqliteStore(':memory:');
    t.after(() => store.close());
    const settings = (
      defaults: AgentDefaults | undefined,
      thinking?: string,
      serviceTier?: string | null,
      model = 'default',
    ) =>
      statusCard(
        dependencies(store, locale, { defaults, model, thinking, serviceTier }),
        chat,
        target,
        now,
      ).text.split('\n')[4];
    assert.equal(
      settings({ model: 'gpt-6.2-sol', effort: 'high', serviceTier: 'fast' }),
      zh
        ? '模型：gpt-6.2-sol · 推理：high · 快速：開'
        : 'Model: gpt-6.2-sol · Effort: high · Fast: on',
    );
    assert.equal(
      settings({ serviceTier: 'fast' }, undefined, null),
      zh
        ? '模型：預設 · 推理：預設 · 快速：預設'
        : 'Model: default · Effort: default · Fast: default',
    );
    assert.equal(
      settings({ model: 'gpt-6.2-sol' }, 'low', 'default'),
      zh
        ? '模型：gpt-6.2-sol · 推理：low · 快速：關'
        : 'Model: gpt-6.2-sol · Effort: low · Fast: off',
    );
    assert.equal(
      settings(undefined, 'raw effort', 'flex-tier', 'raw model'),
      zh
        ? '模型：raw model · 推理：raw effort · 快速：flex-tier'
        : 'Model: raw model · Effort: raw effort · Fast: flex-tier',
    );
  });

  test(`formats compact token counts and quota windows in ${locale}`, (t) => {
    const store = new SqliteStore(':memory:');
    t.after(() => store.close());
    const deps = dependencies(store, locale, {
      quota: {
        primary: {
          usedPercent: 10,
          windowDurationMins: 300,
          resetsAt: localTime(14, 15) / 1_000,
        },
        secondary: { usedPercent: 104, windowDurationMins: 1_440 },
        rateLimitReachedType: 'rate_limit_reached',
      },
    });
    const render = () => statusCard(deps, chat, target, now).text.split('\n');
    for (const [tokens, label] of [
      [999, '999'],
      [1_000, '1k'],
      [9_500, '9.5k'],
      [24_419, '24k'],
      [250_000, '250k'],
      [1_200_000, '1.2M'],
    ] as const) {
      deps.trace.latestSessionSpan = (_, kind) =>
        kind === 'context'
          ? span('agent.context', now, { contextTokens: tokens })
          : undefined;
      const percent = Math.round(tokens / 2_500);
      assert.equal(
        render()[5],
        zh
          ? `上下文：${label} / 250k（${percent}%）`
          : `Context: ${label} / 250k (${percent}%)`,
      );
    }
    assert.equal(
      render()[6],
      zh
        ? '額度：5 小時 剩 90%，14:15 重置 · 每日剩 0% · 已達上限'
        : 'Quota: 5h 90% left, resets 14:15 · daily 0% left · limit reached',
    );
    deps.trace.latestSessionSpan = () => undefined;
    assert.equal(render()[5], zh ? '上下文：未知' : 'Context: unknown');
  });

  test(`formats uptime, dates and build information in ${locale}`, (t) => {
    const store = new SqliteStore(':memory:');
    t.after(() => store.close());
    const deps = dependencies(store, locale);
    const header = () =>
      statusCard(deps, chat, target, now).text.split('\n')[0];
    assert.equal(header(), fullSnapshots[locale][0]);
    deps.build = { version: '1.2.3', revision: 'c731004' };
    deps.startedAt = now - (3 * 24 + 4) * 3_600_000 - 5 * 60_000;
    assert.equal(
      header(),
      zh
        ? '🟢 tsugimori v1.2.3 c731004 · 已運作 3 天 4 小時（11/23 09:28 啟動）'
        : '🟢 tsugimori v1.2.3 c731004 · up 3d 4h (started 11/23 09:28)',
    );
    deps.build = { version: '0.0.0' };
    deps.startedAt = now - (2 * 60 + 5) * 60_000 - 58_000;
    assert.equal(
      header(),
      zh
        ? '🟢 tsugimori · 已運作 2 小時 5 分鐘（11:27 啟動）'
        : '🟢 tsugimori · up 2h 5m (started 11:27)',
    );
    const midnight = localTime(0, 0);
    deps.startedAt = midnight - 1_000;
    assert.equal(
      statusCard(deps, chat, target, midnight).text.split('\n')[0],
      zh
        ? '🟢 tsugimori · 已運作 1 秒（11/25 23:59 啟動）'
        : '🟢 tsugimori · up 1s (started 11/25 23:59)',
    );
  });
}

test('omits the empty chat section when running with no plugins', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const deps = dependencies(store, 'en', { agentId: undefined });
  const runtime = {
    ...deps.runtime,
    attachments: { agents: [], platforms: [] },
  };
  assert.equal(
    statusCard({ ...deps, runtime, sandboxEnabled: false }, chat, target, now)
      .text,
    '🟢 tsugimori c731004 · up 4m (started 13:29)\n\n🖥 System\nWebhook: Unconfigured\nSandbox disabled · checks passing',
  );
});

test('fits within a Telegram message and keeps valid UTF-16 entity offsets', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const deps = dependencies(store, 'en', { model: '🙂'.repeat(3_000) });
  const { text, entities } = statusCard(deps, chat, target, now);
  assert.ok(text.length <= 4_096);
  assert.ok(text.endsWith('…'));
  assert.ok(text.isWellFormed());
  assert.ok(
    entities.every(({ offset, length }) => offset + length < text.length),
  );
});

function dependencies(
  store: SqliteStore,
  locale: 'en' | 'zh-TW',
  work: Partial<Work> = {},
): Dependencies {
  return {
    build: { version: '0.0.0', revision: 'c731004' },
    runtime: {
      config: parseConfig(JSON.stringify({ locale })),
      environmentReports: [],
      attachments: {
        platforms: [{ id: 'telegram:main', state: 'running' }],
        agents: [codex],
      },
    },
    startedAt,
    sandboxEnabled: true,
    store,
    tasks: {
      status: () => ({
        agentId: 'codex',
        model: 'default',
        thinking: undefined,
        defaults: undefined,
        compactAt: undefined,
        serviceTier: undefined,
        quota: undefined,
        sessionScope: 'test-session',
        running: undefined,
        queued: 0,
        ...work,
      }),
    },
    trace: {
      latestSessionSpan: (_, kind) =>
        kind === 'context'
          ? span('agent.context', now, { contextTokens: 24_419 })
          : undefined,
      sessionHistory: () => ({
        compactions: 0,
        createdAt: now - (30 * 60 + 54) * 1_000,
      }),
    },
  };
}

function span(
  name: string,
  endedAt: number,
  attrs: TraceSpan['attrs'],
): TraceSpan {
  return {
    name,
    attrs,
    durationMs: 300,
    startedAt: endedAt - 300,
    endedAt,
    status: 'ok',
  };
}

function localTime(hour: number, minute: number, second = 0) {
  return Date.UTC(2026, 10, 26, hour - 8, minute, second);
}

function prepareStore(store: SqliteStore) {
  for (let index = 0; index <= 60; index++) {
    const ref = index === 1 ? other : chat;
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
    if (index === 60) {
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
      [chat, localTime(13, 42)],
      [other, localTime(13, 40)],
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
    nextDueAt: localTime(13, 40),
    status: 'active',
    timezone: 'Asia/Taipei',
    trigger: { kind: 'once', at: localTime(13, 40) },
  };
  assert.ok(store.createSchedule(schedule, 10));
  assert.ok(
    store.createSchedule(
      { ...schedule, id: 'later', nextDueAt: localTime(13, 42) },
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
