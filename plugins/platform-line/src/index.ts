import type {
  AdapterContext,
  AttachmentContent,
  InboundMessage,
  MediaDestination,
  MediaUpload,
  OutboundMessage,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformFactory,
  QueuedMedia,
  SendPart,
  WebhookIngress,
  WebhookRoute,
} from '@tsugimori/plugin-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  definePlugin,
  parseWebhookBaseUrl,
  PlatformStartError,
  SendFailure,
  ToolFailure,
} from '@tsugimori/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { LineMessage } from './api.ts';

import { LineApi, LineApiError, nonempty, record } from './api.ts';
import { messageParts } from './message-text.ts';
import { LineMediaHost } from './outbound-media.ts';
import {
  defaultReplyTokenTtlMs,
  lineChecks,
  lineCompletion,
  lineConfigSchema,
  lineCredentials,
  lineIdentityFailure,
  lineListenFailure,
  lineSetup,
  validToken,
} from './setup.ts';
import { lineStickers, searchLineStickers } from './stickers.ts';
import { mapEvent } from './updates.ts';
import { webhook, webhookPath } from './webhook.ts';

const uploadLimits = {
  files: { maxBytes: 200 * 1024 * 1024 },
  images: { maxBytes: 10 * 1024 * 1024, queued: true },
};
const maxPreview = 1024 * 1024;
type PendingMedia =
  | { packageId: string; stickerId: string; type: 'sticker' }
  | {
      original: AttachmentContent;
      preview: AttachmentContent;
      type: 'image' | 'video';
    };

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
  ingress: WebhookIngress;
  mediaDirectory: string;
  mediaMaxBytes?: number;
  mediaTtlMs?: number;
  replyTokenTtlMs?: number;
  secret: string;
  token: string;
}

interface Listener {
  controller: AbortController;
  logError?: AdapterContext['logError'];
  signal: AbortSignal;
  start: Promise<() => Promise<void>>;
  stop?: Promise<void>;
}

function messageKey(chatId: string, messageId: string) {
  return `${chatId}/${messageId}`;
}

