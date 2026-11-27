import type { InboundAttachment } from '@tsugimori/plugin-sdk';

import {
  attachmentBytes,
  attachmentMime,
  ToolFailure,
} from '@tsugimori/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { downloadSticker } from './sticker-image.ts';

export function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
}

export function nonempty(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function retryAfterMs(value: string | null) {
  if (value === null) return;
  if (/^\d+$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
}

export class LineApiError extends Error {
  readonly deliveryUnknown: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly invalidReplyToken: boolean;

  constructor(
    deliveryUnknown: boolean,
    status?: number,
    retryAfterMs?: number,
    invalidReplyToken = false,
  ) {
    super(
      status === undefined
        ? 'LINE API request failed'
        : `LINE API returned HTTP ${status}`,
    );
    this.deliveryUnknown = deliveryUnknown;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.invalidReplyToken = invalidReplyToken;
  }
}

export interface LineText {
  quickReply?: {
    items: {
      action: {
        data: string;
        displayText: string;
        label: string;
        type: 'postback';
      };
      type: 'action';
    }[];
  };
  quoteToken?: string;
  text: string;
  type: 'text';
}

export type LineMessage =
  | LineText
  | { duration: number; originalContentUrl: string; type: 'audio' }
  | { packageId: string; stickerId: string; type: 'sticker' }
  | {
      originalContentUrl: string;
      previewImageUrl: string;
      type: 'image' | 'video';
    };

const webhookEndpoint = '/v2/bot/channel/webhook/endpoint';

export class LineApi {
  readonly #fetch: typeof globalThis.fetch;
  readonly #token: string;

  constructor(fetch: typeof globalThis.fetch, token: string) {
    this.#fetch = fetch;
    this.#token = token;
  }

  async downloadAttachment(
    attachment: InboundAttachment,
    signal: AbortSignal,
    maxBytes?: number,
  ) {
    if (attachment.kind === 'sticker')
      return downloadSticker(this.#fetch, attachment, signal, maxBytes);
    if (!attachment.fileId)
      throw new ToolFailure(
        'This attachment is unavailable through the LINE content API',
      );
    signal.throwIfAborted();
    const response = await this.#fetch(
      `https://api-data.line.me/v2/bot/message/${encodeURIComponent(attachment.fileId)}/content`,
      {
        headers: { Authorization: `Bearer ${this.#token}` },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      },
    ).catch(() => {
      signal.throwIfAborted();
      throw new LineApiError(false);
    });
    if (response.status === 202 || !response.ok) {
      await response.body?.cancel();
      if (response.status === 202)
        throw new ToolFailure(
          'LINE is still preparing the attachment. Try again later.',
        );
      if (response.status === 404 || response.status === 410)
        throw new ToolFailure(
          'LINE no longer has the attachment available for download',
        );
      throw new LineApiError(false, response.status);
    }
    return {
      bytes: await attachmentBytes(response, maxBytes),
      mime: attachmentMime(response),
    };
  }

  async identity(signal: AbortSignal) {
    const body = record(await this.#request('/v2/bot/info', signal));
    const id = nonempty(body?.userId);
    const username = nonempty(nonempty(body?.basicId)?.replace(/^@/, ''));
    const displayName = nonempty(body?.displayName);
    if (!id || !username || !displayName)
      throw new Error('LINE bot info returned an invalid identity');
    return { id, username, displayName };
  }

  async webhookEndpoint(signal: AbortSignal) {
    try {
      const body = record(await this.#request(webhookEndpoint, signal));
      if (typeof body?.endpoint !== 'string')
        throw new Error('LINE returned invalid webhook endpoint information');
      return {
        endpoint: body.endpoint,
        active: typeof body.active === 'boolean' ? body.active : undefined,
      };
    } catch (error) {
      if (!(error instanceof LineApiError) || error.status !== 404) throw error;
    }
  }

  setWebhookEndpoint(endpoint: string, signal: AbortSignal) {
    return this.#request(
      webhookEndpoint,
      signal,
      { endpoint },
      undefined,
      'PUT',
    );
  }

  async testWebhookEndpoint(endpoint: string, signal: AbortSignal) {
    const body = record(
      await this.#request('/v2/bot/channel/webhook/test', signal, { endpoint }),
    );
    if (typeof body?.success !== 'boolean')
      throw new Error('LINE returned an invalid webhook test result');
    return body.success;
  }

  async profile(path: string, signal: AbortSignal) {
    const body = record(await this.#request(path, signal));
    return nonempty(body?.displayName);
  }

  loading(chatId: string, signal: AbortSignal) {
    return this.#request('/v2/bot/chat/loading/start', signal, {
      chatId,
      loadingSeconds: 20,
    });
  }

  async reply(
    replyToken: string,
    messages: LineMessage[],
    signal: AbortSignal,
  ) {
    const body = await this.#request('/v2/bot/message/reply', signal, {
      messages,
      replyToken,
    });
    return sentIds(body, messages.length);
  }

  async push(to: string, messages: LineMessage[], signal: AbortSignal) {
    const retryKey = randomUUID();
    const send = () =>
      this.#request('/v2/bot/message/push', signal, { messages, to }, retryKey);
    let body: unknown;
    try {
      body = await send();
    } catch (error) {
      if (!(error instanceof LineApiError) || (error.status ?? 0) < 500)
        throw error;
      // A server error can follow acceptance. Reuse the key for this batch.
      try {
        await delay(250, undefined, { signal });
        body = await send();
      } catch (retryError) {
        if (retryError instanceof LineApiError && retryError.deliveryUnknown)
          throw retryError;
        throw new LineApiError(
          true,
          retryError instanceof LineApiError ? retryError.status : error.status,
          retryError instanceof LineApiError
            ? retryError.retryAfterMs
            : undefined,
        );
      }
    }
    return sentIds(body, messages.length);
  }

  async #request(
    path: string,
    signal: AbortSignal,
    body?: object,
    retryKey?: string,
    method = body ? 'POST' : 'GET',
  ): Promise<unknown> {
    signal.throwIfAborted();
    const headers = new Headers({ Authorization: `Bearer ${this.#token}` });
    if (body) headers.set('Content-Type', 'application/json');
    if (retryKey) headers.set('X-Line-Retry-Key', retryKey);
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, 'https://api.line.me'), {
        body: body && JSON.stringify(body),
        headers,
        method,
        redirect: 'error',
        signal,
      });
    } catch {
      throw new LineApiError(!!body);
    }
    const accepted =
      response.ok ||
      (retryKey &&
        response.status === 409 &&
        response.headers.has('X-Line-Accepted-Request-Id'));
    if (accepted) {
      try {
        return await response.json();
      } catch {
        throw new LineApiError(!!body);
      }
    }
    const error: unknown = await response.json().catch(() => undefined);
    throw new LineApiError(
      !!body && response.status >= 500,
      response.status,
      response.status === 429
        ? retryAfterMs(response.headers.get('Retry-After'))
        : undefined,
      response.status === 400 &&
        record(error)?.message === 'Invalid reply token',
    );
  }
}

function sentIds(body: unknown, count: number) {
  const messages = record(body)?.sentMessages;
  if (!Array.isArray(messages) || messages.length !== count)
    throw new LineApiError(true);
  return messages.map((value: unknown) => {
    const id = record(value)?.id;
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
      return String(id);
    const text = nonempty(id);
    if (!text) throw new LineApiError(true);
    return text;
  });
}
