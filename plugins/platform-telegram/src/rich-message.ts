import type {
  AdapterContext,
  MarkdownBlock,
  MarkdownText,
  OutboundMessage,
} from '@tsugimori/plugin-sdk';

import type { TelegramSpan, TelegramText } from './message-text.ts';

import {
  appendRemainingMentions,
  maxRichNesting,
  telegramMarkdownText,
} from './message-text.ts';

type RichText = string | RichText[] | RichTextEntity;
type RichTextEntity = { text: RichText } & (
  | { type: 'bold' | 'code' | 'italic' | 'strikethrough' }
  | { type: 'mention'; username: string }
  | { type: 'text_mention'; user: { id: number } }
  | { type: 'url'; url: string }
);

type RichTableCell = {
  align: 'left';
  is_header?: true;
  text: RichText;
  valign: 'top';
};

type RichListItem = {
  blocks: RichBlock[];
  type?: '1';
  value?: number;
};

type RichBlock =
  | { text: RichText; type: 'paragraph' }
  | { size: number; text: RichText; type: 'heading' }
  | { language?: string; text: RichText; type: 'pre' }
  | { type: 'divider' }
  | { blocks: RichBlock[]; type: 'blockquote' }
  | { items: RichListItem[]; type: 'list' }
  | { cells: RichTableCell[][]; is_bordered: true; type: 'table' };

type ListBlock = Extract<MarkdownBlock, { type: 'item' }>;

const maxCharacters = 32_768;
const maxBlocks = 500;
const maxColumns = 20;

type LimitReason =
  'block_limit' | 'character_limit' | 'nesting_limit' | 'table_columns';

class RichLimit extends Error {
  readonly reason: LimitReason;

  constructor(reason: LimitReason) {
    super(reason);
    this.reason = reason;
  }
}

function richEntity(
  span: TelegramSpan,
  text: RichText,
  label: string,
): RichTextEntity {
  switch (span.type) {
    case 'mention':
      return { type: 'mention', text, username: label.slice(1) };
    case 'text_mention':
      return { type: 'text_mention', text, user: span.user };
    case 'text_link':
      return { type: 'url', text, url: span.url };
    case 'blockquote':
    case 'pre':
      // Explicit preformatted ranges and parsed blockquotes are handled as blocks.
      return { type: 'code', text };
    default:
      return { type: span.type, text };
  }
}

function sequence(parts: RichText[]): RichText {
  return parts.length <= 1 ? (parts[0] ?? '') : parts;
}

function richText({ text, entities }: TelegramText, depth: number): RichText {
  const ordered = entities
    .filter(({ length }) => length > 0)
    .sort((a, b) => a.offset - b.offset || b.length - a.length);
  let index = 0;
  function range(start: number, end: number, depth: number): RichText {
    if (depth > maxRichNesting) throw new RichLimit('nesting_limit');
    const parts: RichText[] = [];
    let position = start;
    while (index < ordered.length) {
      const entity = ordered[index]!;
      if (entity.offset >= end) break;
      index++;
      const until = Math.min(entity.offset + entity.length, end);
      if (until <= position) continue;
      const from = Math.max(entity.offset, position);
      if (position < from) parts.push(text.slice(position, from));
      parts.push(
        richEntity(
          entity,
          range(from, until, depth + 1),
          text.slice(from, until),
        ),
      );
      position = until;
    }
    if (position < end) parts.push(text.slice(position, end));
    return sequence(parts);
  }
  return range(0, text.length, depth);
}

