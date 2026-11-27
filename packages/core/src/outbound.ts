import type {
  ApprovalReaction,
  ChatRef,
  MediaDestination,
  MediaFile,
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
import type { WebImageNetwork } from './web-image.ts';

import { untilAborted } from './abort.ts';
import { replaceMarkdownImages } from './markdown-images.ts';
import { mediaUpload } from './media.ts';
import { fetchWebImage } from './web-image.ts';

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
  webImageNetwork?: WebImageNetwork;
}

interface SendOptions {
  completeTask?: boolean;
  incognitoId?: number;
  media?: readonly QueuedMedia[];
  onDelivery?(messageIds: readonly string[], error?: unknown): void;
  onParts?(parts: readonly SendPart[], error?: unknown): void;
  onReceipt?(receipt: SendReceipt): void;
  scheduled?: boolean;
  sessionBoundary?: boolean;
  sideQuestion?: boolean;
  signal?: AbortSignal;
  taskId?: string;
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
      incognitoId,
      sessionBoundary,
      sideQuestion,
    }: {
      completedTaskId?: string;
      incognitoId?: number;
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
            incognitoId,
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
    onDelivery?: (ids: readonly string[], error?: unknown) => void,
    options: {
      incognitoId?: number;
      reply?: 'part' | 'last';
      sideQuestion?: boolean;
    } = {},
  ) {
    const { hooks, store, trace } = this.#deps;
    message = this.#address(adapter, message);
    const chat = { adapterId: adapter.id, chatId: conversationId(message) };
    const incognitoId =
      options.incognitoId ?? store.getChat(chat)?.incognitoId ?? undefined;
    const recording = { incognitoId, sideQuestion: options.sideQuestion };
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
      onDelivery?.(
        sent.map(({ messageId }) => messageId),
        error,
      );
      if (sent.length)
        this.#recordParts(adapter.id, message, sent, attrs, recording);
      if (
        !options.reply &&
        error instanceof SendFailure &&
        error.cause instanceof Error
      )
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
    onDelivery?.(parts.map(({ messageId }) => messageId));
    this.#recordParts(adapter.id, message, parts, attrs, {
      ...recording,
      completedTaskId: options.reply === 'last' ? taskId : undefined,
    });
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

  fetchImage(
    url: string,
    maxBytes: number,
    {
      chat,
      signal,
      taskId,
    }: { chat: ChatRef; signal: AbortSignal; taskId: string },
  ) {
    const { trace, webImageNetwork } = this.#deps;
    return trace.span('outbound.fetch_image', { ...chat, taskId }, () =>
      fetchWebImage(url, maxBytes, signal, webImageNetwork),
    );
  }

  async sendFinal(
    adapter: PlatformAdapter,
    message: OutboundMessage,
    options: SendOptions & { signal: AbortSignal; taskId: string },
  ) {
    if (!message.text.includes('!['))
      return this.send(adapter, message, options);
    const { signal, taskId, onDelivery } = options;
    const { store } = this.#deps;
    const chat = { adapterId: adapter.id, chatId: conversationId(message) };
    const images = adapter.capabilities.images;
    const upload = adapter.sendImage?.bind(adapter);
    if (!images || !upload) {
      const text = await replaceMarkdownImages(
        message.text,
        async (url) => url,
      );
      return this.send(adapter, { ...message, text }, options);
    }
    const files: MediaFile[] = [];
    const queued = [...(options.media ?? [])];
    const { chatId, replyTo, threadId } = message;
    const sendImage = (file: MediaFile, reply?: 'part' | 'last') =>
      this.sendMedia(
        adapter,
        { chatId, replyTo, threadId, text: '[image]' },
        signal,
        taskId,
        (address) => upload(mediaUpload(address, file, signal), signal),
        onDelivery,
        {
          incognitoId: options.incognitoId,
          reply,
          sideQuestion: options.sideQuestion,
        },
      );
    const text = await replaceMarkdownImages(message.text, async (url) => {
      try {
        const file = await this.fetchImage(url, images.maxBytes, {
          chat,
          signal,
          taskId,
        });
        if (images.queued) {
          const receipt = await sendImage(file);
          if ('queued' in receipt) queued.push(receipt);
        } else {
          files.push(file);
        }
        return '';
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof ToolFailure)) throw error;
        return url;
      }
    });
    if (!files.length)
      return this.send(
        adapter,
        { ...message, text },
        { ...options, media: queued },
      );
    if (text.trim() || queued.length)
      await this.send(
        adapter,
        { ...message, text },
        { ...options, media: queued, completeTask: false },
      );
    else {
      signal.throwIfAborted();
      store.updateTask(taskId, { status: 'sending' });
    }
    for (const [index, file] of files.entries()) {
      const last = index === files.length - 1;
      let receipt: Awaited<ReturnType<typeof sendImage>>;
      signal.throwIfAborted();
      try {
        receipt = await sendImage(file, last ? 'last' : 'part');
      } catch (error) {
        if (
          (signal.aborted && !(error instanceof SendFailure)) ||
          error instanceof ToolFailure
        )
          throw error;
        this.#failDelivery(taskId, error);
      }
      if ('queued' in receipt)
        await this.send(
          adapter,
          { ...message, text: '' },
          { ...options, media: [receipt], completeTask: last },
        );
    }
  }

  #failDelivery(taskId: string | undefined, error: unknown): never {
    if (!taskId || (error instanceof SendFailure && !error.deliveryUnknown))
      throw error;
    this.#deps.store.updateTask(taskId, {
      status: 'delivery-unknown',
      finishedAt: Date.now(),
    });
    throw new DeliveryError({ cause: error });
  }

  async send(
    adapter: PlatformAdapter,
    message: OutboundMessage,
    options: SendOptions = {},
  ) {
    const { store, trace, hooks } = this.#deps;
    const { signal, taskId } = options;
    message = this.#address(adapter, message);
    const chat: ChatRef = {
      adapterId: adapter.id,
      chatId: conversationId(message),
    };
    const incognitoId =
      options.incognitoId ?? store.getChat(chat)?.incognitoId ?? undefined;
    const recording = {
      incognitoId,
      sessionBoundary: options.sessionBoundary,
      sideQuestion: options.sideQuestion,
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
          this.#recordParts(adapter.id, message, sent, attrs, recording);
        throw error;
      }
      const parts = receipt.parts?.length
        ? receipt.parts
        : [{ ...receipt, text: message.text }];
      options.onDelivery?.(parts.map(({ messageId }) => messageId));
      options.onParts?.(parts);
      this.#recordParts(adapter.id, message, parts, attrs, {
        completedTaskId: options.completeTask === false ? undefined : taskId,
        ...recording,
      });
      options.onReceipt?.(receipt);
    } catch (error) {
      this.#failDelivery(taskId, error);
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
