import type { CheckContext, CheckItem, SetupStep } from './setup.ts';

export type {
  CheckContext,
  CheckItem,
  CommandOptions,
  CommandRunner,
  SetupContext,
  SetupDependencies,
  SetupPatch,
  SetupStep,
} from './setup.ts';
export { agentHome, credentialKey, SetupError } from './setup.ts';
export {
  containsMention,
  textMentionMatches,
  userMentionLinks,
} from './mentions.ts';

export interface ChatRef {
  adapterId: string;
  chatId: string;
}

export interface PrincipalRef {
  adapterId: string;
  userId: string;
}

export interface PlatformCapabilities {
  deleteEvents?: boolean;
  inlineButtons?: boolean;
  /** Defaults to `free`. `metered` uses quota for sends outside a current inbound reply. `none` supports only replies to a current inbound. */
  outboundPush?: 'free' | 'metered' | 'none';
  poll?: boolean;
  richText?: boolean;
}

interface InboundBase {
  chatId: string;
  raw?: unknown;
  threadId?: string;
}

export interface InboundMessage extends InboundBase {
  chatKind: 'dm' | 'group' | 'supergroup';
  chatTitle?: string;
  edited?: boolean;
  mentionsBot?: boolean;
  messageId: string;
  repliesToBot?: boolean;
  replyTo?: string;
  text: string;
  type: 'message';
  userDisplay?: string;
  userId: string;
  userUsername?: string | null;
}

export type ApprovalDecision = 'approve' | 'deny';

export type ApprovalReaction = 'pending' | 'approved' | 'denied' | 'expired';

export const pendingApprovalResult = {
  pending: true,
  instruction:
    'The framework handles pending approval feedback. Do not mention the pending approval in your reply.',
} as const;

export interface ChatMigration {
  chatId: string;
  /** The platform service message, when available for chat history. */
  message?: InboundMessage;
  newChatId: string;
  title?: string;
  type: 'chat-migrated';
}

export type PlatformInboundEvent =
  | ChatMigration
  | InboundMessage
  | (InboundBase & { messageId: string; type: 'delete' })
  | (InboundBase & {
      callbackId: string;
      messageId: string;
      queryId?: string;
      type: 'callback';
      userDisplay?: string;
      userId: string;
      userUsername?: string | null;
    });

export interface ScheduledInboundEvent extends Omit<InboundMessage, 'type'> {
  scheduleId: string;
  type: 'schedule';
}

export type InboundEvent = PlatformInboundEvent | ScheduledInboundEvent;

export interface OutboundMessage {
  /** Whether agent output can add recipients through mentions in its text. */
  allowTextMentions?: boolean;
  approval?: boolean;
  buttons?: readonly { id: string; label: string }[];
  chatId: string;
  entities?: readonly TextEntity[];
  format?: 'markdown';
  mentions?: readonly string[];
  parseTextMentions?: boolean;
  replyTo?: string;
  text: string;
  threadId?: string;
}

export interface TextRange {
  length: number;
  offset: number;
}

export type TextEntity = TextRange &
  ({ type: 'bold' } | { type: 'pre' } | { type: 'mention'; userId: string });

export interface SendReceipt {
  approvalEntities?: readonly TextEntity[];
  messageId: string;
  parts?: readonly SendPart[];
  raw?: unknown;
}

export interface SendPart {
  /** Native destination if delivery moved to another chat. */
  chatId?: string;
  messageId: string;
  raw?: unknown;
  text: string;
}

export class SendFailure extends Error {
  constructor(
    options: {
      deliveryUnknown: boolean;
      parts: readonly SendPart[];
    },
    cause: unknown,
  ) {
    super('Platform send failed', { cause });
    this.deliveryUnknown = options.deliveryUnknown;
    this.parts = options.parts;
  }

  readonly deliveryUnknown: boolean;
  readonly parts: readonly SendPart[];
}

export interface AdapterCursor {
  offset: number;
  updatedAt: number;
}

export interface AdapterContext {
  emit(event: PlatformInboundEvent): Promise<void>;
  getUser?(
    userId: string,
  ): { display: string | null; username: string | null } | undefined;
  loadCursor?(stream: string): AdapterCursor | undefined;
  logError?(event: string, error?: unknown): void;
  logWarning?(event: string): void;
  ready?: Promise<void>;
  resolveChatId?(chatId: string): string;
  saveCursor?(stream: string, cursor: AdapterCursor): void;
  /** Aborted when this startup attempt is cancelled or the adapter detaches. */
  signal?: AbortSignal;
}