export function telegramRichMessage(
  message: OutboundMessage,
  parsed: MarkdownBlock[],
  getUser?: AdapterContext['getUser'],
) {
  const mentions = new Set(message.mentions);
  let characters = 0;
  let count = 0;

  const add = (depth: number, blocks = 1) => {
    if (depth > maxRichNesting) throw new RichLimit('nesting_limit');
    count += blocks;
    if (count > maxBlocks) throw new RichLimit('block_limit');
  };

  const format = (formatted: TelegramText, depth: number) => {
    // Telegram's limit counts Unicode characters while entity offsets use UTF-16.
    characters += [...formatted.text].length;
    if (characters > maxCharacters) throw new RichLimit('character_limit');
    return richText(formatted, depth);
  };

  const inline = (value: MarkdownText, depth: number) => {
    const formatted = telegramMarkdownText(value, message, mentions, getUser);
    return { rich: format(formatted, depth), plain: formatted.text };
  };

  function render(blocks: MarkdownBlock[], depth: number) {
    const result: RichBlock[] = [];
    const lines: string[] = [];
    let index = 0;

    function list(
      first: ListBlock,
      level: number,
    ): { items: RichListItem[]; plain: string } {
      add(level);
      const items: RichListItem[] = [];
      const plain: string[] = [];
      while (index < blocks.length) {
        const item = blocks[index]!;
        if (
          item.type !== 'item' ||
          item.indent !== first.indent ||
          (item.number === undefined) !== (first.number === undefined)
        )
          break;
        index++;
        add(level + 1);
        add(level + 2);
        const value = inline(item.value, level + 2);
        const children: RichBlock[] = [
          item.pre === undefined
            ? { type: 'paragraph', text: value.rich }
            : {
                type: 'pre',
                text: value.rich,
                language: item.pre || undefined,
              },
        ];
        plain.push(item.marker + value.plain);
        while (index < blocks.length) {
          const next = blocks[index]!;
          if (next.type !== 'item' || next.indent <= item.indent) break;
          const nested = list(next, level + 2);
          children.push({ type: 'list', items: nested.items });
          plain.push(nested.plain);
        }
        items.push({
          blocks: children,
          ...(item.number === undefined
            ? {}
            : { type: '1', value: item.number }),
        });
      }
      return { items, plain: plain.join('\n') };
    }

    while (index < blocks.length) {
      const block = blocks[index]!;
      if (block.type === 'item') {
        const content = list(block, depth);
        result.push({ type: 'list', items: content.items });
        lines.push(content.plain);
        continue;
      }
      index++;
      if (block.type === 'blank') continue;
      if (block.type === 'pre' && !block.value.text) continue;
      add(depth);
      switch (block.type) {
        case 'quote': {
          const quoted = render(block.blocks, depth + 1);
          if (quoted.blocks.length)
            result.push({ type: 'blockquote', blocks: quoted.blocks });
          lines.push(quoted.text);
          break;
        }
        case 'table': {
          const columns = block.rows.reduce(
            (width, row) => Math.max(width, row.length),
            0,
          );
          if (columns > maxColumns) throw new RichLimit('table_columns');
          add(depth + 1, block.rows.length);
          const cells = block.rows.map((row, index): RichTableCell[] => {
            const plain: string[] = [];
            const cells = Array.from(
              { length: columns },
              (_, column): RichTableCell => {
                const cell = row[column];
                const value = cell
                  ? inline(cell, depth + 2)
                  : { rich: '', plain: '' };
                plain.push(value.plain);
                return {
                  text: value.rich,
                  ...(index === 0 ? { is_header: true } : {}),
                  align: 'left',
                  valign: 'top',
                };
              },
            );
            lines.push(plain.join('\t'));
            return cells;
          });
          result.push({ type: 'table', cells, is_bordered: true });
          break;
        }
        case 'rule':
          result.push({ type: 'divider' });
          lines.push(block.value.text);
          break;
        default: {
          const value = inline(block.value, depth);
          lines.push(value.plain);
          if (block.type === 'heading')
            result.push({
              type: 'heading',
              size: block.size,
              text: value.rich,
            });
          else if (block.type === 'pre')
            result.push({
              type: 'pre',
              text: value.rich,
              language: block.language,
            });
          else result.push({ type: 'paragraph', text: value.rich });
        }
      }
    }
    return { blocks: result, text: lines.join('\n') };
  }

  try {
    const result = render(parsed, 1);
    if (mentions.size) {
      add(1);
      const approved: TelegramText = { text: '', entities: [] };
      appendRemainingMentions(approved, mentions, getUser);
      result.blocks.push({ type: 'paragraph', text: format(approved, 1) });
      result.text += '\n\n' + approved.text;
    }
    return { ...result, reason: undefined };
  } catch (error) {
    if (!(error instanceof RichLimit)) throw error;
    return { reason: error.reason };
  }
}
