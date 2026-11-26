import type {
  ApprovalReaction,
  ChatRef,
  OutboundMessage,
  PlatformAdapter,
  SendPart,
  SendReceipt,
} from '@tsugimori/plugin-sdk';
import type { Store, TaskRecord } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { SendFailure } from '@tsugimori/plugin-sdk';

import type { HookRunner, Logger } from './hooks.ts';

import { untilAborted } from './abort.ts';

export function conversationId({
  chatId,
  threadId,
}: {
  chatId: string;
  threadId?: string;
}) {
  return threadId === undefined ? chatId : `${chatId}_${threadId}`;
}

interface OutboundDependencies {
  hooks: HookRunner;
  log: Logger;
  store: Store;
  trace: Tracer;
}

export class Outbound {
  readonly #deps: OutboundDependencies;
  readonly #approvalReactions = new Map<string, Promise<void>>();

  constructor(deps: OutboundDependencies) {
    this.#deps = deps;
  }

  reactToApproval(
    adapter: PlatformAdapter,
    source: ChatRef & Pick<TaskRecord, 'id' | 'sourceMessageId'>,
    reaction: ApprovalReaction,
  ) {
    const { id: taskId, sourceMessageId } = source;
    const setReaction = adapter.setApprovalReaction?.bind(adapter);
    if (!setReaction || sourceMessageId.startsWith('schedule:')) return;
    const { log, store, trace } = this.#deps;
    const attrs = {
      adapterId: adapter.id,
      chatId: source.chatId,
      taskId,
      reaction,
    };
    const previous = this.#approvalReactions.get(taskId) ?? Promise.resolve();
    const update = previous
      .then(async () => {
        try {
          await trace.span('approval.reaction', attrs, async () => {
            const message = store.getMessage(source, sourceMessageId);
            const address = store.deliveryAddress(source);
            if (!message || message.deleted || !address) return;
            const signal = AbortSignal.timeout(5_000);
            await untilAborted(signal, () =>
              setReaction(
                { chatId: address.chatId, messageId: sourceMessageId },
                reaction,
                signal,
              ),
            );
          });
        } catch {
          log({ level: 'error', event: 'approval.reaction_failed', ...attrs });
        }
      })
      .finally(() => {
        if (this.#approvalReactions.get(taskId) === update)
          this.#approvalReactions.delete(taskId);
      });
    this.#approvalReactions.set(taskId, update);
    return update;
  }

  async send(
    adapter: PlatformAdapter,
    message: OutboundMessage,
    options: {
      onReceipt?(receipt: SendReceipt): void;
      signal?: AbortSignal;
      taskId?: string;
    } = {},
  ) {
    const { store, trace, hooks } = this.#deps;
    const { signal, taskId } = options;
    const chat: ChatRef = {
      adapterId: adapter.id,
      chatId: conversationId(message),
    };
    const attrs = { ...chat, taskId: taskId ?? null };
    await hooks.emit('outbound.before', { chat, message });
    signal?.throwIfAborted();
    if (taskId) store.updateTask(taskId, { status: 'sending' });
    let receipt: SendReceipt;
    const record = (parts: readonly SendPart[], completedTaskId?: string) => {
      trace.span('outbound.record', attrs, () => {
        for (const [index, part] of parts.entries()) {
          store.recordOutbound(
            {
              ...chat,
              messageId: part.messageId,
              direction: 'outbound',
              userId: null,
              replyTo: message.replyTo ?? null,
              threadId: message.threadId ?? null,
              text: part.text,
              raw: part.raw ?? null,
            },
            index === parts.length - 1 ? completedTaskId : undefined,
          );
        }
      });
    };
    try {
      try {
        receipt = await trace.span('outbound.send', attrs, () =>
          adapter.send(message),
        );
      } catch (error) {
        if (error instanceof SendFailure) record(error.parts);
        throw error;
      }
      record(receipt.parts ?? [{ ...receipt, text: message.text }], taskId);
      options.onReceipt?.(receipt);
    } catch (error) {
      if (!taskId || (error instanceof SendFailure && !error.deliveryUnknown))
        throw error;
      store.updateTask(taskId, {
        status: 'delivery-unknown',
        finishedAt: Date.now(),
      });
      throw new DeliveryError({ cause: error });
    }
    await hooks.emit('outbound.sent', { chat, message, receipt });
    return receipt;
  }
}

export class DeliveryError extends Error {
  constructor(options: ErrorOptions) {
    super('Outbound delivery could not be confirmed', options);
  }
}
