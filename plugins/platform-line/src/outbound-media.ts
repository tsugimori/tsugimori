import type { AdapterContext, AttachmentContent } from '@tsugimori/plugin-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ToolFailure } from '@tsugimori/plugin-sdk';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

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

export class LineMediaHost {
  readonly #directory: string;
  readonly #entries = new Map<string, Entry>();
  readonly #expired = new Set<string>();
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #ttlMs: number;
  #bytes = 0;
  #lastOrder = 0;
  #sweep?: NodeJS.Timeout;
  #writes = Promise.resolve();

  constructor({
    directory,
    maxBytes = defaultMaxBytes,
    now = Date.now,
    ttlMs = defaultTtlMs,
  }: {
    directory: string;
    maxBytes?: number;
    now?: () => number;
    ttlMs?: number;
  }) {
    this.#directory = directory;
    this.#maxBytes = maxBytes;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  async start(logError?: AdapterContext['logError']) {
    await this.#write(async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const files = new Set(
        (await readdir(this.#directory, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map(({ name }) => name),
      );
      const entries: [string, Entry][] = [];
      const now = this.#now();
      this.#expired.clear();
      for (const name of files) {
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
      await this.#makeRoom(0);
    });
    this.#sweep = setInterval(() => {
      void this.#write(() => this.#expire()).catch((error: unknown) =>
        logError?.('line.media_cleanup_failed', error),
      );
    }, 60_000).unref();
  }

  stop() {
    clearInterval(this.#sweep);
    return this.#writes;
  }

  #write<T>(operation: () => Promise<T>) {
    const work = this.#writes.then(operation).catch((error: unknown) => {
      if (error instanceof ToolFailure) throw error;
      throw new Error('LINE media storage operation failed', { cause: error });
    });
    this.#writes = work.then(
      () => undefined,
      () => undefined, // The caller handles failures. Allow later writes to proceed.
    );
    return work;
  }

  publish(base: string, { bytes, mime }: AttachmentContent) {
    return this.#write(async () => {
      const size = bytes.byteLength;
      if (size > this.#maxBytes)
        throw new ToolFailure('LINE media exceeds the storage size limit.');
      if (!supportedMime(mime))
        throw new ToolFailure('Unsupported LINE media type.');
      await this.#expire();
      await this.#makeRoom(size);

      const token = randomBytes(24).toString('base64url');
      const path = join(this.#directory, token);
      const file = await open(path, 'wx', 0o600);
      const now = this.#now();
      const metadata = {
        expires: now + this.#ttlMs,
        mime,
        // Preserve publication order when several files share a timestamp.
        order: Math.max(now, this.#lastOrder + 1),
      };
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
      } catch (error) {
        await this.#removeFiles(token);
        throw error;
      }
      this.#add(token, { ...metadata, size });
      return {
        url: base + token,
        release: () => this.#write(() => this.#release(token)),
      };
    });
  }

  async serve(
    token: string,
    request: IncomingMessage,
    response: ServerResponse,
    ctx: Pick<AdapterContext, 'logInfo'>,
  ) {
    const miss = (reason: MissReason) => {
      response.writeHead(404, { 'cache-control': 'no-store' }).end();
      ctx.logInfo?.('line.media_miss', { reason });
    };
    const { method } = request;
    if (method !== 'GET' && method !== 'HEAD') return miss('method');
    const entry = tokenPattern.test(token)
      ? this.#entries.get(token)
      : undefined;
    if (!entry) return miss(this.#expired.has(token) ? 'expired' : 'unknown');
    const remaining = entry.expires - this.#now();
    if (remaining <= 0) return miss('expired');

    // An open handle lets a GET finish if cap eviction unlinks the file mid-stream.
    const file = await open(
      join(this.#directory, token),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (response.destroyed) {
      await file?.close();
      return;
    }
    if (!file) return miss(this.#expired.has(token) ? 'expired' : 'unknown');
    try {
      response.once('finish', () =>
        ctx.logInfo?.('line.media_served', { method }),
      );
      response.writeHead(200, {
        'cache-control': `public, max-age=${Math.floor(remaining / 1000)}, immutable`,
        'content-length': entry.size,
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
    const path = join(this.#directory, token);
    const raw = await readFile(path + '.json', 'utf8');
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
    )
      return { expires, mime, order, size: (await stat(path)).size };
  }

  #add(token: string, entry: Entry) {
    this.#entries.set(token, entry);
    this.#bytes += entry.size;
    this.#lastOrder = entry.order;
  }

  async #removeFiles(token: string) {
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

  async #makeRoom(size: number) {
    for (const token of this.#entries.keys()) {
      if (this.#bytes + size <= this.#maxBytes) break;
      await this.#release(token);
    }
  }
}

function supportedMime(mime: string | undefined): mime is string {
  return mime === 'image/jpeg' || mime === 'image/png' || mime === 'video/mp4';
}
