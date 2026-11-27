import type { WebSearchTraceResult } from '@tsugimori/plugin-sdk';

import { webSearchHits, webSearchTraceStatus } from '@tsugimori/plugin-sdk';

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

export function searchArgs(input: unknown) {
  const { query } = fields(input);
  return {
    type: 'search',
    query: typeof query === 'string' ? query : undefined,
  };
}

export function searchResult(
  output: unknown,
  started: number,
  status: 'error' | 'ok',
): WebSearchTraceResult {
  const { durationSeconds, results } = fields(output);
  return {
    status: webSearchTraceStatus(status),
    durationMs:
      typeof durationSeconds === 'number' &&
      Number.isFinite(durationSeconds) &&
      durationSeconds >= 0
        ? Math.round(durationSeconds * 1_000)
        : Math.round(performance.now() - started),
    ...(Array.isArray(results) &&
      webSearchHits(
        results.flatMap((result) => {
          const { content } = fields(result);
          return Array.isArray(content) ? content : [];
        }),
      )),
  };
}
