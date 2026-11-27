import type {
  AdapterContext,
  InboundMessage,
  PlatformInboundEvent,
} from '@tsugimori/plugin-sdk';

import { nonempty, record } from './api.ts';
import { lineAttachments } from './inbound-media.ts';

interface LineMessage {
  inbound: InboundMessage;
  profilePath: string;
  quoteToken?: string;
  replyToken?: string;
}

export interface LinePostback {
  data: string;
  inbound: Omit<
    Extract<PlatformInboundEvent, { type: 'callback' }>,
    'callbackId' | 'messageId' | 'queryId'
  > & { queryId: string };
  profilePath: string;
  replyToken?: string;
}

function mapSource(source: Record<string, unknown> | undefined) {
  const userId = nonempty(source?.userId);
  if (!userId) return;
  const sourceType = source?.type;
  const chatId =
    sourceType === 'user'
      ? userId
      : sourceType === 'group'
        ? nonempty(source?.groupId)
        : sourceType === 'room'
          ? nonempty(source?.roomId)
          : undefined;
  if (!chatId) return;
  const user = encodeURIComponent(userId);
  const profilePath =
    sourceType === 'user'
      ? `/v2/bot/profile/${user}`
      : `/v2/bot/${sourceType}/${encodeURIComponent(chatId)}/member/${user}`;
  return { chatId, profilePath, sourceType, userId };
}

export function mapPostback(
  event: Record<string, unknown>,
  ctx: AdapterContext,
): LinePostback | undefined {
  if (event.mode === 'standby') {
    ctx.logDebug?.('line.standby_postback_ignored');
    return;
  }
  const source = record(event.source);
  const sender = mapSource(source);
  if (!sender && !nonempty(source?.userId))
    ctx.logWarning?.('line.postback_missing_user');
  const data = nonempty(record(event.postback)?.data);
  const queryId = nonempty(event.webhookEventId);
  if (!sender || !data || !queryId) return;
  const { chatId, profilePath, userId } = sender;
  return {
    data,
    profilePath,
    replyToken: nonempty(event.replyToken),
    inbound: { chatId, queryId, type: 'callback', userId },
  };
}

export function mapEvent(
  event: Record<string, unknown>,
  ctx: AdapterContext,
): LineMessage | undefined {
  if (event.type !== 'message') {
    ctx.logDebug?.('line.event_ignored');
    return;
  }
  if (event.mode === 'standby') {
    ctx.logDebug?.('line.standby_message_ignored');
    return;
  }
  const source = record(event.source);
  const sender = mapSource(source);
  if (!sender) {
    if (!nonempty(source?.userId))
      ctx.logWarning?.('line.message_missing_user');
    return;
  }
  const { chatId, profilePath, sourceType, userId } = sender;

  const message = record(event.message);
  const messageId = nonempty(message?.id);
  const type = nonempty(message?.type);
  if (!message || !messageId || !type) return;

  const text = type === 'text' ? nonempty(message.text) : `[${type}]`;
  if (text === undefined) return;
  const mentionees = record(message.mention)?.mentionees;
  const mentionsBot =
    Array.isArray(mentionees) &&
    mentionees.some((entry: unknown) => record(entry)?.isSelf === true);
  const addressedToOther =
    sourceType !== 'user' &&
    !mentionsBot &&
    Array.isArray(mentionees) &&
    mentionees.some(
      (entry: unknown) =>
        record(entry)?.type === 'user' && record(entry)?.isSelf === false,
    );
  const replyId = nonempty(message.quotedMessageId);
  const attachments = lineAttachments(message, messageId);
  const timestamp = event.timestamp;
  return {
    profilePath,
    quoteToken: nonempty(message.quoteToken),
    replyToken: nonempty(event.replyToken),
    inbound: {
      ...(addressedToOther && { addressedToOther: true }),
      chatId,
      chatKind: sourceType === 'user' ? 'dm' : 'group',
      mentionsBot,
      messageId,
      raw: event,
      ...(replyId && { replyTo: { id: replyId } }),
      ...(attachments.length && { attachments }),
      ...(typeof timestamp === 'number' &&
        Number.isSafeInteger(timestamp) && { at: timestamp }),
      text,
      type: 'message',
      userId,
    },
  };
}
