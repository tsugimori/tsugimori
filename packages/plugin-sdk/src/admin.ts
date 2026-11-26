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

export interface AdminChat extends ChatRef {
  activeTask: string | null;
  allowlisted: boolean;
  kind: string;
  lastActivity: number | null;
  lastTaskStatus: string | null;
  latestSeq: number;
  messageCount: number;
  pendingApprovals: number;
  platform: string;
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
    nextDueAt: number | null;
    status: string;
    title: string;
  })[];
}

export interface AdminReader {
  approvals(recentLimit?: number): AdminApprovals;
  chat(ref: ChatRef, before?: number): AdminConversation | undefined;
  chats(): readonly AdminChat[];
  overview(now: number): AdminOverview;
  pendingApprovals(now: number): number;
  schedules?(): AdminSchedules;
  trace(taskId: string): AdminTrace | undefined;
  workspace(): AdminWorkspace;
}
