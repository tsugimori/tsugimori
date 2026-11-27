import type {
  ChatRef,
  ContextBlock,
  ResourcePattern,
  ResourceRef,
} from './index.ts';
import type { WebhookStatus } from './webhooks.ts';

export interface AccessIdentity {
  aud: string;
  ownerEmail?: string;
  ownerSub?: string;
  team: string;
  /** Access user email addresses granted read-only viewer access. */
  viewerEmails?: readonly string[];
  /** Access service token client IDs granted read-only viewer access. */
  viewerServiceTokens?: readonly string[];
}

/** `owner` matches the configured owner. `viewer` matches a listed user or service token. */
export type AccessRole = 'owner' | 'viewer';

export type VerifyAccess = (
  jwt: string | undefined,
  identity: AccessIdentity,
) => Promise<AccessRole | false>;

export type ToolCallStatus = 'ok' | 'error' | 'denied' | 'pending-approval';

export interface AdminToolCall {
  args: string | null;
  argsPreview?: string;
  callId: string | null;
  endedAt: number | null;
  name: string;
  result: string | null;
  seq: number;
  startedAt: number;
  status: ToolCallStatus | null;
}

export type AdminEvent =
  | (ChatRef & { direction: string; kind: 'message'; seq: number })
  | (ChatRef & {
      agentId: string | null;
      endedAt: number | null;
      id: string;
      kind: 'task';
      model: string | null;
      startedAt: number | null;
      status: string;
    })
  | {
      endedAt: number | null;
      kind: 'tool';
      name: string;
      seq: number;
      startedAt: number;
      status: ToolCallStatus | null;
      taskId: string;
    }
  | (ChatRef & { id: string; kind: 'approval'; status: string })
  | (ChatRef & { kind: 'summary'; throughSeq: number })
  | (ChatRef & { kind: 'chat' })
  | { id: string; kind: 'schedule'; lastRun: number | null; status: string }
  | { kind: 'reload' };

export interface AdminAgent {
  active: number;
  chats: number;
  failedToday: number;
  id: string;
  implementation: string;
  isDefault: boolean;
  lastActivity: number | null;
  login: 'signed-in' | 'required' | 'unknown';
  model?: string;
  recent: readonly (ChatRef & {
    chatTitle: string;
    durationMs: number | null;
    id: string;
    status: string;
    threadId: string | null;
  })[];
  state: 'ready' | 'disabled' | 'error';
  tasksToday: number;
}

export interface AdminChat extends ChatRef {
  activeTask: string | null;
  allowlisted: boolean;
  currentTool?: string | null;
  kind: string;
  lastActivity: number | null;
  lastTaskStatus: string | null;
  latestSeq: number;
  messageCount: number;
  pendingApprovals: number;
  platform: string;
  preview?: { sender: string | null; text: string } | null;
  route: {
    agentId?: string;
    isDefault: boolean;
    model?: string;
    serviceTier?: string;
    thinking?: string;
  };
  summary: { throughSeq: number; updatedAt: number | null } | null;
  threadId: string | null;
  title: string | null;
}

export interface AdminModelGap {
  endedAt: number;
  inputTokens?: number;
  nextToolSeq?: number;
  outputTokens?: number;
  startedAt: number;
}

export interface AdminAgentTiming {
  agentMs: number;
  modelGaps: readonly AdminModelGap[];
  modelMs: number;
  toolMs: number;
}

export interface AdminTask extends ChatRef {
  agentId: string | null;
  agentTiming?: AdminAgentTiming;
  createdAt: number;
  error?: string;
  finishedAt: number | null;
  id: string;
  inputTokens?: number;
  model: string | null;
  outputTokens?: number;
  silent?: boolean;
  sourceSeq?: number | null;
  startedAt: number | null;
  status: string;
  tools: readonly AdminToolCall[];
}

export type TriggerReason =
  | 'dm-owner'
  | 'mention'
  | 'reply-to-bot'
  | 'command'
  | 'scheduled'
  | 'not-addressed'
  | 'not-allowlisted'
  | 'addressed-to-other'
  | 'deleted'
  | 'duplicate';

export interface TriggerDecision extends ChatRef {
  at: number;
  messageId: string;
  reason: TriggerReason;
  taskId?: string | null;
  triggered: boolean;
}

export interface TaskAgent {
  agentId: string;
  kind: string;
  model: string;
  reasoning?: string;
  requestedModel: string;
  serviceTier?: string;
}

export type TaskContextRef =
  | {
      kind: 'system';
      name:
        | 'guidelines'
        | 'private-guidelines'
        | 'schedule-style'
        | 'telegram-tables-bullets'
        | 'telegram-tables-rich';
    }
  | { index: number; kind: 'rule' }
  | { kind: 'summary' }
  | {
      kind: 'history';
      message?: ContextBlock['message'];
      revision?: number;
      seq: number;
      trust: ContextBlock['trust'];
    }
  | { index: number; kind: 'new' };

export interface TaskRefs {
  history: { fromSeq?: number; seqs?: number[]; throughSeq?: number };
  order: TaskContextRef[];
  session: {
    mode: 'ephemeral' | 'fork' | 'new' | 'resumed';
    previousSessionId?: string;
    reason?: string;
    sessionId?: string;
  };
  summary?: { chatId?: string; revision: number };
  tsugimori: { commit: string; dirty?: boolean };
  workspace?: {
    commit?: string;
    files: { blob?: true; path: string; sha256: string }[];
  };
}