/** Optional hints for the gateway when a platform cannot start. */
export class PlatformStartError extends Error {
  readonly options: { failure: CheckItem } | { retryAfterMs: number };

  constructor(message: string, options: PlatformStartError['options']) {
    super(message);
    this.options = options;
  }
}

export interface ApprovalFeedback {
  chatId: string;
  decision?: ApprovalDecision | 'expired';
  decisionText?: string;
  entities?: readonly TextEntity[];
  messageId: string;
  notice: string;
  pre?: TextRange;
  prompt?: string;
  queryId?: string;
}

export interface PlatformCommand {
  description: string;
  name: string;
}

export type PlatformCommandScope =
  | { type: 'default' | 'group-chats' | 'private-chats' }
  | { type: 'private-chat'; userId: string }
  | { chatId: string; type: 'chat-member'; userId: string };

export interface PlatformCommandErrorDetails {
  code?: number;
  migratedToChatId?: string;
  retryAfterMs?: number;
  scopeUnavailable?: boolean;
}

export interface PlatformAdapter {
  /** The bot's native identity. The username excludes the @ prefix. */
  readonly botIdentity?: { id?: string; username: string };
  capabilities: PlatformCapabilities;
  deleteMessage?(
    message: Pick<InboundMessage, 'chatId' | 'messageId'>,
  ): Promise<void>;
  /** Classify command registration errors for the gateway. */
  describeCommandError?(
    error: unknown,
  ): PlatformCommandErrorDetails | undefined;
  id: string;
  kind: string;
  respondToApproval?(feedback: ApprovalFeedback): Promise<void>;
  send(message: OutboundMessage): Promise<SendReceipt>;
  /** Replace the approval reaction on the original message, or clear it on expiry. */
  setApprovalReaction?(
    message: Pick<InboundMessage, 'chatId' | 'messageId'>,
    reaction: ApprovalReaction,
    signal: AbortSignal,
  ): Promise<void>;
  /** Replace commands for this scope, or clear the scope with an empty list. */
  setCommands?(
    commands: readonly PlatformCommand[],
    scope: PlatformCommandScope,
  ): Promise<void>;
  /** May be retried after cleanup. Honor ctx.signal during startup I/O. */
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  tools?(): readonly ToolDefinition[];
  typing?(
    chat: Pick<OutboundMessage, 'chatId' | 'threadId'>,
    signal: AbortSignal,
  ): void;
}

export interface ContextBlock {
  content: string;
  source: 'system' | 'rule' | 'summary' | 'message' | 'tool' | 'external';
  trust: 'trusted' | 'owner' | 'member' | 'untrusted';
}

export type ResourceRef =
  | { id: string; type: 'project' }
  | { deliveryKey: string; id: string; type: 'schedule' }
  | { path: string; type: 'path' }
  | ({ type: 'chat' } & ChatRef)
  | { type: 'global' };

export type ResourcePattern = { path: string; recursive: true; type: 'path' };

export interface Grant {
  action: string;
  createdAt: Date;
  grantedBy: string;
  mode: 'once' | 'always';
  revokedAt?: Date;
  scope: ResourceRef | ResourcePattern;
}

export interface ApprovalRequest {
  action: string;
  description?: string;
  resource: ResourceRef;
}

export type JSONSchema = boolean | Record<string, unknown>;

export type ScheduleApprovalReason =
  'agent' | 'crossChat' | 'delivery' | 'frequency' | 'model';

export interface ScheduleApprovalRequest {
  address: Pick<OutboundMessage, 'chatId' | 'threadId'>;
  agentReason?: string;
  approverId?: string;
  content: string;
  deliveryKey: string;
  dueAt: number;
  id: string;
  kind: 'agent' | 'message';
  model?: string;
  operation: 'create' | 'update';
  reasons: readonly ScheduleApprovalReason[];
  recipients: readonly { name?: string; userId?: string }[];
  repeat?: { cron: string } | { minutes: number };
  reuseGrant: boolean;
  target: ChatRef;
  targetUserId?: string;
  timezone: string;
  until?: number;
}

export type ScheduleApproval =
  | { approvedBy: string }
  | { pending: true }
  | { failureReason?: string; scheduleApplied: boolean };

