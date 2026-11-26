import type { ChatRef } from '@tsugimori/plugin-sdk';

export class ApiError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(key);
    this.key = key;
  }
}

export async function fetchData<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch('/api/' + path, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(body?.error ?? 'internal');
  }
  return (await response.json()) as T;
}

export function chatApi({ adapterId, chatId }: ChatRef, before?: number) {
  const query = new URLSearchParams({ adapter: adapterId, id: chatId });
  if (before !== undefined) query.set('before', String(before));
  return 'chat?' + query;
}