export class LineAdapter implements PlatformAdapter {
  readonly id: string;
  readonly kind = 'line';
  readonly capabilities: PlatformCapabilities = {
    ...uploadLimits,
    stickers: true,
    deleteEvents: false,
    inlineButtons: false,
    outboundPush: 'metered' as const,
    poll: false,
    richText: false,
  };
  readonly #api: LineApi;
  readonly #options: LineOptions;
  readonly #now: () => number;
  readonly #mediaHost: LineMediaHost;
  readonly #queued = new WeakMap<
    QueuedMedia,
    PendingMedia & { destination: MediaDestination }
  >();
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
    this.#mediaHost = new LineMediaHost({
      directory: options.mediaDirectory,
      maxBytes: options.mediaMaxBytes,
      now,
      ttlMs: options.mediaTtlMs,
    });
    this.id = id;
  }

  get botIdentity() {
    return this.#botIdentity;
  }

  async contactLink() {
    const username = this.#botIdentity?.username;
    if (username)
      return `https://line.me/R/ti/p/${encodeURIComponent(`@${username}`)}`;
  }

  async start(ctx: AdapterContext) {
    if (this.#listener) throw new Error('LINE adapter is already started');
    const controller = new AbortController();
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, controller.signal])
      : controller.signal;
    const path = webhookPath(this.id);
    const mediaPath = path + 'media/';
    const route = (request: IncomingMessage, response: ServerResponse) => {
      const target = request.url?.split('?', 1)[0];
      if (!signal.aborted && target?.startsWith(mediaPath)) {
        void this.#mediaHost
          .serve(target.slice(mediaPath.length), request, response, ctx)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
            ctx.logError?.('line.media_serve_failed');
            if (response.destroyed) return;
            if (!response.headersSent) response.writeHead(500).end();
            else response.destroy();
          });
        return;
      }
      if (
        request.method !== 'POST' ||
        signal.aborted ||
        (target !== path &&
          target !== path.slice(0, -1) &&
          target !== path + 'webhook')
      ) {
        response.writeHead(404).end();
        return;
      }
      void webhook(request, response, this.#options.secret, (events) => {
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
    };
    this.#listener = {
      controller,
      logError: (event, error) => ctx.logError?.(event, error),
      signal,
      start: this.#start(route, signal, ctx),
    };
    try {
      await this.#listener.start;
      signal.throwIfAborted();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async #start(route: WebhookRoute, signal: AbortSignal, ctx: AdapterContext) {
    signal.throwIfAborted();
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
    await this.#mediaHost.start((event, error) => ctx.logError?.(event, error));
    signal.throwIfAborted();
    try {
      const path = webhookPath(this.id);
      const release = await this.#options.ingress.register(
        path,
        route,
        signal,
        { prefix: true },
      );
      try {
        const releaseAlias = await this.#options.ingress.register(
          path + 'webhook',
          (request, response) => {
            if (request.url?.split('?', 1)[0] === path + 'webhook')
              route(request, response);
            else response.writeHead(404).end();
          },
          signal,
        );
        return async () => {
          await Promise.all([release(), releaseAlias()]);
        };
      } catch (error) {
        await release();
        throw error;
      }
    } catch (error) {
      signal.throwIfAborted();
      const failure = lineListenFailure(error);
      throw new PlatformStartError(failure.detail, { failure });
    }
  }

  stop() {
    const listener = this.#listener;
    if (!listener) return Promise.resolve();
    return (listener.stop ??= this.#stop(listener));
  }

  async #stop(listener: Listener) {
    listener.controller.abort();
    try {
      const release = await listener.start.catch(() => undefined); // start() reports its failure.
      await release?.();
    } finally {
      await this.#mediaHost.stop();
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
      const { chatId, messageId } = inbound;
      const replyTo = inbound.replyTo?.id;
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

  searchStickers(query: string, limit: number) {
    return searchLineStickers(query, limit);
  }

  async sendSticker(
    message: MediaDestination & { fileId: string; packageId?: string },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { fileId, packageId } = message;
    const sticker = lineStickers.get(fileId);
    if (!sticker?.packageId || (packageId && sticker.packageId !== packageId))
      throw new ToolFailure(
        'LINE only supports official sendable stickers. Use sticker.search to find one.',
      );
    return this.#queue(message, {
      type: 'sticker',
      packageId: sticker.packageId,
      stickerId: fileId,
    });
  }

  sendImage(message: MediaUpload, signal: AbortSignal) {
    return this.#queueUpload(
      message,
      'image',
      uploadLimits.images.maxBytes,
      signal,
    );
  }

  sendFile(message: MediaUpload, signal: AbortSignal) {
    return this.#queueUpload(
      message,
      'video',
      uploadLimits.files.maxBytes,
      signal,
    );
  }

  async #queueUpload(
    message: MediaUpload,
    type: 'image' | 'video',
    limit: number,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.#mediaBase();
    const { file } = message;
    if (file.bytes.byteLength > limit)
      throw new ToolFailure(
        `LINE ${type} exceeds the ${limit / 1024 ** 2} MB size limit`,
      );
    const bytes = Buffer.from(
      file.bytes.buffer,
      file.bytes.byteOffset,
      file.bytes.byteLength,
    );
    const mime =
      type === 'video'
        ? bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp'
          ? 'video/mp4'
          : undefined
        : bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          ? 'image/png'
          : bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
            ? 'image/jpeg'
            : undefined;
    if (!mime)
      throw new ToolFailure(
        type === 'video'
          ? 'LINE can send MP4 video files only'
          : 'LINE images must be JPEG or PNG',
      );
    const original = { bytes: file.bytes, mime };
    const preview =
      type === 'image' && bytes.byteLength <= maxPreview
        ? original
        : await message.preview(maxPreview);
    if (
      preview.bytes.byteLength > maxPreview ||
      (preview.mime !== 'image/jpeg' && preview.mime !== 'image/png')
    )
      throw new ToolFailure('LINE requires a JPEG or PNG preview up to 1 MB');
    signal.throwIfAborted();
    return this.#queue(message, { type, original, preview });
  }

  #queue(
    { chatId, replyTo, threadId }: MediaDestination,
    media: PendingMedia,
  ): QueuedMedia {
    if (!this.#listener || !this.#botIdentity)
      throw new ToolFailure('LINE adapter is detached');
    const handle = { queued: true as const, id: randomUUID() };
    this.#queued.set(handle, {
      ...media,
      destination: { chatId, replyTo, threadId },
    });
    return handle;
  }

  #mediaBase() {
    const path = this.#options.ingress.url(webhookPath(this.id));
    if (!parseWebhookBaseUrl(path))
      throw new ToolFailure(
        'LINE media requires healthy public HTTPS webhook ingress',
      );
    return path!.replace(/\/?$/, '/') + 'media/';
  }

  async send(
    message: OutboundMessage,
    options?: Parameters<PlatformAdapter['send']>[1],
  ) {
    const parts: SendPart[] = [];
    try {
      const listener = this.#listener;
      if (!listener || !this.#botIdentity)
        throw new Error('LINE adapter is detached');
      const signal = options?.signal
        ? AbortSignal.any([options.signal, listener.signal])
        : listener.signal;
      const { chatId, replyTo, threadId } = message;
      const media = options?.media ?? [];
      const chunks =
        media.length && !message.text.trim() ? [] : messageParts(message);
      const quoteToken =
        replyTo === undefined
          ? undefined
          : this.#quotes.get(messageKey(chatId, replyTo));
      const items: {
        mediaId?: string;
        payload: LineMessage | PendingMedia;
        text: string;
      }[] = chunks.map((text, index) => ({
        payload: {
          type: 'text',
          text,
          ...(index === 0 && quoteToken ? { quoteToken } : {}),
        },
        text,
      }));
      for (const handle of media) {
        const queued = this.#queued.get(handle);
        if (
          !queued ||
          queued.destination.chatId !== chatId ||
          queued.destination.threadId !== threadId ||
          queued.destination.replyTo !== replyTo
        )
          throw new ToolFailure(
            'LINE queued media belongs to a different reply',
          );
        this.#queued.delete(handle);
        const { type } = queued;
        items.push({
          mediaId: handle.id,
          payload:
            type === 'sticker'
              ? {
                  type,
                  packageId: queued.packageId,
                  stickerId: queued.stickerId,
                }
              : queued,
          text: `[${type}]`,
        });
      }
      for (let i = 0; i < items.length; i += messagesPerRequest) {
        signal.throwIfAborted();
        const batch = items.slice(i, i + messagesPerRequest);
        const releases: (() => Promise<void>)[] = [];
        try {
          const messages: LineMessage[] = [];
          for (const { payload } of batch) {
            if (!('original' in payload)) {
              messages.push(payload);
              continue;
            }
            signal.throwIfAborted();
            const base = this.#mediaBase();
            const original = await this.#mediaHost.publish(
              base,
              payload.original,
            );
            releases.push(original.release);
            signal.throwIfAborted();
            const preview = await this.#mediaHost.publish(
              base,
              payload.preview,
            );
            releases.push(preview.release);
            messages.push({
              type: payload.type,
              originalContentUrl: original.url,
              previewImageUrl: preview.url,
            });
          }
          signal.throwIfAborted();
          const token =
            i === 0 ? this.#takeReplyToken(chatId, replyTo) : undefined;
          const ids = await this.#sendBatch(
            messages,
            chatId,
            token,
            AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          );
          for (const [index, messageId] of ids.entries()) {
            if (!signal.aborted)
              this.#sent.set(messageKey(chatId, messageId), true);
            const { mediaId, text } = batch[index]!;
            parts.push({ messageId, text, ...(mediaId && { mediaId }) });
          }
        } catch (error) {
          if (!(error instanceof LineApiError) || !error.deliveryUnknown) {
            for (const release of releases) {
              await release().catch((cleanupError: unknown) =>
                listener.logError?.('line.media_cleanup_failed', cleanupError),
              );
            }
          }
          throw error;
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
    batch: LineMessage[],
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

  downloadAttachment(
    ...args: Parameters<NonNullable<PlatformAdapter['downloadAttachment']>>
  ) {
    return this.#api.downloadAttachment(...args);
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

const line: PlatformFactory = (config, ctx) => {
  const [secretEnv, tokenEnv] = lineCredentials(config);
  const secret = ctx.credential(secretEnv);
  const token = ctx.credential(tokenEnv);
  if (!secret?.trim() || !validToken(token))
    throw new Error('LINE needs a channel secret and channel access token.');
  if (!ctx.webhookIngress)
    throw new Error('LINE needs gateway webhook ingress.');
  return new LineAdapter({ fetch: ctx.fetch }, config.id, {
    secret,
    token,
    ingress: ctx.webhookIngress,
    mediaDirectory: join(
      ctx.workspace,
      'data',
      'platform-line',
      `adapter-${encodeURIComponent(config.id)}`,
    ),
    replyTokenTtlMs: config.replyTokenTtlMs as number | undefined,
  });
};
line.requires = ['webhook'];

export default definePlugin({
  name: 'platform-line',
  checks: lineChecks,
  setupComplete: lineCompletion,
  configSchema: lineConfigSchema,
  credentialNames: lineCredentials,
  setupSteps: lineSetup,
  adapters: { line },
});
