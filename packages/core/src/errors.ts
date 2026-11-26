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
