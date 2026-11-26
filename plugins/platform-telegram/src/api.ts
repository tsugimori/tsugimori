import type { InboundAttachment } from '@tsugimori/plugin-sdk';

import { attachmentBytes, ToolFailure } from '@tsugimori/plugin-sdk';
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
  readonly description?: string;
  readonly parameters: {
    migrateToChatId?: string;
    retryAfterMs?: number;
  };

  constructor(
    method: string,
    code: number | undefined,
    description?: string,
    parameters: BotApiError['parameters'] = {},
  ) {
    super(
      `Telegram ${method} failed${code === undefined ? '' : ` (${code})`}${description ? `: ${description}` : ''}`,
    );
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }

  get invalidEntities() {
    return (
      this.code === 400 &&
      /\b(?:can't|cannot) parse entities\b/iu.test(this.description ?? '')
    );
  }

  get retryAfter() {
    return this.parameters.retryAfterMs;
  }

  get unknownDelivery() {
    return this.code === undefined || this.code >= 500;
  }

  get invalidToken() {
    return this.code === 401 || this.code === 404;
  }
}

export class BotApi {
  readonly #fetch: typeof fetch;
  readonly #token: string;
  readonly #url: string;

  constructor(fetch: typeof globalThis.fetch, token: string) {
    if (!/^\d+:[\w-]+$/.test(token))
      throw new Error('Invalid Telegram bot token format');
    this.#fetch = fetch;
    this.#token = token;
    this.#url = `https://api.telegram.org/bot${token}/`;
  }

  async downloadAttachment(
    attachment: InboundAttachment,
    signal: AbortSignal,
    maxBytes = Infinity,
  ) {
    const platformLimit = 20 * 1024 * 1024;
    const limit = Math.min(platformLimit, maxBytes);
    const platformError = 'Telegram bot downloads are limited to 20 MB';
    const limitError =
      limit === platformLimit
        ? platformError
        : 'Attachment exceeds the media preparation size limit';
    if ((attachment.size ?? 0) > platformLimit)
      throw new ToolFailure(platformError);
    if ((attachment.size ?? 0) > limit) throw new ToolFailure(limitError);
    if (!attachment.fileId)
      throw new Error('Telegram attachment has no file ID');
    let file: Record<string, unknown> | undefined;
    try {
      file = record(
        await this.call('getFile', { file_id: attachment.fileId }, signal),
      );
    } catch (error) {
      if (
        error instanceof BotApiError &&
        /file is too big/i.test(error.description ?? '')
      )
        throw new ToolFailure(platformError);
      throw error;
    }
    if (typeof file?.file_size === 'number' && file.file_size > limit)
      throw new ToolFailure(
        file.file_size > platformLimit ? platformError : limitError,
      );
    const path = file?.file_path;
    if (
      typeof path !== 'string' ||
      !path
        .split('/')
        .every(
          (part) =>
            part !== '.' && part !== '..' && /^[a-z0-9_.-]+$/i.test(part),
        )
    )
      throw new Error('Telegram returned an invalid attachment path');
    const downloadSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(30_000),
    ]);
    try {
      const response = await this.#fetch(
        `https://api.telegram.org/file/bot${this.#token}/${path}`,
        {
          redirect: 'error',
          signal: downloadSignal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new BotApiError('file download', response.status);
      }
      return {
        bytes: await attachmentBytes(response, limit, limitError),
        mime:
          attachment.mime ??
          response.headers.get('content-type')?.split(';')[0],
      };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof BotApiError) throw error;
      if (error instanceof Error && error.message === limitError)
        throw new ToolFailure(limitError);
      throw new BotApiError('file download', undefined);
    }
  }

  async #post(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(
      method === 'getUpdates' ? 60_000 : 10_000,
    );
    const multipart = Object.values(body).some(
      (value) => value instanceof File,
    );
    const form = multipart ? new FormData() : undefined;
    if (form)
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        form.set(
          key,
          value instanceof File || typeof value === 'string'
            ? value
            : JSON.stringify(value),
        );
      }
    let response: Response;
    try {
      response = await this.#fetch(this.#url + method, {
        method: 'POST',
        headers: form ? undefined : { 'Content-Type': 'application/json' },
        body: form ?? JSON.stringify(body),
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch {
      signal.throwIfAborted();
      throw new BotApiError(method, undefined);
    }

    const payload = await readPayload(response);
    if (response.ok && payload?.ok === true && 'result' in payload)
      return payload.result;

    const code =
      payload?.ok === false &&
      typeof payload.error_code === 'number' &&
      Number.isSafeInteger(payload.error_code)
        ? payload.error_code
        : response.ok
          ? undefined
          : response.status;
    const description =
      typeof payload?.description === 'string'
        ? payload.description
            .replace(/https?:\/\/[^\s<>"']+/gi, '<redacted URL>')
            .replaceAll(this.#token, '<redacted token>')
        : undefined;
    const parameters = record(payload?.parameters);
    const after = parameters?.retry_after;
    throw new BotApiError(method, code, description, {
      migrateToChatId: nativeId(parameters?.migrate_to_chat_id),
      retryAfterMs:
        typeof after === 'number' && Number.isFinite(after) && after >= 0
          ? after * 1_000
          : undefined,
    });
  }

  async call(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    retries = 2,
  ): Promise<unknown> {
    const sendsMessage = method.startsWith('send');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#post(method, body, signal);
      } catch (error) {
        if (
          !(error instanceof BotApiError) ||
          attempt >= retries ||
          (error.code !== 429 && (sendsMessage || !error.unknownDelivery))
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
