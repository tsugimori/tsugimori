import type {
  AdminAgent,
  AdminApprovals,
  AdminChat,
  AdminConversation,
  AdminOverview,
  AdminSchedules,
  AdminTask,
  AdminTrace,
} from '@tsugimori/plugin-sdk';

import { render } from 'svelte/server';

import type { ViewContext } from './lib/format.ts';

import AgentCard from './components/AgentCard.svelte';
import ChatDetails from './components/ChatDetails.svelte';
import Header from './components/Header.svelte';
import JsonView from './components/JsonView.svelte';
import TaskLanes from './components/TaskLanes.svelte';
import Time from './components/Time.svelte';
import Timeline from './components/Timeline.svelte';
import { formatTime, relative } from './lib/format.ts';
import Agents from './pages/Agents.svelte';
import Approvals from './pages/Approvals.svelte';
import Chat from './pages/Chat.svelte';
import Overview from './pages/Overview.svelte';
import Schedules from './pages/Schedules.svelte';
import Trace from './pages/Trace.svelte';

export const payload =
  '<script>alert(1)</script> "><img src=x onerror=alert(1)>';
export const now = Date.parse('2026-11-26T06:03:22Z');
const minute = 60_000;
const ctx: ViewContext = {
  locale: 'zh-TW',
  timezone: 'Asia/Taipei',
  name: '月太的工作區',
  now,
  pending: 1,
  schedules: true,
};
const chat: AdminChat = {
  adapterId: 'telegram',
  chatId: '-1000000000123',
  title: 'Suntai 群組',
  kind: 'group',
  platform: 'telegram',
  threadId: '66',
  activeTask: 'fixture-running',
  currentTool: 'history.search',
  allowlisted: true,
  lastActivity: now - 45_000,
  lastTaskStatus: 'running',
  latestSeq: 1284,
  messageCount: 1284,
  pendingApprovals: 1,
  preview: { sender: '月太', text: '幫我看一下 log，服務重啟後有幾則告警。' },
  route: {
    agentId: 'claude-sdk',
    model: 'opus',
    thinking: 'high',
    serviceTier: 'fast',
    isDefault: false,
  },
  summary: { throughSeq: 1240, updatedAt: now - 2 * 60 * minute },
};
const dm: AdminChat = {
  ...chat,
  chatId: 'U123456789000000000abcdef',
  adapterId: 'line',
  title: '月太',
  kind: 'dm',
  platform: 'line',
  activeTask: null,
  currentTool: null,
  allowlisted: false,
  threadId: null,
  lastActivity: now - 25 * 60 * minute,
  lastTaskStatus: 'failed',
  latestSeq: 52,
  messageCount: 52,
  pendingApprovals: 0,
  preview: { sender: null, text: '已整理昨天的工作紀錄。' },
  summary: null,
  route: { agentId: 'codex', model: 'gpt-6.2-sol', isDefault: true },
};
const task: AdminTask = {
  adapterId: chat.adapterId,
  chatId: chat.chatId,
  id: 'fixture-running',
  agentId: 'claude-sdk',
  model: 'opus',
  status: 'running',
  createdAt: now - 40_000,
  startedAt: now - 40_000,
  finishedAt: null,
  sourceSeq: 1284,
  inputTokens: 12034,
  outputTokens: 820,
  tools: [
    {
      args: JSON.stringify(
        {
          command: 'tail -n 50 /var/log/syslog',
          env: { LANG: 'zh_TW.UTF-8', TZ: 'Asia/Taipei' },
          timeout: 30_000,
        },
        null,
        2,
      ),
      argsPreview: 'command: tail -n 50 /var/log/syslog',
      result: JSON.stringify(
        {
          exitCode: 1,
          stderr:
            'service: retry limit reached\nservice: waiting for the next health check',
          details: { retries: [1, 2, 3], recovered: false },
        },
        null,
        2,
      ),
      callId: 'fixture-call-1',
      name: 'exec.run',
      seq: 1,
      startedAt: now - 35_000,
      endedAt: now - 33_800,
      status: 'error',
    },
    {
      args: null,
      result: null,
      callId: null,
      name: 'history.search',
      seq: 2,
      startedAt: now - 12_000,
      endedAt: null,
      status: null,
    },
  ],
};
const approvals: AdminApprovals = {
  approvals: [
    {
      adapterId: chat.adapterId,
      chatId: chat.chatId,
      chat,
      action: 'exec.run',
      status: 'pending',
      id: 'fixture-approval',
      requester: 'example-owner',
      requesterDisplay: '月太',
      requestedAt: now - 3 * minute,
      decidedAt: null,
      decidedBy: null,
      resource: { type: 'global' },
      args: '{"command":"systemctl status example"}',
    },
    {
      adapterId: dm.adapterId,
      chatId: dm.chatId,
      chat: dm,
      action: 'schedule.create',
      status: 'approved',
      id: 'fixture-approved',
      requester: 'example-owner',
      requesterDisplay: '月太',
      requestedAt: now - 25 * minute,
      decidedAt: now - 24 * minute,
      decidedBy: 'example-owner',
      resource: { type: 'global' },
    },
  ],
  grants: [],
};
const schedules: AdminSchedules = {
  schedules: [
    {
      adapterId: chat.adapterId,
      chatId: chat.chatId,
      id: 'fixture-schedule',
      chat,
      title: '每日 09:00 晨報',
      status: 'active',
      nextDueAt: Date.parse('2026-11-27T01:00:00Z'),
      lastRun: Date.parse('2026-11-26T01:00:00Z'),
    },
    {
      adapterId: chat.adapterId,
      chatId: chat.chatId,
      id: 'fixture-report',
      chat,
      title: '週報提醒',
      status: 'active',
      nextDueAt: Date.parse('2026-11-27T09:00:00Z'),
    },
  ],
};
const conversation: AdminConversation = {
  chat,
  older: 1265,
  tasks: [
    task,
    {
      ...task,
      id: 'fixture-silent',
      sourceSeq: 1282,
      createdAt: now - 6 * minute,
      startedAt: now - 6 * minute,
      finishedAt: now - 6 * minute + 800,
      status: 'completed',
      silent: true,
      tools: [],
    },
  ],
  approvals: approvals.approvals.slice(0, 1),
  schedules: schedules.schedules,
  messages: [
    {
      seq: 1285,
      direction: 'outbound',
      recordedAt: now - 20_000,
      text: '找到三則告警。我再查一下之前有沒有發生過。',
      userId: null,
      displayName: null,
      deleted: false,
    },
    {
      seq: 1284,
      direction: 'inbound',
      recordedAt: now - 45_000,
      text: '幫我看一下 log，服務重啟後有幾則告警。',
      userId: 'example-owner',
      displayName: '月太',
      deleted: false,
    },
    {
      seq: 1283,
      direction: 'outbound',
      recordedAt: now - 5 * minute,
      text: '已經重啟服務。我會再留意健康檢查的結果。',
      userId: null,
      displayName: null,
      deleted: false,
    },
    {
      seq: 1282,
      direction: 'inbound',
      recordedAt: now - 6 * minute,
      text: '重啟後回報一下。',
      userId: 'example-owner',
      displayName: '月太',
      deleted: false,
    },
    {
      seq: 1281,
      direction: 'inbound',
      recordedAt: now - 24 * 60 * minute,
      text: Array.from(
        { length: 24 },
        (_, index) => `檢查項目 ${index + 1}`,
      ).join('\n'),
      userId: 'example-owner',
      displayName: '月太',
      deleted: false,
    },
    ...Array.from({ length: 16 }, (_, index) => ({
      seq: 1280 - index,
      direction: index % 2 === 0 ? 'inbound' : 'outbound',
      recordedAt: now - (24 * 60 + index + 1) * minute,
      text: index % 2 === 0 ? '請確認服務的健康檢查。' : '健康檢查已完成。',
      userId: index % 2 === 0 ? 'example-owner' : null,
      displayName: index % 2 === 0 ? '月太' : null,
      deleted: false,
    })),
  ],
};
const agents: AdminAgent[] = [
  {
    id: 'claude-sdk',
    implementation: 'Claude Agent SDK',
    active: 1,
    isDefault: false,
    model: 'opus',
    chats: 2,
    lastActivity: now - 3 * minute,
    failedToday: 1,
    tasksToday: 12,
    login: 'signed-in',
    state: 'ready',
    recent: [
      {
        adapterId: chat.adapterId,
        chatId: chat.chatId,
        threadId: chat.threadId,
        chatTitle: chat.title!,
        id: 'fixture-completed',
        status: 'completed',
        durationMs: 42_100,
      },
      {
        adapterId: dm.adapterId,
        chatId: dm.chatId,
        threadId: null,
        chatTitle: dm.title!,
        id: 'fixture-failed',
        status: 'failed',
        durationMs: 3000,
      },
    ],
  },
  {
    id: 'codex',
    implementation: 'Codex App Server',
    active: 0,
    isDefault: true,
    model: 'gpt-6.2-sol',
    chats: 5,
    lastActivity: now - 24 * 60 * minute,
    failedToday: 0,
    tasksToday: 30,
    login: 'required',
    state: 'ready',
    recent: [],
  },
];
const overview: AdminOverview = {
  chats: [chat, dm],
  totals: { chats: 2, failedToday: 1, pendingApprovals: 1, tasksToday: 42 },
};
const trace: AdminTrace = {
  chat,
  task: { ...task, finishedAt: now, status: 'completed' },
  spans: [
    {
      id: 'one',
      attrs: {},
      durationMs: 40_000,
      name: 'task.run',
      startedAt: now - 40_000,
      status: 'ok',
    },
    {
      id: 'two',
      parentId: 'one',
      attrs: { model: 'opus' },
      durationMs: 37_000,
      name: 'agent.turn',
      startedAt: now - 39_000,
      status: 'ok',
    },
    {
      id: 'three',
      parentId: 'two',
      attrs: { name: 'exec.run', toolCallSeq: 1 },
      durationMs: 1200,
      name: 'agent.tool',
      startedAt: now - 35_000,
      status: 'error',
    },
    {
      id: 'four',
      parentId: 'two',
      attrs: { name: 'history.search' },
      durationMs: 12000,
      name: 'tool.run',
      startedAt: now - 12000,
      status: 'running',
    },
  ],
};
export function pages() {
  const header = (active: string) =>
    render(Header, { props: { active, ctx, state: 'connected', last: now } })
      .body;
  const chatPage = (file: string, viewport?: number) => ({
    file,
    viewport,
    title: '聊天室',
    header: header('chats'),
    chatShell: true,
    body: render(Chat, {
      props: {
        data: conversation,
        ctx,
        preview: true,
        previewChats: overview,
        mobilePreview: viewport === 390,
      },
    }).body,
  });
  return [
    {
      file: 'overview',
      title: '總覽',
      header: header('overview'),
      body: render(Overview, { props: { data: overview, ctx } }).body,
    },
    {
      file: 'chats',
      title: '聊天室',
      header: header('chats'),
      body: render(Overview, {
        props: { data: overview, ctx, chatsOnly: true },
      }).body,
    },
    {
      file: 'agents',
      title: '代理',
      header: header('agents'),
      body: render(Agents, { props: { data: agents, ctx } }).body,
    },
    chatPage('chat'),
    chatPage('chat-narrow', 900),
    chatPage('chat-mobile', 390),
    {
      file: 'trace',
      title: '追蹤',
      header: header('chats'),
      body: render(Trace, { props: { data: trace, ctx, preview: true } }).body,
    },
    {
      file: 'approvals',
      title: '核准',
      header: header('approvals'),
      body: render(Approvals, { props: { data: approvals, ctx } }).body,
    },
    {
      file: 'schedules',
      title: '排程',
      header: header('schedules'),
      body: render(Schedules, { props: { data: schedules, ctx } }).body,
    },
  ];
}

