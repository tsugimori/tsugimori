import { setTimeout as delay } from 'node:timers/promises';

export function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
}

export function nativeId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return String(value);
}

export class BotApiError extends Error {
  readonly code: number | undefined;
  readonly invalidEntities: boolean;
  readonly retryAfter?: number;
  constructor(
    method: string,
    code: number | undefined,
    retryAfter?: number,
    invalidEntities = false,
  ) {
    super(
      `Telegram ${method} failed${code === undefined ? '' : ` (HTTP ${code})`}`,
    );
    this.code = code;
    this.invalidEntities = invalidEntities;
    this.retryAfter = retryAfter;
  }

  get unknownDelivery() {
    return this.code === undefined || this.code >= 500;
  }
}

export class BotApi {
  readonly #fetch: typeof fetch;
  readonly #url: string;

  constructor(fetch: typeof globalThis.fetch, token: string) {
    if (!/^\d+:[\w-]+$/.test(token))
      throw new Error('Invalid Telegram bot token format');
    this.#fetch = fetch;
    this.#url = `https://api.telegram.org/bot${token}/`;
  }

  async #post(
    method: string,
    body: object,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(
      method === 'getUpdates' ? 60_000 : 10_000,
    );
    let response: Response;
    try {
      response = await this.#fetch(this.#url + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch {
      signal.throwIfAborted();
      throw new BotApiError(method, undefined);
    }

    const payload = await readPayload(response);
    if (response.ok && payload?.ok === true && 'result' in payload)
      return payload.result;

    const code = !response.ok
      ? response.status
      : payload?.ok === false && typeof payload.error_code === 'number'
        ? payload.error_code
        : undefined;
    const after = record(payload?.parameters)?.retry_after;
    throw new BotApiError(
      method,
      code,
      typeof after === 'number' && Number.isFinite(after) && after >= 0
        ? after * 1_000
        : undefined,
      code === 400 &&
        typeof payload?.description === 'string' &&
        /\b(?:can't|cannot) parse entities\b/iu.test(payload.description),
    );
  }

  async call(
    method: string,
    body: object,
    signal: AbortSignal,
    retries = 2,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#post(method, body, signal);
      } catch (error) {
        if (
          !(error instanceof BotApiError) ||
          attempt >= retries ||
          (error.code !== 429 &&
            (method === 'sendMessage' || !error.unknownDelivery))
        )
          throw error;
        await delay(error.retryAfter ?? 250 * 2 ** attempt, undefined, {
          signal,
        });
      }
    }
  }
}

async function readPayload(response: Response) {
  try {
    return record(await response.json());
  } catch {
    return undefined;
  }
}
