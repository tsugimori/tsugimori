import type {
  InboundMessage,
  PlatformInboundEvent,
} from '@tsugimori/plugin-sdk';

import { nativeId, record } from './api.ts';

export interface BotIdentity {
  id: string;
  username: string;
}

function address(message: Record<string, unknown>) {
  const chat = record(message.chat);
  const chatId = nativeId(chat?.id);
  const messageId = nativeId(message.message_id);
  let chatKind: InboundMessage['chatKind'];
  switch (chat?.type) {
    case 'private':
      chatKind = 'dm';
      break;
    case 'group':
    case 'supergroup':
      chatKind = chat.type;
      break;
    default:
      return;
  }
  if (chatId === undefined || messageId === undefined) return;
  return {
    chatId,
    chatKind,
    chatTitle: typeof chat.title === 'string' ? chat.title : undefined,
    messageId,
    threadId:
      message.is_topic_message === true
        ? nativeId(message.message_thread_id)
        : undefined,
  };
}

function mentions(entities: unknown, text: string, bot: BotIdentity) {
  if (!Array.isArray(entities)) return false;
  return entities.some((value: unknown) => {
    const entity = record(value);
    if (entity?.type === 'text_mention')
      return nativeId(record(entity.user)?.id) === bot.id;
    const { length, offset } = entity ?? {};
    return (
      entity?.type === 'mention' &&
      typeof offset === 'number' &&
      Number.isSafeInteger(offset) &&
      offset >= 0 &&
      typeof length === 'number' &&
      Number.isSafeInteger(length) &&
      length > 0 &&
      offset + length <= text.length &&
      text.slice(offset, offset + length).toLowerCase() === `@${bot.username}`
    );
  });
}

function displayName(user: Record<string, unknown> | undefined) {
  return [user?.first_name, user?.last_name]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
}

export function mapUpdate(
  update: Record<string, unknown>,
  bot: BotIdentity,
): PlatformInboundEvent | undefined {
  const callback = record(update.callback_query);
  if (callback) {
    const source = record(callback.message);
    const room = source && address(source);
    const from = record(callback.from);
    const userId = nativeId(from?.id);
    if (room && userId !== undefined && typeof callback.id === 'string') {
      const userDisplay = displayName(from);
      return {
        type: 'callback',
        raw: callback,
        callbackId: typeof callback.data === 'string' ? callback.data : '',
        queryId: callback.id,
        chatId: room.chatId,
        threadId: room.threadId,
        messageId: room.messageId,
        userId,
        userDisplay: userDisplay || undefined,
        userUsername: typeof from?.username === 'string' ? from.username : null,
      };
    }
    return;
  }

  const edited = record(update.edited_message);
  const message = edited ?? record(update.message);
  if (!message) return;
  const room = address(message);
  if (!room) return;
  const fromChatId = nativeId(message.migrate_from_chat_id);
  const toChatId = nativeId(message.migrate_to_chat_id);
  const migration =
    room.chatKind === 'group' && toChatId !== undefined
      ? { chatId: room.chatId, newChatId: toChatId }
      : room.chatKind === 'supergroup' && fromChatId !== undefined
        ? { chatId: fromChatId, newChatId: room.chatId }
        : undefined;
  const inbound = mapMessage(message, room, bot, edited !== undefined);
  return migration
    ? {
        ...migration,
        type: 'chat-migrated',
        title: room.chatTitle,
        message: inbound,
      }
    : inbound;
}

function mapMessage(
  message: Record<string, unknown>,
  room: NonNullable<ReturnType<typeof address>>,
  bot: BotIdentity,
  edited: boolean,
): InboundMessage | undefined {
  const sender = record(message.from);
  const userId = nativeId(sender?.id);
  if (userId === undefined) return;
  const text =
    typeof message.text === 'string'
      ? message.text
      : typeof message.caption === 'string'
        ? message.caption
        : '';
  const entities =
    typeof message.text === 'string'
      ? message.entities
      : message.caption_entities;
  const reply = record(message.reply_to_message);
  const replySender = record(reply?.from);
  const repliesToBot = nativeId(replySender?.id) === bot.id;
  const mentionsBot = repliesToBot || mentions(entities, text, bot);
  const addressedToOther = !mentionsBot && replySender?.is_bot === true;
  const userDisplay = displayName(sender);
  return {
    ...room,
    type: 'message',
    raw: message,
    ...(sender?.is_bot === true && { botMessage: true }),
    ...(addressedToOther && { addressedToOther: true }),
    edited,
    userId,
    userDisplay: userDisplay || undefined,
    userUsername: typeof sender?.username === 'string' ? sender.username : null,
    text,
    replyTo: nativeId(reply?.message_id),
    repliesToBot,
    mentionsBot,
  };
}
