import type {
  AccessIdentity,
  LocalEndpoint,
  Preview,
  PreviewRequest,
  TunnelProvider,
  VerifyAccess,
} from '@tsugimori/plugin-sdk';

import { ToolFailure } from '@tsugimori/plugin-sdk';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import {
  cloudflareApi,
  cloudflareId,
  cloudflareTunnelId,
  record,
} from './api.ts';
import {
  close,
  listen,
  originPath,
  proxy,
  safeEndpoint,
  send,
} from './proxy.ts';

interface NamedDependencies {
  fetch?: typeof globalThis.fetch;
  logError?(): void;
  now?(): number;
  verify: VerifyAccess;
}

interface NamedConfig {
  access: AccessIdentity;
  domain: string;
  port?: number;
  token: string;
  tunnelId: string;
  zoneId: string;
}

interface Route {
  closed: AbortController;
  dnsId: string;
  endpoint: LocalEndpoint;
  expiresAt: number;
  host: string;
  timer: NodeJS.Timeout;
}

const marker = 'tsugimori';
export class NamedTunnel implements TunnelProvider {
  readonly id = 'cloudflare-named';
  readonly #deps: NamedDependencies;
  readonly #config: NamedConfig;
  readonly #routes = new Map<string, Route>();
  readonly #previews = new Map<string, Route>();
  readonly #deleting = new Map<string, Promise<void>>();
  readonly #pending = new Set<string>();
  readonly #server;
  readonly #api: ReturnType<typeof cloudflareApi>;
  #started?: Promise<number>;
  #timer?: NodeJS.Timeout;

  constructor(deps: NamedDependencies, config: NamedConfig) {
    if (
      !cloudflareId.test(config.zoneId) ||
      !cloudflareTunnelId.test(config.tunnelId) ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(config.domain) ||
      !config.token
    )
      throw new Error('Invalid Cloudflare named tunnel configuration');
    this.#deps = deps;
    this.#config = config;
    this.#api = cloudflareApi(config.token, deps.fetch);
    this.#server = createServer((request, response) => {
      void (async () => {
        const host = request.headers.host
          ?.toLowerCase()
          .replace(/:(?:80|443)$/, '');
        const route = host && this.#routes.get(host);
        const path = originPath(request);
        if (
          !route ||
          !path ||
          route.expiresAt <= this.#now() ||
          route.endpoint.closed?.aborted
        ) {
          send(response, 404, 'Preview not found');
          return;
        }
        const jwt = request.headers['cf-access-jwt-assertion'];
        if (
          typeof jwt !== 'string' ||
          !(await this.#deps.verify(jwt, this.#config.access))
        ) {
          send(response, 403, 'Access denied');
          return;
        }
        if (
          route.closed.signal.aborted ||
          route.expiresAt <= this.#now() ||
          route.endpoint.closed?.aborted
        ) {
          send(response, 404, 'Preview closed');
          return;
        }
        proxy(request, response, route.endpoint, path, route.closed.signal);
      })().catch(() => {
        this.#deps.logError?.();
        if (!response.headersSent) send(response, 502, 'Preview unavailable');
        else response.destroy();
      });
    });
  }

  #now() {
    return (this.#deps.now ?? Date.now)();
  }

  start() {
    this.#started ??= listen(this.#server, this.#config.port ?? 8788).catch(
      (error: unknown) => {
        this.#started = undefined;
        throw error;
      },
    );
    this.#timer ??= setInterval(() => {
      for (const id of this.#pending) void this.#remove(id);
    }, 30_000).unref();
    return this.#started;
  }

  async open({ endpoint, onClose, signal, ttlMs }: PreviewRequest) {
    safeEndpoint(endpoint);
    signal.throwIfAborted();
    await this.start();
    const host = `pv-${randomBytes(12).toString('hex')}.${this.#config.domain}`;
    const data = await this.#call(
      '',
      'POST',
      {
        type: 'CNAME',
        name: host,
        content: this.#config.tunnelId + '.cfargotunnel.com',
        proxied: true,
        ttl: 1,
        comment: marker,
      },
      signal,
    );
    const dnsId = record(data.result).id;
    if (typeof dnsId !== 'string' || !cloudflareId.test(dnsId))
      throw new ToolFailure('Cloudflare returned an invalid DNS record ID');
    if (signal.aborted || endpoint.closed?.aborted) {
      await this.#remove(dnsId);
      throw new ToolFailure('Preview was cancelled before routing started');
    }
    const id = randomUUID();
    const expiresAt = this.#now() + ttlMs;
    const timer = setTimeout(() => {
      onClose?.('expired');
      void this.close(id).catch(() => this.#deps.logError?.());
    }, ttlMs).unref();
    const route = {
      closed: new AbortController(),
      dnsId,
      endpoint,
      expiresAt,
      host,
      timer,
    };
    this.#routes.set(host, route);
    this.#previews.set(id, route);
    return {
      id,
      provider: this.id,
      url: `https://${host}/`,
      expiresAt: new Date(expiresAt),
    };
  }

  async close(id: string) {
    const route = this.#previews.get(id);
    if (!route) return;
    this.#previews.delete(id);
    this.#routes.delete(route.host);
    clearTimeout(route.timer);
    route.closed.abort();
    await this.#remove(route.dnsId);
  }

  async reconcile(open: readonly Preview[]) {
    await this.start();
    const live = new Set(
      open
        .filter((preview) => preview.provider === this.id)
        .map((preview) => new URL(preview.url).hostname),
    );
    for (const host of this.#routes.keys()) live.add(host);
    const remove: string[] = [];
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({
        type: 'CNAME',
        'comment.exact': marker,
        page: String(page),
        per_page: '100',
      });
      const data = await this.#call('?' + query, 'GET');
      if (!Array.isArray(data.result))
        throw new Error('Invalid Cloudflare DNS record listing');
      for (const item of data.result) {
        const { id, name, type, comment } = record(item);
        if (
          type === 'CNAME' &&
          comment === marker &&
          typeof id === 'string' &&
          cloudflareId.test(id) &&
          typeof name === 'string' &&
          this.#ownedHost(name) &&
          !live.has(name.toLowerCase())
        )
          remove.push(id);
      }
      const total = record(data.result_info).total_pages;
      if (typeof total !== 'number' || total <= page) break;
      if (page >= 1000) throw new Error('Cloudflare DNS listing is too large');
    }
    for (const id of remove) await this.#remove(id);
  }

  #ownedHost(host: string) {
    const suffix = '.' + this.#config.domain;
    const normalized = host.toLowerCase();
    return (
      normalized.endsWith(suffix) &&
      /^pv-[a-z0-9-]+$/.test(normalized.slice(0, -suffix.length))
    );
  }

  async #call(
    path: string,
    method: string,
    body?: object,
    signal?: AbortSignal,
  ) {
    try {
      return await this.#api(
        `/zones/${this.#config.zoneId}/dns_records${path}`,
        method,
        body,
        signal,
      );
    } catch {
      throw new ToolFailure('Cloudflare DNS operation failed');
    }
  }

  #remove(id: string) {
    const current = this.#deleting.get(id);
    if (current) return current;
    const operation = this.#call('/' + id, 'DELETE')
      .then(
        () => {
          this.#pending.delete(id);
        },
        () => {
          this.#pending.add(id);
          this.#deps.logError?.();
        },
      )
      .finally(() => this.#deleting.delete(id));
    this.#deleting.set(id, operation);
    return operation;
  }

  async stop() {
    clearInterval(this.#timer);
    await Promise.allSettled(
      [...this.#previews.keys()].map((id) => this.close(id)),
    );
    await close(this.#server);
  }
}
