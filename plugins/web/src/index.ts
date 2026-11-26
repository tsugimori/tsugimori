import type {
  AccessIdentity,
  AdminReader,
  VerifyAccess,
} from '@tsugimori/plugin-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { createAccessVerifier } from './access.ts';
import { Assets } from './assets.ts';
import { addHistoryLink, chatHistory } from './chat-history.ts';
import { AdminEvents } from './events.ts';
import { taskFilter, taskPage } from './tasks.ts';

export { createAccessVerifier };

interface WebDependencies {
  logError?(): void;
  now?(): number;
  pingMs?: number;
  reader: AdminReader;
  uiDirectory?: string;
  verify?: VerifyAccess;
}

interface WebOptions {
  access?: AccessIdentity;
  allowLocalWithoutAccess?: boolean;
  listen?: string;
}

const html = 'text/html; charset=utf-8';
const jsonType = 'application/json; charset=utf-8';
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const uiDirectory = fileURLToPath(
  new URL(
    import.meta.url.endsWith('/src/index.ts') ? '../dist/ui/' : './ui/',
    import.meta.url,
  ),
);

function respond(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  type = 'text/plain; charset=utf-8',
  cache = 'no-store',
) {
  response.writeHead(status, {
    'Cache-Control': cache,
    'Content-Type': type,
  });
  response.end(body);
}

