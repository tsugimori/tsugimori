import type { AttachmentContent } from '@tsugimori/plugin-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ToolFailure } from '@tsugimori/plugin-sdk';
import { randomBytes } from 'node:crypto';

const ttlMs = 10 * 60_000;
const totalLimit = 256 * 1024 ** 2;

interface Entry {
  bytes: Uint8Array;
  expires: number;
  fetching: boolean;
  mime: string;
  timer: NodeJS.Timeout;
}

export class LineMediaHost {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  #bytes = 0;

  constructor(now: () => number) {
    this.#now = now;
  }

  publish(base: string, { bytes, mime }: AttachmentContent) {
    this.#expire();
    if (bytes.byteLength + this.#bytes > totalLimit)
      throw new ToolFailure('LINE media storage is full. Try again later.');
    const token = randomBytes(24).toString('base64url');
    const release = () => this.#release(token);
    const timer = setTimeout(release, ttlMs).unref();
    this.#bytes += bytes.byteLength;
    this.#entries.set(token, {
      bytes,
      expires: this.#now() + ttlMs,
      fetching: false,
      mime: mime!,
      timer,
    });
    return { url: base + token, release };
  }

  serve(
    token: string,
    request: IncomingMessage,
    response: ServerResponse,
    served: () => void,
  ) {
    const entry = /^[A-Za-z0-9_-]{32}$/.test(token)
      ? this.#entries.get(token)
      : undefined;
    if (entry && entry.expires <= this.#now()) this.#release(token);
    if (
      !entry ||
      request.method !== 'GET' ||
      entry.fetching ||
      entry.expires <= this.#now()
    ) {
      response.writeHead(404, { 'cache-control': 'no-store' }).end();
      return;
    }
    entry.fetching = true;
    response.once('close', () => {
      entry.fetching = false;
    });
    response.once('finish', () => {
      this.#release(token);
      served();
    });
    response
      .writeHead(200, {
        'cache-control': 'private, no-store',
        'content-length': entry.bytes.byteLength,
        'content-type': entry.mime,
        'x-content-type-options': 'nosniff',
      })
      .end(entry.bytes);
  }

  #release(token: string) {
    const entry = this.#entries.get(token);
    if (!entry) return;
    this.#entries.delete(token);
    this.#bytes -= entry.bytes.byteLength;
    clearTimeout(entry.timer);
  }

  #expire() {
    const now = this.#now();
    for (const [token, entry] of this.#entries)
      if (entry.expires <= now) this.#release(token);
  }

  clear() {
    for (const token of this.#entries.keys()) this.#release(token);
  }
}
