import type {
  AdapterContext,
  ApprovalFeedback,
  OutboundMessage,
  PlatformAdapter,
  SendPart,
  TextEntity,
} from '@tsugimori/plugin-sdk';

import { definePlugin, SendFailure } from '@tsugimori/plugin-sdk';
import { setTimeout as delay } from 'node:timers/promises';

import type { BotIdentity } from './updates.ts';

import { BotApi, BotApiError, nativeId, record } from './api.ts';
import { maxMessage, splitText, telegramMessageParts } from './message-text.ts';
import { telegramChecks, telegramIdentity, telegramSetup } from './setup.ts';
import { mapUpdate } from './updates.ts';

const cursorLifetimeMs = 6 * 24 * 60 * 60 * 1_000;

export { splitText };

export class TelegramAdapter implements PlatformAdapter {
  readonly id: string;
  readonly kind = 'telegram';
  readonly capabilities = {
    deleteEvents: false,
    inlineButtons: true,
    richText: true,
  };
  readonly #api: BotApi;
  readonly #fetch: typeof globalThis.fetch;
  readonly #token: string;
  readonly #now: () => number;
  readonly #typingIntervalMs: number;
  #ctx?: AdapterContext;
  #controller?: AbortController;
  #polling?: Promise<void>;

  constructor(
    {
      fetch = globalThis.fetch,
      now = Date.now,
      typingIntervalMs = 4500,
    }: {
      fetch?: typeof globalThis.fetch;
      now?: () => number;
      typingIntervalMs?: number;
    },
    id: string,
    token: string,
  ) {
    this.id = id;
    this.#api = new BotApi(fetch, token);
    this.#fetch = fetch;
    this.#token = token;
    this.#now = now;
    this.#typingIntervalMs = typingIntervalMs;
  }

  async start(ctx: AdapterContext) {
    if (this.#controller)
      throw new Error('Telegram adapter is already started');
    const controller = new AbortController();
    this.#controller = controller;
    this.#ctx = ctx;
    try {
      const bot = await telegramIdentity(
        this.#fetch,
        this.#token,
        AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
      );
      this.#polling = this.#poll(ctx, bot, controller.signal).catch(
        (error: unknown) => {
          if (controller.signal.aborted) return;
          ctx.logError?.('telegram.poll_stopped');
          throw error;
        },
      );
      void this.#polling.catch(() => undefined); // stop() observes the failure.
    } catch (error) {
      this.#controller = undefined;
      this.#ctx = undefined;
      controller.abort();
      throw error;
    }
  }

  async stop() {
    this.#controller?.abort();
    try {
      await this.#polling;
    } finally {
      this.#polling = undefined;
      this.#controller = undefined;
      this.#ctx = undefined;
    }
  }