export function json(text: string, error = false) {
  return render(JsonView, {
    props: { text, label: '結果', locale: ctx.locale, error },
  }).body;
}

export function timeline() {
  return render(Timeline, {
    props: {
      ctx,
      data: {
        messages: [
          { ...conversation.messages[0]!, text: payload, displayName: payload },
        ],
        tasks: [],
      },
    },
  }).body;
}

export function overlappingLanes() {
  const tool = task.tools[0]!;
  const start = now - 40_000;
  return render(TaskLanes, {
    props: {
      task: {
        ...task,
        tools: [
          { ...tool, startedAt: start + 4_000, endedAt: start + 16_000 },
          {
            ...tool,
            seq: 2,
            startedAt: start + 12_000,
            endedAt: start + 24_000,
          },
        ],
      },
      start,
      end: now,
      locale: ctx.locale,
    },
  }).body;
}

export function agentCard() {
  return render(AgentCard, { props: { agent: agents[0]!, ctx } }).body;
}

export function details() {
  return render(ChatDetails, { props: { data: conversation, ctx, close() {} } })
    .body;
}

export function time() {
  const at = now - 3 * minute;
  return {
    html: render(Time, { props: { at, ctx, mode: 'absolute' } }).body,
    yesterday: relative(now - 25 * 60 * minute, now, ctx.locale),
    relative: relative(at, now, ctx.locale),
    absolute: formatTime(at, ctx.timezone),
  };
}
