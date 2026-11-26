import type {
  AdapterContext,
  ApprovalFeedback,
  ApprovalReaction,
  InboundMessage,
  MediaDestination,
  MediaUpload,
  OutboundMessage,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformCommand,
  PlatformCommandErrorDetails,
  PlatformCommandScope,
  SendPart,
  TextEntity,
} from '@tsugimori/plugin-sdk';

import {
  definePlugin,
  PlatformStartError,
  SendFailure,
  ToolFailure,
} from '@tsugimori/plugin-sdk';
import { setTimeout as delay } from 'node:timers/promises';

import type { BotIdentity } from './updates.ts';

import { BotApi, BotApiError, nativeId, record } from './api.ts';
import { telegramSetSticker } from './inbound-media.ts';
import {
  maxMessage,
  parseTelegramMarkdown,
  splitText,
  telegramMessageParts,
} from './message-text.ts';
import { normalizeReaction, telegramReactions } from './outbound-media.ts';
import { telegramRichMessage } from './rich-message.ts';
import {
  telegramChecks,
  telegramIdentity,
  telegramIdentityFailure,
  telegramSetup,
} from './setup.ts';
import { mapUpdate } from './updates.ts';

const telegramUploadLimits = {
  files: { maxBytes: 50 * 1024 * 1024 },
  images: { maxBytes: 10 * 1024 * 1024 },
};
type SendMethod =
  | 'sendMessage'
  | 'sendRichMessage'
  | 'sendSticker'
  | 'sendPhoto'
  | 'sendDocument'
  | 'sendVideo';

const cursorLifetimeMs = 6 * 24 * 60 * 60 * 1_000;
const unavailableScopeReasons = [
  /\b(?:chat|user|member) not found\b/i,
  /\b(?:not (?:a )?member|USER_NOT_PARTICIPANT)\b/i,
  /\bbot was (?:kicked|removed|blocked)\b/i,
  /\b(?:group chat was deleted|user is deactivated|bot can't initiate conversation)\b/i,
];

export { splitText };

function commandScope(scope: PlatformCommandScope) {
  if ('userId' in scope) {
    const id = Number(scope.userId);
    if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== scope.userId)
      return;
  }
  switch (scope.type) {
    case 'default':
      return { type: 'default' };
    case 'group-chats':
      return { type: 'all_group_chats' };
    case 'private-chats':
      return { type: 'all_private_chats' };
    case 'private-chat':
      return { type: 'chat', chat_id: scope.userId };
    case 'chat-member':
      return {
        type: 'chat_member',
        chat_id: scope.chatId,
        user_id: Number(scope.userId),
      };
  }
}

