import type {
  AdapterContext,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  SendPart,
} from '@tsugimori/plugin-sdk';
import type { Server } from 'node:http';

import {
  definePlugin,
  PlatformStartError,
  SendFailure,
} from '@tsugimori/plugin-sdk';
import { createServer } from 'node:http';

import type { LineText } from './api.ts';

import { LineApi, LineApiError, nonempty, record } from './api.ts';
import { messageParts } from './message-text.ts';
import {
  defaultReplyTokenTtlMs,
  lineChecks,
  lineConfigSchema,
  lineCredentials,
  lineIdentityFailure,
  lineListenFailure,
  lineSetup,
  validToken,
} from './setup.ts';
import { mapEvent } from './updates.ts';
import {
  closeServer,
  listen,
  listenAddress,
  webhook,
  webhookPath,
} from './webhook.ts';

const messagesPerRequest = 5;
const profileTtlMs = 5 * 60_000;

class Lru<Value> {
  readonly #entries = new Map<string, Value>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get(key: string) {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: Value) {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.#limit)
      this.#entries.delete(this.#entries.keys().next().value!);
  }

  delete(key: string) {
    this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
  }
}

interface LineOptions {
  listen?: string;
  replyTokenTtlMs?: number;
  secret: string;
  token: string;
}

interface Listener {
  controller: AbortController;
  server: Server;
  signal: AbortSignal;
  start: Promise<void>;
  stop?: Promise<void>;
}

function messageKey(chatId: string, messageId: string) {
  return `${chatId}/${messageId}`;
}

