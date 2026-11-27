function* sections(source: string) {
  let start = 0;
  let code: { end: number; marker?: string; start: number } | undefined;
  for (const { 0: line, index } of source.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const content = line.replace(/\r?\n$/, '');
    const end = index + content.length;
    const text = content.replace(/^(?: {0,3}>[ \t]?)+/, '');
    const blank = !text.trim();
    const indented = !blank && /^(?: {4}| {0,3}\t)/.test(text);
    if (code) {
      if (code.marker) {
        const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(text)?.[1];
        if (close?.startsWith(code.marker)) {
          start = end;
          yield { code: true, text: source.slice(code.start, start) };
          code = undefined;
        }
        continue;
      }
      if (indented) code.end = end;
      if (indented || blank) continue;
      yield { code: true, text: source.slice(code.start, code.end) };
      start = code.end;
      code = undefined;
    }
    const opening =
      /^ {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(?:(`{3,})[^`]*|(~{3,}).*)$/.exec(
        text,
      );
    if (opening || indented) {
      if (index > start)
        yield { code: false, text: source.slice(start, index) };
      code = { start: index, end, marker: opening?.[1] ?? opening?.[2] };
    }
  }
  if (code) {
    start = code.marker ? source.length : code.end;
    yield { code: true, text: source.slice(code.start, start) };
  }
  if (start < source.length) yield { code: false, text: source.slice(start) };
}

export async function replaceMarkdownImages(
  source: string,
  replace: (url: string) => Promise<string>,
) {
  if (!source.includes('![')) return source;
  const image =
    /!\[(?:\\.|\[[^\[\]\r\n]*\]|[^\[\]\\\r\n])*\]\([ \t]*(<https?:\/\/[^<>\s]+>|https?:\/\/(?:[^()<>\\\s]|\\[()]|\([^()\s]*\))+)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\)))?[ \t]*\)/iuy;
  const parts: { code: boolean; text: string }[] = [];
  let removed = false;
  for (const section of sections(source)) {
    if (section.code) {
      parts.push(section);
      continue;
    }
    const { text } = section;
    const token = /\\[\\`!]|`+|!\[/g;
    let start = 0;
    let output = '';
    let removedHere = false;
    for (let match = token.exec(text); match; match = token.exec(text)) {
      if (match[0].startsWith('`')) {
        const close = new RegExp('(?<!`)' + match[0] + '(?!`)', 'g');
        close.lastIndex = token.lastIndex;
        if (close.test(text)) {
          output += text.slice(start, match.index);
          // Keep code spans separate so whitespace inside them is preserved.
          parts.push({ code: false, text: collapse(output, removedHere) });
          parts.push({
            code: true,
            text: text.slice(match.index, close.lastIndex),
          });
          output = '';
          removedHere = false;
          start = token.lastIndex = close.lastIndex;
        }
        continue;
      }
      if (match[0] !== '![') continue;
      image.lastIndex = match.index;
      const target = image.exec(text)?.[1];
      if (!target) continue;
      const end = image.lastIndex;
      const url = target.replace(/^<|>$/g, '').replace(/\\([()])/g, '$1');
      const replacement = await replace(url);
      output += text.slice(start, match.index) + replacement;
      removedHere ||= replacement === '';
      removed ||= removedHere;
      start = token.lastIndex = end;
    }
    parts.push({
      code: false,
      text: collapse(output + text.slice(start), removedHere),
    });
  }
  if (removed) {
    const first = parts[0];
    const last = parts.at(-1);
    if (first && !first.code)
      first.text = first.text.replace(/^(?:[ \t]*\r?\n)+/, '');
    if (last && !last.code) last.text = last.text.trimEnd();
  }
  return parts.map(({ text }) => text).join('');
}

function collapse(text: string, removed: boolean) {
  return removed ? text.replace(/(\r?\n)(?:[ \t]*\r?\n){2,}/g, '$1$1') : text;
}
