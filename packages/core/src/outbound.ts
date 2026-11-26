import type {
  ChatRef,
  OutboundMessage,
  PlatformAdapter,
  SendPart,
  SendReceipt,
} from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { SendFailure } from '@tsugimori/plugin-sdk';

import type { HookRunner } from './hooks.ts';

export function conversationId({
  chatId,
  threadId,
}: {
  chatId: string;
  threadId?: string;
}) {
  return threadId === undefined ? chatId : `${chatId}_${threadId}`;
}

export class Outbound {
  readonly #deps: { hooks: HookRunner; store: Store; trace: Tracer };

  constructor(deps: { hooks: HookRunner; store: Store; trace: Tracer }) {
    this.#deps = deps;
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