  async #poll(ctx: AdapterContext, bot: BotIdentity, signal: AbortSignal) {
    if (ctx.ready) {
      const stopped = Promise.withResolvers<void>();
      const stop = () => stopped.resolve();
      signal.addEventListener('abort', stop, { once: true });
      try {
        await Promise.race([ctx.ready, stopped.promise]);
      } finally {
        signal.removeEventListener('abort', stop);
      }
    }
    if (signal.aborted) return;
    let cursor: ReturnType<NonNullable<AdapterContext['loadCursor']>>;
    let initialized = false;
    let backoff = 250;
    while (!signal.aborted) {
      try {
        if (!initialized) {
          cursor = ctx.loadCursor?.(bot.id);
          initialized = true;
        }
        if (cursor && this.#now() - cursor.updatedAt >= cursorLifetimeMs)
          cursor = undefined;
        const offset = cursor?.offset;
        const updates = await this.#api.call(
          'getUpdates',
          {
            timeout: 50,
            offset,
            allowed_updates: ['message', 'edited_message', 'callback_query'],
          },
          signal,
          0,
        );
        if (!Array.isArray(updates))
          throw new Error('Telegram returned invalid updates');
        for (const update of updates
          .map(record)
          .sort((a, b) => Number(a?.update_id) - Number(b?.update_id))) {
          signal.throwIfAborted();
          const id = update?.update_id;
          if (
            typeof id !== 'number' ||
            !Number.isSafeInteger(id) ||
            id < 0 ||
            !update
          )
            throw new Error('Telegram returned an invalid update ID');
          if (cursor && id < cursor.offset) continue;
          const event = mapUpdate(update, bot);
          if (event) await ctx.emit(event);
          const next = { offset: id + 1, updatedAt: this.#now() };
          ctx.saveCursor?.(bot.id, next);
          cursor = next;
        }
        backoff = 250;
      } catch (error) {
        if (signal.aborted) return;
        ctx.logError?.('telegram.poll_retry', error);
        await delay(
          error instanceof BotApiError
            ? (error.retryAfter ?? backoff)
            : backoff,
          undefined,
          { signal },
        );
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  async deleteMessage(
    message: Pick<OutboundMessage, 'chatId'> & { messageId: string },
  ) {
    await this.#api.call(
      'deleteMessage',
      {
        chat_id: message.chatId,
        message_id: Number(message.messageId),
      },
      AbortSignal.timeout(5_000),
    );
  }

  async send(message: OutboundMessage) {
    const signal = this.#signal();
    const parts: SendPart[] = [];
    let messages: ReturnType<typeof telegramMessageParts>;
    try {
      messages = telegramMessageParts(message, this.#ctx?.getUser);
    } catch (error) {
      throw new SendFailure({ parts, deliveryUnknown: false }, error);
    }
    const controls = message.approval ? messages.length - 1 : 0;
    try {
      for (const [index, part] of messages.entries()) {
        const { text, entities } = part;
        const body = {
          ...destination(message),
          text,
          entities,
          reply_parameters: message.replyTo
            ? {
                message_id: Number(message.replyTo),
                allow_sending_without_reply: true,
              }
            : undefined,
          reply_markup:
            index === controls && message.buttons?.length
              ? {
                  inline_keyboard: [
                    message.buttons.map((button) => ({
                      text: button.label,
                      callback_data: button.id,
                    })),
                  ],
                }
              : undefined,
        };
        const sent = record(
          await this.#api
            .call('sendMessage', body, signal)
            .catch((error: unknown) => {
              if (
                message.format !== 'markdown' ||
                message.approval ||
                !entities?.length ||
                !(error instanceof BotApiError) ||
                !error.invalidEntities
              )
                throw error;
              this.#ctx?.logWarning?.('telegram.entities_rejected');
              return this.#api.call(
                'sendMessage',
                { ...body, entities: undefined },
                signal,
                0,
              );
            }),
        );
        const messageId = nativeId(sent?.message_id);
        if (!messageId) throw new BotApiError('sendMessage', undefined);
        parts.push({ messageId, text, raw: { message_id: sent?.message_id } });
      }
    } catch (error) {
      throw new SendFailure(
        {
          parts,
          deliveryUnknown:
            !(error instanceof BotApiError) || error.unknownDelivery,
        },
        error,
      );
    }
    const approvalEntities = message.approval
      ? (messages[controls]?.entities ?? []).flatMap((entity): TextEntity[] =>
          entity.type === 'pre'
            ? [entity]
            : entity.type === 'text_mention'
              ? [
                  {
                    offset: entity.offset,
                    length: entity.length,
                    type: 'mention',
                    userId: String(entity.user.id),
                  },
                ]
              : [],
        )
      : undefined;
    return {
      messageId: parts[controls]!.messageId,
      parts,
      approvalEntities,
    };
  }

  typing(
    chat: Pick<OutboundMessage, 'chatId' | 'threadId'>,
    task: AbortSignal,
  ) {
    const signal = AbortSignal.any([this.#signal(), task]);
    if (signal.aborted) return;
    const ctx = this.#ctx;
    const send = () => {
      // A rate-limited or slow typing action must never pile up behind the next refresh.
      if (busy) return;
      busy = true;
      void this.#api
        .call(
          'sendChatAction',
          {
            ...destination(chat),
            action: 'typing',
          },
          signal,
          0,
        )
        .catch(() => {
          if (!signal.aborted) ctx?.logError?.('telegram.typing_failed');
        })
        .finally(() => {
          busy = false;
        });
    };
    let busy = false;
    send();
    const timer = setInterval(send, this.#typingIntervalMs);
    timer.unref();
    signal.addEventListener('abort', () => clearInterval(timer), {
      once: true,
    });
  }

  async respondToApproval({
    chatId,
    decisionText,
    entities,
    messageId,
    notice,
    pre,
    prompt,
    queryId,
  }: ApprovalFeedback) {
    const signal = this.#signal();
    try {
      if (queryId)
        await this.#api.call(
          'answerCallbackQuery',
          { callback_query_id: queryId, text: notice },
          signal,
        );
    } finally {
      if (decisionText) {
        const suffix = '\n\n' + decisionText;
        const display = prompt
          ? (splitText(prompt)[0] ?? '')
              .slice(0, maxMessage - suffix.length)
              .replace(/[\uD800-\uDBFF]$/u, '')
          : '';
        const text = display ? display + suffix : notice;
        const formatting = (
          entities ?? (pre ? [{ ...pre, type: 'pre' as const }] : [])
        )
          .filter(({ offset }) => offset < display.length)
          .map((entity) => ({
            ...entity,
            length: Math.min(entity.length, display.length - entity.offset),
          }));
        const rendered = telegramMessageParts({
          chatId,
          text,
          entities: formatting,
        });
        await this.#api.call(
          'editMessageText',
          {
            chat_id: chatId,
            message_id: Number(messageId),
            text,
            entities: rendered[0]?.entities,
            reply_markup: { inline_keyboard: [] },
          },
          signal,
        );
      }
    }
  }

  #signal() {
    if (!this.#controller) throw new Error('Telegram adapter is detached');
    return this.#controller.signal;
  }
}

function destination({
  chatId,
  threadId,
}: Pick<OutboundMessage, 'chatId' | 'threadId'>) {
  return {
    chat_id: chatId,
    message_thread_id: threadId === undefined ? undefined : Number(threadId),
  };
}

export default definePlugin({
  name: 'platform-telegram',
  checks: telegramChecks,
  credentialNames: (entry) =>
    'tokenEnv' in entry && typeof entry.tokenEnv === 'string'
      ? [entry.tokenEnv]
      : [],
  setupSteps: telegramSetup,
  adapters: {
    telegram(config, ctx) {
      const token = config.tokenEnv && ctx.credential(config.tokenEnv);
      if (!token)
        throw new Error(
          'Telegram requires tokenEnv with a configured credential',
        );
      return new TelegramAdapter({ fetch: ctx.fetch }, config.id, token);
    },
  },
});
