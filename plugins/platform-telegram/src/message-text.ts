import type { OutboundMessage, TextRange } from '@tsugimori/plugin-sdk';

import { userMentionLinks } from '@tsugimori/plugin-sdk';

export const maxMessage = 4096;

type TelegramEntity = TextRange &
  (
    | { type: 'text_link'; url: string }
    | { type: 'text_mention'; user: { id: number } }
    | { type: 'pre' }
  );

function splitMessage(
  text: string,
  spans: TelegramEntity[],
  limit = maxMessage,
) {
  const parts: { entities?: TelegramEntity[]; text: string }[] = [];
  let start = 0;
  let firstLink = 0;
  while (start < text.length) {
    let end = text.length;
    if (end - start > limit) {
      const window = text.slice(start, start + limit);
      const paragraph = window.lastIndexOf('\n\n');
      const line = window.lastIndexOf('\n');
      end =
        start + (paragraph >= 0 ? paragraph + 2 : line >= 0 ? line + 1 : limit);
      if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end--;
      for (let index = firstLink; index < spans.length; index++) {
        const { offset, length, type } = spans[index]!;
        if (offset >= end) break;
        if (type !== 'pre' && offset > start && offset + length > end) {
          end = offset;
          break;
        }
      }
    }
    const entities: TelegramEntity[] = [];
    while (firstLink < spans.length) {
      const link = spans[firstLink]!;
      if (link.offset >= end) break;
      const offset = Math.max(link.offset, start);
      const linkEnd = link.offset + link.length;
      entities.push({
        ...link,
        offset: offset - start,
        length: Math.min(end, linkEnd) - offset,
      });
      if (linkEnd > end) break;
      firstLink++;
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

export function telegramMessageParts(message: OutboundMessage) {
  // Leave room to append the localized decision without replacing preview text.
  const limit = message.approval ? maxMessage - 64 : maxMessage;
  if (message.entities) {
    if (!message.text) throw new Error('Empty Telegram message');
    const entities = [...message.entities].sort((a, b) => a.offset - b.offset);
    let end = 0;
    return splitMessage(
      message.text,
      entities.map((entity) => {
        const { offset, length } = entity;
        if (
          !Number.isInteger(offset) ||
          !Number.isInteger(length) ||
          offset < end ||
          length <= 0 ||
          offset + length > message.text.length
        )
          throw new Error('Invalid Telegram message entity range');
        end = offset + length;
        if (entity.type === 'pre') return { offset, length, type: 'pre' };
        const id = Number(entity.userId);
        if (!/^[1-9]\d{0,15}$/.test(entity.userId) || id > 2 ** 52 - 1)
          throw new Error('Expected a native user ID for Telegram mention');
        return { offset, length, type: 'text_mention', user: { id } };
      }),
      limit,
    );
  }
  const mentions = new Set(message.mentions);
  if ([...mentions].some((id) => !/^[1-9]\d{0,19}$/.test(id)))
    throw new Error('Expected native user IDs for Telegram mentions');
  const entities: TelegramEntity[] = [];
  let text = '';
  const link = (label: string, userId: string) => {
    entities.push({
      type: 'text_link',
      offset: text.length,
      length: label.length,
      url: 'tg://user?id=' + userId,
    });
    text += label;
  };
  let end = 0;
  if (message.parseTextMentions !== false) {
    for (const mention of userMentionLinks(message.text)) {
      text += message.text.slice(end, mention.start);
      link(mention.label, mention.userId);
      mentions.delete(mention.userId);
      end = mention.end;
    }
  }
  text += message.text.slice(end);
  if (mentions.size && text) text += '\n\n';
  for (const [index, userId] of [...mentions].entries()) {
    if (index) text += ' ';
    link('user ' + userId, userId);
  }
  if (!text) throw new Error('Empty Telegram message');
  return splitMessage(text, entities, limit);
}
