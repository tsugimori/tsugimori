import type { TextEntity, TextRange } from './index.ts';

import { userMentionLinks } from './mentions.ts';

type Style = 'bold' | 'italic' | 'strikethrough';
export type MarkdownEntity = TextRange &
  (
    | { language?: string; type: 'pre' }
    | { type: 'blockquote' | 'code' | Style }
    | { type: 'mention'; userId: string }
    | { type: 'text_link'; url: string }
  );

export type MarkdownText = { entities: MarkdownEntity[]; text: string };
type Formatted = MarkdownText;

export type MarkdownBlock = { lineBreak: boolean } & (
  | { type: 'blank' | 'literal' | 'paragraph' | 'rule'; value: MarkdownText }
  | { size: number; type: 'heading'; value: MarkdownText }
  | { language?: string; type: 'pre'; value: MarkdownText }
  | {
      indent: number;
      marker: string;
      number?: number;
      pre?: string;
      type: 'item';
      value: MarkdownText;
    }
  | { blocks: MarkdownBlock[]; type: 'quote' }
  | { rows: MarkdownText[][]; type: 'table'; value: MarkdownText }
);

interface MarkdownOptions {
  tables?: 'bullets' | 'pre';
}
type Delimiter = { marker: string; token: number; width: number };
type StylePair = { first: number; last: number; type: Style };

const fence = /^ {0,3}(`{3,})([^`]*?)$|^ {0,3}(~{3,})(.*)$/u;
const tableRow = /\|/u;
const tableDivider =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u;
const quote = /^ {0,3}>[ \t]?/u;
const nestedQuotes = /^(?: {0,3}>[ \t]?)+/u;
const heading = /^ {0,3}#{1,6}(?:[ \t]+|$)/u;
const bullet = /^( *?)[*-][ \t]+/u;
const numbered = /^ *\d{1,9}[.)][ \t]+/u;
const rule = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u;
const punctuation = /[\p{P}\p{S}]/u;
const whitespace = /\s/u;

function literal(text: string): Formatted {
  return { text, entities: [] };
}

function append(output: Formatted, part: Formatted) {
  const offset = output.text.length;
  output.text += part.text;
  for (const entity of part.entities)
    output.entities.push({ ...entity, offset: offset + entity.offset });
}

function style(
  output: Formatted,
  type: Style,
  start: number,
  end: number,
  code: readonly TextRange[],
) {
  // Telegram does not allow emphasis to overlap code.
  let first = 0;
  let last = code.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    const range = code[middle]!;
    if (range.offset + range.length <= start) first = middle + 1;
    else last = middle;
  }
  for (let index = first; index < code.length; index++) {
    const { offset, length } = code[index]!;
    if (offset >= end) break;
    if (offset > start)
      output.entities.push({ offset: start, length: offset - start, type });
    start = offset + length;
  }
  if (end > start)
    output.entities.push({ offset: start, length: end - start, type });
}

function codeRanges({ entities }: Formatted) {
  return entities.filter(({ type }) => type === 'code' || type === 'pre');
}

