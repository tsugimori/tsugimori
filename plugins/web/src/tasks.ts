import type {
  AdminTaskFilter,
  AdminTaskPage,
  AdminTaskSummary,
  ChatRef,
} from '@tsugimori/plugin-sdk';

const statuses = new Set([
  'queued',
  'running',
  'sending',
  'sent',
  'completed',
  'cancelled',
  'failed',
  'delivery-unknown',
]);

function pair(text: string): unknown[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length !== 2) throw new Error('pair');
  return value;
}

function chatKey(text: string): ChatRef {
  const [adapterId, chatId] = pair(text);
  if (
    typeof adapterId !== 'string' ||
    !adapterId ||
    typeof chatId !== 'string' ||
    !chatId
  )
    throw new Error('chat');
  return { adapterId, chatId };
}

function cursorKey(text: string) {
  if (!/^[\w-]{1,2048}$/.test(text)) throw new Error('cursor');
  const [createdAt, id] = pair(Buffer.from(text, 'base64url').toString());
  if (
    typeof createdAt !== 'number' ||
    !Number.isSafeInteger(createdAt) ||
    typeof id !== 'string' ||
    !id
  )
    throw new Error('cursor');
  return { createdAt, id };
}

function date(text: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      text,
    )
  )
    throw new Error('date');
  const day = Date.parse(text.slice(0, 10));
  const value = Date.parse(text);
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(day) ||
    new Date(day).toISOString().slice(0, 10) !== text.slice(0, 10)
  )
    throw new Error('date');
  return value;
}

export function taskFilter(
  query: URLSearchParams,
): AdminTaskFilter | undefined {
  try {
    const get = (key: string) => query.get(key) ?? undefined;
    const status = get('status');
    const chat = get('chat');
    const cursor = get('cursor');
    const since = get('since');
    const before = get('before');
    const q = get('q')?.trim();
    const rawLimit = get('limit') ?? '25';
    const limit = Number(rawLimit);
    if (
      !/^\d{1,3}$/.test(rawLimit) ||
      limit < 1 ||
      limit > 100 ||
      (status !== undefined && !statuses.has(status)) ||
      (q?.length ?? 0) > 500
    )
      return;
    const from = since === undefined ? undefined : date(since);
    const until = before === undefined ? undefined : date(before);
    if (from !== undefined && until !== undefined && from >= until) return;
    return {
      agent: get('agent') || undefined,
      before: until,
      chat: chat === undefined ? undefined : chatKey(chat),
      cursor: cursor === undefined ? undefined : cursorKey(cursor),
      limit,
      platform: get('platform') || undefined,
      q: q || undefined,
      since: from,
      status,
    };
  } catch {
    // Malformed dates and opaque keys are client errors.
    return;
  }
}

export function taskPage(
  rows: readonly AdminTaskSummary[],
  limit: number,
): AdminTaskPage {
  const tasks = rows.slice(0, limit);
  const last = rows.length > limit ? tasks.at(-1) : undefined;
  return {
    nextCursor: last
      ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString(
          'base64url',
        )
      : null,
    tasks,
  };
}
