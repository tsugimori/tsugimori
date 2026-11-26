import type {
  AdapterContext,
  MarkdownBlock,
  MarkdownEntity,
  MarkdownText,
  OutboundMessage,
  TextRange,
} from '@tsugimori/plugin-sdk';

import {
  containsMention,
  parseMarkdown,
  renderMarkdownBlocks,
  userMentionLinks,
} from '@tsugimori/plugin-sdk';

export const maxMessage = 4096;
export const maxRichNesting = 16;

type TelegramEntity =
  | Exclude<MarkdownEntity, { type: 'mention' }>
  | (TextRange & { type: 'text_mention'; user: { id: number } });
export type TelegramSpan = TelegramEntity | (TextRange & { type: 'mention' });

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

export type TelegramText = { entities: TelegramSpan[]; text: string };

function containsTable(blocks: MarkdownBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.type === 'table' ||
      (block.type === 'quote' && containsTable(block.blocks)),
  );
}

export function parseTelegramMarkdown(message: OutboundMessage) {
  const explicit = new Map(
    sourceEntities(message).map((entity) => [entity.offset, entity]),
  );
  const parse = (nesting: number) =>
    parseMarkdown(message.text, explicit, message.parseTextMentions !== false, {
      tables: 'bullets',
      nesting,
      foldQuotes: nesting > 1,
    });
  if (
    message.text.includes('|') &&
    /^ {0,3}>[ \t]? {0,3}>/mu.test(message.text)
  ) {
    // Keep deeper quotes for table replies and retain the existing handling for other messages.
    const blocks = parse(maxRichNesting + 1);
    if (containsTable(blocks)) return { blocks, hasTable: true };
  }
  const blocks = parse(1);
  return { blocks, hasTable: containsTable(blocks) };
}

export function appendRemainingMentions(
  output: TelegramText,
  mentions: ReadonlySet<string>,
  getUser?: AdapterContext['getUser'],
) {
  let separator = '';
  for (const userId of mentions) {
    output.text += separator;
    appendMention(output, getUser, userId);
    separator = ' ';
  }
}

function appendMention(
  output: TelegramText,
  getUser: AdapterContext['getUser'],
  userId: string,
  label?: string,
  following = '',
) {
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
  if (username && /[\p{L}\p{N}_]$/u.test(output.text)) output.text += ' ';
  const range = { offset: output.text.length, length: name.length };
  output.entities.push(
    username
      ? { ...range, type: 'mention' }
      : { ...range, type: 'text_mention', user: { id } },
  );
  output.text += name;
  if (username && /^[\p{L}\p{N}_]/u.test(following)) output.text += ' ';
}

export function telegramMarkdownText(
  rendered: MarkdownText,
  message: OutboundMessage,
  mentions: Set<string>,
  getUser?: AdapterContext['getUser'],
): TelegramText {
  const output: TelegramText = { text: '', entities: [] };
  let end = 0;
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
    output.text += rendered.text.slice(end, offset);
    end = offset + length;
    appendMention(
      output,
      getUser,
      userId,
      rendered.text.slice(offset, end),
      rendered.text.slice(end, end + 2),
    );
    mentions.delete(userId);
    replacements.push({ end, shift: output.text.length - end });
  }
  output.text += rendered.text.slice(end);
  for (const entity of rendered.entities) {
    if (entity.type === 'mention') continue;
    const offset = shiftedOffset(entity.offset, replacements);
    const length =
      shiftedOffset(entity.offset + entity.length, replacements) - offset;
    output.entities.push({ ...entity, offset, length });
  }
  return output;
}

export function telegramMessageParts(
  message: OutboundMessage,
  getUser?: AdapterContext['getUser'],
  markdown?: MarkdownBlock[],
) {
  // Leave room to append the localized decision without replacing preview text.
  const limit = message.approval ? maxMessage - 64 : maxMessage;
  let output: TelegramText = { text: '', entities: [] };
  let end = 0;
  const mentions = new Set(message.mentions);
  if (message.format === 'markdown' && !message.approval) {
    const rendered = renderMarkdownBlocks(
      markdown ?? parseTelegramMarkdown(message).blocks,
    );
    output = telegramMarkdownText(rendered, message, mentions, getUser);
  } else if (message.entities) {
    const explicit = sourceEntities(message);
    if (!message.text) throw new Error('Empty Telegram message');
    for (const entity of explicit) {
      const { offset, length } = entity;
      output.text += message.text.slice(end, offset);
      end = offset + length;
      const label = message.text.slice(offset, end);
      if (entity.type === 'mention') {
        appendMention(
          output,
          getUser,
          entity.userId,
          label,
          message.text.slice(end, end + 2),
        );
      } else {
        output.entities.push({
          type: entity.type,
          offset: output.text.length,
          length,
        });
        output.text += label;
      }
    }
    return splitMessage(
      output.text + message.text.slice(end),
      output.entities,
      limit,
    );
  } else {
    if (message.parseTextMentions !== false) {
      for (const { start, end: next, label, userId } of userMentionLinks(
        message.text,
      )) {
        output.text += message.text.slice(end, start);
        appendMention(
          output,
          getUser,
          userId,
          label,
          message.text.slice(next, next + 2),
        );
        mentions.delete(userId);
        end = next;
      }
    }
    output.text += message.text.slice(end);
  }
  if (mentions.size && output.text) output.text += '\n\n';
  appendRemainingMentions(output, mentions, getUser);
  const { text } = output;
  // Telegram rejects messages containing only whitespace.
  if (message.format === 'markdown' && !text.trim() && message.text.trim())
    return splitMessage(message.text, [], limit);
  if (!text) throw new Error('Empty Telegram message');
  return splitMessage(text, output.entities, limit);
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
