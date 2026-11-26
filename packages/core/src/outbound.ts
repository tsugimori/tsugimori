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
  readonly #approvalReactions = new Map<string, Promise<boolean>>();

  constructor(deps: OutboundDependencies) {
    this.#deps = deps;
  }

  reactToApproval(
    adapter: PlatformAdapter,
    source: ChatRef &
      Pick<TaskRecord, 'id' | 'sourceChatId' | 'sourceMessageId'>,
    reaction: ApprovalReaction,
  ) {
    const { id: taskId, sourceMessageId } = source;
    const setReaction = adapter.setApprovalReaction?.bind(adapter);
    if (!setReaction || sourceMessageId.startsWith('schedule:'))
      return Promise.resolve(false);
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
          return await trace.span('approval.reaction', attrs, async () => {
            const current = store.getTask(taskId) ?? source;
            const chat = store.resolveChat(current);
            if (current.sourceChatId || chat.chatId !== current.chatId)
              return false;
            const message = store.getMessage(chat, sourceMessageId, '');
            const address = store.deliveryAddress(chat);
            if (!message || message.deleted || !address) return false;
            const signal = AbortSignal.timeout(5_000);
            await untilAborted(signal, () =>
              setReaction(
                { chatId: address.chatId, messageId: sourceMessageId },
                reaction,
                signal,
              ),
            );
            return true;
          });
        } catch {
          log({ level: 'error', event: 'approval.reaction_failed', ...attrs });
          return false;
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
      onDelivery?(messageIds: readonly string[], error?: unknown): void;
      onReceipt?(receipt: SendReceipt): void;
      scheduled?: boolean;
      signal?: AbortSignal;
      taskId?: string;
    } = {},
  ) {
    const { store, trace, hooks } = this.#deps;
    const { signal, taskId } = options;
    const { chatId } = store.resolveChat({
      adapterId: adapter.id,
      chatId: message.chatId,
    });
    if (chatId !== message.chatId)
      message = { ...message, chatId, replyTo: undefined, threadId: undefined };
    const chat: ChatRef = {
      adapterId: adapter.id,
      chatId: conversationId(message),
    };
    const push = adapter.capabilities.outboundPush ?? 'free';
    const metered =
      (message.approval && push !== 'free') ||
      (options.scheduled && push === 'metered');
    const attrs = {
      ...chat,
      taskId: taskId ?? null,
      ...(metered && { 'push.metered': true }),
    };
    await hooks.emit('outbound.before', { chat, message });
    signal?.throwIfAborted();
    if (taskId) store.updateTask(taskId, { status: 'sending' });
    let receipt: SendReceipt;
    const record = (parts: readonly SendPart[], completedTaskId?: string) => {
      trace.span('outbound.record', attrs, () => {
        for (const [index, part] of parts.entries()) {
          const address =
            part.chatId === undefined
              ? message
              : {
                  chatId: part.chatId,
                  replyTo: undefined,
                  threadId: undefined,
                };
          store.recordOutbound(
            {
              adapterId: adapter.id,
              chatId: conversationId(address),
              messageId: part.messageId,
              direction: 'outbound',
              userId: null,
              replyTo: address.replyTo ?? null,
              threadId: address.threadId ?? null,
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
        const sent = error instanceof SendFailure ? error.parts : [];
        options.onDelivery?.(
          sent.map(({ messageId }) => messageId),
          error,
        );
        if (sent.length) record(sent);
        throw error;
      }
      const parts = receipt.parts?.length
        ? receipt.parts
        : [{ ...receipt, text: message.text }];
      options.onDelivery?.(parts.map(({ messageId }) => messageId));
      record(parts, taskId);
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
    const delivered = message.approval
      ? receipt.parts?.at(-1)
      : receipt.parts?.[0];
    if (delivered?.chatId !== undefined)
      message = {
        ...message,
        chatId: delivered.chatId,
        replyTo: undefined,
        threadId: undefined,
      };
    await hooks.emit('outbound.sent', {
      chat: { adapterId: adapter.id, chatId: conversationId(message) },
      message,
      receipt,
    });
    return receipt;
  }
}

export class DeliveryError extends Error {
  constructor(options: ErrorOptions) {
    super('Outbound delivery could not be confirmed', options);
  }
}
