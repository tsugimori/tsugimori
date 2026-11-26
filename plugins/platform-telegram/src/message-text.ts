import type {
  AdapterContext,
  OutboundMessage,
  TextRange,
} from '@tsugimori/plugin-sdk';

import { userMentionLinks } from '@tsugimori/plugin-sdk';

export const maxMessage = 4096;

type TelegramEntity = TextRange &
  ({ type: 'text_mention'; user: { id: number } } | { type: 'pre' });
type TelegramSpan = TelegramEntity | (TextRange & { type: 'mention' });

function splitMessage(text: string, spans: TelegramSpan[], limit = maxMessage) {
  const parts: { entities?: TelegramEntity[]; text: string }[] = [];
  let start = 0;
  let firstSpan = 0;
  while (start < text.length) {
    let end = text.length;
    if (end - start > limit) {
      const window = text.slice(start, start + limit);
      const paragraph = window.lastIndexOf('\n\n');
      const line = window.lastIndexOf('\n');
      end =
        start + (paragraph >= 0 ? paragraph + 2 : line >= 0 ? line + 1 : limit);
      if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end--;
      for (let index = firstSpan; index < spans.length; index++) {
        const { offset, length, type } = spans[index]!;
        if (offset >= end) break;
        if (type !== 'pre' && offset > start && offset + length > end) {
          end = offset;
          break;
        }
      }
    }
    const entities: TelegramEntity[] = [];
    while (firstSpan < spans.length) {
      const span = spans[firstSpan]!;
      if (span.offset >= end) break;
      const offset = Math.max(span.offset, start);
      const spanEnd = span.offset + span.length;
      // Telegram detects @usernames in the text. Keep their spans together when splitting.
      if (span.type !== 'mention')
        entities.push({
          ...span,
          offset: offset - start,
          length: Math.min(end, spanEnd) - offset,
        });
      if (spanEnd > end) break;
      firstSpan++;
    }
    parts.push({
      text: text.slice(start, end),
      entities: entities.length ? entities : undefined,
    });
    start = end;
  }
  return parts;
}

export function splitText(text: string) {
  return splitMessage(text, []).map((part) => part.text);
}

export function telegramMessageParts(
  message: OutboundMessage,
  getUser?: AdapterContext['getUser'],
) {
  // Leave room to append the localized decision without replacing preview text.
  const limit = message.approval ? maxMessage - 64 : maxMessage;
  const spans: TelegramSpan[] = [];
  let text = '';
  const mention = (userId: string, label?: string, sourceEnd?: number) => {
    const id = Number(userId);
    if (!/^[1-9]\d{0,15}$/.test(userId) || id > 2 ** 52 - 1)
      throw new Error('Expected a native user ID for Telegram mention');
    const user = getUser?.(userId);
    const username =
      user?.username && /^[a-z0-9_]{2,32}$/i.test(user.username)
        ? user.username
        : undefined;
    const name = username
      ? '@' + username
      : label || user?.display || 'user ' + userId;
    // Telegram ignores @usernames adjacent to letters or numbers, including CJK.
    if (username && /[\p{L}\p{N}_]$/u.test(text)) text += ' ';
    const range = { offset: text.length, length: name.length };
    spans.push(
      username
        ? { ...range, type: 'mention' }
        : { ...range, type: 'text_mention', user: { id } },
    );
    text += name;
    if (
      username &&
      sourceEnd !== undefined &&
      /^[\p{L}\p{N}_]/u.test(message.text.slice(sourceEnd, sourceEnd + 2))
    )
      text += ' ';
  };
  let end = 0;
  if (message.entities) {
    if (!message.text) throw new Error('Empty Telegram message');
    for (const entity of [...message.entities].sort(
      (a, b) => a.offset - b.offset,
    )) {
      const { offset, length } = entity;
      if (
        !Number.isInteger(offset) ||
        !Number.isInteger(length) ||
        offset < end ||
        length <= 0 ||
        offset + length > message.text.length
      )
        throw new Error('Invalid Telegram message entity range');
      text += message.text.slice(end, offset);
      end = offset + length;
      const label = message.text.slice(offset, end);
      if (entity.type === 'pre') {
        spans.push({ type: 'pre', offset: text.length, length });
        text += label;
      } else {
        mention(entity.userId, label, end);
      }
    }
    return splitMessage(text + message.text.slice(end), spans, limit);
  }
  const mentions = new Set(message.mentions);
  if (message.parseTextMentions !== false) {
    for (const { start, end: next, label, userId } of userMentionLinks(
      message.text,
    )) {
      text += message.text.slice(end, start);
      mention(userId, label, next);
      mentions.delete(userId);
      end = next;
    }
  }
  text += message.text.slice(end);
  if (mentions.size && text) text += '\n\n';
  for (const [index, userId] of [...mentions].entries()) {
    if (index) text += ' ';
    mention(userId);
  }
  if (!text) throw new Error('Empty Telegram message');
  return splitMessage(text, spans, limit);
}
