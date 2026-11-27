import type {
  ApprovalReaction,
  ChatRef,
  MediaDestination,
  MediaReceipt,
  OutboundMessage,
  PlatformAdapter,
  QueuedMedia,
  SendPart,
  SendReceipt,
} from '@tsugimori/plugin-sdk';
import type { Store, TaskRecord } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { SendFailure, ToolFailure } from '@tsugimori/plugin-sdk';

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

  async sendSecret(adapter: PlatformAdapter, message: OutboundMessage) {
    const { log, store, trace } = this.#deps;
    const chat = { adapterId: adapter.id, chatId: conversationId(message) };
    const mark = (parts: readonly Pick<SendPart, 'chatId' | 'messageId'>[]) => {
      for (const { chatId, messageId } of parts)
        store.markSetupSecret(
          chatId === undefined ? chat : { ...chat, chatId },
          messageId,
        );
    };
    // Send directly so the secret and provider receipt stay out of hooks and history.
    let receipt: SendReceipt;
    try {
      receipt = await trace.span('outbound.secret', chat, () =>
        adapter.send(message),
      );
    } catch (error) {
      if (error instanceof SendFailure) mark(error.parts);
      log({ level: 'warn', event: 'outbound.secret_failed', ...chat });
      return false;
    }
    mark(receipt.parts?.length ? receipt.parts : [receipt]);
    return true;
  }

  #address<T extends MediaDestination>(
    adapter: PlatformAdapter,
    message: T,
  ): T {
    const { chatId } = this.#deps.store.resolveChat({
      adapterId: adapter.id,
      chatId: message.chatId,
    });
    return chatId === message.chatId
      ? message
      : { ...message, chatId, replyTo: undefined, threadId: undefined };
  }

  #recordParts(
    adapterId: string,
    message: MediaDestination,
    parts: readonly SendPart[],
    attrs: Parameters<Tracer['span']>[1],
    {
      completedTaskId,
      sessionBoundary,
      sideQuestion,
    }: {
      completedTaskId?: string;
      sessionBoundary?: boolean;
      sideQuestion?: boolean;
    } = {},
  ) {
    const { store, trace } = this.#deps;
    trace.span('outbound.record', attrs, () => {
      for (const [index, part] of parts.entries()) {
        const address =
          part.chatId === undefined ? message : { chatId: part.chatId };
        store.recordOutbound(
          {
            adapterId,
            chatId: conversationId(address),
            messageId: part.messageId,
            direction: 'outbound',
            userId: null,
            replyTo: address.replyTo ?? null,
            threadId: address.threadId ?? null,
            text: part.text,
            raw: part.raw ?? null,
            ...((sessionBoundary || sideQuestion) && {
              metadata: { sessionBoundary, sideQuestion },
            }),
          },
          index === parts.length - 1 ? completedTaskId : undefined,
        );
      }
    });
  }

  async sendMedia(
    adapter: PlatformAdapter,
    message: OutboundMessage,
    signal: AbortSignal,
    taskId: string,
    run: (address: MediaDestination) => Promise<MediaReceipt>,
    onDelivery: (ids: readonly string[], error?: unknown) => void,
    sideQuestion?: boolean,
  ) {
    const { hooks, trace } = this.#deps;
    message = this.#address(adapter, message);
    const chat = { adapterId: adapter.id, chatId: conversationId(message) };
    const attrs = { ...chat, taskId };
    await hooks.emit('outbound.before', { chat, message });
    signal.throwIfAborted();
    let receipt: MediaReceipt;
    try {
      receipt = await trace.span('outbound.send_media', attrs, () =>
        run(message),
      );
    } catch (error) {
      const sent = error instanceof SendFailure ? error.parts : [];
      onDelivery(
        sent.map(({ messageId }) => messageId),
        error,
      );
      if (sent.length)
        this.#recordParts(adapter.id, message, sent, attrs, { sideQuestion });
      if (error instanceof SendFailure && error.cause instanceof Error)
        throw new ToolFailure(
          error.deliveryUnknown
            ? 'Media delivery could not be confirmed'
            : error.cause.message,
        );
      throw error;
    }
    if ('queued' in receipt) return receipt;
    const parts = receipt.parts?.length
      ? receipt.parts
      : [{ ...receipt, text: message.text }];
    onDelivery(parts.map(({ messageId }) => messageId));
    this.#recordParts(adapter.id, message, parts, attrs, { sideQuestion });
    const delivered = parts[0]!.chatId;
    if (delivered !== undefined)
      message = {
        ...message,
        chatId: delivered,
        replyTo: undefined,
        threadId: undefined,
      };
    await hooks.emit('outbound.sent', {
      chat: { adapterId: adapter.id, chatId: conversationId(message) },
      message,
      receipt,
    });
    return {
      messageId: receipt.messageId,
      messageIds: parts.map(({ messageId }) => messageId),
    };
  }

  async send(
    adapter: PlatformAdapter,
    message: OutboundMessage,
    options: {
      media?: readonly QueuedMedia[];
      onDelivery?(messageIds: readonly string[], error?: unknown): void;
      onParts?(parts: readonly SendPart[], error?: unknown): void;
      onReceipt?(receipt: SendReceipt): void;
      scheduled?: boolean;
      sessionBoundary?: boolean;
      sideQuestion?: boolean;
      signal?: AbortSignal;
      taskId?: string;
    } = {},
  ) {
    const { store, trace, hooks } = this.#deps;
    const { signal, taskId } = options;
    message = this.#address(adapter, message);
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
    try {
      try {
        receipt = await trace.span('outbound.send', attrs, () =>
          adapter.send(
            message,
            options.media?.length
              ? { media: options.media, signal }
              : undefined,
          ),
        );
      } catch (error) {
        const sent = error instanceof SendFailure ? error.parts : [];
        options.onDelivery?.(
          sent.map(({ messageId }) => messageId),
          error,
        );
        options.onParts?.(sent, error);
        if (sent.length)
          this.#recordParts(adapter.id, message, sent, attrs, {
            sessionBoundary: options.sessionBoundary,
            sideQuestion: options.sideQuestion,
          });
        throw error;
      }
      const parts = receipt.parts?.length
        ? receipt.parts
        : [{ ...receipt, text: message.text }];
      options.onDelivery?.(parts.map(({ messageId }) => messageId));
      options.onParts?.(parts);
      this.#recordParts(adapter.id, message, parts, attrs, {
        completedTaskId: taskId,
        sessionBoundary: options.sessionBoundary,
        sideQuestion: options.sideQuestion,
      });
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
