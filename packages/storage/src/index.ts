import type {
  AdapterCursor,
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
  model: string | null;
  title: string | null;
}

export interface MessageRecord extends ChatRef {
  deleted: boolean;
  direction: 'inbound' | 'outbound';
  messageId: string;
  raw: unknown;
  replyTo: string | null;
  seq: number;
  text: string;
  threadId: string | null;
  userId: string | null;
}

export interface ChatSummary extends ChatRef {
  revision: number;
  text: string;
  throughSeq: number;
}

export interface AgentSession extends ChatRef {
  agentId: string;
  model: string;
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
  sourceMessageId: string;
  startedAt: number | null;
  status: TaskStatus;
}

export interface ApprovalRecord extends ChatRef {
  action: string;
  approverId: string | null;
  decidedAt: number | null;
  decidedBy: string | null;
  id: string;
  onceOnly: boolean;
  promptMessageId: string | null;
  requester: string;
  resource: ResourceRef;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  taskId: string;
}

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
  status: 'pending' | 'complete';
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

export type NewMessage = Omit<MessageRecord, 'seq' | 'deleted'>;
export type InboundRecord = NewMessage & {
  direction: 'inbound';
  userId: string;
};

export type ScheduleTrigger =
  | { at: number; kind: 'once' }
  | { expr: string; kind: 'cron'; until?: number }
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
  id: string;
  mentions: string[];
  missed: 'latest' | 'skip';
  nextDueAt: number | null;
  status: 'active' | 'paused' | 'cancelled' | 'done';
  target: ScheduleAddress;
  timezone: string;
  trigger: ScheduleTrigger;
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
  beginSummary(ref: ChatRef): ChatSummary;
  cancelApproval(id: string, now: number): void;
  cancelApprovals(taskId: string, now: number): void;
  claimPairing(principal: PrincipalRef, digest: string, now: number): boolean;
  claimScheduleRun(
    schedule: ScheduleRecord,
    run: ScheduleRun,
    nextDueAt: number | null,
  ): boolean;
  claimSetupRun(run: SetupRun, now: number): SetupRun | undefined;
  clearAgentSessions(agentId: string): void;
  clearSession(ref: ChatRef): void;
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
      status: 'approved' | 'denied';
    },
    grant?: StoredGrant,
  ): boolean;
  deliveryAddress(
    ref: ChatRef,
  ):
    | (ScheduleAddress & { kind: ChatRecord['kind']; userId: string })
    | undefined;
  dueSchedules(now: number, adapterIds: readonly string[]): ScheduleRecord[];
  findApprovalByPrompt(
    ref: ChatRef,
    promptMessageId: string,
  ): ApprovalRecord | undefined;
  finishScheduleRun(run: ScheduleRun): void;
  getApproval(id: string): ApprovalRecord | undefined;
  getChat(ref: ChatRef): ChatRecord | undefined;
  getCursor(adapterId: string, stream: string): AdapterCursor | undefined;
  getMessage(ref: ChatRef, messageId: string): MessageRecord | undefined;
  getOwner(adapterId: string): string | undefined;
  getSchedule(id: string): ScheduleRecord | undefined;
  getSession(
    ref: ChatRef,
    agentId: string,
    model: string,
  ): AgentSession | undefined;
  getSetupRun(id: string): SetupRun | undefined;
  getSummary(ref: ChatRef): ChatSummary | undefined;
  getTask(id: string): TaskRecord | undefined;
  getUserDisplay(ref: PrincipalRef): string | undefined;
  getWorkspaceSettings(ref: ChatRef): WorkspaceSettings | undefined;
  insertGrant(grant: StoredGrant): void;
  interruptScheduleRuns(now: number): void;
  interruptTasks(now: number): void;
  isSetupSecret(ref: ChatRef, messageId: string): boolean;
  linkApproval(id: string, promptMessageId: string): void;
  listApprovals(): ApprovalRecord[];
  listChatMessages(ref: ChatRef, before?: number): Omit<MessageRecord, 'raw'>[];
  listChats(): ChatRecord[];
  listChatTasks(ref: ChatRef): TaskRecord[];
  listGrants(): StoredGrant[];
  listPreviews(adapterId?: string): StoredPreview[];
  listSchedules(ref: ChatRef): ScheduleRecord[];
  markDeleted(ref: ChatRef, messageId: string): void;
  markSetupSecret(ref: ChatRef, messageId: string): void;
  openPreview(preview: StoredPreview): void;
  recentMessages(
    ref: ChatRef,
    options: {
      afterSeq?: number;
      afterSummarySeq?: number;
      limit: number;
      skipSeq?: readonly number[];
      throughSeq: number;
    },
  ): MessageRecord[];
  recordInbound(
    chat: ChatRef & Pick<ChatRecord, 'kind' | 'title'>,
    user: PrincipalRef & { display: string | null },
    message: InboundRecord,
    edited?: boolean,
  ): MessageRecord | undefined;
  recordOutbound(message: NewMessage, taskId?: string): void;
  saveCursor(adapterId: string, stream: string, cursor: AdapterCursor): void;
  savePairingCode(adapterId: string, digest: string, expiresAt: number): void;
  saveSetupRun(run: SetupRun, lease: string): boolean;
  saveSummary(summary: ChatSummary): boolean;
  setAllowlisted(ref: ChatRef, allowlisted: boolean): void;
  setChatRoute(
    ref: ChatRef,
    route: Partial<Pick<ChatRecord, 'agentId' | 'model'>>,
  ): void;
  setSession(session: AgentSession): void;
  setWorkspaceSettings(ref: ChatRef, settings: WorkspaceSettings): void;
  summaryMessages(
    ref: ChatRef,
    afterSeq: number,
    throughSeq: number,
    limit: number,
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
