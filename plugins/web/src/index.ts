import type {
  AccessIdentity,
  AdminReader,
  VerifyAccess,
} from '@tsugimori/plugin-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';

import type { ViewContext } from './format.ts';
import type { Section } from './layout.ts';

import { createAccessVerifier } from './access.ts';
import { escapeHtml } from './format.ts';
import { i18n } from './i18n.ts';
import { page } from './layout.ts';
import { approvalsView } from './views/approvals.ts';
import { chatView } from './views/chat.ts';
import { overviewView } from './views/overview.ts';
import { schedulesView } from './views/schedules.ts';
import { chatTitle } from './views/shared.ts';
import { traceView } from './views/trace.ts';

export { createAccessVerifier };

interface WebDependencies {
  logError?(): void;
  now?(): number;
  reader: AdminReader;
  verify?: VerifyAccess;
}

interface WebOptions {
  access?: AccessIdentity;
  allowLocalWithoutAccess?: boolean;
  listen?: string;
}

function respond(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function isLocal(request: IncomingMessage) {
  const address = request.socket.remoteAddress;
  return (
    (address === '127.0.0.1' || address === '::1') &&
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(
      request.headers.host ?? '',
    ) &&
    !['cf-access-jwt-assertion', 'cf-ray', 'forwarded', 'x-forwarded-for'].some(
      (key) => key in request.headers,
    )
  );
}

export class AdminServer {
  readonly #deps: WebDependencies;
  readonly #options: WebOptions;
  readonly #verify: VerifyAccess;
  readonly #server;

  constructor(deps: WebDependencies, options: WebOptions = {}) {
    this.#deps = deps;
    this.#options = options;
    this.#verify = deps.verify ?? createAccessVerifier();
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        this.#deps.logError?.();
        if (!response.headersSent)
          this.#error(request, response, 500, 'internal');
        else response.destroy();
      });
    });
  }

  async start() {
    const address = this.#options.listen ?? '127.0.0.1:8787';
    const match = /^(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/.exec(address);
    if (!match || Number(match[2]) > 65535)
      throw new Error('Web listen must use a loopback address and valid port');
    const listening = Promise.withResolvers<void>();
    this.#server.once('error', listening.reject);
    try {
      this.#server.listen(
        Number(match[2]),
        match[1] === '[::1]' ? '::1' : '127.0.0.1',
        listening.resolve,
      );
      await listening.promise;
    } finally {
      this.#server.off('error', listening.reject);
    }
    return this.#server.address() as AddressInfo;
  }

  async stop() {
    if (!this.#server.listening) return;
    const closed = Promise.withResolvers<void>();
    this.#server.close((error) =>
      error ? closed.reject(error) : closed.resolve(),
    );
    this.#server.closeAllConnections();
    await closed.promise;
  }

  #error(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    key: 'internal' | 'forbidden' | 'method' | 'invalidChat' | 'notFound',
    ctx?: ViewContext,
  ) {
    let workspace: Pick<ViewContext, 'locale' | 'name'> = { locale: 'en' };
    try {
      const { locale, name } = ctx ?? this.#deps.reader.workspace();
      workspace = { locale, name: status === 403 ? undefined : name };
    } catch {
      // The error page remains available if workspace metadata cannot be read.
    }
    const m = i18n(workspace.locale);
    if (request.url?.startsWith('/api/')) {
      respond(response, status, m[key]);
      return;
    }
    respond(
      response,
      status,
      page({
        ...workspace,
        schedules: status !== 403 && Boolean(this.#deps.reader.schedules),
        pending: ctx?.pending,
        title: m.error,
        body: `<section class="card error-page"><h1>${m.error} ${status}</h1><p>${escapeHtml(m[key])}</p></section>`,
      }),
      'text/html; charset=utf-8',
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse) {
    const jwt = request.headers['cf-access-jwt-assertion'];
    const { access, allowLocalWithoutAccess } = this.#options;
    if (
      !(allowLocalWithoutAccess && isLocal(request)) &&
      !(access && typeof jwt === 'string' && (await this.#verify(jwt, access)))
    ) {
      this.#error(request, response, 403, 'forbidden');
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      this.#error(request, response, 405, 'method');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const api = url.pathname.startsWith('/api/');
    const route = api ? url.pathname.slice(4) : url.pathname;
    const { reader } = this.#deps;
    const json = (data: unknown) =>
      respond(
        response,
        200,
        JSON.stringify(data),
        'application/json; charset=utf-8',
      );
    if (api && (route === '/' || route === '/chats'))
      return json(reader.chats());
    const workspace = reader.workspace();
    const now = this.#deps.now?.() ?? Date.now();
    const m = i18n(workspace.locale);
    const overview =
      !api && (route === '/' || route === '/chats')
        ? reader.overview(now)
        : undefined;
    const ctx: ViewContext = {
      ...workspace,
      now,
      pending: api
        ? 0
        : (overview?.totals.pendingApprovals ?? reader.pendingApprovals(now)),
      schedules: Boolean(reader.schedules),
    };
    const show = <T>(
      title: string,
      active: Section,
      data: T,
      view: (data: T, ctx: ViewContext) => string,
    ) => {
      if (api) return json(data);
      respond(
        response,
        200,
        page({ ...ctx, title, active, body: view(data, ctx) }),
        'text/html; charset=utf-8',
      );
    };
    if ((route === '/' || route === '/chats') && overview)
      return show(
        route === '/' ? m.overview : m.chats,
        route === '/' ? 'overview' : 'chats',
        overview,
        (data, ctx) => overviewView(data, ctx, route === '/chats'),
      );
    if (route === '/approvals')
      return show(
        m.approvals,
        'approvals',
        reader.approvals(api ? undefined : 50),
        approvalsView,
      );
    if (route === '/schedules' && reader.schedules)
      return show(m.schedules, 'schedules', reader.schedules(), schedulesView);
    if (route === '/chat') {
      const adapterId = url.searchParams.get('adapter');
      const chatId = url.searchParams.get('id');
      const cursor = url.searchParams.get('before');
      const before = cursor === null ? undefined : Number(cursor);
      if (
        !adapterId ||
        !chatId ||
        (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      ) {
        this.#error(request, response, 400, 'invalidChat', ctx);
        return;
      }
      const data = reader.chat({ adapterId, chatId }, before);
      if (data)
        return show(
          `${m.chat} · ${chatTitle(data.chat)}`,
          'chats',
          data,
          chatView,
        );
    }
    if (route === '/trace') {
      const taskId = url.searchParams.get('task');
      const data = taskId ? reader.trace(taskId) : undefined;
      if (data) return show(m.traceTitle, 'chats', data, traceView);
    }
    this.#error(request, response, 404, 'notFound', ctx);
  }
}