export interface TaskOutcome {
  delivery?: {
    adapterId: string;
    parts: { error?: string; messageId?: string; ok: boolean }[];
  };
  error?: {
    code: string;
    message: string;
    stage: 'queue' | 'context' | 'agent' | 'delivery' | 'record' | 'other';
  };
  kind: 'delivered' | 'silent' | 'failed' | 'cancelled' | 'no-agent';
  silentReason?: string;
}

export interface TaskTiming {
  agentMs: number;
  contextMs: number;
  deliveryMs: number;
  firstTokenMs?: number;
  queuedMs: number;
  toolsMs: number;
  totalMs: number;
}

export interface TaskSupplement {
  afterEventSeq: number;
  at: number;
  messageId: string;
}

export type TaskEvent = { at: number; seq: number } & (
  | { data: { text: string }; kind: 'text' | 'reasoning' }
  | { data: { toolSeq: number }; kind: 'tool'; tool?: AdminToolCall }
  | { data: { messageId: string }; kind: 'supplement' }
  | {
      data: {
        status?: string;
        tokensAfter?: number;
        tokensBefore?: number;
        trigger: string;
      };
      kind: 'compaction';
    }
  | { data: NonNullable<TaskOutcome['error']>; kind: 'error' }
);

export interface TaskExecution {
  agent: TaskAgent | null;
  input: ContextBlock[] | null;
  outcome: TaskOutcome;
  output: string | null;
  refs: TaskRefs;
  supplements: TaskSupplement[];
  timing: TaskTiming;
}

export interface AdminTaskRecord extends Partial<TaskExecution> {
  context: readonly {
    kind: 'fixed' | 'history' | 'summary' | 'new';
    message?: ContextBlock['message'];
    ref: string;
    text?: string;
    title: string;
  }[];
  events: readonly TaskEvent[];
  task: AdminTask;
  trigger?: TriggerDecision;
}

export interface AdminConversation {
  approvals?: AdminApprovals['approvals'];
  chat: AdminChat;
  messages: readonly {
    adapterId?: string;
    chatId?: string;
    deleted: boolean;
    direction: string;
    displayName: string | null;
    recordedAt: number | null;
    seq: number;
    text: string;
    trigger?: TriggerDecision;
    userId: string | null;
  }[];
  older?: number;
  schedules?: AdminSchedules['schedules'];
  tasks: readonly AdminTask[];
}

export interface AdminTrace {
  chat: AdminChat;
  spans: readonly {
    attrs: Record<string, unknown>;
    durationMs: number;
    id?: number | string;
    name: string;
    parentId?: number | string | null;
    startedAt: number;
    status: string;
  }[];
  task: AdminTask;
}

export interface AdminApprovals {
  approvals: readonly (ChatRef & {
    action: string;
    args?: string | null;
    chat?: AdminChat;
    decidedAt: number | null;
    decidedBy: string | null;
    failureReason?: string | null;
    id: string;
    requestedAt?: number | null;
    requester: string;
    requesterDisplay?: string | null;
    resource: ResourceRef;
    status: string;
  })[];
  grants: readonly (ChatRef & {
    action: string;
    createdAt: number;
    grantedBy: string;
    grantedTo: string;
    mode: string;
    revokedAt: number | null;
    scope: ResourcePattern | ResourceRef;
  })[];
}

export interface AdminWorkspace {
  locale: 'en' | 'zh-TW';
  name?: string;
  pendingApprovals?: number;
  schedules?: boolean;
  timezone: string;
}

export interface AdminOverview {
  chats: readonly AdminChat[];
  records: { bytes: number; maxBytes: number; oldestFullTaskAt?: number };
  totals: {
    chats: number;
    failedToday: number;
    pendingApprovals: number;
    tasksToday: number;
  };
  webhook: WebhookStatus;
}

export interface AdminSchedules {
  schedules: readonly (ChatRef & {
    chat?: AdminChat;
    id: string;
    lastRun?: number | null;
    nextDueAt: number | null;
    status: string;
    title: string;
  })[];
}

export type AdminTaskSort = 'newest' | 'oldest' | 'duration';

export interface AdminTaskFilter {
  agent?: string;
  before?: number;
  chat?: ChatRef;
  cursor?: { createdAt: number; durationMs?: number | null; id: string };
  limit: number;
  platform?: string;
  q?: string;
  since?: number;
  sort?: AdminTaskSort;
  status?: string;
}

export interface AdminTaskSummary extends ChatRef {
  agentId: string | null;
  chatKey: string;
  chatTitle: string;
  createdAt: number;
  durationMs: number | null;
  error: string | null;
  finishedAt: number | null;
  id: string;
  inputTokens: number | null;
  model: string | null;
  outputTokens: number | null;
  platform: string;
  silent: boolean;
  startedAt: number | null;
  status: string;
  toolCount: number;
  triggerReason: TriggerReason | null;
  triggerText: string | null;
}

export interface AdminTaskPage {
  nextCursor: string | null;
  tasks: readonly AdminTaskSummary[];
}

export interface AdminReader {
  agents(now: number): readonly AdminAgent[];
  approvals(recentLimit?: number): AdminApprovals;
  chat(ref: ChatRef, before?: number): AdminConversation | undefined;
  chats(): readonly AdminChat[];
  messageRaw(ref: ChatRef, seq: number): unknown;
  overview(now: number, agentId?: string): AdminOverview;
  pendingApprovals(now: number): number;
  schedules?(): AdminSchedules;
  subscribe(listener: (event: AdminEvent) => void): () => void;
  task(taskId: string): Promise<AdminTaskRecord | undefined>;
  tasks(filter: AdminTaskFilter): readonly AdminTaskSummary[];
  toolCall(taskId: string, seq: number): AdminToolCall | undefined;
  trace(taskId: string): AdminTrace | undefined;
  workspace(): AdminWorkspace;
}
