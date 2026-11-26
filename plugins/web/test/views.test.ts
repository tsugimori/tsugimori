import type {
  AdminApprovals,
  AdminChat,
  AdminConversation,
  AdminOverview,
  AdminSchedules,
  AdminTask,
  AdminTrace,
} from '@tsugimori/plugin-sdk';

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ViewContext } from '../src/format.ts';
import type { Section } from '../src/layout.ts';

import { duration, formatTime, relative } from '../src/format.ts';
import { page } from '../src/layout.ts';
import { approvalsView } from '../src/views/approvals.ts';
import { chatView } from '../src/views/chat.ts';
import { overviewView } from '../src/views/overview.ts';
import { schedulesView } from '../src/views/schedules.ts';
import { traceView } from '../src/views/trace.ts';

const now = Date.parse('2026-11-26T06:04:22Z');
const ctx: ViewContext = {
  locale: 'zh-TW',
  timezone: 'Asia/Taipei',
  name: '月太的工作區',
  now,
  pending: 1,
  schedules: true,
};
const chat: AdminChat = {
  adapterId: 'telegram-default',
  chatId: '-1000000000042_66',
  platform: 'telegram',
  kind: 'supergroup',
  title: 'Suntai 群組',
  allowlisted: true,
  threadId: '66',
  lastActivity: now - 180_000,
  activeTask: '7f3a0001-sample',
  lastTaskStatus: 'running',
  messageCount: 1284,
  pendingApprovals: 1,
  latestSeq: 1284,
  route: {
    agentId: 'claude-sdk',
    model: 'opus',
    thinking: 'high',
    serviceTier: 'priority',
    isDefault: false,
  },
  summary: { throughSeq: 1240, updatedAt: now - 7_200_000 },
};
const secondChat: AdminChat = {
  ...chat,
  adapterId: 'line',
  platform: 'line',
  chatId: 'U1234567890sample1234567890cdef',
  kind: 'dm',
  title: '月太',
  threadId: null,
  lastActivity: now - 86_400_000,
  activeTask: null,
  lastTaskStatus: 'failed',
  messageCount: 52,
  pendingApprovals: 0,
  latestSeq: 52,
  route: { agentId: 'codex', isDefault: true },
  summary: null,
};
const startedAt = now - 197_000;
const task: AdminTask = {
  id: chat.activeTask!,
  adapterId: chat.adapterId,
  chatId: chat.chatId,
  agentId: 'claude-sdk',
  model: 'opus',
  createdAt: startedAt,
  startedAt,
  finishedAt: null,
  status: 'running',
  sourceSeq: 1283,
  inputTokens: 12034,
  outputTokens: 820,
  tools: [
    {
      seq: 8,
      name: 'history.search',
      status: 'ok',
      startedAt: startedAt + 1000,
      endedAt: startedAt + 1080,
      callId: 'tool-1',
      args: '{"query":"log"}',
      result: '{"matches":3}',
    },
    {
      seq: 9,
      name: 'sample.read',
      status: 'error',
      startedAt: startedAt + 5000,
      endedAt: startedAt + 8000,
      callId: 'tool-2',
      args: '{"text":"<script>alert(1)</script>"}',
      result: '<script>…[omitted 1,234 chars]…</script>',
    },
    {
      seq: 10,
      name: 'sample.check',
      status: 'pending-approval',
      startedAt: startedAt + 9000,
      endedAt: null,
      callId: 'tool-3',
      args: null,
      result: null,
    },
  ],
};
const overview: AdminOverview = {
  chats: [chat, secondChat],
  totals: { chats: 2, failedToday: 2, pendingApprovals: 1, tasksToday: 48 },
};
const conversation: AdminConversation = {
  chat,
  older: 1282,
  tasks: [task],
  messages: [
    {
      seq: 1284,
      direction: 'outbound',
      recordedAt: startedAt + 43_000,
      deleted: false,
      userId: null,
      displayName: null,
      text: '看到了，錯誤在第三行。',
    },
    {
      seq: 1283,
      direction: 'inbound',
      recordedAt: startedAt,
      deleted: false,
      userId: '42',
      displayName: '月太',
      text:
        '幫我看一下 log\n' +
        Array.from({ length: 22 }, (_, i) => `日誌第 ${i + 1} 行`).join('\n'),
    },
    {
      seq: 1282,
      direction: 'inbound',
      recordedAt: startedAt - 86_400_000,
      deleted: false,
      userId: '42',
      displayName: '月太',
      text: '',
    },
  ],
};
const trace: AdminTrace = {
  chat,
  task: { ...task, finishedAt: startedAt + 42100, status: 'completed' },
  spans: [
    {
      id: 1,
      name: 'task.run',
      startedAt,
      durationMs: 42100,
      status: 'ok',
      attrs: {},
    },
    {
      id: 2,
      name: 'agent.run',
      parentId: 1,
      startedAt: startedAt + 250,
      durationMs: 40900,
      status: 'ok',
      attrs: { agentId: 'claude-sdk' },
    },
    {
      id: 3,
      name: 'tool.run',
      parentId: 2,
      startedAt: startedAt + 1000,
      durationMs: 80,
      status: 'ok',
      attrs: { name: 'history.search', toolCallSeq: 8 },
    },
    {
      id: 4,
      name: 'agent.tool',
      parentId: 2,
      startedAt: startedAt + 5000,
      durationMs: 3000,
      status: 'error',
      attrs: { name: 'sample.read', toolCallSeq: 9, detail: '<script>' },
    },
  ],
};
const request = {
  adapterId: chat.adapterId,
  chatId: chat.chatId,
  chat,
  action: 'test.review',
  requestedAt: startedAt + 9000,
  requesterDisplay: '月太',
  requester: '42',
  resource: { type: 'global' as const },
  args: '{"text":"<script>alert(1)</script>"}',
};
const approvals: AdminApprovals = {
  approvals: [
    {
      ...request,
      id: 'denied',
      status: 'denied',
      decidedBy: 'owner',
      decidedAt: startedAt - 240_000,
    },
    {
      ...request,
      id: 'pending',
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
    },
  ],
  grants: [],
};
const schedules: AdminSchedules = {
  schedules: [
    {
      id: 'reminder',
      adapterId: chat.adapterId,
      chatId: chat.chatId,
      chat,
      title: '下午提醒',
      nextDueAt: now + 3600000,
      status: 'active',
    },
  ],
};

