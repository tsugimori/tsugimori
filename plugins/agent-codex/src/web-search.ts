import { asRecord } from './app-server.ts';

type Fields = Record<string, unknown>;

export function webSearchTimestamp(...values: unknown[]) {
  return values.find(
    (value): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value),
  );
}

export function webSearchArgs(item: Fields, started?: Fields) {
  const { type: initialType, ...initial } = asRecord(started?.action);
  const { type, ...action } = asRecord(item.action);
  const actionType =
    typeof type === 'string' && type !== 'other'
      ? type
      : (initialType ?? 'other');
  const details = {
    ...initial,
    ...Object.fromEntries(
      Object.entries(action).filter(([, value]) => value != null),
    ),
  };
  const url = details.url ?? item.url ?? started?.url;
  const queries = details.queries ?? item.queries ?? started?.queries;
  const pattern = details.pattern ?? item.pattern ?? started?.pattern;
  const query =
    details.query ??
    (url == null && queries == null && pattern == null
      ? item.query || started?.query || undefined
      : undefined);
  return {
    ...(actionType === 'other'
      ? { description: 'Codex did not specify the web search action' }
      : {}),
    ...details,
    type: actionType,
    query,
    queries,
    url,
    pattern,
  };
}

export function webSearchResult(
  item: Fields,
  started: Fields | undefined,
  params: Fields,
  status: 'denied' | 'error' | 'ok',
) {
  const startedAt = webSearchTimestamp(item.startedAtMs, started?.startedAtMs);
  const completedAt =
    webSearchTimestamp(params.completedAtMs, item.completedAtMs) ?? Date.now();
  const results = item.results ?? started?.results ?? undefined;
  const sources =
    item.sources ??
    asRecord(item.action).sources ??
    started?.sources ??
    asRecord(started?.action).sources;
  const result = item.result ?? started?.result ?? undefined;
  const pageContent =
    item.pageContent ??
    item.content ??
    started?.pageContent ??
    started?.content;
  const pageContentBytes =
    typeof pageContent === 'string'
      ? Buffer.byteLength(pageContent)
      : (item.pageContentBytes ?? started?.pageContentBytes ?? undefined);
  const error = item.error ?? undefined;
  return {
    // Item completion alone describes the lifecycle, even for hosted calls with no result payload.
    status:
      status === 'ok'
        ? 'completed'
        : status === 'error'
          ? 'failed'
          : 'declined',
    durationMs:
      startedAt === undefined
        ? undefined
        : Math.max(0, completedAt - startedAt),
    ...(results == null &&
    sources == null &&
    result == null &&
    pageContentBytes == null &&
    error == null
      ? { note: 'Codex did not report web search result data' }
      : {}),
    pageContentBytes,
    results,
    sources,
    result,
    error,
  };
}
