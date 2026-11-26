import type { AdapterContext, InboundMessage } from '@tsugimori/plugin-sdk';

import { nonempty, record } from './api.ts';

interface LineMessage {
  inbound: InboundMessage;
  profilePath: string;
  quoteToken?: string;
  replyToken?: string;
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
  const message = record(event.message);
  const source = record(event.source);
  const userId = nonempty(source?.userId);
  if (!userId) {
    ctx.logWarning?.('line.message_missing_user');
    return;
  }
  const messageId = nonempty(message?.id);
  const type = nonempty(message?.type);
  if (!message || !messageId || !type) return;
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

  const text = type === 'text' ? nonempty(message.text) : `[${type}]`;
  if (text === undefined) return;
  const mentionees = record(message.mention)?.mentionees;
  const mentionsBot =
    Array.isArray(mentionees) &&
    mentionees.some((entry: unknown) => record(entry)?.isSelf === true);
  const user = encodeURIComponent(userId);
  const profilePath =
    sourceType === 'user'
      ? `/v2/bot/profile/${user}`
      : `/v2/bot/${sourceType}/${encodeURIComponent(chatId)}/member/${user}`;
  return {
    profilePath,
    quoteToken: nonempty(message.quoteToken),
    replyToken: nonempty(event.replyToken),
    inbound: {
      chatId,
      chatKind: sourceType === 'user' ? 'dm' : 'group',
      mentionsBot,
      messageId,
      replyTo: nonempty(message.quotedMessageId),
      text,
      type: 'message',
      userId,
    },
  };
}
