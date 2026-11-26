const textMentions =
  /@[\p{L}\p{N}_]+|(?:tg:\/\/user\?id=|(?:https?:\/\/)?t\.me\/)[^\s<>()]*/giu;

export function containsMention(text: string) {
  return text.search(textMentions) !== -1;
}

export function textMentionMatches(text: string) {
  return text.match(textMentions) ?? [];
}

export function* userMentionLinks(text: string) {
  const pattern = /\[([^[\]\r\n]+)\]\(tg:\/\/user\?id=([1-9]\d{0,19})\)/gi;
  for (const match of text.matchAll(pattern)) {
    yield {
      start: match.index,
      end: match.index + match[0].length,
      label: match[1]!,
      userId: match[2]!,
    };
  }
}
