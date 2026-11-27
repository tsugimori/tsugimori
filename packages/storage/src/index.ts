import type {
  AdapterCursor,
  AdminEvent,
  AdminTaskFilter,
  AdminTaskSummary,
  AdminToolCall,
  ApprovalFeedback,
  ChatRef,
  Grant,
  InboundMessage,
  PluginInstanceConfig,
  PreviewCloseReason,
  PrincipalRef,
  ReplyTarget,
  ResourceRef,
  TaskEvent,
  TaskExecution,
  TaskRefs,
  TextRange,
  TriggerDecision,
  WebhookConfig,
} from '@tsugimori/plugin-sdk';

export interface ChatRecord extends ChatRef {
  agentId: string | null;
  allowlisted: boolean;
  incognitoId: number | null;
  kind: 'dm' | 'group' | 'supergroup';
  migratedToChatId: string | null;
  model: string | null;
  serviceTier: string | null;
  sessionAgentId?: string | null;
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

export type MessageMetadata = Pick<
  InboundMessage,
  | 'at'
  | 'attachments'
  | 'mentionsBot'
  | 'repliesToBot'
  | 'replyTo'
  | 'sender'
  | 'userDisplay'
> & {
  privateReply?: boolean;
  sessionBoundary?: boolean;
  sideQuestion?: boolean;
};

export interface MessageRecord extends ChatRef {
  albumId?: string | null;
  deleted: boolean;
  direction: 'inbound' | 'outbound';
  displayName?: string | null;
  incognitoId?: number | null;
  messageId: string;
  metadata?: MessageMetadata | null;
  migratedFromChatId: string;
  raw: unknown;
  recordedAt: number | null;
  replyTo: string | null;
  revision?: number;
  seq: number;
  text: string;
  threadId: string | null;
  userId: string | null;
}

export type AlbumMessage = MessageRecord & { attachmentOffset: number };

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
  | 'albumId'
  | 'direction'
  | 'messageId'
  | 'metadata'
  | 'migratedFromChatId'
  | 'recordedAt'
  | 'replyTo'
  | 'seq'
  | 'text'
  | 'userId'
> & { displayName: string | null };

export interface ChatSummary extends ChatRef {
  revision: number;
  text: string;
  throughSeq: number;
  updatedAt: number | null;
}

export type SessionMetric =
  'context' | 'compaction' | 'contextWindow' | 'run' | 'usage';

export interface SessionHistory {
  compactions: number;
  createdAt?: number;
  firstActivityAt?: number;
  tasks?: number;
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
  requestedAt?: number | null;
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
  category: 'agent' | 'platform' | 'webhook';
  draft: {
    entry: PluginInstanceConfig & Record<string, unknown>;
    ownerId?: string;
    webhooks?: WebhookConfig;
  };
  id: string;
  lease: string | null;
  leaseUntil: number;
  mode: 'add' | 'login' | 'remove';
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

export interface RemovalTarget {
  category: 'agent' | 'platform';
  id: string;
}

export interface RemovalRows {
  chats: string[];
  counts: Record<string, number>;
  routes: ChatRef[];
  schedules: string[];
  tasks: string[];
  workspaceSettings: ChatRef[];
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

export interface ToolCallRecord extends AdminToolCall {
  approvalId: string | null;
  taskId: string;
}

export interface ActiveTaskRefs extends ChatRef {
  refs: Pick<TaskRefs, 'summary' | 'workspace'>;
  taskId: string;
}

export interface IndexedSticker {
  description: string;
  emoji: string | null;
  fileId: string;
  format: 'animated' | 'static' | 'video';
  uniqueId: string;
}

export interface StickerDescription {
  createdAt: number;
  description: string;
  emoji?: string;
  keywords?: string[];
  model: string;
  platformKind: string;
  stickerId: string;
}

export interface StickerSetStatus {
  blocked: boolean;
  count: number;
  name: string;
}

export interface Store {
  adminAgentActivity(
    agentId: string,
    since: number,
    now: number,
  ): {
    active: number;
    failedToday: number;
    lastActivity: number | null;
    recent: readonly TaskRecord[];
    tasksToday: number;
  };
  adminChatActivity(
    ref: ChatRef,
    now: number,
  ): {
    activeTask: TaskRecord | undefined;
    currentTool: string | null;
    lastTask: TaskRecord | undefined;
    latestSeq: number;
    messageCount: number;
    messageTime: number | null;
    pendingApprovals: number;
    preview: { sender: string | null; text: string } | null;
    threadId: string | null;
  };
  adminChatApprovals(ref: ChatRef, now: number): readonly ApprovalRecord[];
  adminChatSchedules(ref: ChatRef): readonly ScheduleRecord[];
  adminChatTasks(
    ref: ChatRef,
    page: {
      before?: number;
      oldestSeq?: number;
      oldestTime?: number | null;
    },
  ): (TaskRecord & { sourceSeq: number | null })[];
  adminLastScheduleRun(id: string): number | null;
  adminTaskCounts(
    since: number,
    now: number,
  ): {
    failedToday: number;
    pendingApprovals: number;
    tasksToday: number;
  };
  adminTasks(
    filter: AdminTaskFilter,
    platforms: ReadonlyMap<string, string>,
  ): readonly AdminTaskSummary[];
  adminToolCall(taskId: string, seq: number): ToolCallRecord | undefined;
  appendTaskEvents(
    taskId: string,
    events: readonly TaskEvent[],
    replaceAfterSeq?: number,
  ): void;
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
  backup(path: string): void;
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
  clearSession(ref: ChatRef, incognitoId?: number | null): void;
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
  contextBlob(sha256: string): string | undefined;
  contextMessage(
    ref: ChatRef,
    seq: number,
    revision?: number,
  ):
    | Pick<
        MessageRecord,
        | 'albumId'
        | 'displayName'
        | 'messageId'
        | 'metadata'
        | 'migratedFromChatId'
        | 'recordedAt'
        | 'replyTo'
        | 'text'
        | 'userId'
      >
    | undefined;
  countPendingApprovals(now: number): number;
  countStickerDescriptions(): number;
  createApproval(approval: ApprovalRecord): void;
  createSchedule(schedule: ScheduleRecord, limit: number): boolean;
  createTask(task: TaskRecord): void;
  createToolCall(call: Omit<ToolCallRecord, 'seq'>): number | undefined;
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
  deleteInstanceData(
    target: RemovalTarget,
    fileRoutes: readonly ChatRef[],
    now: number,
  ): Record<string, number>;
  deletePairingCode(adapterId: string): void;
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
  getIndexedSticker(
    name: string,
    uniqueId: string,
  ): Pick<IndexedSticker, 'description' | 'emoji'> | undefined;
  /** Unfiltered lookup for administration and message bookkeeping. */
  getMessage(
    ref: ChatRef,
    messageId: string,
    migratedFromChatId?: string,
    includeRaw?: boolean,
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
  getStickerDescription(
    platformKind: string,
    stickerId: string,
  ): StickerDescription | undefined;
  getStickerDescriptions(
    name: string,
  ): { description: string; uniqueId: string }[];
  getSummary(ref: ChatRef): ChatSummary | undefined;
  getSummaryStatus(
    ref: ChatRef,
  ): { messages: number; updatedAt: number | null } | undefined;
  getSummaryVersion(ref: ChatRef, revision: number): string | undefined;
  getTask(id: string): TaskRecord | undefined;
  getTaskEvents(taskId: string): readonly TaskEvent[];
  getTaskExecution(taskId: string): TaskExecution | undefined;
  getUser(ref: PrincipalRef): UserRecord | undefined;
  getUserDisplay(ref: PrincipalRef): string | undefined;
  getWorkspaceSettings(ref: ChatRef): WorkspaceSettings | undefined;
  hasStickerSet(name: string, botId: string): boolean;
  historyMessages(ref: ChatRef, query: HistoryQuery): HistoryMessage[];
  insertGrant(grant: StoredGrant): void;
  inspectInstanceData(
    target: RemovalTarget,
    fileRoutes: readonly ChatRef[],
  ): RemovalRows;
  instanceSetupRuns(target: RemovalTarget): SetupRun[];
  interruptScheduleRuns(now: number): void;
  interruptTasks(now: number): void;
  isSetupSecret(
    ref: ChatRef,
    messageId: string,
    migratedFromChatId?: string,
  ): boolean;
  isStickerSetBlocked(name: string): boolean;
  latestSessionSpan(
    scope: string,
    metric: SessionMetric,
  ): TraceSpan | undefined;
  linkApproval(
    id: string,
    promptMessageId: string,
    format?: ApprovalPromptFormat,
  ): void;
  listAdminSchedules(): ScheduleRecord[];
  listApprovals(now?: number, recentLimit?: number): ApprovalRecord[];
  listChatMessages(
    ref: ChatRef,
    before?: number,
  ): (Omit<MessageRecord, 'raw'> & { displayName: string | null })[];
  listChats(): ChatRecord[];
  listChatTasks(ref: ChatRef): TaskRecord[];
  listGrants(): StoredGrant[];
  listMigratedApprovalPrompts(adapterId: string, now: number): ApprovalRecord[];
  listPendingApprovals(ref: ChatRef): ApprovalRecord[];
  listPreviews(adapterId?: string): StoredPreview[];
  listSchedules(ref: ChatRef): ScheduleRecord[];
  listStickerSets(): StickerSetStatus[];
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
  messageAlbum(
    ref: ChatRef,
    albumId: string,
    migratedFromChatId: string,
  ): AlbumMessage[];
  messageRaw(ref: ChatRef, seq: number): unknown;
  /** Unknown targets can use platform-supplied reply data only outside incognito. */
  messageVisible(
    ref: ChatRef,
    messageId: string,
    migratedFromChatId: string,
  ): boolean;
  migrateChat(ref: ChatRef, newChatId: string, title?: string): boolean;
  openPreview(preview: StoredPreview): void;
  pruneRecords(
    maxBytes: number,
    active?: readonly ActiveTaskRefs[],
  ): { bytes: number; tasks: number };
  /** A source sequence restricts the lookup to a resolved reply shown to the agent. */
  quotedAttachmentMessage(
    ref: ChatRef,
    messageId: string,
    migratedFromChatId: string,
    sourceSeq?: number,
  ): MessageRecord | undefined;
  recentMessages(
    ref: ChatRef,
    options: {
      afterSeq?: number;
      afterSummarySeq?: number;
      includeRaw?: boolean;
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
  recordUsage(): { bytes: number; oldestFullTaskAt?: number };
  recordUser(
    user: Omit<UserRecord, 'username'> & Partial<Pick<UserRecord, 'username'>>,
  ): void;
  releaseRemoval(id: string, lease: string): void;
  /** Whether an explicit reply can expose this known target. */
  replyTargetVisible(
    ref: ChatRef,
    messageId: string,
    migratedFromChatId: string,
  ): boolean;
  resolveChat(ref: ChatRef): ChatRef;
  saveContextBlob(sha256: string, content: string): void;
  saveCursor(adapterId: string, stream: string, cursor: AdapterCursor): void;
  savePairingCode(adapterId: string, digest: string, expiresAt: number): void;
  saveSetupRun(run: SetupRun, lease: string): boolean;
  saveStickerDescription(sticker: StickerDescription): void;
  saveStickerSet(
    name: string,
    botId: string,
    source: ChatRef,
    stickers: readonly IndexedSticker[],
  ): boolean;
  saveSummary(summary: ChatSummary): boolean;
  saveTaskExecution(taskId: string, record: TaskExecution): void;
  saveTrigger(decision: TriggerDecision, messageSeq?: number): void;
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
  searchStickers(
    botId: string,
    query: string,
    limit: number,
  ): { description: string; emoji?: string; fileId: string }[];
  sessionHistory(scope: string): SessionHistory;
  setAllowlisted(ref: ChatRef, allowlisted: boolean): void;
  setChatRoute(
    ref: ChatRef,
    route: ChatRoute,
    invalidateSession?: boolean,
  ): void;
  setSession(session: AgentSession): void;
  setStickerSetBlocked(name: string, blocked: boolean): void;
  setWorkspaceSettings(ref: ChatRef, settings: WorkspaceSettings): void;
  subscribeAdmin?(listener: (event: AdminEvent) => void): () => void;
  summaryMessages(
    ref: ChatRef,
    afterSeq: number,
    throughSeq: number,
    limit: number,
    offset?: number,
  ): MessageRecord[];
  taskToolCalls(
    taskIds: readonly string[],
    details?: boolean | 'args',
  ): ToolCallRecord[];
  taskTrace(taskId: string): TraceSpan[];
  triggerForTask(task: TaskRecord): TriggerDecision | undefined;
  triggersForMessages(
    seqs: readonly number[],
  ): ReadonlyMap<number, TriggerDecision>;
  updateSchedule(
    schedule: ScheduleRecord,
    expected: ScheduleRecord,
    limit: number,
  ): boolean;
  updateTask(
    id: string,
    patch: Partial<Omit<TaskRecord, keyof ChatRef | 'id' | 'sourceMessageId'>>,
  ): void;
  updateToolCall(
    seq: number,
    patch: Partial<
      Pick<
        ToolCallRecord,
        'approvalId' | 'args' | 'endedAt' | 'result' | 'status'
      >
    >,
  ): void;
  visibleReply(
    ref: ChatRef,
    reply: ReplyTarget,
    migratedFromChatId: string,
  ): ReplyTarget;
  writeTraceSpans(spans: readonly TraceSpan[]): void | Promise<void>;
}