export interface ToolContext {
  chat: ChatRef;
  principal: PrincipalRef;
  signal: AbortSignal;
  taskId: string;
}

export type ToolResult = unknown;

export interface ToolDefinition<A = unknown> {
  description: string;
  name: string;
  permission?: {
    action: string;
    describe?(args: A, ctx: ToolContext): string;
    resource: (args: A, ctx: ToolContext) => ResourceRef;
    targets?: (args: A, ctx: ToolContext) => PrincipalRef[];
  };
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
  schema: JSONSchema;
}

export interface ExecScope {
  denyRead: string[];
  network: 'none' | 'allow';
  workdir: string;
  writable: string[];
}

export interface RunOptions {
  backgroundPort?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export interface LocalEndpoint {
  closed?: AbortSignal;
  host: string;
  port: number;
}

export interface ExecSession {
  exposePort(port: number): Promise<LocalEndpoint>;
  readFile(path: string): Promise<Uint8Array>;
  run(cmd: string[], opts: RunOptions): Promise<RunResult>;
  stop(): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

export interface ExecBackend {
  id: string;
  start(scope: ExecScope): Promise<ExecSession>;
}

export type AgentTool = Pick<
  ToolDefinition,
  'description' | 'name' | 'schema'
> & {
  run(args: unknown, context?: ToolContext): Promise<ToolResult>;
};

export class ToolFailure extends Error {}

export interface AgentRequest {
  context: ContextBlock[];
  exec?: ExecBackend;
  model: string;
  purpose?: 'summary';
  resumeSessionId?: string;
  sandbox?: ExecScope;
  signal: AbortSignal;
  thinking?: string;
  tools: readonly AgentTool[];
  toolsDisabled?: boolean;
  workdir: string;
}

export interface AgentIO {
  reportCompaction?(event: AgentCompactionEvent): void;
  requestApproval(request: ApprovalRequest): Promise<boolean>;
  supplements: AsyncIterable<InboundMessage>;
}

export interface AgentCompactRequest {
  model: string;
  sandbox?: ExecScope;
  sessionId: string;
  signal: AbortSignal;
  workdir: string;
}

export interface AgentCompaction {
  durationMs?: number;
  tokensAfter?: number;
  tokensBefore?: number;
}

export interface AgentCompactionEvent extends AgentCompaction {
  status?: 'ok' | 'error';
  trigger: 'post-turn' | 'async' | 'manual' | 'native';
  type: 'compaction';
}

export type AgentCompactResult =
  | { status: 'unsupported' | 'skipped' }
  | (AgentCompaction & { shared?: boolean; status: 'compacted' });

export const defaultCompactAt = 250_000;

export function nativeCompactionLimit(
  compactAt: number,
  contextWindow?: number,
) {
  const limit = Math.ceil(Math.max((compactAt * 8) / 5, compactAt + 150_000));
  return Math.min(limit, contextWindow ?? Number.MAX_SAFE_INTEGER);
}

export type AgentEvent =
  | { text: string; type: 'text.delta' }
  | { text: string; type: 'text.final' }
  | { callId: string; name: string; type: 'tool.started' }
  | {
      callId: string;
      name: string;
      status: 'ok' | 'error';
      type: 'tool.finished';
    }
  | { request: ApprovalRequest; type: 'approval.requested' }
  | { error: Error; type: 'error' }
  | AgentCompactionEvent
  | {
      /** Tokens occupying the session context. Null when the provider only reports aggregate usage. */
      contextTokens?: number | null;
      inputTokens?: number;
      outputTokens?: number;
      type: 'usage';
    }
  | { sessionId: string; type: 'sessionId' };

export function toolWireName(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface AgentDefaults {
  effort?: string;
  model?: string;
  serviceTier?: string;
}

export interface AgentQuotaWindow {
  /** Reset timestamp in Unix seconds. */
  resetsAt?: number;
  usedPercent?: number;
  windowDurationMins?: number;
}

export interface AgentQuota {
  limitName?: string;
  planType?: string;
  primary?: AgentQuotaWindow;
  rateLimitReachedType?: string;
  secondary?: AgentQuotaWindow;
}

export interface AgentSessionInfo {
  serviceTier?: string | null;
}

export interface AgentConnector {
  acceptsSession?(id: string, tools: readonly ToolDefinition[]): boolean;
  compact?(request: AgentCompactRequest): Promise<AgentCompactResult>;
  /** Describe locally known defaults for the gateway to cache on startup and reload. */
  describeDefaults?(): AgentDefaults | Promise<AgentDefaults>;
  /** Return cached account quota, if available. */
  describeQuota?(): AgentQuota | undefined;
  /** Return locally observed metadata for the given agent session. */
  describeSession?(sessionId: string): AgentSessionInfo | undefined;
  id: string;
  kind: string;
  loop: 'framework' | 'external';
  run(request: AgentRequest, io: AgentIO): AsyncIterable<AgentEvent>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface PluginInstanceConfig {
  enabled?: boolean;
  id: string;
  kind: string;
  options?: Record<string, unknown>;
}

export interface PlatformInstanceConfig extends PluginInstanceConfig {
  [option: string]: unknown;
  tokenEnv?: string;
}

export type AgentInstanceConfig = PluginInstanceConfig & {
  [option: string]: unknown;
  compactAt?: number;
  version?: string;
};

export interface PluginFactoryContext {
  credential(name: string): string | undefined;
  fetch?: typeof globalThis.fetch;
  workspace: string;
}

export type PlatformFactory = (
  config: PlatformInstanceConfig,
  ctx: PluginFactoryContext,
) => PlatformAdapter | Promise<PlatformAdapter>;

export type AgentFactory = (
  config: AgentInstanceConfig,
  ctx: PluginFactoryContext,
) => AgentConnector | Promise<AgentConnector>;

export interface HookEvents {
  'agent.before': { agentId: string; model: string; task: ToolContext };
  'context.assembled': { context: readonly ContextBlock[]; task: ToolContext };
  'inbound.received': { chat: ChatRef; message: InboundMessage };
  'outbound.before': { chat: ChatRef; message: OutboundMessage };
  'outbound.sent': {
    chat: ChatRef;
    message: OutboundMessage;
    receipt: SendReceipt;
  };
  'preview.closed': { previewId: string };
  'preview.opened': { previewId: string };
  'schedule.fired': { scheduleId: string };
  'tool.after': { name: string; status: 'ok' | 'error'; task: ToolContext };
  'tool.before': { name: string; task: ToolContext };
  'trigger.decided': {
    chat: ChatRef;
    message: InboundMessage;
    triggered: boolean;
  };
}

export type HookName = keyof HookEvents;

export type Hook<T extends HookName> = (
  { mode: 'sync'; timeoutMs: number } | { mode: 'async' }
) & { run(event: HookEvents[T], signal: AbortSignal): void | Promise<void> };

export type Hooks = { [T in HookName]?: Hook<T> };

export interface PluginDefinition {
  adapters?: Readonly<Record<string, PlatformFactory>>;
  agents?: Readonly<Record<string, AgentFactory>>;
  checks?(
    ctx: CheckContext,
  ): readonly CheckItem[] | Promise<readonly CheckItem[]>;
  configSchema?: JSONSchema;
  credentialNames?(entry: PluginInstanceConfig): readonly string[];
  execBackends?: readonly ExecBackend[];
  hooks?: Hooks;
  install?(
    ctx: CheckContext,
    options: { signal?: AbortSignal; upgrade: boolean },
  ): Promise<string | undefined>;
  name: string;
  setupSteps?: readonly SetupStep[];
  tools?: readonly ToolDefinition[];
}

export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin;
}

export type {
  AccessIdentity,
  AdminApprovals,
  AdminChat,
  AdminConversation,
  AdminReader,
  AdminTrace,
  VerifyAccess,
} from './admin.ts';

export type PreviewCloseReason =
  | 'expired'
  | 'requested'
  | 'service-stopped'
  | 'provider-stopped'
  | 'shutdown'
  | 'restart';

export interface Preview {
  expiresAt: Date;
  id: string;
  provider: string;
  url: string;
}

export interface PreviewRequest {
  endpoint: LocalEndpoint;
  onClose?(reason: PreviewCloseReason): void;
  openedBy: string;
  signal: AbortSignal;
  ttlMs: number;
}

export interface TunnelProvider {
  close(id: string, reason: PreviewCloseReason): Promise<void>;
  id: string;
  open(request: PreviewRequest): Promise<Preview>;
  reconcile(open: readonly Preview[]): Promise<void>;
  stop?(): Promise<void>;
}
