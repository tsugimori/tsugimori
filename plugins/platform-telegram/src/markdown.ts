import type { TextEntity, TextRange } from '@tsugimori/plugin-sdk';

import { userMentionLinks } from '@tsugimori/plugin-sdk';

type Style = 'bold' | 'italic' | 'strikethrough';
export type MarkdownEntity = TextRange &
  (
    | { language?: string; type: 'pre' }
    | { type: 'blockquote' | 'code' | Style }
    | { type: 'mention'; userId: string }
    | { type: 'text_link'; url: string }
  );

type Formatted = { entities: MarkdownEntity[]; text: string };
type Delimiter = { marker: string; token: number; width: number };
type StylePair = { first: number; last: number; type: Style };

const fence = /^ {0,3}(`{3,})([^`]*?)$|^ {0,3}(~{3,})(.*)$/u;
const tableRow = /\|/u;
const tableDivider =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u;
const quote = /^ {0,3}>[ \t]?/u;
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
      let close = source.indexOf(source.slice(pos, end), end);
      while (
        close >= 0 &&
        (source[close - 1] === '`' || source[close + end - pos] === '`')
      )
        close = source.indexOf(source.slice(pos, end), runEnd(source, close));
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

export function renderMarkdown(
  source: string,
  explicit: ReadonlyMap<number, TextEntity>,
  parseMentions: boolean,
  allowQuotes = true,
) {
  const offsets: number[] = [];
  let offset = 0;
  const lines = source.split('\n').map((raw) => {
    offsets.push(offset);
    offset += raw.length + 1;
    return raw.replace(/\r$/u, '');
  });
  const output = literal('');
  const inline = (text: string, start: number) =>
    renderInline(text, start, explicit, parseMentions);
  const isTable = (index: number) =>
    tableRow.test(lines[index] ?? '') &&
    tableRow.test(lines[index + 1] ?? '') &&
    tableDivider.test(lines[index + 1]!);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const start = offsets[i]!;
    const item = bullet.exec(line);
    const number = numbered.exec(line)?.[0];
    const prefix = item?.[0] ?? number ?? '';
    const listMarker = item ? item[1] + '• ' : number;
    const fenced = fence.exec(line.slice(prefix.length));
    const headingPrefix = heading.exec(line)?.[0];
    if (fenced) {
      const marker = (fenced[1] ?? fenced[3])!;
      const language = (fenced[2] ?? fenced[4])
        ?.trim()
        .match(/^[\w+#.-]+/u)?.[0];
      const closing = new RegExp(
        '^ {0,3}' + marker[0] + '{' + marker.length + ',}[ \\t]*$',
        'u',
      );
      const indent = ' '.repeat(prefix.length);
      const content = (line: string) =>
        line.startsWith(indent) ? line.slice(indent.length) : line;
      let last = i + 1;
      while (last < lines.length && !closing.test(content(lines[last]!)))
        last++;
      if (last === lines.length) {
        output.text += source.slice(start);
        break;
      }
      const text = lines
        .slice(i + 1, last)
        .map(content)
        .join('\n');
      if (listMarker) output.text += listMarker.trimEnd() + '\n';
      if (text.trim())
        append(output, {
          text,
          entities: [
            {
              type: 'pre',
              offset: 0,
              length: text.length,
              ...(language ? { language } : {}),
            },
          ],
        });
      i = last;
    } else if (isTable(i)) {
      let last = i + 2;
      while (last < lines.length && tableRow.test(lines[last]!)) last++;
      const text = lines.slice(i, last).join('\n');
      append(output, {
        text,
        entities: [{ type: 'pre', offset: 0, length: text.length }],
      });
      i = last - 1;
    } else if (allowQuotes && quote.test(line)) {
      const quoted: string[] = [];
      const entities = new Map<number, TextEntity>();
      let offset = 0;
      do {
        const prefix = quote.exec(lines[i]!)![0];
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
      const part = renderMarkdown(
        quoted.join('\n'),
        entities,
        parseMentions,
        false,
      );
      if (part.text.trim())
        part.entities.unshift({
          type: 'blockquote',
          offset: 0,
          length: part.text.length,
        });
      append(output, part);
    } else if (headingPrefix !== undefined) {
      const title = line
        .slice(headingPrefix.length)
        .replace(/[ \t]+#+[ \t]*$/u, '')
        .trimEnd();
      const part = inline(title, start + headingPrefix.length);
      part.entities = part.entities.filter(({ type }) => type !== 'bold');
      style(part, 'bold', 0, part.text.length, codeRanges(part));
      append(output, part);
    } else if (rule.test(line)) {
      output.text += line;
    } else if (listMarker) {
      output.text += listMarker;
      append(output, inline(line.slice(prefix.length), start + prefix.length));
    } else {
      let last = i + 1;
      while (line.trim() && last < lines.length) {
        const next = lines[last]!;
        if (
          !next.trim() ||
          fence.test(next) ||
          (allowQuotes && quote.test(next)) ||
          heading.test(next) ||
          bullet.test(next) ||
          numbered.test(next) ||
          rule.test(next) ||
          isTable(last)
        )
          break;
        last++;
      }
      const end = last < lines.length ? offsets[last]! - 1 : source.length;
      append(
        output,
        inline(source.slice(start, end).replace(/\r$/u, ''), start),
      );
      i = last - 1;
    }
    if (i < lines.length - 1) output.text += '\n';
  }
  return output;
}