test('zh-TW admin view snapshots and HTML previews', async (t) => {
  const directory = '/tmp/tsugimori-console-preview';
  await mkdir(directory, { recursive: true });
  const pages: [string, string, Section, string][] = [
    ['overview', '總覽', 'overview', overviewView(overview, ctx)],
    ['chat', '聊天室 · Suntai 群組', 'chats', chatView(conversation, ctx)],
    ['trace', '任務追蹤', 'chats', traceView(trace, ctx)],
    ['approvals', '核准', 'approvals', approvalsView(approvals, ctx)],
    ['schedules', '排程', 'schedules', schedulesView(schedules, ctx)],
  ];
  await Promise.all(
    pages.map(([file, title, active, body]) =>
      writeFile(
        join(directory, file + '.html'),
        page({ ...ctx, title, active, body }),
      ),
    ),
  );
  for (const [, , , body] of pages) t.assert.snapshot(body);
  for (const [, , , body] of pages.slice(1, 4)) {
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script&gt;/);
  }
  const renderedChat = pages[1]![3];
  assert.match(renderedChat, /class="task card warn" open/);
  assert.match(renderedChat, /class="omit">…［省略 1,234 個字元］…/);
  assert.ok(
    renderedChat.indexOf('日誌第 1 行') <
      renderedChat.indexOf('history.search'),
  );
  assert.ok(
    renderedChat.indexOf('history.search') < renderedChat.indexOf('看到了'),
  );
});

test('workspace timestamps and relative times use the supplied zone and locale', () => {
  assert.equal(formatTime(now, ctx.timezone), '2026-11-26 14:04:22');
  assert.equal(relative(now - 180_000, now, 'zh-TW'), '3 分鐘前');
  assert.equal(relative(now - 86_400_000, now, 'en'), 'Yesterday');
  assert.equal(duration(192_000, 'zh-TW'), '3 分 12 秒');
});
