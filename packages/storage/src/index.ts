import type {
  AdapterCursor,
  ApprovalFeedback,
  ChatRef,
  Grant,
  PluginInstanceConfig,
  PreviewCloseReason,
  PrincipalRef,
  ResourceRef,
  TextRange,
} from '@tsugimori/plugin-sdk';

export interface ChatRecord extends ChatRef {
  agentId: string | null;
  allowlisted: boolean;
  kind: 'dm' | 'group' | 'supergroup';
  migratedToChatId: string | null;
  model: string | null;
  serviceTier: string | null;
  thinking: string | null;
  title: string | null;
}

export type ChatRoute = Partial<
  Pick<ChatRecord, 'agentId' | 'model' | 'serviceTier' | 'thinking'>
>;

export interface CommandScopeChat extends ChatRef {
  botId: string;
}

export interface UserRecord extends PrincipalRef {
  display: string | null;
  username: string | null;
}

export interface MessageRecord extends ChatRef {
  deleted: boolean;
  direction: 'inbound' | 'outbound';
  messageId: string;
  migratedFromChatId: string;
  raw: unknown;
  recordedAt: number | null;
  replyTo: string | null;
  seq: number;
  text: string;
  threadId: string | null;
  userId: string | null;
}

export type HistoryQuery = { limit: number } & (
  | { fromSeq: number; throughSeq: number }
  | {
      beforeSeq?: number;
      fromTime?: number;
      query: string;
      toTime?: number;
      userId?: string;
    }
);

export type HistoryMessage = Pick<
  MessageRecord,
  'direction' | 'recordedAt' | 'seq' | 'text' | 'userId'
> & { displayName: string | null };

export interface ChatSummary extends ChatRef {
  revision: number;
  text: string;
  throughSeq: number;
  updatedAt: number | null;
}

export type SessionMetric = 'context' | 'compaction' | 'contextWindow';

export interface SessionHistory {
  compactions: number;
  createdAt?: number;
  firstActivityAt?: number;
}

