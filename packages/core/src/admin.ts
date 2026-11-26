import type { Config } from '@tsugimori/config';
import type {
  AdminChat,
  AdminEvent,
  AdminReader,
  AdminTask,
  AdminToolCall,
  ChatRef,
  TaskEvent,
  WebhookStatus,
} from '@tsugimori/plugin-sdk';
import type {
  ChatRecord,
  ScheduleRecord,
  Store,
  TaskRecord,
  ToolCallRecord,
  TraceSpan,
} from '@tsugimori/storage';

import { defaultRecordsMaxBytes } from '@tsugimori/config';

import type { Tasks } from './tasks.ts';

import { reconstructContext } from './record-context.ts';
import { capToolDetail } from './tool-details.ts';

interface Dependencies {
  agentInfo(id: string): {
    implementation?: string;
    isDefault: boolean;
    login: 'signed-in' | 'required' | 'unknown';
    model?: string;
    state: 'ready' | 'disabled' | 'error';
  };
  config(): Config;
  reloadListeners: Set<(event: AdminEvent) => void>;
  route: Tasks['route'];
  store: Store;
  webhook(): WebhookStatus;
  workspace: string;
}

function startOfDay(now: number, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const day = formatter.format(now);
  let low = now - 36 * 60 * 60 * 1000;
  let high = now;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (formatter.format(middle) === day) high = middle;
    else low = middle + 1;
  }
  return low;
}

function taskDetails(
  task: TaskRecord,
  calls: readonly AdminToolCall[],
  spans: readonly TraceSpan[],
): AdminTask {
  const known = new Set(calls.map(({ seq }) => seq));
  const tools = [...calls];
  for (const [index, span] of spans.entries()) {
    if (span.name !== 'tool.run' && span.name !== 'agent.tool') continue;
    const { name, toolCallSeq } = span.attrs;
    if (typeof toolCallSeq === 'number' && known.has(toolCallSeq)) continue;
    if (typeof name !== 'string') continue;
    tools.push({
      seq: -index - 1,
      name,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      status: span.status,
      args: null,
      callId: null,
      result: null,
    });
  }
  const usages = spans.filter(
    ({ attrs, name }) => name === 'agent.usage' && attrs.purpose !== 'summary',
  );
  // Codex can report cumulative usage repeatedly, so display the latest recorded usage.
  const inputTokens = usages.findLast(
    ({ attrs }) => typeof attrs.inputTokens === 'number',
  )?.attrs.inputTokens;
  const outputTokens = usages.findLast(
    ({ attrs }) => typeof attrs.outputTokens === 'number',
  )?.attrs.outputTokens;
  const error = spans.findLast(({ name }) => name === 'task.failed')?.attrs
    .error;
  return {
    ...task,
    silent: spans.some(
      ({ attrs, name }) =>
        name === 'outbound.silent' &&
        attrs.reply === 'silent' &&
        !attrs.fallback,
    ),
    tools: tools.sort(
      (a, b) =>
        a.startedAt - b.startedAt ||
        (a.seq < 0 && b.seq < 0 ? b.seq - a.seq : a.seq - b.seq),
    ),
    inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
    outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
    error: typeof error === 'string' ? error : undefined,
  };
}

function groupCalls(calls: readonly ToolCallRecord[]) {
  const groups = new Map<string, ToolCallRecord[]>();
  for (const call of calls) {
    const group = groups.get(call.taskId);
    if (group) group.push(call);
    else groups.set(call.taskId, [call]);
  }
  return groups;
}

function summarizeCall({
  args,
  endedAt,
  name,
  seq,
  startedAt,
  status,
}: ToolCallRecord): AdminToolCall {
  let parsed: unknown;
  if (args !== null) {
    try {
      parsed = JSON.parse(args);
    } catch {
      // A recorded argument can be truncated in the middle of its JSON.
    }
  }
  const first =
    parsed && typeof parsed === 'object'
      ? Object.entries(parsed).find(
          ([, value]) => value === null || typeof value !== 'object',
        )
      : undefined;
  const preview =
    first && `${first[0]}: ${String(first[1])}`.replace(/\s+/g, ' ');
  return {
    args: null,
    callId: null,
    endedAt,
    name,
    result: null,
    seq,
    startedAt,
    status,
    ...(preview && {
      argsPreview: preview.length > 160 ? preview.slice(0, 159) + '…' : preview,
    }),
  };
}

