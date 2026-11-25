import type {
  AgentEvent,
  AgentIO,
  ApprovalRequest,
  ContextBlock,
} from '@tsugimori/plugin-sdk';

import { createHash } from 'node:crypto';

import type { AppServer, ServerFrame } from './app-server.ts';

import { asRecord } from './app-server.ts';

export const approvalPolicy = 'on-request';
export const approvalsReviewer = 'user';

const approvalMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

const toolNames: Record<string, string> = {
  commandExecution: 'command',
  fileChange: 'file_change',
  webSearch: 'web_search',
  imageView: 'image_view',
  imageGeneration: 'image_generation',
};

export function renderContext(blocks: ContextBlock[], resumed: boolean) {
  const messages = resumed
    ? blocks.filter((block) => block.source === 'message')
    : blocks;
  return messages
    .map(({ content, source, trust }) =>
      JSON.stringify({ source, trust, content }),
    )
    .join('\n');
}

export class TurnFrames {
  readonly #frames: ServerFrame[] = [];
  #ready = Promise.withResolvers<void>();

  push = (frame: ServerFrame) => {
    this.#frames.push(frame);
    this.#ready.resolve();
  };

  async next(signal: AbortSignal): Promise<ServerFrame> {
    while (!this.#frames.length) {
      signal.throwIfAborted();
      const abort = () => this.#ready.resolve();
      signal.addEventListener('abort', abort, { once: true });
      try {
        await this.#ready.promise;
      } finally {
        signal.removeEventListener('abort', abort);
        this.#ready = Promise.withResolvers<void>();
      }
    }
    signal.throwIfAborted();
    return this.#frames.shift()!;
  }
}

export class TurnOutput {
  readonly #items = new Map<string, Record<string, unknown>>();
  #final: string | undefined;
  #fallback: string | undefined;

  events({ method, params }: ServerFrame): AgentEvent[] {
    if (
      method === 'item/agentMessage/delta' &&
      typeof params.delta === 'string'
    )
      return [{ type: 'text.delta', text: params.delta }];
    if (method === 'thread/tokenUsage/updated') {
      const usage = asRecord(asRecord(params.tokenUsage).last);
      return [
        {
          type: 'usage',
          inputTokens:
            typeof usage.inputTokens === 'number'
              ? usage.inputTokens
              : undefined,
          outputTokens:
            typeof usage.outputTokens === 'number'
              ? usage.outputTokens
              : undefined,
        },
      ];
    }
    if (method !== 'item/started' && method !== 'item/completed') return [];
    const item = asRecord(params.item);
    if (typeof item.type !== 'string' || typeof item.id !== 'string') return [];
    const callId = item.id;
    const name =
      toolNames[item.type] ??
      (typeof item.tool === 'string' ? item.tool : undefined);
    if (method === 'item/started') {
      this.#items.set(callId, item);
      return name ? [{ type: 'tool.started', callId, name }] : [];
    }
    this.#items.delete(callId);
    this.#message(item);
    if (!name) return [];
    const failed =
      item.status === 'failed' ||
      item.status === 'declined' ||
      item.success === false;
    return [
      { type: 'tool.finished', callId, name, status: failed ? 'error' : 'ok' },
    ];
  }

  final(turn: Record<string, unknown>) {
    if (Array.isArray(turn.items))
      for (const item of turn.items) this.#message(asRecord(item));
    return this.#final ?? this.#fallback;
  }

  #message(item: Record<string, unknown>) {
    if (item.type !== 'agentMessage' || typeof item.text !== 'string') return;
    if (item.phase === 'final_answer') this.#final = item.text;
    else if (item.phase !== 'commentary') this.#fallback = item.text;
  }

  approval(
    { method, id, params }: ServerFrame,
    workdir: string,
  ): ApprovalRequest | undefined {
    if (!approvalMethods.has(method) || id === undefined) return;
    const cwd = typeof params.cwd === 'string' ? params.cwd : workdir;
    const item =
      typeof params.itemId === 'string'
        ? this.#items.get(params.itemId)
        : undefined;
    let details: unknown;
    let action: string;
    switch (method) {
      case 'item/commandExecution/requestApproval':
        action = 'codex.command';
        details = {
          command: params.command ?? item?.command,
          itemId:
            typeof (params.command ?? item?.command) === 'string' &&
            params.kind !== 'writeStdin'
              ? undefined
              : params.itemId,
          kind: params.kind,
          approvalId:
            params.kind === 'writeStdin' ? params.approvalId : undefined,
          network: params.networkApprovalContext,
        };
        break;
      case 'item/fileChange/requestApproval':
        action = 'codex.file_change';
        details = {
          grantRoot: params.grantRoot,
          changes: item?.changes,
          itemId: item?.changes ? undefined : params.itemId,
        };
        break;
      default:
        action = 'codex.permissions';
        details = params.permissions;
    }
    const scope = JSON.stringify({ cwd, details });
    return {
      action,
      resource: {
        type: 'project',
        id: createHash('sha256').update(scope).digest('hex'),
      },
      description: `${scope.slice(0, 3_500)}${scope.length > 3_500 ? '…' : ''}`,
    };
  }
}

export async function replyToApproval(
  server: AppServer,
  frame: ServerFrame,
  allowed: boolean,
) {
  if (frame.id === undefined) return;
  if (frame.method === 'item/permissions/requestApproval') {
    const { network, fileSystem } = asRecord(frame.params.permissions);
    await server.answer(frame.id, {
      permissions: allowed
        ? {
            network: network ?? undefined,
            fileSystem: fileSystem ?? undefined,
          }
        : {},
      scope: 'turn',
    });
  } else {
    await server.answer(frame.id, { decision: allowed ? 'accept' : 'decline' });
  }
}

export async function approve(
  io: AgentIO,
  request: ApprovalRequest,
  signal: AbortSignal,
) {
  if (signal.aborted) return false;
  const interrupted = Promise.withResolvers<boolean>();
  const abort = () => interrupted.resolve(false);
  signal.addEventListener('abort', abort, { once: true });
  try {
    return (
      (await Promise.race([
        io.requestApproval(request),
        interrupted.promise,
      ])) && !signal.aborted
    );
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