export interface AgentSession extends ChatRef {
  agentId: string;
  /** The model at session creation, which keeps the session scope stable. */
  model: string;
  scopeChatId?: string | null;
  seenAfter: number[];
  sessionId: string;
  throughSeq: number;
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'sending'
  | 'sent'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'delivery-unknown';

export interface TaskRecord extends ChatRef {
  agentId: string | null;
  createdAt: number;
  finishedAt: number | null;
  id: string;
  model: string | null;
  sourceChatId?: string | null;
  sourceMessageId: string;
  startedAt: number | null;
  status: TaskStatus;
}

export interface ApprovalRecord extends ChatRef {
  action: string;
  approverId: string | null;
  continuation: ApprovalContinuation | null;
  decidedAt: number | null;
  decidedBy: string | null;
  expiresAt: number | null;
  failureReason?: string | null;
  id: string;
  migratedPrompt?: string | null;
  promptFormat: ApprovalPromptFormat | null;
  promptMessageId: string | null;
  requester: string;
  resource: ResourceRef;
  status: 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';
  taskId: string;
}

export type ApprovalPromptFormat = Pick<ApprovalFeedback, 'entities' | 'pre'>;

export type ApprovalContinuation =
  | { change: ScheduleChange; kind: 'schedule' }
  | { args: unknown; kind: 'tool'; name: string };

export interface SetupRun {
  category: 'agent' | 'platform';
  draft: {
    entry: PluginInstanceConfig & Record<string, unknown>;
    ownerId?: string;
  };
  id: string;
  lease: string | null;
  leaseUntil: number;
  mode: 'add' | 'login';
  status: 'pending' | 'complete' | 'cancelled';
  step: number;
}

export interface StoredGrant
  extends Omit<Grant, 'createdAt' | 'revokedAt'>, ChatRef {
  consumedAt: number | null;
  createdAt: number;
  grantedTo: string;
  id: string;
  revokedAt: number | null;
}

export interface GrantQuery extends ChatRef {
  action: string;
  grantedBy: string;
  requester: string;
  resource: ResourceRef;
}

export interface TraceSpan {
  attrs: Record<string, boolean | number | string | null>;
  durationMs: number;
  endedAt: number;
  name: string;
  startedAt: number;
  status: 'ok' | 'error';
}

export type NewMessage = Omit<
  MessageRecord,
  'seq' | 'deleted' | 'migratedFromChatId' | 'recordedAt'
> &
  Partial<Pick<MessageRecord, 'migratedFromChatId'>>;
export type InboundRecord = NewMessage & {
  direction: 'inbound';
  userId: string;
};

export type ScheduleTrigger =
  | { at: number; kind: 'once' }
  | {
      expr: string;
      /** First occurrence selected when the scheduler saved this trigger. */
      firstDueAt?: number;
      from?: number;
      kind: 'cron';
      until?: number;
    }
  | { at: number; kind: 'interval'; minutes: number; until?: number };

export type ScheduleAction =
  | { kind: 'message'; mentions?: ReminderMention[]; text: string }
  | { kind: 'agent'; model?: string; prompt: string };

export interface ReminderMention {
  displayName?: string;
  ranges: TextRange[];
  userId: string;
}

export interface ScheduleAddress {
  chatId: string;
  threadId?: string;
}

export interface ScheduleRecord extends ChatRef {
  action: ScheduleAction;
  address: ScheduleAddress;
  createdBy: string;
  deliveryApprovedBy: string | null;
  failureReason?: string | null;
  id: string;
  mentions: string[];
  missed: 'latest' | 'skip';
  nextDueAt: number | null;
  status: 'active' | 'paused' | 'cancelled' | 'done' | 'failed';
  target: ScheduleAddress;
  timezone: string;
  trigger: ScheduleTrigger;
}

export interface ScheduleChange {
  approverName?: string;
  previous?: ScheduleRecord;
  schedule: ScheduleRecord;
}

export interface ScheduleRun {
  dueAt: number;
  finishedAt: number | null;
  scheduleId: string;
  startedAt: number;
  status:
    | 'claimed'
    | 'sent'
    | 'completed'
    | 'failed'
    | 'delivery-unknown'
    | 'skipped';
}

export interface WorkspaceSettings {
  agentId?: string;
  model?: string;
  thinking?: string;
}

export interface StoredPreview extends ChatRef {
  closedAt: number | null;
  closedReason: PreviewCloseReason | null;
  createdAt: number;
  expiresAt: number;
  id: string;
  openedBy: string;
  port: number;
  provider: string;
  url: string;
}

export interface Store {
  approvalStatus(
    ref: ChatRef,
    now: number,
    includeRecent?: boolean,
  ): {
    chat: number;
    latest?: Pick<ApprovalRecord, 'failureReason' | 'status'>;
    nextExpiry: number | null;
    total: number;
  };
  beginSummary(ref: ChatRef): ChatSummary;
  cancelApproval(id: string, now: number): void;
  cancelChatApprovals(
    ref: ChatRef,
    now: number,
    sourceMessageId?: string,
    sourceChatId?: string,
  ): void;
  claimPairing(principal: PrincipalRef, digest: string, now: number): boolean;
  claimScheduleRun(
    schedule: ScheduleRecord,
    run: ScheduleRun,
    nextDueAt: number | null,
    failureReason?: string,
  ): boolean;
  claimSetupRun(run: SetupRun, now: number): SetupRun | undefined;
  clearAgentSessions(agentId: string): void;
  clearSession(ref: ChatRef): void;
  clearUnavailableCommandScopes(ref: CommandScopeChat): void;
  close(): void;
  closePreview(
    id: string,
    closedAt: number,
    closedReason: PreviewCloseReason,
  ): void;
  closePreviewsOnRestart(now: number): StoredPreview[];
  consumeGrant(
    query: GrantQuery,
    now: number,
    matches: (scope: StoredGrant['scope'], resource: ResourceRef) => boolean,
  ): boolean;
  createApproval(approval: ApprovalRecord): void;
  createSchedule(schedule: ScheduleRecord, limit: number): boolean;
  createTask(task: TaskRecord): void;
  decideApproval(
    id: string,
    decision: {
      decidedAt: number;
      decidedBy: string;
      failureReason?: string;
      status: 'approved' | 'denied';
    },
    grant?: StoredGrant,
    scheduleLimit?: number,
  ): { scheduleApplied?: boolean } | undefined;
  deliveryAddress(
    ref: ChatRef,
  ):
    | (ScheduleAddress & { kind: ChatRecord['kind']; userId: string })
    | undefined;
  dueSchedules(now: number, adapterIds: readonly string[]): ScheduleRecord[];
  expireApprovals(now: number, adapterIds: readonly string[]): ApprovalRecord[];
  findApprovalByPrompt(
    ref: ChatRef,
    promptMessageId: string,
  ): ApprovalRecord | undefined;
  finishScheduleRun(run: ScheduleRun): void;
  getApproval(id: string): ApprovalRecord | undefined;
  getChat(ref: ChatRef): ChatRecord | undefined;
  getCursor(adapterId: string, stream: string): AdapterCursor | undefined;
  getMessage(
    ref: ChatRef,
    messageId: string,
    migratedFromChatId?: string,
  ): MessageRecord | undefined;
  getOwner(adapterId: string): string | undefined;
  getSchedule(id: string): ScheduleRecord | undefined;
  /** Look up the active session, optionally restricted to its original model. */
  getSession(
    ref: ChatRef,
    agentId: string,
    model?: string,
  ): AgentSession | undefined;
  getSetupRun(id: string): SetupRun | undefined;
  getSummary(ref: ChatRef): ChatSummary | undefined;
  getSummaryStatus(
    ref: ChatRef,
  ): { messages: number; updatedAt: number | null } | undefined;
  getTask(id: string): TaskRecord | undefined;
  getUser(ref: PrincipalRef): UserRecord | undefined;
  getUserDisplay(ref: PrincipalRef): string | undefined;
  getWorkspaceSettings(ref: ChatRef): WorkspaceSettings | undefined;
  historyMessages(ref: ChatRef, query: HistoryQuery): HistoryMessage[];
  insertGrant(grant: StoredGrant): void;
  interruptScheduleRuns(now: number): void;
  interruptTasks(now: number): void;
  isSetupSecret(ref: ChatRef, messageId: string): boolean;
  latestSessionSpan(
    scope: string,
    metric: SessionMetric,
  ): TraceSpan | undefined;
  linkApproval(
    id: string,
    promptMessageId: string,
    format?: ApprovalPromptFormat,
  ): void;
  listApprovals(): ApprovalRecord[];
  listChatMessages(
    ref: ChatRef,
    before?: number,
  ): Omit<MessageRecord, 'raw' | 'recordedAt'>[];
  listChats(): ChatRecord[];
  listChatTasks(ref: ChatRef): TaskRecord[];
  listGrants(): StoredGrant[];
  listMigratedApprovalPrompts(adapterId: string, now: number): ApprovalRecord[];
  listPendingApprovals(ref: ChatRef): ApprovalRecord[];
  listPreviews(adapterId?: string): StoredPreview[];
  listSchedules(ref: ChatRef): ScheduleRecord[];
  listUnavailableCommandScopes(
    ref: Omit<CommandScopeChat, 'chatId'>,
  ): { chatId: string; scope: string }[];
  markCommandScopeUnavailable(ref: CommandScopeChat, scope: string): void;
  markDeleted(
    ref: ChatRef,
    messageId: string,
    migratedFromChatId?: string,
  ): void;
  markSetupSecret(ref: ChatRef, messageId: string): void;
  migrateChat(ref: ChatRef, newChatId: string, title?: string): boolean;
  openPreview(preview: StoredPreview): void;
  recentMessages(
    ref: ChatRef,
    options: {
      afterSeq?: number;
      afterSummarySeq?: number;
      limit?: number;
      skipSeq?: readonly number[];
      throughSeq: number;
    },
  ): MessageRecord[];
  recordInbound(
    chat: ChatRef & Pick<ChatRecord, 'kind' | 'title'>,
    user: Omit<UserRecord, 'username'> & Partial<Pick<UserRecord, 'username'>>,
    message: InboundRecord,
    edited?: boolean,
  ): MessageRecord | undefined;
  recordOutbound(message: NewMessage, taskId?: string): void;
  recordUser(
    user: Omit<UserRecord, 'username'> & Partial<Pick<UserRecord, 'username'>>,
  ): void;
  resolveChat(ref: ChatRef): ChatRef;
  saveCursor(adapterId: string, stream: string, cursor: AdapterCursor): void;
  savePairingCode(adapterId: string, digest: string, expiresAt: number): void;
  saveSetupRun(run: SetupRun, lease: string): boolean;
  saveSummary(summary: ChatSummary): boolean;
  scheduleStatus(
    adapterId: string,
    target: ScheduleAddress,
  ): {
    count: number;
    failed?: Pick<ScheduleRecord, 'failureReason' | 'id'>;
    next?: Pick<
      ScheduleRecord,
      'action' | 'id' | 'nextDueAt' | 'timezone' | 'trigger'
    >;
  };
  sessionHistory(scope: string): SessionHistory;
  setAllowlisted(ref: ChatRef, allowlisted: boolean): void;
  setChatRoute(
    ref: ChatRef,
    route: ChatRoute,
    invalidateSession?: boolean,
  ): void;
  setSession(session: AgentSession): void;
  setWorkspaceSettings(ref: ChatRef, settings: WorkspaceSettings): void;
  summaryMessages(
    ref: ChatRef,
    afterSeq: number,
    throughSeq: number,
    limit: number,
    offset?: number,
  ): MessageRecord[];
  taskTrace(taskId: string): TraceSpan[];
  updateSchedule(
    schedule: ScheduleRecord,
    expected: ScheduleRecord,
    limit: number,
  ): boolean;
  updateTask(
    id: string,
    patch: Partial<Omit<TaskRecord, keyof ChatRef | 'id' | 'sourceMessageId'>>,
  ): void;
  writeTraceSpans(spans: readonly TraceSpan[]): void | Promise<void>;
}