export function adminReader({
  agentInfo,
  config,
  reloadListeners,
  webhook,
  route,
  store,
  workspace,
}: Dependencies): AdminReader {
  function showTool({ args, result, ...tool }: AdminToolCall): AdminToolCall {
    const limit = config().web?.toolDetails?.maxChars ?? 4000;
    return {
      ...tool,
      args: args === null ? null : capToolDetail(args, limit),
      result: result === null ? null : capToolDetail(result, limit),
    };
  }

  const chatDetails = (chat: ChatRecord, now: number): AdminChat => {
    const {
      activeTask,
      currentTool,
      preview,
      lastTask,
      latestSeq,
      messageCount,
      messageTime,
      pendingApprovals,
      threadId,
    } = store.adminChatActivity(chat, now);
    const { agentId, model, thinking, serviceTier, selected } = route(
      chat,
      chat,
    );
    const settings = store.getWorkspaceSettings(chat);
    const summary = store.getSummary(chat);
    const lastActivity = Math.max(
      messageTime ?? 0,
      lastTask?.finishedAt ?? 0,
      lastTask?.startedAt ?? 0,
      lastTask?.createdAt ?? 0,
    );
    return {
      ...chat,
      platform:
        config().platforms.find(({ id }) => id === chat.adapterId)?.kind ??
        chat.adapterId,
      threadId,
      activeTask: activeTask?.id ?? null,
      currentTool,
      preview: preview && {
        sender: preview.sender,
        text: (() => {
          const text = [...preview.text.replace(/\s+/g, ' ').trim()];
          return text.length > 80
            ? text.slice(0, 79).join('') + '…'
            : text.join('');
        })(),
      },
      lastTaskStatus: lastTask?.status ?? null,
      lastActivity: lastActivity || null,
      latestSeq,
      messageCount,
      pendingApprovals,
      route: {
        agentId,
        model: model.value ?? selected?.defaults?.model,
        thinking: thinking.value,
        serviceTier: serviceTier.value,
        isDefault: (chat.agentId ?? settings?.agentId) == null,
      },
      summary: summary?.throughSeq
        ? { throughSeq: summary.throughSeq, updatedAt: summary.updatedAt }
        : null,
    };
  };
  const getChat = (ref: ChatRef, now: number) => {
    const chat = store.getChat(ref);
    return chat && chatDetails(chat, now);
  };
  const scheduleDetails = (schedule: ScheduleRecord) => ({
    id: schedule.id,
    adapterId: schedule.adapterId,
    chatId: schedule.chatId,
    title:
      schedule.action.kind === 'message'
        ? schedule.action.text
        : schedule.action.prompt,
    nextDueAt: schedule.nextDueAt,
    lastRun: store.adminLastScheduleRun(schedule.id),
    status: schedule.status,
  });
  return {
    subscribe: (listener) => {
      const unsubscribe = store.subscribeAdmin?.(listener);
      reloadListeners.add(listener);
      return () => {
        reloadListeners.delete(listener);
        unsubscribe?.();
      };
    },
    agents: (now) => {
      const { agents, timezone } = config();
      const since = startOfDay(now, timezone);
      const chatCounts = new Map<string, number>();
      for (const chat of store.listChats()) {
        if (chat.migratedToChatId !== null) continue;
        const { agentId } = route(chat, chat);
        if (agentId)
          chatCounts.set(agentId, (chatCounts.get(agentId) ?? 0) + 1);
      }
      return agents
        .map(({ id, kind }) => {
          const info = agentInfo(id);
          const activity = store.adminAgentActivity(id, since, now);
          return {
            ...info,
            ...activity,
            id,
            implementation: info.implementation ?? kind,
            chats: chatCounts.get(id) ?? 0,
            recent: activity.recent.map((task) => {
              const chat = getChat(task, now);
              return {
                adapterId: task.adapterId,
                chatId: task.chatId,
                chatTitle: chat?.title ?? task.chatId,
                threadId: chat?.threadId ?? null,
                status: task.status,
                id: task.id,
                durationMs:
                  task.startedAt !== null && task.finishedAt !== null
                    ? task.finishedAt - task.startedAt
                    : null,
              };
            }),
          };
        })
        .sort(
          (a, b) =>
            Number(b.active > 0) - Number(a.active > 0) ||
            (b.lastActivity ?? 0) - (a.lastActivity ?? 0),
        );
    },
    workspace: () => {
      const { locale, name, timezone } = config();
      return { locale, name, timezone };
    },
    chats: () => {
      const now = Date.now();
      return store.listChats().map((chat) => chatDetails(chat, now));
    },
    pendingApprovals: (now) => store.countPendingApprovals(now),
    overview: (now, agentId) => {
      const chats = store
        .listChats()
        .filter(({ migratedToChatId }) => migratedToChatId === null)
        .map((chat) => chatDetails(chat, now))
        .filter((chat) => !agentId || chat.route.agentId === agentId)
        .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
      return {
        chats: chats.slice(0, 200),
        webhook: webhook(),
        records: {
          ...store.recordUsage(),
          maxBytes: config().records?.maxBytes ?? defaultRecordsMaxBytes,
        },
        totals: {
          chats: chats.length,
          ...store.adminTaskCounts(startOfDay(now, config().timezone), now),
        },
      };
    },
    chat: (ref, before) => {
      ref = store.resolveChat(ref);
      const now = Date.now();
      const chat = getChat(ref, now);
      if (!chat) return;
      const window = store.listChatMessages(ref, before);
      const decisions = store.triggersForMessages(window.map(({ seq }) => seq));
      const oldest = window.length === 100 ? window.at(-1) : undefined;
      const page = store.adminChatTasks(ref, {
        before,
        oldestSeq: oldest?.seq,
        oldestTime: oldest?.recordedAt,
      });
      const calls = groupCalls(
        store.taskToolCalls(
          page.map(({ id }) => id),
          'args',
        ),
      );
      return {
        chat,
        messages: window.map((message) => ({
          ...message,
          trigger: decisions.get(message.seq),
        })),
        older: oldest?.seq,
        approvals: store
          .adminChatApprovals(ref, now)
          .map(
            ({
              adapterId,
              chatId,
              id,
              action,
              status,
              requestedAt,
              requester,
              resource,
              decidedAt,
              decidedBy,
            }) => ({
              adapterId,
              chatId,
              id,
              action,
              status,
              requestedAt,
              requester,
              resource,
              decidedAt,
              decidedBy,
            }),
          ),
        schedules: store.adminChatSchedules(ref).map(scheduleDetails),
        tasks: page.map((task) => ({
          ...taskDetails(
            task,
            (calls.get(task.id) ?? []).map(summarizeCall),
            store.taskTrace(task.id),
          ),
          sourceSeq: task.sourceSeq,
        })),
      };
    },
    approvals: (recentLimit) => {
      const now = Date.now();
      const records = store.listApprovals(now, recentLimit);
      const calls = store.taskToolCalls([
        ...new Set(records.map(({ taskId }) => taskId)),
      ]);
      const byApproval = new Map(
        calls
          .filter(({ approvalId }) => approvalId !== null)
          .map((call) => [call.approvalId, call]),
      );
      return {
        approvals: records.map((approval) => ({
          action: approval.action,
          adapterId: approval.adapterId,
          approverId: approval.approverId,
          chatId: approval.chatId,
          decidedAt: approval.decidedAt,
          decidedBy: approval.decidedBy,
          expiresAt: approval.expiresAt,
          failureReason: approval.failureReason,
          id: approval.id,
          promptMessageId: approval.promptMessageId,
          requestedAt: approval.requestedAt,
          requester: approval.requester,
          resource: approval.resource,
          taskId: approval.taskId,
          status:
            approval.status === 'pending' &&
            approval.expiresAt !== null &&
            approval.expiresAt <= now
              ? 'expired'
              : approval.status,
          args: byApproval.has(approval.id)
            ? showTool(byApproval.get(approval.id)!).args
            : undefined,
          chat: getChat(approval, now),
          requesterDisplay: store.getUserDisplay({
            ...approval,
            userId: approval.requester,
          }),
        })),
        grants: store.listGrants(),
      };
    },
    toolCall: (taskId, seq) => {
      const record = store.adminToolCall(taskId, seq);
      if (!record) return;
      const { name, args, result, status, callId, startedAt, endedAt } = record;
      return showTool({
        name,
        args,
        result,
        status,
        callId,
        startedAt,
        endedAt,
        seq,
      });
    },
    messageRaw: (ref, seq) => store.messageRaw(ref, seq),
    task: async (taskId) => {
      const task = store.getTask(taskId);
      if (!task) return;
      const execution = store.getTaskExecution(taskId);
      const detailedTask = taskDetails(
        task,
        store.taskToolCalls([taskId]).map(showTool),
        store.taskTrace(taskId),
      );
      const bySeq = new Map(detailedTask.tools.map((call) => [call.seq, call]));
      const events: TaskEvent[] = [];
      let lastSeq = 0;
      for (const event of store.getTaskEvents(taskId)) {
        lastSeq = event.seq;
        if (event.kind === 'tool') {
          events.push({ ...event, tool: bySeq.get(event.data.toolSeq) });
          bySeq.delete(event.data.toolSeq);
        } else events.push(event);
      }
      // Calls created by older builds or by a post-task approval still belong in the transcript.
      for (const tool of bySeq.values()) {
        events.push({
          kind: 'tool',
          at: tool.startedAt,
          seq: ++lastSeq,
          data: { toolSeq: tool.seq },
          tool,
        });
      }
      events.sort((a, b) => a.at - b.at || a.seq - b.seq);
      return {
        ...execution,
        task: detailedTask,
        events,
        trigger: store.triggerForTask(task),
        context: execution
          ? await reconstructContext(store, workspace, task, execution)
          : [],
      };
    },
    trace: (taskId) => {
      const task = store.getTask(taskId);
      const chat = task && getChat(task, Date.now());
      if (!task || !chat) return;
      const spans = store.taskTrace(taskId);
      return {
        chat,
        task: taskDetails(
          task,
          store.taskToolCalls([taskId]).map(showTool),
          spans,
        ),
        spans,
      };
    },
    schedules: () => {
      const now = Date.now();
      return {
        schedules: store.listAdminSchedules().map((schedule) => ({
          ...scheduleDetails(schedule),
          chat: getChat(schedule, now),
        })),
      };
    },
  };
}
