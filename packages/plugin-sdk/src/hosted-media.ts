import type { IncomingMessage, ServerResponse } from 'node:http';

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { AdapterContext } from './index.ts';
import type { MediaHost } from './media.ts';
import type { WebhookIngress } from './webhooks.ts';

import { ToolFailure } from './index.ts';
import { parseWebhookBaseUrl } from './webhooks.ts';

const defaultTtlMs = 14 * 24 * 60 * 60_000;
const defaultMaxBytes = 1024 ** 3;
const tokenPattern = /^[A-Za-z0-9_-]{32}$/;
const expiredHistoryLimit = 1024;

interface Metadata {
  expires: number;
  mime: string;
  order: number;
}

interface Entry extends Metadata {
  size: number;
}

type MissReason = 'expired' | 'method' | 'unknown';

export class HostedMedia implements MediaHost {
  readonly #directory: string;
  readonly #workspace: string;
  readonly #ingress: WebhookIngress;
  readonly #path: string;
  readonly #eventPrefix: string;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry>();
  readonly #expired = new Set<string>();
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #ttlMs: number;
  #closing?: Promise<void>;
  #realDirectory?: string;
  #bytes = 0;
  #lastOrder = 0;
  #sweep?: NodeJS.Timeout;
  #closeRoute?: () => Promise<void>;
  #signal?: AbortSignal;
  #writes = Promise.resolve();

