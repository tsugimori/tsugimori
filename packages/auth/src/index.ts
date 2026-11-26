import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatRef,
  PrincipalRef,
  ResourceRef,
} from '@tsugimori/plugin-sdk';
import type { ApprovalRecord, Store, StoredGrant } from '@tsugimori/storage';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const pairingTtlMs = 10 * 60_000;
const approvalTtlMs = 24 * 60 * 60_000;
const scheduleGrantAction = 'schedule.delivery';

interface AuthDependencies {
  configuredOwner?(adapterId: string): string | undefined;
  now?: () => number;
  store: Store;
}

export type ApprovalInput = ChatRef & {
  userId: string;
} & (
    | { callbackId: string; messageId: string }
    | { replyTo?: string; text: string }
  );

function digest(code: string) {
  return createHash('sha256').update(code).digest('hex');
}

function replyDecision(text: string): ApprovalDecision | undefined {
  switch (text.trim().toLowerCase()) {
    case 'yes':
    case 'ok':
    case '好':
    case '同意':
    case '允許':
    case '允許一次':
    case 'once':
    case 'allow':
    case 'allow once':
    case 'approve':
    case 'always':
    case '一律允許':
      return 'approve';
    case 'no':
    case 'deny':
    case '不':
    case '拒絕':
      return 'deny';
  }
}

export function approvalCallbackId(
  approvalId: string,
  decision: ApprovalDecision,
) {
  return `approval:${decision === 'approve' ? 'once' : 'deny'}:${approvalId}`;
}

function matchesResource(scope: StoredGrant['scope'], resource: ResourceRef) {
  switch (scope.type) {
    case 'global':
      return resource.type === 'global';
    case 'project':
      return resource.type === 'project' && resource.id === scope.id;
    case 'schedule':
      return (
        resource.type === 'schedule' &&
        resource.id === scope.id &&
        resource.deliveryKey === scope.deliveryKey
      );
    case 'chat':
      return (
        resource.type === 'chat' &&
        resource.adapterId === scope.adapterId &&
        resource.chatId === scope.chatId
      );
    case 'path': {
      if (
        resource.type !== 'path' ||
        !isAbsolute(resource.path) ||
        !isAbsolute(scope.path)
      )
        return false;
      const distance = relative(resolve(scope.path), resolve(resource.path));
      return (
        distance === '' ||
        ('recursive' in scope &&
          distance !== '..' &&
          !distance.startsWith(`..${sep}`) &&
          !isAbsolute(distance))
      );
    }
  }
}

export class Auth {
  readonly #store: Store;
  readonly #configuredOwner: NonNullable<AuthDependencies['configuredOwner']>;
  readonly #now: () => number;

  constructor({
    store,
    configuredOwner = () => undefined,
    now = Date.now,
  }: AuthDependencies) {
    this.#store = store;
    this.#configuredOwner = configuredOwner;
    this.#now = now;
  }

  owner(adapterId: string) {
    return this.#configuredOwner(adapterId) ?? this.#store.getOwner(adapterId);
  }

  isOwner({ adapterId, userId }: PrincipalRef) {
    return this.owner(adapterId) === userId;
  }

  isAllowlisted(chat: ChatRef) {
    return this.#store.getChat(chat)?.allowlisted ?? false;
  }

  createPairingCode(adapterId: string) {
    if (this.owner(adapterId))
      throw new Error('This adapter already has an owner');
    const code = randomBytes(12).toString('base64url');
    this.#store.savePairingCode(
      adapterId,
      digest(code),
      this.#now() + pairingTtlMs,
    );
    return code;
  }

  claimPairing(adapterId: string, userId: string, code: string) {
    if (this.owner(adapterId) || !/^[\w-]{16}$/.test(code)) return false;
    return this.#store.claimPairing(
      { adapterId, userId },
      digest(code),
      this.#now(),
    );
  }

  createApproval(
    chat: ChatRef,
    taskId: string,
    requester: string,
    request: ApprovalRequest,
    options: {
      approverId?: string;
      continuation?: ApprovalRecord['continuation'];
    } = {},
  ) {
    const approval: ApprovalRecord = {
      adapterId: chat.adapterId,
      chatId: chat.chatId,
      id: randomUUID(),
      taskId,
      requester,
      action: request.action,
      resource: request.resource,
      continuation: options.continuation ?? null,
      expiresAt: Math.min(
        this.#now() + approvalTtlMs,
        options.continuation?.kind === 'schedule'
          ? (options.continuation.change.schedule.nextDueAt ?? Infinity)
          : Infinity,
      ),
      promptMessageId: null,
      promptFormat: null,
      approverId: options.approverId ?? null,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
    };
    this.#store.createApproval(approval);
    return approval;
  }

  resolveApproval(
    input: ApprovalInput,
    scheduleLimit?: (approval: ApprovalRecord) => number | undefined,
  ) {
    let approval: ApprovalRecord | undefined;
    let decision: ApprovalDecision | undefined;
    if ('callbackId' in input) {
      const [, action, approvalId] =
        /^approval:(once|deny):([\w-]+)$/.exec(input.callbackId) ?? [];
      if (!approvalId) return;
      decision = action === 'once' ? 'approve' : 'deny';
      approval = this.#store.getApproval(approvalId);
      if (approval?.promptMessageId !== input.messageId) return;
    } else if (input.replyTo) {
      decision = replyDecision(input.text);
      approval = this.#store.findApprovalByPrompt(input, input.replyTo);
    }
    if (
      !decision ||
      approval?.adapterId !== input.adapterId ||
      approval.chatId !== input.chatId ||
      (!this.isOwner(input) && approval.approverId !== input.userId)
    )
      return;

    const now = this.#now();
    if (
      approval.status === 'expired' ||
      (approval.status === 'pending' &&
        approval.expiresAt !== null &&
        approval.expiresAt <= now)
    )
      return { id: approval.id, decision: 'expired' as const };
    if (approval.status !== 'pending') return;

    const approved = decision === 'approve';
    const grant: StoredGrant | undefined = approved
      ? {
          adapterId: approval.adapterId,
          chatId: approval.chatId,
          id: randomUUID(),
          action:
            approval.resource.type === 'schedule'
              ? scheduleGrantAction
              : approval.action,
          scope: approval.resource,
          mode: 'once',
          grantedTo: approval.requester,
          grantedBy: input.userId,
          createdAt: now,
          revokedAt: null,
          consumedAt: now,
        }
      : undefined;
    const changed = this.#store.decideApproval(
      approval.id,
      {
        status: approved ? 'approved' : 'denied',
        decidedBy: input.userId,
        decidedAt: now,
      },
      grant,
      approved && approval.continuation?.kind === 'schedule'
        ? scheduleLimit?.(approval)
        : undefined,
    );
    if (changed)
      return {
        id: approval.id,
        approved,
        decision,
        ...changed,
      };
  }

  hasGrant(
    chat: ChatRef,
    requester: string,
    request: ApprovalRequest,
    grantedBy = this.owner(chat.adapterId),
  ) {
    if (grantedBy === undefined) return false;
    return this.#store.consumeGrant(
      {
        ...chat,
        grantedBy,
        requester,
        resource: request.resource,
        action:
          request.resource.type === 'schedule'
            ? scheduleGrantAction
            : request.action,
      },
      this.#now(),
      matchesResource,
    );
  }
}
