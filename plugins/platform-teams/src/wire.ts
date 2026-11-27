export type Data = Record<string, unknown>;

export function object(value: unknown): Data | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Data;
}

export function json(text: string): Data {
  try {
    const data = object(JSON.parse(text));
    if (data) return data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new Error('Teams returned invalid JSON');
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

export function mri(value: unknown): string | undefined {
  const id = string(value);
  if (id && /^8:[A-Za-z0-9_.:-]{1,200}$/u.test(id)) return id;
}

export function messageId(value: unknown): string | undefined {
  const id =
    typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : string(value);
  if (id && /^[1-9]\d{0,23}$/u.test(id)) return id;
}

export function chatKind(id: string) {
  if (mri(id)) return 'dm';
  if (/^19:[A-Za-z0-9_-]{1,240}@thread\.v2$/u.test(id)) return 'group';
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Teams request failed (HTTP ${status})`);
    this.status = status;
  }
}

export async function request(
  fetch: typeof globalThis.fetch,
  url: string | URL,
  init: RequestInit,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(15_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: deadline });
  } catch {
    signal?.throwIfAborted();
    throw new Error('Teams network request failed');
  }
}

export async function readJson(response: Response, allowEmpty = false) {
  const reader = response.body?.getReader();
  let data = '';
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2_000_000) {
          await reader.cancel();
          throw new Error('Teams response exceeded its size limit');
        }
        data += decoder.decode(value, { stream: true });
      }
      data += decoder.decode();
    } catch {
      throw new Error('Could not read Teams response');
    } finally {
      reader.releaseLock();
    }
  }
  return !data && allowEmpty ? {} : json(data);
}