export class TelegramAdapter implements PlatformAdapter {
  readonly id: string;
  readonly kind = 'telegram';
  readonly capabilities: PlatformCapabilities;
  readonly #api: BotApi;
  readonly #fetch: typeof globalThis.fetch;
  readonly #token: string;
  readonly #now: () => number;
  readonly #typingIntervalMs: number;
  #ctx?: AdapterContext;
  #botIdentity?: BotIdentity;
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
    { richMessages = false }: { richMessages?: boolean } = {},
  ) {
    this.id = id;
    this.capabilities = {
      deleteEvents: false,
      ...telegramUploadLimits,
      reactions: true,
      stickers: true,
      inlineButtons: true,
      outboundPush: 'free',
      richText: richMessages,
    };
    this.#api = new BotApi(fetch, token);
    this.#fetch = fetch;
    this.#token = token;
    this.#now = now;
    this.#typingIntervalMs = typingIntervalMs;
  }

  get botIdentity() {
    return this.#botIdentity;
  }

  async contactLink() {
    const username = this.#botIdentity?.username;
    if (username) return `https://t.me/${username}`;
  }

  async start(ctx: AdapterContext) {
    if (this.#controller)
      throw new Error('Telegram adapter is already started');
    const controller = new AbortController();
    this.#controller = controller;
    this.#ctx = ctx;
    try {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(8_000),
        ...(ctx.signal ? [ctx.signal] : []),
      ]);
      const bot = await telegramIdentity(this.#fetch, this.#token, signal, 0);
      signal.throwIfAborted();
      this.#botIdentity = bot;
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
      if (error instanceof BotApiError) {
        if (error.invalidToken)
          throw new PlatformStartError(error.message, {
            failure: telegramIdentityFailure,
          });
        if (error.code === 429 && error.retryAfter !== undefined)
          throw new PlatformStartError(error.message, {
            retryAfterMs: error.retryAfter,
          });
      }
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
      this.#botIdentity = undefined;
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

  async setCommands(
    commands: readonly PlatformCommand[],
    scope: PlatformCommandScope,
  ) {
    const target = commandScope(scope);
    if (!target) {
      if (commands.length) throw new Error('Invalid Telegram command user ID');
      return;
    }
    const result = await this.#api.call(
      commands.length ? 'setMyCommands' : 'deleteMyCommands',
      commands.length
        ? {
            scope: target,
            commands: commands.map(({ name, description }) => ({
              command: name,
              description,
            })),
          }
        : { scope: target },
      AbortSignal.any([this.#signal(), AbortSignal.timeout(5_000)]),
    );
    if (result !== true) throw new Error('Telegram did not update commands');
  }

  describeCommandError(
    error: unknown,
  ): PlatformCommandErrorDetails | undefined {
    if (!(error instanceof BotApiError)) return;
    const { code, description, parameters } = error;
    return {
      code,
      migratedToChatId: parameters.migrateToChatId,
      retryAfterMs: parameters.retryAfterMs,
      scopeUnavailable:
        (code === 400 || code === 403) &&
        description !== undefined &&
        unavailableScopeReasons.some((reason) => reason.test(description)),
    };
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

  #sender(message: MediaDestination, signal: AbortSignal) {
    let chatId = this.#ctx?.resolveChatId?.(message.chatId) ?? message.chatId;
    let migrated = false;
    return async (
      method: SendMethod,
      body: Record<string, unknown>,
      retries?: number,
    ) => {
      const post = (retries?: number) => {
        const fields = {
          ...body,
          ...destination(chatId === message.chatId ? message : { chatId }),
          reply_parameters:
            chatId === message.chatId && message.replyTo
              ? {
                  message_id: Number(message.replyTo),
                  allow_sending_without_reply: true,
                }
              : undefined,
        };
        return this.#api.call(method, fields, signal, retries);
      };
      let result;
      try {
        result = await post(retries);
      } catch (error) {
        if (migrated) throw error;
        const next = await this.#recordMigration(chatId, error);
        if (!next) throw error;
        chatId = next;
        migrated = true;
        result = await post(0);
      }
      const sent = record(result);
      const messageId = nativeId(sent?.message_id);
      if (!messageId) throw new BotApiError(method, undefined);
      return {
        ...(chatId === message.chatId ? {} : { chatId }),
        messageId,
        raw: { message_id: sent?.message_id },
      };
    };
  }

  async send(message: OutboundMessage) {
    const send = this.#sender(message, this.#signal());
    const parts: SendPart[] = [];
    let messages: ReturnType<typeof telegramMessageParts>;
    let markdown: ReturnType<typeof parseTelegramMarkdown> | undefined;
    let rich: ReturnType<typeof telegramRichMessage> | undefined;
    const getUser = this.#ctx?.getUser;
    try {
      if (message.format === 'markdown' && !message.approval)
        markdown = parseTelegramMarkdown(message);
      if (
        this.capabilities.richText &&
        markdown?.hasTable &&
        !message.buttons?.length
      )
        rich = telegramRichMessage(message, markdown.blocks, getUser);
    } catch (error) {
      throw new SendFailure({ parts, deliveryUnknown: false }, error);
    }
    if (rich) {
      let reason: string | undefined = rich.reason;
      if (rich.reason === undefined) {
        try {
          const part = await send('sendRichMessage', {
            rich_message: { blocks: rich.blocks },
          });
          parts.push({ ...part, text: rich.text });
          return { messageId: part.messageId, parts };
        } catch (error) {
          if (!(error instanceof BotApiError) || error.code !== 400)
            throw new SendFailure(
              {
                parts,
                deliveryUnknown:
                  !(error instanceof BotApiError) || error.unknownDelivery,
              },
              error,
            );
          reason = 'api_400';
        }
      }
      this.#ctx?.logWarning?.('telegram.rich_fallback', reason);
    }
    try {
      messages = telegramMessageParts(message, getUser, markdown?.blocks);
    } catch (error) {
      throw new SendFailure({ parts, deliveryUnknown: false }, error);
    }
    const controls = message.approval ? messages.length - 1 : 0;
    const keyboard = [];
    const buttons = message.buttons ?? [];
    for (let index = 0; index < buttons.length; index += 4)
      keyboard.push(
        buttons.slice(index, index + 4).map(({ id, label }) => ({
          text: label,
          callback_data: id,
        })),
      );
    try {
      for (const [index, part] of messages.entries()) {
        const { text, entities } = part;
        const body = {
          text,
          reply_markup:
            index === controls && keyboard.length
              ? { inline_keyboard: keyboard }
              : undefined,
        };
        const sent = await send('sendMessage', { ...body, entities }).catch(
          (error: unknown) => {
            if (
              message.format !== 'markdown' ||
              message.approval ||
              !entities?.length ||
              !(error instanceof BotApiError) ||
              !error.invalidEntities
            )
              throw error;
            this.#ctx?.logWarning?.('telegram.entities_rejected');
            return send('sendMessage', body, 0);
          },
        );
        parts.push({ ...sent, text });
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

  async sendReaction(
    {
      chatId,
      emoji,
      messageId,
    }: MediaDestination & { emoji: string; messageId: string },
    signal: AbortSignal,
  ) {
    const normalized = normalizeReaction(emoji);
    if (!telegramReactions.has(normalized))
      throw new ToolFailure('Telegram does not support this reaction emoji');
    const id = Number(messageId);
    if (!Number.isSafeInteger(id) || id < 1 || String(id) !== messageId)
      throw new ToolFailure('Invalid Telegram reaction message ID');
    if ((this.#ctx?.resolveChatId?.(chatId) ?? chatId) !== chatId)
      throw new ToolFailure(
        'Cannot react to a message before the chat migrated',
      );
    try {
      await this.#api.call(
        'setMessageReaction',
        {
          chat_id: chatId,
          message_id: id,
          reaction: [{ type: 'emoji', emoji: normalized }],
        },
        AbortSignal.any([this.#signal(), signal]),
      );
    } catch (error) {
      await this.#recordMigration(chatId, error);
      if (
        error instanceof BotApiError &&
        /reaction_invalid|reaction is not allowed/i.test(
          error.description ?? '',
        )
      )
        throw new ToolFailure(
          'This Telegram chat does not allow that reaction',
        );
      throw error;
    }
  }

  sendSticker(
    message: MediaDestination & { fileId: string },
    signal: AbortSignal,
  ) {
    if (!/^[\w-]+$/.test(message.fileId))
      throw new ToolFailure('Expected a Telegram sticker file ID');
    return this.#sendMedia(
      message,
      'sendSticker',
      { sticker: message.fileId },
      '[sticker]',
      signal,
    );
  }

  sendImage(message: MediaUpload, signal: AbortSignal) {
    return this.#upload(
      message,
      'sendPhoto',
      'photo',
      telegramUploadLimits.images.maxBytes,
      signal,
    );
  }

  sendFile(message: MediaUpload, signal: AbortSignal) {
    return message.file.mime === 'video/mp4'
      ? this.#upload(
          message,
          'sendVideo',
          'video',
          telegramUploadLimits.files.maxBytes,
          signal,
        )
      : this.#upload(
          message,
          'sendDocument',
          'document',
          telegramUploadLimits.files.maxBytes,
          signal,
        );
  }

  #upload(
    message: MediaUpload,
    method: SendMethod,
    field: 'photo' | 'video' | 'document',
    limit: number,
    signal: AbortSignal,
  ) {
    if (message.file.bytes.byteLength > limit)
      throw new ToolFailure(
        `Telegram ${field} upload exceeds the ${limit / 1024 ** 2} MB size limit`,
      );
    const { bytes, mime, name } = message.file;
    const file = new File([new Uint8Array(bytes)], name, { type: mime });
    return this.#sendMedia(
      message,
      method,
      { [field]: file },
      field === 'photo' ? '[image]' : field === 'video' ? '[video]' : '[file]',
      signal,
    );
  }

  async #sendMedia(
    message: MediaDestination,
    method: SendMethod,
    body: Record<string, unknown>,
    text: string,
    signal: AbortSignal,
  ) {
    const send = this.#sender(
      message,
      AbortSignal.any([this.#signal(), signal]),
    );
    try {
      const part = await send(method, body);
      return { messageId: part.messageId, parts: [{ ...part, text }] };
    } catch (error) {
      throw new SendFailure(
        {
          parts: [],
          deliveryUnknown:
            !(error instanceof BotApiError) || error.unknownDelivery,
        },
        error,
      );
    }
  }

  async getStickerSet(name: string, signal: AbortSignal) {
    const response = record(
      await this.#api.call(
        'getStickerSet',
        { name },
        AbortSignal.any([this.#signal(), signal]),
      ),
    );
    const stickers = response?.stickers;
    if (!Array.isArray(stickers) || !stickers.length)
      throw new Error('Telegram returned an empty or invalid sticker set');
    return stickers.map((value: unknown, index) =>
      telegramSetSticker(value, name, index),
    );
  }

  downloadAttachment(
    ...args: Parameters<NonNullable<PlatformAdapter['downloadAttachment']>>
  ) {
    return this.#api.downloadAttachment(...args);
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
          { callback_query_id: queryId, text: notice || undefined },
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
        const text = display ? display + suffix : decisionText;
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
        try {
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
        } catch (error) {
          await this.#recordMigration(chatId, error);
          throw error;
        }
      }
    }
  }

  async setApprovalReaction(
    { chatId, messageId }: Pick<InboundMessage, 'chatId' | 'messageId'>,
    status: ApprovalReaction,
    signal: AbortSignal,
  ) {
    const emoji = {
      pending: '👀',
      approved: '👍',
      denied: '👎',
      expired: null,
    }[status];
    try {
      await this.#api.call(
        'setMessageReaction',
        {
          chat_id: chatId,
          message_id: Number(messageId),
          reaction: emoji ? [{ type: 'emoji', emoji }] : [],
        },
        AbortSignal.any([this.#signal(), signal]),
        0,
      );
    } catch (error) {
      await this.#recordMigration(chatId, error);
      throw error;
    }
  }

  async #recordMigration(chatId: string, error: unknown) {
    if (!(error instanceof BotApiError) || error.code !== 400) return;
    const newChatId = error.parameters.migrateToChatId;
    if (!newChatId || newChatId === chatId) return;
    await this.#ctx?.emit({ type: 'chat-migrated', chatId, newChatId });
    const resolved = this.#ctx?.resolveChatId?.(chatId) ?? newChatId;
    return resolved === chatId ? undefined : resolved;
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
      return new TelegramAdapter({ fetch: ctx.fetch }, config.id, token, {
        richMessages: config.richMessages,
      });
    },
  },
});