  constructor({
    directory,
    eventPrefix = 'media',
    ingress,
    maxBytes = defaultMaxBytes,
    maxEntries = 4096,
    now = Date.now,
    path,
    ttlMs = defaultTtlMs,
    workspace = dirname(directory),
  }: {
    directory: string;
    eventPrefix?: string;
    ingress: WebhookIngress;
    maxBytes?: number;
    maxEntries?: number;
    now?: () => number;
    path: string;
    ttlMs?: number;
    workspace?: string;
  }) {
    this.#directory = directory;
    this.#workspace = workspace;
    this.#eventPrefix = eventPrefix;
    this.#ingress = ingress;
    this.#path = path.replace(/\/$/, '') + '/';
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  async start(
    signal: AbortSignal,
    ctx: Pick<AdapterContext, 'logError' | 'logInfo'>,
  ) {
    await this.#closing;
    signal.throwIfAborted();
    if (this.#closeRoute) throw new Error('Hosted media is already serving');
    await this.#write(async () => {
      this.#realDirectory = await this.#prepareDirectory();
      const files = new Set(
        (await readdir(this.#directory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() || entry.isSymbolicLink())
          .map(({ name }) => name),
      );
      const entries: [string, Entry][] = [];
      const now = this.#now();
      this.#expired.clear();
      for (const name of files) {
        signal.throwIfAborted();
        if (tokenPattern.test(name)) {
          const entry = files.has(name + '.json')
            ? await this.#readEntry(name)
            : undefined;
          if (entry && entry.expires > now) entries.push([name, entry]);
          else {
            await this.#removeFiles(name);
            if (entry) this.#rememberExpired(name);
          }
        } else if (name.endsWith('.json')) {
          const token = name.slice(0, -5);
          if (tokenPattern.test(token) && !files.has(token))
            await rm(join(this.#directory, name), { force: true });
        }
      }
      this.#entries.clear();
      this.#bytes = 0;
      this.#lastOrder = 0;
      for (const [token, entry] of entries.sort(
        (a, b) => a[1].order - b[1].order,
      ))
        this.#add(token, entry);
      await this.#makeRoom(0, 0);
    }, signal);
    this.#closeRoute = await this.#ingress.register(
      this.#path,
      (request, response) => {
        const target = request.url?.split('?', 1)[0] ?? '';
        const token = target.startsWith(this.#path)
          ? target.slice(this.#path.length)
          : '';
        void this.#serve(token, request, response, ctx).catch(
          (error: NodeJS.ErrnoException) => {
            if (
              error.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
              response.destroyed
            )
              return;
            ctx.logError?.(this.#eventPrefix + '.media_serve_failed');
            if (!response.headersSent) response.writeHead(500).end();
            else response.destroy();
          },
        );
      },
      signal,
      { prefix: true },
    );
    this.#signal = signal;
    this.#sweep = setInterval(() => {
      void this.#write(() => this.#expire()).catch((error: unknown) =>
        ctx.logError?.(this.#eventPrefix + '.media_cleanup_failed', error),
      );
    }, 60_000).unref();
  }

  async #prepareDirectory() {
    const path = relative(this.#workspace, this.#directory);
    if (!path || isAbsolute(path) || path.split(sep).includes('..'))
      throw new Error('Hosted media must be stored inside the workspace');
    let current = await realpath(this.#workspace);
    for (const component of path.split(sep)) {
      current = join(current, component);
      await mkdir(current, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      if (!(await lstat(current)).isDirectory())
        throw new Error('Invalid hosted media directory');
    }
    return current;
  }

  async #checkDirectory() {
    if ((await realpath(this.#directory)) !== this.#realDirectory)
      throw new Error('Hosted media directory moved');
  }

  stop() {
    if (this.#closing) return this.#closing;
    clearInterval(this.#sweep);
    this.#signal = undefined;
    const close = this.#closeRoute;
    this.#closeRoute = undefined;
    this.#closing = this.#writes.then(close).finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }

  checkAvailable() {
    this.#base();
  }

  #base() {
    const url =
      this.#signal && !this.#signal.aborted && this.#ingress.url(this.#path);
    if (!url || !parseWebhookBaseUrl(url))
      throw new ToolFailure(
        'Hosted media requires healthy public HTTPS webhook ingress. Configure the public webhook URL first.',
      );
    return url;
  }

  #write<T>(operation: () => Promise<T>, signal?: AbortSignal) {
    const work = this.#writes.then(operation).catch((error: unknown) => {
      signal?.throwIfAborted();
      if (error instanceof ToolFailure) throw error;
      throw new Error('Hosted media storage operation failed', {
        cause: error,
      });
    });
    this.#writes = work.then(
      () => undefined,
      () => undefined, // The caller handles failures. Allow later writes to proceed.
    );
    return work;
  }

  publish(
    bytes: Uint8Array,
    { mime, ttlMs = this.#ttlMs }: Parameters<MediaHost['publish']>[1],
    caller?: AbortSignal,
  ) {
    const active = this.#signal;
    const signal =
      active && caller ? AbortSignal.any([active, caller]) : (caller ?? active);
    return this.#write(async () => {
      signal?.throwIfAborted();
      this.#base();
      const size = bytes.byteLength;
      if (size > this.#maxBytes)
        throw new ToolFailure('Hosted media exceeds the storage size limit.');
      if (!supportedMime(mime))
        throw new ToolFailure('Invalid hosted media MIME type.');
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > defaultTtlMs)
        throw new ToolFailure(
          'Hosted media TTL must be between 1 millisecond and 14 days.',
        );
      await this.#checkDirectory();
      await this.#expire();
      signal?.throwIfAborted();
      await this.#makeRoom(size, 1);
      signal?.throwIfAborted();

      const token = randomBytes(24).toString('base64url');
      const path = join(this.#directory, token);
      const file = await open(path, 'wx', 0o600);
      const now = this.#now();
      const metadata = {
        expires: now + ttlMs,
        mime,
        // Preserve publication order when several files share a timestamp.
        order: Math.max(now, this.#lastOrder + 1),
      };
      let base: string;
      try {
        try {
          await file.writeFile(bytes);
        } finally {
          await file.close();
        }
        await writeFile(path + '.json', JSON.stringify(metadata), {
          flag: 'wx',
          mode: 0o600,
        });
        signal?.throwIfAborted();
        base = this.#base();
      } catch (error) {
        await this.#removeFiles(token);
        throw error;
      }
      this.#add(token, { ...metadata, size });
      return {
        url: base + token,
        expires: metadata.expires,
        release: () => this.#write(() => this.#release(token)),
      };
    }, signal);
  }

  async #serve(
    token: string,
    request: IncomingMessage,
    response: ServerResponse,
    ctx: Pick<AdapterContext, 'logInfo'>,
  ) {
    const miss = (reason: MissReason) => {
      response.writeHead(404, { 'cache-control': 'no-store' }).end();
      ctx.logInfo?.(this.#eventPrefix + '.media_miss', { reason });
    };
    const { method } = request;
    if (!this.#signal || this.#signal.aborted) return miss('unknown');
    if (method !== 'GET' && method !== 'HEAD') return miss('method');
    const entry = tokenPattern.test(token)
      ? this.#entries.get(token)
      : undefined;
    if (!entry) return miss(this.#expired.has(token) ? 'expired' : 'unknown');
    if (entry.expires <= this.#now()) return miss('expired');

    // An open handle lets a GET finish if cap eviction unlinks the file mid-stream.
    await this.#checkDirectory();
    const file = await this.#openFile(token);
    if (response.destroyed) {
      await file?.close();
      return;
    }
    if (!file) return miss(this.#expired.has(token) ? 'expired' : 'unknown');
    try {
      if (!this.#signal || this.#signal.aborted) return miss('unknown');
      const remaining = entry.expires - this.#now();
      if (remaining <= 0) return miss('expired');
      response.once('finish', () =>
        ctx.logInfo?.(this.#eventPrefix + '.media_served', { method }),
      );
      response.writeHead(200, {
        'cache-control': `public, max-age=${Math.floor(remaining / 1000)}, immutable`,
        'content-length': entry.size,
        'content-security-policy': "sandbox; default-src 'none'",
        'content-type': entry.mime,
        'x-content-type-options': 'nosniff',
      });
      if (method === 'HEAD') response.end();
      else
        await pipeline(file.createReadStream({ autoClose: false }), response);
    } finally {
      await file.close();
    }
  }

  async #readEntry(token: string): Promise<Entry | undefined> {
    const metadataFile = await this.#openFile(token + '.json');
    if (!metadataFile) return;
    let raw: string;
    try {
      if ((await metadataFile.stat()).size > 1024) return;
      raw = await metadataFile.readFile('utf8');
    } finally {
      await metadataFile.close();
    }
    let metadata: Partial<Metadata>;
    try {
      metadata = (JSON.parse(raw) ?? {}) as Partial<Metadata>;
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    const { expires, mime, order } = metadata;
    if (
      typeof expires === 'number' &&
      Number.isSafeInteger(expires) &&
      typeof order === 'number' &&
      Number.isSafeInteger(order) &&
      supportedMime(mime)
    ) {
      const bytes = await this.#openFile(token);
      if (!bytes) return;
      try {
        return { expires, mime, order, size: (await bytes.stat()).size };
      } finally {
        await bytes.close();
      }
    }
  }

  async #openFile(name: string) {
    const file = await open(
      join(this.#directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ELOOP') throw error;
    });
    if (file) {
      let regular = false;
      try {
        const info = await file.stat();
        regular = info.isFile() && info.nlink === 1;
        if (regular) return file;
      } finally {
        if (!regular) await file.close();
      }
    }
  }

  #add(token: string, entry: Entry) {
    this.#entries.set(token, entry);
    this.#bytes += entry.size;
    this.#lastOrder = entry.order;
  }

  async #removeFiles(token: string) {
    await this.#checkDirectory();
    const path = join(this.#directory, token);
    await rm(path + '.json', { force: true });
    await rm(path, { force: true });
  }

  async #release(token: string) {
    const entry = this.#entries.get(token);
    if (!entry) return;
    await this.#removeFiles(token);
    this.#entries.delete(token);
    this.#bytes -= entry.size;
  }

  async #expire() {
    const now = this.#now();
    for (const [token, entry] of this.#entries) {
      if (entry.expires > now) continue;
      await this.#release(token);
      this.#rememberExpired(token);
    }
  }

  #rememberExpired(token: string) {
    this.#expired.add(token);
    if (this.#expired.size > expiredHistoryLimit)
      this.#expired.delete(this.#expired.values().next().value!);
  }

  async #makeRoom(size: number, count: number) {
    for (const token of this.#entries.keys()) {
      if (
        this.#bytes + size <= this.#maxBytes &&
        this.#entries.size + count <= this.#maxEntries
      )
        break;
      await this.#release(token);
    }
  }
}

function supportedMime(mime: string | undefined): mime is string {
  return (
    typeof mime === 'string' &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i.test(
      mime,
    )
  );
}
