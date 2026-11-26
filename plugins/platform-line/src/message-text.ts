import type { OutboundMessage } from '@tsugimori/plugin-sdk';

import { renderMarkdown } from '@tsugimori/plugin-sdk';

const maxText = 5000;

export function messageParts(message: OutboundMessage) {
  let text = message.text;
  if (message.format === 'markdown' && !message.approval) {
    const rendered = renderMarkdown(
      text,
      new Map(),
      message.parseTextMentions !== false,
    );
    let end = 0;
    let plain = '';
    for (const entity of rendered.entities) {
      if (entity.type !== 'text_link') continue;
      const next = entity.offset + entity.length;
      plain += rendered.text.slice(end, next);
      if (rendered.text.slice(entity.offset, next) !== entity.url)
        plain += ` (${entity.url})`;
      end = next;
    }
    text = plain + rendered.text.slice(end);
  }
  if (!text.trim()) throw new Error('Empty LINE message');

  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + maxText, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const paragraph = window.lastIndexOf('\n\n');
      const line = window.lastIndexOf('\n');
      if (paragraph >= 0) end = start + paragraph + 2;
      else if (line >= 0) end = start + line + 1;
      else if (/[\uD800-\uDBFF]$/u.test(window)) end--;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}
