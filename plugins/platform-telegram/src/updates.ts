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

export function mapUpdate(
  update: Record<string, unknown>,
  bot: BotIdentity,
): PlatformInboundEvent | undefined {
  const callback = record(update.callback_query);
  if (callback) {
    const source = record(callback.message);
    const room = source && address(source);
    const userId = nativeId(record(callback.from)?.id);
    if (room && userId !== undefined && typeof callback.id === 'string') {
      return {
        type: 'callback',
        callbackId: typeof callback.data === 'string' ? callback.data : '',
        queryId: callback.id,
        chatId: room.chatId,
        threadId: room.threadId,
        messageId: room.messageId,
        userId,
      };
    }
    return;
  }

  const edited = record(update.edited_message);
  const message = edited ?? record(update.message);
  if (!message) return;
  const room = address(message);
  const sender = record(message.from);
  const userId = nativeId(sender?.id);
  if (!room || userId === undefined) return;
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
  const repliesToBot = nativeId(record(reply?.from)?.id) === bot.id;
  const userDisplay = [sender?.first_name, sender?.last_name]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  return {
    ...room,
    type: 'message',
    edited: edited !== undefined,
    userId,
    userDisplay: userDisplay || undefined,
    text,
    replyTo: nativeId(reply?.message_id),
    repliesToBot,
    mentionsBot: repliesToBot || mentions(entities, text, bot),
  };
}
