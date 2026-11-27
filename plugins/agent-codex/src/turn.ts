import type {
  AgentCompaction,
  AgentEvent,
  AgentIO,
  ApprovalRequest,
  ContextBlock,
} from '@tsugimori/plugin-sdk';

import { renderContextLine } from '@tsugimori/plugin-sdk';
import { createHash } from 'node:crypto';

import type { AppServer, ServerFrame } from './app-server.ts';

import { asRecord } from './app-server.ts';
import { contextWindow } from './compaction.ts';

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
  return messages.map(renderContextLine).join('\n');
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

export function lastUsage(params: ServerFrame['params']) {
  return asRecord(asRecord(params.tokenUsage).last);
}

export class TurnCompactions {
  readonly #items = new Map<
    string,
    { startedAt: number; tokensAfter?: number; tokensBefore?: number }
  >();
  #latest?: number;
  #replacement?: Pick<AgentCompaction, 'tokensAfter' | 'tokensBefore'>;

  constructor(tokensBefore?: number) {
    this.#latest = tokensBefore;
  }

  observe({ method, params }: ServerFrame) {
    if (method === 'thread/tokenUsage/updated') {
      const { totalTokens, inputTokens, outputTokens } = lastUsage(params);
      if (typeof totalTokens === 'number') {
        // Codex publishes a replacement context estimate with zero billable input/output.
        this.#replacement =
          inputTokens === 0 && outputTokens === 0
            ? { tokensBefore: this.#latest, tokensAfter: totalTokens }
            : undefined;
        if (this.#items.size === 1 && this.#replacement)
          this.#items.values().next().value!.tokensAfter = totalTokens;
        this.#latest = totalTokens;
      }
      return;
    }
    const { item, startedAtMs, completedAtMs } = params;
    const { type, id } = asRecord(item);
    if (type !== 'contextCompaction' || typeof id !== 'string') return;
    if (method === 'item/started') {
      this.#items.set(id, {
        startedAt: typeof startedAtMs === 'number' ? startedAtMs : Date.now(),
        tokensBefore: this.#latest,
      });
      return;
    }
    if (method !== 'item/completed') return;
    const start = this.#items.get(id);
    this.#items.delete(id);
    const endedAt =
      typeof completedAtMs === 'number' ? completedAtMs : Date.now();
    const details = {
      durationMs: start && Math.max(0, endedAt - start.startedAt),
      tokensBefore: start?.tokensBefore ?? this.#replacement?.tokensBefore,
      tokensAfter: start?.tokensAfter ?? this.#replacement?.tokensAfter,
    };
    this.#replacement = undefined;
    return details;
  }
}

function toolData(item: Record<string, unknown>) {
  switch (item.type) {
    case 'commandExecution':
      return {
        args:
          typeof item.command === 'string'
            ? { command: item.command, cwd: item.cwd }
            : undefined,
        result:
          item.aggregatedOutput ?? item.output ?? item.error ?? item.exitCode,
      };
    case 'fileChange':
      return { args: item.changes, result: item.output ?? item.error };
    case 'webSearch':
      return { args: item.action ?? item.query, result: item.result };
    case 'imageView':
      return { args: item.path, result: item.result };
    default:
      return {
        args: item.arguments ?? item.prompt,
        result: item.error ?? item.result ?? item.contentItems,
      };
  }
}

export class TurnOutput {
  readonly #items = new Map<string, Record<string, unknown>>();
  readonly #summaries = new Map<string, Set<number>>();
  readonly #streamedText = new Set<string>();
  #final: string | undefined;
  #fallback: string | undefined;

  readonly #frameworkTools: ReadonlySet<string>;

  constructor(frameworkTools: ReadonlySet<string> = new Set()) {
    this.#frameworkTools = frameworkTools;
  }

  get hasFinalMessage() {
    return this.#final !== undefined || this.#fallback !== undefined;
  }

  events({ method, params }: ServerFrame, knownWindow?: number): AgentEvent[] {
    if (
      method === 'item/agentMessage/delta' &&
      typeof params.delta === 'string'
    ) {
      if (typeof params.itemId === 'string')
        this.#streamedText.add(params.itemId);
      return [{ type: 'text.delta', text: params.delta }];
    }
    if (
      method === 'item/reasoning/summaryTextDelta' &&
      typeof params.itemId === 'string' &&
      typeof params.summaryIndex === 'number' &&
      typeof params.delta === 'string'
    ) {
      const parts = this.#summaries.get(params.itemId) ?? new Set<number>();
      const separator =
        parts.size > 0 && !parts.has(params.summaryIndex) ? '\n\n' : '';
      parts.add(params.summaryIndex);
      this.#summaries.set(params.itemId, parts);
      return [{ type: 'reasoning', text: separator + params.delta }];
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = lastUsage(params);
      const costUsd = usage.costUsd;
      const window =
        contextWindow(asRecord(params.tokenUsage).modelContextWindow) ??
        knownWindow;
      return [
        {
          type: 'usage',
          ...(typeof costUsd === 'number' && { costUsd }),
          ...(window !== undefined && { contextWindow: window }),
          contextTokens:
            typeof usage.totalTokens === 'number' ? usage.totalTokens : null,
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
    const framework =
      item.type === 'dynamicToolCall' && name && this.#frameworkTools.has(name);
    const { args, result } = toolData(item);
    if (method === 'item/started') {
      this.#items.set(callId, item);
      return name && !framework
        ? [
            {
              type: 'tool.started',
              callId,
              name,
              ...(args === undefined ? {} : { args }),
            },
          ]
        : [];
    }
    this.#items.delete(callId);
    this.#message(item);
    if (item.type === 'reasoning') {
      const streamed = this.#summaries.get(callId);
      this.#summaries.delete(callId);
      const summary = Array.isArray(item.summary)
        ? item.summary
            .filter(
              (text, index) =>
                typeof text === 'string' && !streamed?.has(index),
            )
            .join('\n\n')
        : '';
      return summary
        ? [
            {
              type: 'reasoning',
              text: (streamed?.size ? '\n\n' : '') + summary,
            },
          ]
        : [];
    }
    if (
      item.type === 'agentMessage' &&
      item.phase === 'commentary' &&
      !this.#streamedText.delete(callId) &&
      typeof item.text === 'string'
    )
      return [{ type: 'text.delta', text: item.text }];
    this.#streamedText.delete(callId);
    if (!name || framework) return [];
    const failed =
      item.status === 'failed' ||
      item.status === 'cancelled' ||
      item.success === false ||
      (item.type === 'commandExecution' &&
        typeof item.exitCode === 'number' &&
        item.exitCode !== 0);
    return [
      {
        type: 'tool.finished',
        callId,
        name,
        status: item.status === 'declined' ? 'denied' : failed ? 'error' : 'ok',
        ...(args === undefined ? {} : { args }),
        ...(result === undefined ? {} : { result }),
      },
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
  callId?: string,
) {
  if (signal.aborted) return false;
  const interrupted = Promise.withResolvers<boolean>();
  const abort = () => interrupted.resolve(false);
  signal.addEventListener('abort', abort, { once: true });
  try {
    return (
      (await Promise.race([
        io.requestApproval(request, callId),
        interrupted.promise,
      ])) && !signal.aborted
    );
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
