import type { OutboundMessage } from '@tsugimori/plugin-sdk';

import { userMentionLinks } from '@tsugimori/plugin-sdk';

export const maxMessage = 4096;

interface MentionEntity {
  length: number;
  offset: number;
  type: 'text_link';
  url: string;
}

function splitMessage(text: string, links: MentionEntity[]) {
  const parts: { entities?: MentionEntity[]; text: string }[] = [];
  let start = 0;
  let firstLink = 0;
  while (start < text.length) {
    let end = text.length;
    if (end - start > maxMessage) {
      const window = text.slice(start, start + maxMessage);
      const paragraph = window.lastIndexOf('\n\n');
      const line = window.lastIndexOf('\n');
      end =
        start +
        (paragraph >= 0 ? paragraph + 2 : line >= 0 ? line + 1 : maxMessage);
      if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end--;
      for (let index = firstLink; index < links.length; index++) {
        const { offset, length } = links[index]!;
        if (offset >= end) break;
        if (offset > start && offset + length > end) {
          end = offset;
          break;
        }
      }
    }
    const entities: MentionEntity[] = [];
    while (firstLink < links.length) {
      const link = links[firstLink]!;
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
  const mentions = new Set(message.mentions);
  if ([...mentions].some((id) => !/^[1-9]\d{0,19}$/.test(id)))
    throw new Error('Expected native user IDs for Telegram mentions');
  const entities: MentionEntity[] = [];
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
  return splitMessage(text, entities);
}