function renderInline(
  source: string,
  base: number,
  explicit: ReadonlyMap<number, TextEntity>,
  parseMentions: boolean,
  links = true,
): Formatted {
  const tokens: Formatted[] = [];
  const openers: Delimiter[] = [];
  const pairs: StylePair[] = [];
  const link =
    /(!?)\[((?:\\.|[^\[\]\\\r\n])+)\]\((<[^<>\s]+>|(?:[^()\s]|\([^()\s]*\))+)\)/uy;
  const url = /https?:\/\/[^\s<>`]+/iuy;
  const special = /[\\`*_~[!hH]/u;

  let plain = '';
  function push(token: Formatted) {
    if (plain) tokens.push(literal(plain));
    plain = '';
    tokens.push(token);
    return tokens.length - 1;
  }

  for (let pos = 0; pos < source.length;) {
    const original = explicit.get(base + pos);
    if (original && pos + original.length <= source.length) {
      const text = source.slice(pos, pos + original.length);
      push({ text, entities: [{ ...original, offset: 0 }] });
      pos += original.length;
      continue;
    }
    const char = source[pos]!;
    const next = source[pos + 1] ?? '';
    if (char === '\\' && /[!-/:-@[-`{-~]/u.test(next)) {
      plain += next;
      pos += 2;
      continue;
    }
    if (char === '`') {
      const end = runEnd(source, pos);
      const close = codeClosing(source, pos, end);
      if (close >= 0) {
        let text = source.slice(end, close).replace(/\r?\n/g, ' ');
        if (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/u.test(text))
          text = text.slice(1, -1);
        push({
          text,
          entities: [{ type: 'code', offset: 0, length: text.length }],
        });
        pos = close + end - pos;
      } else {
        plain += source.slice(pos, end);
        pos = end;
      }
      continue;
    }
    if (links && (char === '[' || (char === '!' && next === '['))) {
      link.lastIndex = pos;
      const match = link.exec(source);
      if (match) {
        const [syntax, image, label = '', destination = ''] = match;
        const native = userMentionLinks(syntax).next().value;
        const target = destination.replace(/^<|>$/gu, '');
        if (!image && native && parseMentions) {
          push({
            text: label,
            entities: [
              {
                type: 'mention',
                offset: 0,
                length: label.length,
                userId: native.userId,
              },
            ],
          });
        } else if (
          !image &&
          /^(?:https?:\/\/|mailto:|tel:)/iu.test(target) &&
          URL.canParse(target)
        ) {
          const part = renderInline(
            label,
            base + pos + 1,
            explicit,
            parseMentions,
            false,
          );
          if (
            part.text.trim() &&
            part.entities.every(
              ({ type }) =>
                type === 'bold' ||
                type === 'italic' ||
                type === 'strikethrough',
            )
          )
            part.entities.push({
              type: 'text_link',
              offset: 0,
              length: part.text.length,
              url: target,
            });
          push(part);
        } else {
          plain += syntax;
        }
        pos = link.lastIndex;
        continue;
      }
    }
    if (char === 'h' || char === 'H') {
      url.lastIndex = pos;
      const match = url.exec(source);
      if (match) {
        // Leave closing emphasis markers for the delimiter scanner.
        const trailing = /([*_~])\1*(?=[.,!?;:)\]]*$)/u.exec(match[0]);
        const closes =
          trailing && openers.some(({ marker }) => marker === trailing[1]);
        const end = closes ? pos + trailing.index : url.lastIndex;
        plain += source.slice(pos, end);
        pos = end;
        continue;
      }
    }
    if (char === '*' || char === '_' || char === '~') {
      const end = runEnd(source, pos);
      const width = end - pos;
      if (char === '~' ? width === 2 : width <= 3) {
        const before = pos
          ? (source.codePointAt(
              pos - (/^[\uDC00-\uDFFF]$/u.test(source[pos - 1]!) ? 2 : 1),
            ) ?? 32)
          : 32;
        const after = source.codePointAt(end) ?? 32;
        const left = String.fromCodePoint(before);
        const right = String.fromCodePoint(after);
        const leftFlanking =
          !whitespace.test(right) &&
          (!punctuation.test(right) ||
            whitespace.test(left) ||
            punctuation.test(left));
        const rightFlanking =
          !whitespace.test(left) &&
          (!punctuation.test(left) ||
            whitespace.test(right) ||
            punctuation.test(right));
        const canOpen =
          leftFlanking &&
          (char !== '_' || !rightFlanking || punctuation.test(left));
        const canClose =
          rightFlanking &&
          (char !== '_' || !leftFlanking || punctuation.test(right));
        const token = push(literal(source.slice(pos, end)));
        let remaining = width;
        while (canClose && remaining) {
          const index = openers.findLastIndex(
            ({ marker, width }) =>
              marker === char &&
              (width === remaining || width === 3 || remaining === 3),
          );
          if (index < 0) break;
          const open = openers[index]!;
          const size = open.width >= 2 && remaining >= 2 ? 2 : 1;
          const type =
            char === '~' ? 'strikethrough' : size === 2 ? 'bold' : 'italic';
          openers.length = index + 1;
          open.width -= size;
          remaining -= size;
          tokens[open.token]!.text = char.repeat(open.width);
          tokens[token]!.text = char.repeat(remaining);
          pairs.push({ first: open.token + 1, last: token, type });
          if (!open.width) openers.pop();
        }
        if (canOpen && remaining)
          openers.push({ marker: char, token, width: remaining });
      } else {
        plain += source.slice(pos, end);
      }
      pos = end;
      continue;
    }
    const start = pos++;
    while (
      pos < source.length &&
      !explicit.has(base + pos) &&
      !special.test(source[pos]!)
    )
      pos++;
    plain += source.slice(start, pos);
  }

  const output = literal('');
  const offsets: number[] = [];
  for (const token of tokens) {
    offsets.push(output.text.length);
    append(output, token);
  }
  output.text += plain;
  const code = codeRanges(output);
  // Keep outer ranges when the same emphasis type is nested.
  const ends = new Map<Style, number>();
  pairs.sort((a, b) => a.first - b.first || b.last - a.last);
  for (const { first, last, type } of pairs) {
    const start = offsets[first]!;
    const end = offsets[last]!;
    if (end <= (ends.get(type) ?? 0)) continue;
    style(output, type, start, end, code);
    ends.set(type, end);
  }
  return output;
}

function runEnd(text: string, start: number) {
  let end = start + 1;
  while (text[end] === text[start]) end++;
  return end;
}

function codeClosing(source: string, start: number, end: number) {
  const marker = source.slice(start, end);
  let close = source.indexOf(marker, end);
  while (
    close >= 0 &&
    (source[close - 1] === '`' || source[close + marker.length] === '`')
  )
    close = source.indexOf(marker, runEnd(source, close));
  return close;
}

function tableCells(line: string) {
  const cells: { start: number; text: string }[] = [];
  const add = (start: number, end: number) => {
    const raw = line.slice(start, end);
    const trimmed = raw.trimStart();
    cells.push({
      start: start + raw.length - trimmed.length,
      text: trimmed.trimEnd(),
    });
  };
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\' && /[!-\/:-@[-`{-~]/u.test(line[i + 1] ?? '')) {
      i++;
    } else if (char === '`') {
      const end = runEnd(line, i);
      const close = codeClosing(line, i, end);
      i = close < 0 ? end - 1 : close + end - i - 1;
    } else if (char === '|') {
      if (cells.length || start || line.slice(0, i).trim()) add(start, i);
      start = i + 1;
    }
  }
  if (!start) return;
  if (!cells.length || line.slice(start).trim()) add(start, line.length);
  return cells;
}

