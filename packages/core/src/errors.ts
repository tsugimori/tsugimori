import { redactPairingCodes } from './inbound-message.ts';

const tokenPattern = /\bbot\d+:[\w-]+/g;

/** Returns a short, secret-free description of an error for structured logs. */
export function describeError(error: unknown, redact = (text: string) => text) {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redact(
    text
      .replace(/https?:\/\/api\.telegram\.org\/[^\s<>"']*/gi, '<redacted URL>')
      .replace(tokenPattern, 'bot<redacted>'),
  ).slice(0, 500);
}

export function describeTaskError(
  error: unknown,
  redact?: (text: string) => string,
) {
  return redactPairingCodes(describeError(error, redact))
    .split(/[\r\n\u2028\u2029]/u, 1)[0]!
    .slice(0, 300);
}

export function describeStickerError(
  error: unknown,
  redact: (text: string) => string,
) {
  return describeTaskError(error, (text) =>
    redact(text)
      .replace(
        /\b(?:Describe the first \d+ cells of this sticker sheet|Describe this sticker in one short English line)[^\r\n\u2028\u2029]*/u,
        '[redacted prompt]',
      )
      .replace(
        /\bdata:image\/[^\s"',)]+,[A-Za-z0-9+/_=%-]+|[A-Za-z0-9+/]{64,}={0,2}/gu,
        '[redacted image]',
      )
      .replace(
        /'(?:file:\/\/|\/|[a-z]:[\\/]|\\\\)[^']*'|"(?:file:\/\/|\/|[a-z]:[\\/]|\\\\)[^"]*"|(?:file:\/\/|\/|[a-z]:[\\/]|\\\\)[^\s"'`<>),;]+/giu,
        '[redacted path]',
      ),
  );
}
