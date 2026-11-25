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
}

export type ApprovalDecision = 'deny' | 'once' | 'always';

export type PlatformInboundEvent =
  | InboundMessage
  | (InboundBase & { messageId: string; type: 'delete' })
  | (InboundBase & {
      callbackId: string;
      messageId: string;
      queryId?: string;
      type: 'callback';
      userId: string;
    });

export interface ScheduledInboundEvent extends Omit<InboundMessage, 'type'> {
  scheduleId: string;
  type: 'schedule';
}

export type InboundEvent = PlatformInboundEvent | ScheduledInboundEvent;

export interface OutboundMessage {
  buttons?: readonly { id: string; label: string }[];
  chatId: string;
  mentions?: readonly string[];
  replyTo?: string;
  text: string;
  threadId?: string;
}

export interface SendReceipt {
  messageId: string;
  parts?: readonly SendPart[];
  raw?: unknown;
}

export interface SendPart {
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
  loadCursor?(stream: string): AdapterCursor | undefined;
  logError?(event: string, error?: unknown): void;
  ready?: Promise<void>;
  saveCursor?(stream: string, cursor: AdapterCursor): void;
}

export interface ApprovalFeedback {
  chatId: string;
  decision?: ApprovalDecision;
  messageId: string;
  prompt?: string;
  queryId?: string;
}

export interface PlatformAdapter {
  capabilities: PlatformCapabilities;
  deleteMessage?(
    message: Pick<InboundMessage, 'chatId' | 'messageId'>,
  ): Promise<void>;
  id: string;
  kind: string;
  respondToApproval?(feedback: ApprovalFeedback): Promise<void>;
  send(message: OutboundMessage): Promise<SendReceipt>;
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

export interface ToolContext {
  approveSchedule?(request: {
    address: Pick<OutboundMessage, 'chatId' | 'threadId'>;
    approverId?: string;
    description: string;
    id: string;
  }): Promise<string | undefined>;
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
  requestApproval(request: ApprovalRequest): Promise<boolean>;
  supplements: AsyncIterable<InboundMessage>;
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
  | { inputTokens?: number; outputTokens?: number; type: 'usage' }
  | { sessionId: string; type: 'sessionId' };

export function toolWireName(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface AgentConnector {
  acceptsSession?(id: string, tools: readonly ToolDefinition[]): boolean;
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
