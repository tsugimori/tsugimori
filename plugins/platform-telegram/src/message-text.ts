import type {
  AdapterContext,
  OutboundMessage,
  TextRange,
} from '@tsugimori/plugin-sdk';

import { containsMention, userMentionLinks } from '@tsugimori/plugin-sdk';

import type { MarkdownEntity } from './markdown.ts';

import { renderMarkdown } from './markdown.ts';

export const maxMessage = 4096;

type TelegramEntity =
  | Exclude<MarkdownEntity, { type: 'mention' }>
  | (TextRange & { type: 'text_mention'; user: { id: number } });
type TelegramSpan = TelegramEntity | (TextRange & { type: 'mention' });

function splitMessage(text: string, spans: TelegramSpan[], limit = maxMessage) {
  const parts: { entities?: TelegramEntity[]; text: string }[] = [];
  const ordered = spans
    .filter(({ length, type }) => length <= limit || type === 'pre')
    .sort((a, b) => a.offset - b.offset || b.length - a.length);
  let start = 0;
  let firstSpan = 0;
  while (start < text.length) {
    let end = text.length;
    if (end - start > limit) {
      const window = text.slice(start, start + limit);
      const paragraph = window.lastIndexOf('\n\n');
      const line = window.lastIndexOf('\n');
      const hardEnd = start + limit - Number(/[\uD800-\uDBFF]$/u.test(window));
      end =
        paragraph >= 0
          ? start + paragraph + 2
          : line >= 0
            ? start + line + 1
            : hardEnd;
      // A preferred line break may be inside an entity that fits in this chunk.
      for (let index = firstSpan; index < ordered.length; index++) {
        const span = ordered[index]!;
        if (span.offset >= end) break;
        const spanEnd = span.offset + span.length;
        if (span.length > limit || spanEnd <= end) continue;
        if (span.offset > start) {
          end = span.offset;
          break;
        }
        end = Math.min(spanEnd, hardEnd);
      }
    }
    const entities: TelegramEntity[] = [];
    const ends = new Map<TelegramEntity['type'], number>();
    for (let index = firstSpan; index < ordered.length; index++) {
      const span = ordered[index]!;
      if (span.offset >= end) break;
      const spanEnd = span.offset + span.length;
      if (spanEnd <= start || span.type === 'mention') continue;
      const offset = Math.max(span.offset, start);
      const until = Math.min(end, spanEnd);
      // Telegram rejects nested entities of the same type.
      if (until <= (ends.get(span.type) ?? 0)) continue;
      ends.set(span.type, until);
      entities.push({
        ...span,
        offset: offset - start,
        length: until - offset,
      });
    }
    while (
      firstSpan < ordered.length &&
      ordered[firstSpan]!.offset + ordered[firstSpan]!.length <= end
    )
      firstSpan++;
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

function sourceEntities({ entities, text }: OutboundMessage) {
  const ordered = [...(entities ?? [])].sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const { offset, length } of ordered) {
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < end ||
      length <= 0 ||
      offset + length > text.length
    )
      throw new Error('Invalid Telegram message entity range');
    end = offset + length;
  }
  return ordered;
}

export function telegramMessageParts(
  message: OutboundMessage,
  getUser?: AdapterContext['getUser'],
) {
  // Leave room to append the localized decision without replacing preview text.
  const limit = message.approval ? maxMessage - 64 : maxMessage;
  const spans: TelegramSpan[] = [];
  let text = '';
  const mention = (userId: string, label?: string, following = '') => {
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
    if (username && /^[\p{L}\p{N}_]/u.test(following)) text += ' ';
  };
  let end = 0;
  const mentions = new Set(message.mentions);
  const explicit = sourceEntities(message);
  if (message.format === 'markdown' && !message.approval) {
    const rendered = renderMarkdown(
      message.text,
      new Map(explicit.map((entity) => [entity.offset, entity])),
      message.parseTextMentions !== false,
    );
    if (
      message.allowTextMentions === false &&
      (containsMention(rendered.text) ||
        rendered.entities.some(
          (entity) =>
            entity.type === 'mention' ||
            (entity.type === 'text_link' && containsMention(entity.url)),
        ))
    )
      throw new Error('Scheduled response contains an unapproved mention');
    const replacements: { end: number; shift: number }[] = [];
    for (const entity of rendered.entities
      .filter((entity) => entity.type === 'mention')
      .sort((a, b) => a.offset - b.offset)) {
      const { offset, length, userId } = entity;
      text += rendered.text.slice(end, offset);
      end = offset + length;
      mention(
        userId,
        rendered.text.slice(offset, end),
        rendered.text.slice(end, end + 2),
      );
      mentions.delete(userId);
      replacements.push({ end, shift: text.length - end });
    }
    text += rendered.text.slice(end);
    for (const entity of rendered.entities) {
      if (entity.type === 'mention') continue;
      const offset = shiftedOffset(entity.offset, replacements);
      const length =
        shiftedOffset(entity.offset + entity.length, replacements) - offset;
      spans.push({ ...entity, offset, length });
    }
  } else if (message.entities) {
    if (!message.text) throw new Error('Empty Telegram message');
    for (const entity of explicit) {
      const { offset, length } = entity;
      text += message.text.slice(end, offset);
      end = offset + length;
      const label = message.text.slice(offset, end);
      if (entity.type === 'pre') {
        spans.push({ type: 'pre', offset: text.length, length });
        text += label;
      } else {
        mention(entity.userId, label, message.text.slice(end, end + 2));
      }
    }
    return splitMessage(text + message.text.slice(end), spans, limit);
  } else {
    if (message.parseTextMentions !== false) {
      for (const { start, end: next, label, userId } of userMentionLinks(
        message.text,
      )) {
        text += message.text.slice(end, start);
        mention(userId, label, message.text.slice(next, next + 2));
        mentions.delete(userId);
        end = next;
      }
    }
    text += message.text.slice(end);
  }
  if (mentions.size && text) text += '\n\n';
  for (const [index, userId] of [...mentions].entries()) {
    if (index) text += ' ';
    mention(userId);
  }
  // Telegram rejects messages containing only whitespace.
  if (message.format === 'markdown' && !text.trim() && message.text.trim())
    return splitMessage(message.text, [], limit);
  if (!text) throw new Error('Empty Telegram message');
  return splitMessage(text, spans, limit);
}

function shiftedOffset(
  offset: number,
  replacements: readonly { end: number; shift: number }[],
) {
  let low = 0;
  let high = replacements.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (replacements[middle]!.end <= offset) low = middle + 1;
    else high = middle;
  }
  return offset + (replacements[low - 1]?.shift ?? 0);
}
