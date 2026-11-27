import type {
  AdapterContext,
  MarkdownEntity,
  OutboundMessage,
} from '@tsugimori/plugin-sdk';

import { renderMarkdown } from '@tsugimori/plugin-sdk';

import { mri } from './wire.ts';

export const replySchema = 'http://schema.skype.com/Reply';
const mentionSchema = 'http://schema.skype.com/Mention';
const escapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const entities: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/gu, (char) => escapes[char]!);
}

function unescapeHtml(text: string) {
  return text.replace(
    /&(?:#(x[\da-f]+|\d+)|([a-z]+));/giu,
    (whole: string, number?: string, name?: string) => {
      if (!number) return entities[(name ?? '').toLowerCase()] ?? whole;
      const code =
        number[0]?.toLowerCase() === 'x'
          ? Number.parseInt(number.slice(1), 16)
          : Number(number);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '�';
    },
  );
}

export function attribute(tag: string, name: string) {
  const values = /\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu;
  for (const [, key, double, single, bare] of tag.matchAll(values)) {
    if (key?.toLowerCase() === name)
      return unescapeHtml(double ?? single ?? bare ?? '');
  }
}

function webLink(value: string | undefined) {
  return value && /^https?:\/\//iu.test(value) && URL.canParse(value)
    ? value
    : undefined;
}

export function plainText(html: string): string {
  return unescapeHtml(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
      .replace(
        /(<a\b[^>]*>)([\s\S]*?)<\/a\s*>/giu,
        (_match, tag: string, label: string) => {
          const href = webLink(attribute(tag, 'href'));
          if (!href || plainText(label) === href) return label;
          return label.trim()
            ? `${label} (${escapeHtml(href)})`
            : escapeHtml(href);
        },
      )
      .replace(/<img\b[^>]*>/giu, (tag) =>
        escapeHtml(attribute(tag, 'alt') ?? ''),
      )
      .replace(/<br\b[^>]*>|<\/(?:p|div|li)\s*>/giu, '\n')
      .replace(/<[^>]*>/gu, ''),
  )
    .replace(/\r/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function htmlText(text: string) {
  return escapeHtml(text)
    .replace(/ {2,}/gu, (spaces) => '&nbsp;'.repeat(spaces.length - 1) + ' ')
    .replace(/\r?\n/gu, '<br>');
}

function entityTags(entity: MarkdownEntity): [string, string] | undefined {
  switch (entity.type) {
    case 'bold':
      return ['<strong>', '</strong>'];
    case 'italic':
      return ['<em>', '</em>'];
    case 'text_link': {
      const href = webLink(entity.url);
      if (href) return [`<a href="${escapeHtml(href)}">`, '</a>'];
      break;
    }
    case 'blockquote':
      return ['› ', ''];
  }
}

export function renderText(
  message: OutboundMessage,
  getUser?: AdapterContext['getUser'],
  allowEmpty = false,
) {
  const explicit = new Map(
    message.entities?.map((entity) => [entity.offset, entity]),
  );
  const rendered =
    message.format === 'markdown' && !message.approval
      ? renderMarkdown(message.text, explicit, false, true, {
          tables: 'bullets',
        })
      : { text: message.text, entities: [...(message.entities ?? [])] };
  const { text } = rendered;
  if ((!allowEmpty && !text.trim()) || text.length > 20_000)
    throw new Error(
      'Teams requires a nonempty message of at most 20000 characters',
    );
  const ranges = rendered.entities.filter(
    ({ offset, length }) =>
      Number.isInteger(offset) &&
      Number.isInteger(length) &&
      offset >= 0 &&
      length > 0 &&
      offset + length <= text.length,
  );
  const code = ranges.filter(({ type }) => type === 'code' || type === 'pre');
  const styles = ranges.flatMap((entity) => {
    const tags = entityTags(entity);
    return tags
      ? [{ start: entity.offset, end: entity.offset + entity.length, tags }]
      : [];
  });
  const mentions: {
    '@type': string;
    displayName: string;
    itemid: string;
    mentionType: 'person';
    mri: string;
  }[] = [];
  function mention(id: string, label?: string) {
    const itemid = String(mentions.length);
    const displayName = getUser?.(id)?.display || label || id;
    mentions.push({
      '@type': mentionSchema,
      itemid,
      mri: id,
      mentionType: 'person',
      displayName,
    });
    return `<readonly contenteditable="false"><span itemtype="${mentionSchema}" itemscope itemid="${itemid}">${escapeHtml(displayName)}</span></readonly>`;
  }
  const touchesCode = (start: number, end: number) =>
    code.some(({ offset, length }) => start < offset + length && end > offset);
  const native = new Map<number, { end: number; id: string }>();
  if (message.allowTextMentions !== false) {
    for (const entity of ranges) {
      if (entity.type !== 'mention') continue;
      const id = mri(entity.userId);
      const end = entity.offset + entity.length;
      if (id && !touchesCode(entity.offset, end))
        native.set(entity.offset, { id, end });
    }
  }
  const inlineIds = new Set([...native.values()].map(({ id }) => id));
  const prefix = [...new Set(message.mentions)].flatMap((recipient) => {
    const id = mri(recipient);
    if (!id) throw new Error('Invalid Teams mention recipient');
    return inlineIds.has(id) ? [] : [mention(id)];
  });
  const separators = new Map<number, number>();
  for (const gap of text.matchAll(/(?:\r?\n){2,}/gu)) {
    const end = gap.index + gap[0].length;
    if (!touchesCode(gap.index, end)) separators.set(gap.index, end);
  }
  const positions = [
    ...new Set([
      0,
      text.length,
      ...styles.flatMap(({ start, end }) => [start, end]),
      ...code.flatMap(({ offset, length }) => [offset, offset + length]),
      ...[...native].flatMap(([start, { end }]) => [start, end]),
      ...[...separators].flat(),
    ]),
  ].sort((a, b) => a - b);

  let content = '<p>' + (prefix.length ? prefix.join(' ') + ' ' : '');
  let consumed = 0;
  for (const [index, start] of positions.entries()) {
    if (start < consumed) continue;
    const end = positions[index + 1];
    if (end === undefined) break;
    const nativeMention = native.get(start);
    const separator = separators.get(start);
    if (nativeMention) {
      content += mention(
        nativeMention.id,
        text.slice(start, nativeMention.end),
      );
      consumed = nativeMention.end;
    } else if (separator !== undefined) {
      content += '</p><p>';
      consumed = separator;
    } else {
      const active = touchesCode(start, end)
        ? []
        : styles.filter((range) => range.start <= start && range.end >= end);
      content +=
        active.map(({ tags }) => tags[0]).join('') +
        htmlText(text.slice(start, end)) +
        active
          .reverse()
          .map(({ tags }) => tags[1])
          .join('');
    }
  }
  const properties: Record<string, string> = {};
  if (mentions.length) properties.mentions = JSON.stringify(mentions);
  return {
    content:
      allowEmpty && !text.trim() && !prefix.length ? '' : content + '</p>',
    properties,
  };
}
