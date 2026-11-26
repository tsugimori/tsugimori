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

export interface AdminChat extends ChatRef {
  allowlisted: boolean;
  kind: string;
  title: string | null;
}

interface AdminTask extends ChatRef {
  agentId: string | null;
  createdAt: number;
  finishedAt: number | null;
  id: string;
  model: string | null;
  startedAt: number | null;
  status: string;
}

export interface AdminConversation {
  chat: AdminChat;
  messages: readonly {
    deleted: boolean;
    direction: string;
    seq: number;
    text: string;
    userId: string | null;
  }[];
  tasks: readonly AdminTask[];
}

export interface AdminTrace {
  spans: readonly {
    attrs: Record<string, unknown>;
    durationMs: number;
    name: string;
    startedAt: number;
    status: string;
  }[];
  task: AdminTask;
}

export interface AdminApprovals {
  approvals: readonly (ChatRef & {
    action: string;
    decidedAt: number | null;
    decidedBy: string | null;
    failureReason?: string | null;
    id: string;
    requester: string;
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

export interface AdminReader {
  approvals(): AdminApprovals;
  chat(ref: ChatRef, before?: number): AdminConversation | undefined;
  chats(): readonly AdminChat[];
  trace(taskId: string): AdminTrace | undefined;
}
