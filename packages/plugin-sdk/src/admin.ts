import type { ChatRef, ResourcePattern, ResourceRef } from './index.ts';

export interface AccessIdentity {
  aud: string;
  ownerEmail?: string;
  ownerSub?: string;
  team: string;
}

export type VerifyAccess = (
  jwt: string | undefined,
  identity: AccessIdentity,
) => Promise<boolean>;

export type ToolCallStatus = 'ok' | 'error' | 'denied' | 'pending-approval';

export interface AdminToolCall {
  args: string | null;
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

export interface AdminTask extends ChatRef {
  agentId: string | null;
  createdAt: number;
  error?: string;
  finishedAt: number | null;
  id: string;
  inputTokens?: number;
  model: string | null;
  outputTokens?: number;
  sourceSeq?: number | null;
  startedAt: number | null;
  status: string;
  tools: readonly AdminToolCall[];
}

export interface AdminConversation {
  approvals?: AdminApprovals['approvals'];
  chat: AdminChat;
  messages: readonly {
    deleted: boolean;
    direction: string;
    displayName: string | null;
    recordedAt: number | null;
    seq: number;
    text: string;
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
  totals: {
    chats: number;
    failedToday: number;
    pendingApprovals: number;
    tasksToday: number;
  };
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

export interface AdminReader {
  agents(now: number): readonly AdminAgent[];
  approvals(recentLimit?: number): AdminApprovals;
  chat(ref: ChatRef, before?: number): AdminConversation | undefined;
  chats(): readonly AdminChat[];
  overview(now: number, agentId?: string): AdminOverview;
  pendingApprovals(now: number): number;
  schedules?(): AdminSchedules;
  subscribe(listener: (event: AdminEvent) => void): () => void;
  toolCall(taskId: string, seq: number): AdminToolCall | undefined;
  trace(taskId: string): AdminTrace | undefined;
  workspace(): AdminWorkspace;
}