function apiError(response: ServerResponse, status: number, error: string) {
  respond(response, status, JSON.stringify({ error }), jsonType);
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

function positiveInt(value: string | null) {
  const number = Number(value);
  return /^\d+$/.test(value ?? '') && Number.isSafeInteger(number) && number > 0
    ? number
    : undefined;
}

export class AdminServer {
  readonly #deps: WebDependencies;
  readonly #options: WebOptions;
  readonly #verify: VerifyAccess;
  readonly #assets: Assets;
  readonly #events: AdminEvents;
  readonly #server;
  #unsubscribe?: () => void;
  #stopping = false;

  constructor(deps: WebDependencies, options: WebOptions = {}) {
    this.#deps = deps;
    this.#options = options;
    this.#verify = deps.verify ?? createAccessVerifier();
    this.#assets = new Assets(deps.uiDirectory ?? uiDirectory);
    this.#events = new AdminEvents(deps.pingMs);
    this.#server = createServer((request, response) => {
      response.setHeader('Content-Security-Policy', csp);
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      void this.#handle(request, response).catch(() => {
        this.#deps.logError?.();
        if (response.headersSent) response.destroy();
        else if (request.url?.startsWith('/api'))
          apiError(response, 500, 'internal');
        else respond(response, 500, 'Internal server error.');
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
    this.#stopping = false;
    this.#unsubscribe = this.#deps.reader.subscribe((event) =>
      this.#events.publish(event),
    );
    return this.#server.address() as AddressInfo;
  }

  async stop() {
    if (!this.#server.listening) return;
    this.#stopping = true;
    this.#unsubscribe?.();
    this.#events.close();
    const closed = Promise.withResolvers<void>();
    this.#server.close((error) =>
      error ? closed.reject(error) : closed.resolve(),
    );
    this.#server.closeAllConnections();
    await closed.promise;
  }

  async #handle(request: IncomingMessage, response: ServerResponse) {
    const jwt = request.headers['cf-access-jwt-assertion'];
    const { access, allowLocalWithoutAccess } = this.#options;
    const raw = request.url ?? '/';
    const path = raw.split('?', 1)[0]!;
    const api = path === '/api' || path.startsWith('/api/');
    if (
      !(allowLocalWithoutAccess && isLocal(request)) &&
      !(access && typeof jwt === 'string' && (await this.#verify(jwt, access)))
    ) {
      if (api) apiError(response, 403, 'forbidden');
      else respond(response, 403, 'Access denied.');
      return;
    }
    if (this.#stopping || response.destroyed) {
      response.destroy();
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      if (api) apiError(response, 405, 'method');
      else respond(response, 405, 'Only GET is supported.');
      return;
    }
    // Inspect the path before URL normalizes dot segments and backslashes.
    if (
      /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|%(?:2f|5c)|\\/i.test(path) &&
      !/^\/(?:chat|trace|task)\//.test(path)
    ) {
      respond(response, 404, 'Not found.');
      return;
    }
    const url = new URL(raw, 'http://127.0.0.1');
    if (api) return await this.#api(url, request, response);
    if (
      /^\/(?:_nuxt|assets)(?:\/|$)|\.[a-z0-9]+$/i.test(path) &&
      !/^\/(?:chat|trace|task)\//.test(path)
    ) {
      const asset = await this.#assets.get(path.slice(1));
      if (!asset) return respond(response, 404, 'Not found.');
      return respond(response, 200, asset.body, asset.type, asset.cache);
    }
    const query = url.searchParams;
    const adapter = query.get('adapter');
    const id = query.get('id');
    const topic = query.get('topic');
    const task = query.get('task');
    let redirect: string | undefined;
    if (path === '/chat' && adapter && id) {
      redirect = [
        '/chat',
        encodeURIComponent(adapter),
        encodeURIComponent(id),
        ...(topic ? [encodeURIComponent(topic)] : []),
      ].join('/');
      const before = positiveInt(query.get('before'));
      if (before !== undefined) redirect += `?before=${before}`;
    }
    if ((path === '/trace' || path === '/task') && task)
      redirect = '/task/' + encodeURIComponent(task);
    if (path.startsWith('/trace/')) {
      redirect = '/task/' + path.slice('/trace/'.length) + url.search;
    }
    if (path === '/agents') redirect = '/#agents';
    if (path === '/approvals') redirect = '/ops';
    if (path === '/schedules') redirect = '/ops';
    if (path === '/chats') redirect = '/chat' + url.search;
    if (redirect) {
      response.setHeader('Location', redirect);
      return respond(response, 302, '');
    }
    const page = await this.#assets.page(path);
    const index = page?.body;
    if (index && path.startsWith('/chat/')) {
      const cursor = query.get('before');
      const before = positiveInt(cursor);
      const source = index.toString('utf8');
      if (query.get('view') === 'history') {
        const [adapterId, chatId] = path
          .split('/')
          .slice(2, 4)
          .map((part) => {
            try {
              return decodeURIComponent(part);
            } catch {
              return '';
            }
          });
        if (!adapterId || !chatId || (cursor !== null && before === undefined))
          return respond(response, 400, 'Invalid chat or message cursor.');
        const { reader } = this.#deps;
        const data = reader.chat({ adapterId, chatId }, before);
        return data
          ? respond(
              response,
              200,
              chatHistory(source, path, data, reader.workspace()),
              html,
            )
          : respond(response, 404, 'Chat not found.');
      }
      return respond(response, 200, addHistoryLink(source, path, before), html);
    }
    return index
      ? respond(response, 200, index, html)
      : respond(
          response,
          503,
          '<!doctype html><html lang="en"><title>Console unavailable</title><p>The admin UI is not built.</p></html>',
          html,
        );
  }

  async #api(url: URL, request: IncomingMessage, response: ServerResponse) {
    const { reader } = this.#deps;
    const query = url.searchParams;
    const now = this.#deps.now?.() ?? Date.now();
    const task = query.get('task');
    const json = (data: unknown) =>
      respond(response, 200, JSON.stringify(data), jsonType);
    switch (url.pathname) {
      case '/api/events':
        return this.#events.open(
          response,
          request.headers['last-event-id'] as string | undefined,
        );
      case '/api/workspace':
        return json({
          ...reader.workspace(),
          schedules: Boolean(reader.schedules),
          pendingApprovals: reader.pendingApprovals(now),
        });
      case '/api/':
      case '/api/chats':
        return json(reader.chats());
      case '/api/overview':
        return json(reader.overview(now, query.get('agent') ?? undefined));
      case '/api/agents':
        return json(reader.agents(now));
      case '/api/approvals':
        return json(
          reader.approvals(query.get('recent') === '50' ? 50 : undefined),
        );
      case '/api/schedules':
        if (reader.schedules) return json(reader.schedules());
        break;
      case '/api/chat': {
        const adapterId = query.get('adapter');
        const chatId = query.get('id');
        const cursor = query.get('before');
        const before = positiveInt(cursor);
        if (!adapterId || !chatId || (cursor !== null && !before))
          return apiError(response, 400, 'invalidChat');
        const data = reader.chat({ adapterId, chatId }, before);
        if (data) return json(data);
        break;
      }
      case '/api/tasks': {
        const filter = taskFilter(query);
        if (!filter) return apiError(response, 400, 'invalidTaskFilter');
        return json(taskPage(reader.tasks(filter), filter.limit));
      }
      case '/api/task': {
        const id = query.get('id');
        const data = id ? await reader.task(id) : undefined;
        if (data) return json(data);
        break;
      }
      case '/api/message-raw': {
        const adapterId = query.get('adapter');
        const chatId = query.get('chat');
        const seq = positiveInt(query.get('seq'));
        if (!adapterId || !chatId || !seq)
          return apiError(response, 400, 'invalidChat');
        const data = reader.messageRaw({ adapterId, chatId }, seq);
        if (data !== undefined) return json(data);
        break;
      }
      case '/api/trace': {
        const trace = task ? reader.trace(task) : undefined;
        if (trace) return json(trace);
        break;
      }
      case '/api/tool-call': {
        const seq = positiveInt(query.get('seq'));
        const call = task && seq ? reader.toolCall(task, seq) : undefined;
        if (call) return json(call);
        break;
      }
    }
    return apiError(response, 404, 'notFound');
  }
}