export class LineAdapter implements PlatformAdapter {
  readonly id: string;
  readonly kind = 'line';
  readonly capabilities = {
    deleteEvents: false,
    inlineButtons: false,
    outboundPush: 'metered' as const,
    poll: false,
    richText: false,
  };
  readonly #api: LineApi;
  readonly #options: LineOptions;
  readonly #now: () => number;
  readonly #seen = new Lru<true>(4096);
  readonly #sent = new Lru<true>(4096);
  readonly #quotes = new Lru<string>(4096);
  readonly #replies = new Lru<{
    messageId: string;
    receivedAt: number;
    token: string;
  }>(4096);
  readonly #profiles = new Lru<{
    expires: number;
    result: Promise<string | undefined>;
  }>(256);
  #botIdentity?: Awaited<ReturnType<LineApi['identity']>>;
  #listener?: Listener;

  constructor(
    {
      fetch = globalThis.fetch,
      now = Date.now,
    }: { fetch?: typeof globalThis.fetch; now?: () => number },
    id: string,
    options: LineOptions,
  ) {
    this.#api = new LineApi(fetch, options.token);
    this.#options = options;
    this.#now = now;
    this.id = id;
  }

  get botIdentity() {
    return this.#botIdentity;
  }

  async start(ctx: AdapterContext) {
    if (this.#listener) throw new Error('LINE adapter is already started');
    const controller = new AbortController();
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, controller.signal])
      : controller.signal;
    const path = webhookPath(this.id);
    const server = createServer((request, response) => {
      void webhook(request, response, path, this.#options.secret, (events) => {
        try {
          this.#receive(events, ctx, signal);
        } catch {
          ctx.logError?.('line.webhook_failed');
        }
      }).catch(() => {
        if (signal.aborted || response.destroyed) return;
        ctx.logError?.('line.webhook_failed');
        if (!response.headersSent) response.writeHead(500).end();
        else response.destroy();
      });
    });
    this.#listener = {
      controller,
      server,
      signal,
      start: this.#start(server, signal),
    };
    try {
      await this.#listener.start;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async #start(server: Server, signal: AbortSignal) {
    signal.throwIfAborted();
    const address = listenAddress(this.#options.listen);
    try {
      this.#botIdentity = await this.#api.identity(
        AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof LineApiError) {
        if (error.status === 401 || error.status === 403)
          throw new PlatformStartError(lineIdentityFailure.detail, {
            failure: lineIdentityFailure,
          });
        if (error.retryAfterMs !== undefined)
          throw new PlatformStartError(error.message, {
            retryAfterMs: error.retryAfterMs,
          });
      }
      throw error;
    }
    signal.throwIfAborted();
    try {
      await listen(server, address);
    } catch (error) {
      const failure = lineListenFailure(error);
      throw new PlatformStartError(failure.detail, { failure });
    }
    signal.throwIfAborted();
  }

  stop() {
    const listener = this.#listener;
    if (!listener) return Promise.resolve();
    return (listener.stop ??= this.#stop(listener));
  }

  async #stop(listener: Listener) {
    listener.controller.abort();
    try {
      await listener.start.catch(() => undefined); // start() reports its failure.
      await closeServer(listener.server);
    } finally {
      this.#botIdentity = undefined;
      this.#seen.clear();
      this.#sent.clear();
      this.#quotes.clear();
      this.#replies.clear();
      this.#profiles.clear();
      this.#listener = undefined;
    }
  }

  #receive(events: unknown[], ctx: AdapterContext, signal: AbortSignal) {
    if (signal.aborted) return;
    const receivedAt = this.#now();
    for (const raw of events) {
      const event = record(raw);
      const id = nonempty(event?.webhookEventId);
      if (!event || !id || this.#seen.get(id)) continue;
      this.#seen.set(id, true);
      const mapped = mapEvent(event, ctx);
      if (!mapped) continue;
      const { inbound, profilePath, quoteToken, replyToken } = mapped;
      const { chatId, messageId, replyTo } = inbound;
      if (replyToken)
        this.#replies.set(chatId, { messageId, receivedAt, token: replyToken });
      else this.#replies.delete(chatId);
      if (quoteToken)
        this.#quotes.set(messageKey(chatId, messageId), quoteToken);
      inbound.repliesToBot =
        replyTo !== undefined &&
        this.#sent.get(messageKey(chatId, replyTo)) === true;
      void this.#emit(ctx, inbound, profilePath, signal).catch(() => {
        if (!signal.aborted) ctx.logError?.('line.event_emit_failed');
      });
    }
  }

  async #emit(
    ctx: AdapterContext,
    inbound: InboundMessage,
    profilePath: string,
    signal: AbortSignal,
  ) {
    const now = this.#now();
    let profile = this.#profiles.get(profilePath);
    if (!profile || profile.expires <= now) {
      profile = {
        expires: now + profileTtlMs,
        result: this.#api
          .profile(
            profilePath,
            AbortSignal.any([signal, AbortSignal.timeout(2000)]),
          )
          .catch(() => {
            if (!signal.aborted) ctx.logDebug?.('line.profile_unavailable');
            return undefined;
          }),
      };
      this.#profiles.set(profilePath, profile);
    }
    const userDisplay = await profile.result;
    if (!signal.aborted) await ctx.emit({ ...inbound, userDisplay });
  }

  async send(message: OutboundMessage) {
    const parts: SendPart[] = [];
    try {
      const signal = this.#listener?.signal;
      if (!signal || !this.#botIdentity)
        throw new Error('LINE adapter is detached');
      const { chatId, replyTo } = message;
      const chunks = messageParts(message);
      const quoteToken =
        replyTo === undefined
          ? undefined
          : this.#quotes.get(messageKey(chatId, replyTo));
      for (let i = 0; i < chunks.length; i += messagesPerRequest) {
        signal.throwIfAborted();
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(8000),
        ]);
        const batch = chunks
          .slice(i, i + messagesPerRequest)
          .map((text, j): LineText => ({
            type: 'text',
            text,
            ...(i === 0 && j === 0 && quoteToken ? { quoteToken } : {}),
          }));
        const token =
          i === 0 ? this.#takeReplyToken(chatId, replyTo) : undefined;
        const ids = await this.#sendBatch(batch, chatId, token, requestSignal);
        for (const [index, messageId] of ids.entries()) {
          if (!signal.aborted)
            this.#sent.set(messageKey(chatId, messageId), true);
          parts.push({ messageId, text: batch[index]!.text });
        }
      }
      return {
        messageId: (message.approval ? parts.at(-1) : parts[0])!.messageId,
        parts,
      };
    } catch (error) {
      throw new SendFailure(
        {
          deliveryUnknown:
            error instanceof LineApiError && error.deliveryUnknown,
          parts,
          retryAfterMs:
            error instanceof LineApiError ? error.retryAfterMs : undefined,
        },
        error,
      );
    }
  }

  #takeReplyToken(chatId: string, replyTo?: string) {
    const reply = this.#replies.get(chatId);
    if (!reply || replyTo !== reply.messageId) return;
    this.#replies.delete(chatId);
    if (
      this.#now() - reply.receivedAt <
      (this.#options.replyTokenTtlMs ?? defaultReplyTokenTtlMs)
    )
      return reply.token;
  }

  async #sendBatch(
    batch: LineText[],
    chatId: string,
    token: string | undefined,
    signal: AbortSignal,
  ) {
    if (token) {
      try {
        return await this.#api.reply(token, batch, signal);
      } catch (error) {
        if (!(error instanceof LineApiError) || !error.invalidReplyToken)
          throw error;
      }
    }
    return this.#api.push(chatId, batch, signal);
  }

  typing({ chatId }: Pick<OutboundMessage, 'chatId'>, signal: AbortSignal) {
    const listener = this.#listener;
    if (!listener || !this.#botIdentity || !/^U[0-9a-f]{32}$/.test(chatId))
      return;
    void this.#api
      .loading(
        chatId,
        AbortSignal.any([signal, listener.signal, AbortSignal.timeout(5000)]),
      )
      .catch(() => undefined); // Loading indicators are best effort.
  }
}

export default definePlugin({
  name: 'platform-line',
  checks: lineChecks,
  configSchema: lineConfigSchema,
  credentialNames: lineCredentials,
  setupSteps: lineSetup,
  adapters: {
    line(config, ctx) {
      const [secretEnv, tokenEnv] = lineCredentials(config);
      const secret = ctx.credential(secretEnv);
      const token = ctx.credential(tokenEnv);
      if (!secret?.trim() || !validToken(token))
        throw new Error(
          'LINE needs a channel secret and channel access token.',
        );
      return new LineAdapter({ fetch: ctx.fetch }, config.id, {
        secret,
        token,
        listen: config.listen as string | undefined,
        replyTokenTtlMs: config.replyTokenTtlMs as number | undefined,
      });
    },
  },
});
