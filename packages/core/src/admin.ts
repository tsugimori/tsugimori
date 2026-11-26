import type { Config } from '@tsugimori/config';
import type {
  AdminChat,
  AdminReader,
  AdminTask,
  AdminToolCall,
  ChatRef,
} from '@tsugimori/plugin-sdk';
import type {
  ChatRecord,
  Store,
  TaskRecord,
  ToolCallRecord,
  TraceSpan,
} from '@tsugimori/storage';

import type { Tasks } from './tasks.ts';

interface Dependencies {
  config(): Config;
  route: Tasks['route'];
  store: Store;
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

export function adminReader({
  config,
  route,
  store,
}: Dependencies): AdminReader {
  const chatDetails = (chat: ChatRecord, now: number): AdminChat => {
    const {
      activeTask,
      lastTask,
      latestSeq,
      messageCount,
      messageTime,
      pendingApprovals,
      threadId,
    } = store.adminChatActivity(chat, now);
    const { agentId, model, thinking, serviceTier } = route(chat, chat);
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
      lastTaskStatus: lastTask?.status ?? null,
      lastActivity: lastActivity || null,
      latestSeq,
      messageCount,
      pendingApprovals,
      route: {
        agentId,
        model: model.value,
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
  return {
    workspace: () => {
      const { locale, name, timezone } = config();
      return { locale, name, timezone };
    },
    chats: () => {
      const now = Date.now();
      return store.listChats().map((chat) => chatDetails(chat, now));
    },
    pendingApprovals: (now) => store.countPendingApprovals(now),
    overview: (now) => {
      const chats = store
        .listChats()
        .filter(({ migratedToChatId }) => migratedToChatId === null)
        .map((chat) => chatDetails(chat, now))
        .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
      return {
        chats: chats.slice(0, 200),
        totals: {
          chats: chats.length,
          ...store.adminTaskCounts(startOfDay(now, config().timezone), now),
        },
      };
    },
    chat: (ref, before) => {
      const chat = getChat(ref, Date.now());
      if (!chat) return;
      const window = store.listChatMessages(ref, before);
      const oldest = window.length === 100 ? window.at(-1) : undefined;
      const page = store.adminChatTasks(ref, {
        before,
        oldestSeq: oldest?.seq,
        oldestTime: oldest?.recordedAt,
      });
      const calls = groupCalls(store.taskToolCalls(page.map(({ id }) => id)));
      return {
        chat,
        messages: window,
        older: oldest?.seq,
        tasks: page.map((task) => ({
          ...taskDetails(
            task,
            calls.get(task.id) ?? [],
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
          args: byApproval.get(approval.id)?.args,
          chat: getChat(approval, now),
          requesterDisplay: store.getUserDisplay({
            ...approval,
            userId: approval.requester,
          }),
        })),
        grants: store.listGrants(),
      };
    },
    trace: (taskId) => {
      const task = store.getTask(taskId);
      const chat = task && getChat(task, Date.now());
      if (!task || !chat) return;
      const spans = store.taskTrace(taskId);
      return {
        chat,
        task: taskDetails(task, store.taskToolCalls([taskId]), spans),
        spans,
      };
    },
    schedules: () => {
      const now = Date.now();
      return {
        schedules: store
          .listAdminSchedules()
          .map(({ action, ...schedule }) => ({
            id: schedule.id,
            adapterId: schedule.adapterId,
            chatId: schedule.chatId,
            title: action.kind === 'message' ? action.text : action.prompt,
            nextDueAt: schedule.nextDueAt,
            status: schedule.status,
            chat: getChat(schedule, now),
          })),
      };
    },
  };
}
