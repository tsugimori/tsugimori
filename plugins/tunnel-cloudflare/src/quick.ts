import type { PreviewRequest, TunnelProvider } from '@tsugimori/plugin-sdk';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { ToolFailure } from '@tsugimori/plugin-sdk';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  close,
  listen,
  originPath,
  proxy,
  safeEndpoint,
  send,
  sessionCookie,
} from './proxy.ts';

type Child = ChildProcessByStdio<Writable | null, Readable, Readable>;
const worker = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts') ? './quick-worker.ts' : './quick-worker.js',
    import.meta.url,
  ),
);

interface QuickDependencies {
  command?: string;
  logError?(): void;
  now?(): number;
  spawnTunnel?(command: string, args: string[], env: NodeJS.ProcessEnv): Child;
}

function equals(actual: string | undefined, expected: string) {
  if (!actual || actual.length !== expected.length) return false;
  const value = Buffer.from(actual);
  const secret = Buffer.from(expected);
  return value.length === secret.length && timingSafeEqual(value, secret);
}

export class QuickTunnel implements TunnelProvider {
  readonly id = 'cloudflare-quick';
  readonly #deps: QuickDependencies;
  readonly #open = new Map<string, () => Promise<void>>();

  constructor(deps: QuickDependencies = {}) {
    this.#deps = deps;
  }

  async open({ endpoint, onClose, signal, ttlMs }: PreviewRequest) {
    safeEndpoint(endpoint);
    signal.throwIfAborted();
    const id = randomUUID();
    const now = this.#deps.now ?? Date.now;
    const secret = randomBytes(24).toString('base64url');
    const session = randomBytes(32).toString('base64url');
    const shutdown = new AbortController();
    let expiresAt = Number.POSITIVE_INFINITY;
    let redeemed = false;
    const server = createServer((request, response) => {
      const path = originPath(request);
      if (!path || shutdown.signal.aborted || now() >= expiresAt) {
        send(response, 404, 'Preview closed');
        return;
      }
      const url = new URL(path, 'http://127.0.0.1');
      if (url.origin !== 'http://127.0.0.1' || url.pathname.startsWith('//')) {
        send(response, 400, 'Invalid preview path');
        return;
      }
      const queryToken = url.searchParams.get('token');
      if (queryToken !== null) {
        if (
          redeemed ||
          request.method !== 'GET' ||
          !equals(queryToken, secret)
        ) {
          send(response, 403, 'Preview access denied');
          return;
        }
        redeemed = true;
        url.searchParams.delete('token');
        response.writeHead(303, {
          Location: url.pathname + url.search,
          'Set-Cookie': `${sessionCookie}=${session}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.floor((expiresAt - now()) / 1000))}`,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        response.end();
        return;
      }
      const cookies =
        request.headers.cookie?.split(';').map((part) => part.trim()) ?? [];
      const value = cookies
        .find((part) => part.startsWith(sessionCookie + '='))
        ?.slice(sessionCookie.length + 1);
      if (!redeemed || !equals(value, session)) {
        send(response, 403, 'Preview access denied');
        return;
      }
      proxy(request, response, endpoint, path, shutdown.signal);
    });

    const temporary = await mkdtemp(join(tmpdir(), 'tsugimori-quick-'));
    let child: Child | undefined;
    let closed: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    const cleanup = async () => {
      shutdown.abort();
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const kill = setTimeout(() => child?.kill('SIGKILL'), 1_000);
        kill.unref();
        await closed;
        clearTimeout(kill);
      }
      try {
        await close(server);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    };
    const stop = () => (closing ??= cleanup());
    let timer: NodeJS.Timeout | undefined;

    try {
      const port = await listen(server, 0);
      const command = this.#deps.command ?? 'cloudflared';
      const args = ['tunnel', '--url', `http://127.0.0.1:${port}`];
      const env = {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        HOME: temporary,
        XDG_CONFIG_HOME: temporary,
      };
      const start =
        this.#deps.spawnTunnel ??
        ((name, argv, childEnv) =>
          spawn(process.execPath, [worker, name, ...argv], {
            env: childEnv,
            cwd: temporary,
            stdio: 'pipe',
          }));
      const ready = Promise.withResolvers<string>();
      const ended = Promise.withResolvers<void>();
      closed = ended.promise;
      const opening = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const abort = () =>
        ready.reject(
          new ToolFailure('Quick Tunnel startup timed out or was cancelled'),
        );
      opening.addEventListener('abort', abort, { once: true });
      try {
        opening.throwIfAborted();
        child = start(command, args, env);
        child.once('error', () =>
          ready.reject(
            new ToolFailure('Could not start cloudflared for the Quick Tunnel'),
          ),
        );
        child.once('close', () => {
          ended.resolve();
          ready.reject(
            new ToolFailure(
              'cloudflared stopped before publishing a Quick Tunnel URL',
            ),
          );
          if (this.#open.has(id) && !shutdown.signal.aborted) {
            onClose?.('provider-stopped');
            void this.close(id).catch(() => this.#deps.logError?.());
          }
        });
        for (const stream of [child.stdout, child.stderr]) {
          let buffer = '';
          stream.setEncoding('utf8').on('data', (text: string) => {
            buffer = (buffer + text).slice(-8192);
            const url =
              /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|])/i.exec(
                buffer,
              )?.[0];
            if (url) ready.resolve(url);
          });
        }
        const origin = await ready.promise;
        opening.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null)
          throw new ToolFailure('The Quick Tunnel process stopped');
        expiresAt = now() + ttlMs;
        timer = setTimeout(() => {
          onClose?.('expired');
          void this.close(id).catch(() => this.#deps.logError?.());
        }, ttlMs);
        timer.unref();
        this.#open.set(id, stop);
        return {
          id,
          url: `${origin}/?token=${secret}`,
          expiresAt: new Date(expiresAt),
          provider: this.id,
        };
      } finally {
        opening.removeEventListener('abort', abort);
      }
    } catch (error) {
      await stop();
      throw error;
    }
  }

  async close(id: string) {
    const stop = this.#open.get(id);
    this.#open.delete(id);
    await stop?.();
  }

  async reconcile() {
    // Quick tunnels last only as long as their cloudflared process.
  }

  async stop() {
    await Promise.allSettled(
      [...this.#open.keys()].map((id) => this.close(id)),
    );
  }
}
