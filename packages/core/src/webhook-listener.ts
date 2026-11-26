import type { WebhookRoute } from '@tsugimori/plugin-sdk';
import type { Server } from 'node:http';

import {
  defaultWebhookListen,
  parseWebhookListen,
} from '@tsugimori/plugin-sdk';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import { untilAborted } from './abort.ts';

export const probePath = '/.well-known/tsugimori/probe/';
const nonceTtlMs = 60_000;
const maxPending = 4;

export function normalizedWebhookPath(path: string) {
  return path.endsWith('/') ? path.slice(0, -1) || '/' : path;
}

export class WebhookListener {
  readonly #routes = new Map<string, WebhookRoute>();
  readonly #pending = new Map<string, { consumed: boolean; expires: number }>();
  readonly #now: () => number;
  #address = defaultWebhookListen;
  #server?: { address: string; server: Server };
  #queue = Promise.resolve();
  #probes = 0;
  #stopped = false;

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.#now = now;
  }

  get listen() {
    return this.#address;
  }

  configure(address: string) {
    this.#address = address;
    return this.#sync();
  }

  async register(path: string, route: WebhookRoute, signal: AbortSignal) {
    const key = normalizedWebhookPath(path);
    if (
      !/^\/(?!\/)[^?#\s\\]*$/.test(path) ||
      key === probePath.slice(0, -1) ||
      key.startsWith(probePath)
    )
      throw new Error('Invalid webhook path');
    signal.throwIfAborted();
    if (this.#stopped) throw new Error('Webhook listener has stopped');
    if (this.#routes.has(key))
      throw new Error('Webhook path is already registered');
    this.#routes.set(key, route);
    let closing: Promise<void> | undefined;
    const release = () => {
      if (closing) return closing;
      this.#routes.delete(key);
      return (closing = this.#sync());
    };
    try {
      await this.#sync();
      signal.throwIfAborted();
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  }

  has(path: string) {
    return this.#routes.has(normalizedWebhookPath(path));
  }

  paths() {
    return this.isListening() ? [...this.#routes.keys()] : [];
  }

  isListening() {
    return (
      this.#server?.server.listening === true &&
      this.#server.address === this.#address
    );
  }

  async probe(
    baseUrl: string,
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
  ) {
    this.#expire();
    if (this.#probes >= maxPending || this.#stopped)
      throw new Error('Webhook listener cannot start another probe');
    this.#probes++;
    const nonce = randomBytes(32).toString('base64url');
    try {
      await this.#sync();
      signal.throwIfAborted();
      const pending = { consumed: false, expires: this.#now() + nonceTtlMs };
      this.#pending.set(nonce, pending);
      const url = baseUrl + probePath + nonce;
      return await untilAborted(signal, async () => {
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal,
        });
        if (response.status !== 200 || !pending.consumed) {
          await response.body?.cancel();
          return { ok: false, status: response.status };
        }
        return {
          ok: await matchesNonce(response, nonce),
          status: response.status,
        };
      });
    } finally {
      this.#pending.delete(nonce);
      this.#probes--;
      await this.#sync();
    }
  }

  #expire() {
    const now = this.#now();
    for (const [nonce, { expires }] of this.#pending)
      if (expires <= now) this.#pending.delete(nonce);
  }

  #sync() {
    const work = this.#queue.then(async () => {
      const address = this.#address;
      const needed =
        !this.#stopped && (this.#routes.size > 0 || this.#probes > 0);
      if (this.#server && (!needed || this.#server.address !== address)) {
        const { server } = this.#server;
        this.#server = undefined;
        const closed = Promise.withResolvers<void>();
        server.close((error) =>
          error ? closed.reject(error) : closed.resolve(),
        );
        server.closeAllConnections();
        await closed.promise;
      }
      if (!needed || this.#server) return;
      const binding = parseWebhookListen(address);
      if (!binding) throw new Error('Invalid webhook listen address');
      const server = createServer((request, response) => {
        const path = request.url?.split('?', 1)[0] ?? '';
        if (path.startsWith(probePath)) {
          const nonce = path.slice(probePath.length);
          const pending = this.#pending.get(nonce);
          if (
            request.method === 'GET' &&
            pending &&
            pending.expires > this.#now()
          ) {
            pending.consumed = true;
            this.#pending.delete(nonce);
            response
              .writeHead(200, {
                'content-type': 'text/plain',
                'cache-control': 'no-store',
                connection: 'close',
              })
              .end(nonce);
            return;
          }
        } else {
          const route = this.#routes.get(normalizedWebhookPath(path));
          if (route) {
            route(request, response);
            return;
          }
        }
        response.writeHead(404).end();
      });
      const ready = Promise.withResolvers<void>();
      server.once('error', ready.reject);
      try {
        server.listen(binding, ready.resolve);
        await ready.promise;
        this.#server = { address, server };
      } finally {
        server.off('error', ready.reject);
      }
    });
    this.#queue = work.catch(() => {}); // Allow a later registration or check to retry.
    return work;
  }

  stop() {
    this.#stopped = true;
    this.#pending.clear();
    this.#routes.clear();
    return this.#sync();
  }
}

async function matchesNonce(response: Response, nonce: string) {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const expected = Buffer.from(nonce);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return offset === expected.length;
      if (
        !Buffer.from(value).equals(
          expected.subarray(offset, offset + value.length),
        )
      )
        return false;
      offset += value.length;
    }
  } finally {
    await reader.cancel();
  }
}
