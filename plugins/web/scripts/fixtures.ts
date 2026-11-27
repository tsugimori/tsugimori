import type {
  AdminAgent,
  AdminApprovals,
  AdminChat,
  AdminConversation,
  AdminEvent,
  AdminOverview,
  AdminReader,
  AdminSchedules,
  AdminTask,
  AdminTaskRecord,
  AdminTaskSort,
  AdminTaskSummary,
  AdminTrace,
  AdminWorkspace,
} from '@tsugimori/plugin-sdk';

export const payload =
  '<script>alert(1)</script> "><img src=x onerror=alert(1)>';
export const now = Date.now();
const minute = 60_000;
const workspace: AdminWorkspace = {
  locale: 'zh-TW',
  timezone: 'Asia/Taipei',
  name: 'home-lab',
  pendingApprovals: 1,
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
  grants: [
    {
      adapterId: chat.adapterId,
      chatId: chat.chatId,
      action: 'exec.run',
      scope: { type: 'path', path: '/workspace/example' },
      mode: 'always',
      createdAt: now - 30 * minute,
      grantedBy: '月太',
      grantedTo: 'example-owner',
      revokedAt: null,
    },
  ],
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
      nextDueAt: now + 18 * 60 * minute,
      lastRun: now - 6 * 60 * minute,
    },
    {
      adapterId: chat.adapterId,
      chatId: chat.chatId,
      id: 'fixture-report',
      chat,
      title: '週報提醒',
      status: 'active',
      nextDueAt: now + 27 * 60 * minute,
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
    ...Array.from({ length: 4 }, (_, index) => ({
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
  webhook: { state: 'ok', baseUrl: 'https://console.example.test' },
  records: {
    bytes: 432_223_400,
    maxBytes: 1_073_741_824,
    oldestFullTaskAt: now - 6 * 86_400_000,
  },
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
const moreChats = [
  {
    ...chat,
    chatId: '-1000000000465',
    title: '家庭群組',
    threadId: null,
    activeTask: null,
    currentTool: null,
    lastTaskStatus: 'sent',
    pendingApprovals: 0,
    lastActivity: now - 14 * minute,
    preview: { sender: '阿姨', text: '明天天氣怎麼樣？要不要帶傘？' },
  },
  {
    ...chat,
    chatId: '-1000000000789',
    title: 'Infra 值班',
    threadId: '812',
    activeTask: null,
    currentTool: null,
    lastTaskStatus: 'failed',
    pendingApprovals: 0,
    lastActivity: now - 20 * minute,
    preview: { sender: 'Kenji', text: '請看看 nightly 為什麼掛了。' },
  },
  {
    ...chat,
    chatId: '-1000000000211',
    title: '讀書會',
    threadId: null,
    activeTask: null,
    currentTool: null,
    lastTaskStatus: 'sent',
    pendingApprovals: 0,
    lastActivity: now - 31 * minute,
    preview: { sender: 'bot', text: '第三章的重點可以分成三個部分。' },
  },
  {
    ...dm,
    chatId: 'U123045678999999',
    title: 'LINE 家人',
    lastTaskStatus: 'sent',
    lastActivity: now - 50 * minute,
    preview: { sender: '媽媽', text: '［附件］' },
  },
];
const allChats = [chat, dm, ...moreChats];
const complete: AdminTask = {
  ...trace.task,
  id: 'fixture-completed',
  sourceSeq: 1286,
  createdAt: now - 4 * minute - 42_000,
  startedAt: now - 4 * minute - 41_580,
  finishedAt: now - 4 * minute,
  inputTokens: 48_200,
  outputTokens: 1900,
  tools: task.tools.map((tool, index) => ({
    ...tool,
    startedAt: now - 4 * minute - 37_000 + index * 5500,
    endedAt: now - 4 * minute - 35_800 + index * 5500,
    status: index ? 'ok' : 'error',
    args: tool.args ?? '{"query":"health check"}',
    result: tool.result ?? '健康檢查已重新啟動。',
  })),
};
const moreTasks = allChats.slice(1).map((room, index): AdminTask => ({
  ...complete,
  adapterId: room.adapterId,
  chatId: room.chatId,
  sourceSeq: null,
  agentId: room.route.agentId ?? null,
  model: room.route.model ?? null,
  id: index === 0 ? 'fixture-failed' : 'fixture-task-' + index,
  status:
    index === 0 || index === 2 ? 'failed' : index === 4 ? 'cancelled' : 'sent',
  createdAt: now - (index + 9) * minute,
  startedAt: now - (index + 9) * minute + 95,
  finishedAt: now - (index + 9) * minute + 6100,
  error: index === 0 ? 'delivery · rate limit · retry after 31 s' : undefined,
  tools: index % 2 ? [] : complete.tools,
}));
const output = [
  '### 健康檢查報告',
  '確認了三則告警。服務重啟後已恢復正常。',
  '',
  '- **系統日誌**顯示兩次重試。',
  '- 健康檢查已通過，佇列回復穩定。',
  '',
  '> 建議再觀察下一輪週期性檢查。',
  '',
  '    service status  OK',
  '    queued jobs     0',
].join('\n');
const mainConversation: AdminConversation = {
  ...conversation,
  tasks: [...conversation.tasks, complete],
  messages: [
    ...conversation.messages,
    {
      seq: 1287,
      direction: 'outbound',
      recordedAt: complete.finishedAt,
      text: '健康檢查已完成，服務重啟後已恢復正常。',
      userId: null,
      displayName: null,
      deleted: false,
    },
    {
      seq: 1286,
      direction: 'inbound',
      recordedAt: complete.createdAt - 650,
      text: '幫我整理一下昨天的健康檢查報告。',
      userId: 'example-owner',
      displayName: '月太',
      deleted: false,
      trigger: {
        adapterId: chat.adapterId,
        chatId: chat.chatId,
        at: complete.createdAt - 650,
        messageId: '1286',
        taskId: complete.id,
        reason: 'mention' as const,
        triggered: true,
      },
    },
  ].sort((a, b) => b.seq - a.seq),
};
const allTasks = [...mainConversation.tasks, ...moreTasks];
function record(current: AdminTask): AdminTaskRecord {
  const start = current.startedAt ?? current.createdAt;
  const isComplete = current.id === complete.id;
  return {
    task: current,
    trigger: {
      adapterId: current.adapterId,
      chatId: current.chatId,
      taskId: current.id,
      at: start - 650,
      triggered: true,
      messageId: '1286',
      reason: 'mention',
    },
    agent: {
      agentId: current.agentId ?? 'codex',
      kind: 'claude-sdk',
      model: current.model ?? 'opus',
      requestedModel: current.model ?? 'opus',
      reasoning: 'high',
      serviceTier: 'fast',
    },
    context: [
      {
        kind: 'fixed',
        title: 'System guidelines',
        ref: 'system:guidelines',
        text: 'Review the service health checks and summarize relevant events.',
      },
      {
        kind: 'fixed',
        title: 'AGENTS.md',
        ref: 'sha256 3f9a…c1',
        text: 'Use clear titles and include the dates of events.',
      },
      {
        kind: 'summary',
        title: 'Chat summary',
        ref: 'rev 41',
        text: 'The service was restarted yesterday.',
      },
      {
        kind: 'history',
        title: 'Message #1,282',
        ref: '#1282',
        text: '重啟後回報一下。',
      },
      {
        kind: 'new',
        title: 'telegram · owner',
        ref: '#1286',
        text: '幫我整理一下昨天的健康檢查報告。',
      },
      { kind: 'fixed', title: 'Workspace snapshot', ref: '4be77e1' },
    ],
    refs: {
      history: { fromSeq: 1282, throughSeq: 1286 },
      order: [],
      session: { mode: 'resumed', sessionId: 'sess_01JDX83QC' },
      tsugimori: { commit: 'a91f0c21ff87' },
      workspace: { commit: '4be77e1ac7cb', files: [] },
    },
    timing: {
      queuedMs: 120,
      contextMs: 300,
      agentMs: 40_900,
      deliveryMs: 680,
      toolsMs: 2400,
      firstTokenMs: 3100,
      totalMs: 42_000,
    },
    events: [
      {
        kind: 'reasoning',
        at: start + 3100,
        seq: 1,
        data: { text: '先檢查系統日誌和上一次健康檢查，再整理告警。' },
      },
      ...current.tools.map((tool, index) => ({
        kind: 'tool' as const,
        at: tool.startedAt,
        seq: index + 2,
        data: { toolSeq: tool.seq },
        tool,
      })),
      ...(isComplete
        ? [
            {
              kind: 'supplement' as const,
              at: start + 27_000,
              seq: 10,
              data: { messageId: '88412' },
            },
            {
              kind: 'compaction' as const,
              at: start + 31_400,
              seq: 11,
              data: {
                trigger: 'auto',
                status: 'ok',
                tokensBefore: 182_400,
                tokensAfter: 41_900,
              },
            },
            {
              kind: 'text' as const,
              at: start + 40_250,
              seq: 12,
              data: { text: output },
            },
          ]
        : []),
    ],
    output: isComplete ? output : null,
    outcome: isComplete
      ? {
          kind: 'delivered',
          delivery: {
            adapterId: current.adapterId,
            parts: [{ messageId: '88415', ok: true }],
          },
        }
      : {
          kind: current.silent
            ? 'silent'
            : current.error
              ? 'failed'
              : 'cancelled',
          silentReason: current.silent ? 'NO_REPLY' : undefined,
        },
    supplements: isComplete
      ? [{ at: start + 27_000, afterEventSeq: 3, messageId: '88412' }]
      : [],
  };
}
const chatKey = ({
  adapterId,
  chatId,
}: {
  adapterId: string;
  chatId: string;
}) => JSON.stringify([adapterId, chatId]);
const summaries = allTasks.map((current, index): AdminTaskSummary => {
  const room =
    allChats.find((room) => chatKey(room) === chatKey(current)) ?? chat;
  const source = mainConversation.messages.find(
    ({ seq }) => seq === current.sourceSeq,
  );
  return {
    adapterId: current.adapterId,
    chatId: current.chatId,
    id: current.id,
    agentId: current.agentId,
    model: current.model,
    status: current.status,
    createdAt: current.createdAt,
    startedAt: current.startedAt,
    finishedAt: current.finishedAt,
    chatKey: chatKey(current),
    chatTitle: room.title ?? room.chatId,
    platform: room.platform,
    durationMs:
      current.finishedAt === null
        ? null
        : current.finishedAt - (current.startedAt ?? current.createdAt),
    error: current.error ?? null,
    inputTokens: current.inputTokens ?? null,
    outputTokens: current.outputTokens ?? null,
    silent: current.silent ?? false,
    toolCount: current.tools.length,
    triggerReason:
      index % 3 === 0
        ? ('mention' as const)
        : index % 3 === 1
          ? ('reply-to-bot' as const)
          : ('dm-owner' as const),
    triggerText: source?.text ?? room.preview?.text ?? null,
  };
});

type TaskKey = Pick<AdminTaskSummary, 'createdAt' | 'id'> & {
  durationMs?: number | null;
};

function compareTasks(a: TaskKey, b: TaskKey, sort: AdminTaskSort = 'newest') {
  if (sort === 'duration') {
    if (a.durationMs == null && b.durationMs != null) return 1;
    if (a.durationMs != null && b.durationMs == null) return -1;
    if (
      a.durationMs != null &&
      b.durationMs != null &&
      a.durationMs !== b.durationMs
    )
      return b.durationMs - a.durationMs;
  }
  const creation =
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : Number(a.id > b.id));
  return sort === 'oldest' ? creation : -creation;
}

export function createFixtureReader(empty = false) {
  const listeners = new Set<(event: AdminEvent) => void>();
  const reader: AdminReader = {
    agents: () => (empty ? [] : agents),
    approvals: () => (empty ? { approvals: [], grants: [] } : approvals),
    chat(ref, before) {
      const room = empty
        ? undefined
        : allChats.find((item) => chatKey(item) === chatKey(ref));
      if (!room) return;
      if (room.chatId !== chat.chatId)
        return {
          chat: room,
          messages: [],
          tasks: allTasks.filter((item) => chatKey(item) === chatKey(room)),
        };
      if (before !== undefined)
        return {
          ...mainConversation,
          older: undefined,
          tasks: [],
          messages: [
            {
              ...mainConversation.messages[0]!,
              seq: before - 1,
              text: '較早的聊天室訊息。',
              recordedAt: now - 2 * 86_400_000,
            },
          ],
        };
      return mainConversation;
    },
    chats: () => (empty ? [] : allChats),
    messageRaw: () => ({
      payload,
      message: {
        id: 1284,
        text: '請確認服務的健康檢查。',
        entities: [{ type: 'mention' }],
      },
    }),
    overview: (_, agent) => {
      const chats = empty
        ? []
        : allChats.filter(({ route }) => !agent || route.agentId === agent);
      return {
        ...overview,
        chats,
        totals: empty
          ? { chats: 0, failedToday: 0, pendingApprovals: 0, tasksToday: 0 }
          : { ...overview.totals, chats: chats.length },
      };
    },
    pendingApprovals: () => (empty ? 0 : 1),
    schedules: () => (empty ? { schedules: [] } : schedules),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    task: async (id) => {
      const current = empty
        ? undefined
        : allTasks.find((item) => item.id === id);
      return current ? record(current) : undefined;
    },
    tasks: (filter) =>
      empty
        ? []
        : summaries
            .filter(
              (row) =>
                (!filter.agent || row.agentId === filter.agent) &&
                (!filter.chat || row.chatKey === chatKey(filter.chat)) &&
                (!filter.platform || row.platform === filter.platform) &&
                (!filter.status || row.status === filter.status) &&
                (filter.since === undefined || row.createdAt >= filter.since) &&
                (filter.before === undefined ||
                  row.createdAt < filter.before) &&
                (!filter.q ||
                  row.triggerText
                    ?.toLowerCase()
                    .includes(filter.q.toLowerCase())) &&
                (!filter.cursor ||
                  compareTasks(row, filter.cursor, filter.sort) > 0),
            )
            .sort((a, b) => compareTasks(a, b, filter.sort))
            .slice(0, filter.limit + 1),
    toolCall: (id, seq) =>
      allTasks
        .find((item) => item.id === id)
        ?.tools.find((tool) => tool.seq === seq),
    trace: (id) => {
      const current = empty
        ? undefined
        : allTasks.find((item) => item.id === id);
      if (!current) return;
      return {
        chat:
          allChats.find((room) => chatKey(room) === chatKey(current)) ?? chat,
        task: current,
        spans: trace.spans.map((span) => ({
          ...span,
          startedAt: current.createdAt + span.startedAt - task.createdAt,
        })),
      };
    },
    workspace: () => workspace,
  };
  return {
    reader,
    emit: (event: AdminEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}