function startsBlock(line: string, allowQuotes: boolean) {
  const item = bullet.exec(line)?.[0] ?? numbered.exec(line)?.[0];
  return (
    !line.trim() ||
    fence.test(line.slice(item?.length ?? 0)) ||
    (allowQuotes && quote.test(line)) ||
    heading.test(line) ||
    item !== undefined ||
    rule.test(line)
  );
}

export function parseMarkdown(
  source: string,
  explicit: ReadonlyMap<number, TextEntity>,
  parseMentions: boolean,
  {
    tables = 'pre',
    nesting = 1,
    foldQuotes = false,
  }: MarkdownOptions & { foldQuotes?: boolean; nesting?: number } = {},
): MarkdownBlock[] {
  const offsets: number[] = [];
  let offset = 0;
  const lines = source.split('\n').map((raw) => {
    offsets.push(offset);
    offset += raw.length + 1;
    return raw.replace(/\r$/u, '');
  });
  const blocks: MarkdownBlock[] = [];
  const inline = (text: string, start: number) =>
    renderInline(text, start, explicit, parseMentions);
  const isTable = (index: number) => {
    const line = lines[index] ?? '';
    const divider = lines[index + 1] ?? '';
    if (!tableDivider.test(divider)) return false;
    if (tables === 'pre') return tableRow.test(line) && tableRow.test(divider);
    if (startsBlock(line, true)) return false;
    const headerCells = tableCells(line);
    const dividerCells = tableCells(divider);
    return (
      (headerCells !== undefined || dividerCells !== undefined) &&
      (headerCells?.length ?? 1) === (dividerCells?.length ?? 1)
    );
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const start = offsets[i]!;
    const item = bullet.exec(line);
    const number = numbered.exec(line)?.[0];
    const prefix = item?.[0] ?? number ?? '';
    const listMarker = item ? item[1] + '• ' : number;
    const list = {
      indent: prefix.length - prefix.trimStart().length,
      marker: listMarker ?? '',
      number: number === undefined ? undefined : Number.parseInt(number, 10),
    };
    const fenced = fence.exec(line.slice(prefix.length));
    const headingPrefix = heading.exec(line)?.[0];
    let block: MarkdownBlock;
    if (fenced) {
      const marker = (fenced[1] ?? fenced[3])!;
      const language = (fenced[2] ?? fenced[4])
        ?.trim()
        .match(/^[\w+#.-]+/u)?.[0];
      const closing = new RegExp(
        '^ {0,3}' + marker[0] + '{' + marker.length + ',}[ \t]*$',
        'u',
      );
      const indent = ' '.repeat(prefix.length);
      const content = (line: string) =>
        line.startsWith(indent) ? line.slice(indent.length) : line;
      let last = i + 1;
      while (last < lines.length && !closing.test(content(lines[last]!)))
        last++;
      if (last === lines.length) {
        blocks.push({
          type: 'literal',
          value: literal(source.slice(start)),
          lineBreak: false,
        });
        break;
      }
      const text = lines
        .slice(i + 1, last)
        .map(content)
        .join('\n');
      const value = literal(text.trim() ? text : '');
      block = listMarker
        ? {
            ...list,
            type: 'item',
            value,
            pre: language ?? '',
            lineBreak: false,
          }
        : { type: 'pre', value, language, lineBreak: false };
      i = last;
    } else if (isTable(i)) {
      let last = i + 2;
      const rows: MarkdownText[][] = [];
      if (tables === 'pre') {
        while (last < lines.length && tableRow.test(lines[last]!)) last++;
      } else {
        const row = (index: number) => tableCells(lines[index]!);
        const singleCell = (text: string) => [
          { start: text.length - text.trimStart().length, text: text.trim() },
        ];
        const renderRow = (
          cells: NonNullable<ReturnType<typeof tableCells>>,
          index: number,
        ) =>
          cells.map(({ text, start }) => inline(text, offsets[index]! + start));
        const headers = row(i) ?? singleCell(line);
        rows.push(renderRow(headers, i));
        while (last < lines.length && !startsBlock(lines[last]!, true)) {
          const cells = row(last);
          if (!cells && headers.length !== 1) break;
          rows.push(renderRow(cells ?? singleCell(lines[last]!), last));
          last++;
        }
      }
      block = {
        type: 'table',
        rows,
        value: literal(lines.slice(i, last).join('\n')),
        lineBreak: false,
      };
      i = last - 1;
    } else if (nesting > 0 && quote.test(line)) {
      const quoted: string[] = [];
      const entities = new Map<number, TextEntity>();
      let offset = 0;
      do {
        const marker = foldQuotes && nesting === 1 ? nestedQuotes : quote;
        const prefix = marker.exec(lines[i]!)![0];
        const text = lines[i]!.slice(prefix.length);
        const start = offsets[i]! + prefix.length;
        for (let j = 0; explicit.size && j < text.length; j++) {
          const entity = explicit.get(start + j);
          if (entity) entities.set(offset + j, entity);
        }
        quoted.push(text);
        offset += text.length + 1;
        if (!quote.test(lines[i + 1] ?? '')) break;
        i++;
      } while (true);
      block = {
        type: 'quote',
        blocks: parseMarkdown(quoted.join('\n'), entities, parseMentions, {
          tables,
          nesting: nesting - 1,
          foldQuotes,
        }),
        lineBreak: false,
      };
    } else if (headingPrefix !== undefined) {
      const title = line
        .slice(headingPrefix.length)
        .replace(/[ \t]+#+[ \t]*$/u, '')
        .trimEnd();
      block = {
        type: 'heading',
        size: headingPrefix.trim().length,
        value: inline(title, start + headingPrefix.length),
        lineBreak: false,
      };
    } else if (rule.test(line)) {
      block = { type: 'rule', value: literal(line), lineBreak: false };
    } else if (listMarker) {
      block = {
        ...list,
        type: 'item',
        value: inline(line.slice(prefix.length), start + prefix.length),
        lineBreak: false,
      };
    } else {
      let last = i + 1;
      while (line.trim() && last < lines.length) {
        if (startsBlock(lines[last]!, nesting > 0) || isTable(last)) break;
        last++;
      }
      const end = last < lines.length ? offsets[last]! - 1 : source.length;
      block = {
        type: line.trim() ? 'paragraph' : 'blank',
        value: inline(source.slice(start, end).replace(/\r$/u, ''), start),
        lineBreak: false,
      };
      i = last - 1;
    }
    block.lineBreak = i < lines.length - 1;
    blocks.push(block);
  }
  return blocks;
}

function bold(part: Formatted): Formatted {
  const output = {
    ...part,
    entities: part.entities.filter(({ type }) => type !== 'bold'),
  };
  style(output, 'bold', 0, part.text.length, codeRanges(part));
  return output;
}

function pre(value: Formatted, language?: string): Formatted {
  return value.text
    ? {
        text: value.text,
        entities: [
          {
            type: 'pre',
            offset: 0,
            length: value.text.length,
            ...(language ? { language } : {}),
          },
        ],
      }
    : value;
}

function tableBullets([headers = [], ...rows]: MarkdownText[][]): Formatted {
  const output = literal('');
  const single = headers.length === 1 && rows.every((row) => row.length === 1);
  for (const [first, ...cells] of rows) {
    const group = literal('');
    if (first?.text.trim()) {
      if (single) {
        group.text = '• ';
        append(group, first);
      } else {
        append(group, bold(first));
      }
    }
    for (const [index, cell] of cells.entries()) {
      if (!cell.text.trim()) continue;
      if (group.text) group.text += '\n';
      group.text += '• ';
      const header = headers[index + 1];
      if (header?.text) {
        append(group, header);
        group.text += ': ';
      }
      append(group, cell);
    }
    if (!group.text) continue;
    if (output.text) output.text += single ? '\n' : '\n\n';
    append(output, group);
  }
  return output;
}

export function renderMarkdownBlocks(blocks: MarkdownBlock[]): MarkdownText {
  const output = literal('');
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        append(output, bold(block.value));
        break;
      case 'item':
        if (block.pre !== undefined) {
          output.text += block.marker.trimEnd() + '\n';
          append(output, pre(block.value, block.pre));
        } else {
          output.text += block.marker;
          append(output, block.value);
        }
        break;
      case 'pre':
        append(output, pre(block.value, block.language));
        break;
      case 'quote': {
        const part = renderMarkdownBlocks(block.blocks);
        if (part.text.trim())
          part.entities.unshift({
            type: 'blockquote',
            offset: 0,
            length: part.text.length,
          });
        append(output, part);
        break;
      }
      case 'table':
        append(
          output,
          block.rows.length ? tableBullets(block.rows) : pre(block.value),
        );
        break;
      default:
        append(output, block.value);
    }
    if (block.lineBreak) output.text += '\n';
  }
  return output;
}

export function renderMarkdown(
  source: string,
  explicit: ReadonlyMap<number, TextEntity>,
  parseMentions: boolean,
  allowQuotes = true,
  options: MarkdownOptions = {},
) {
  return renderMarkdownBlocks(
    parseMarkdown(source, explicit, parseMentions, {
      ...options,
      nesting: allowQuotes ? 1 : 0,
    }),
  );
}
