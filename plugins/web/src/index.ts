import type {
  AccessIdentity,
  AdminReader,
  VerifyAccess,
} from '@tsugimori/plugin-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServer } from 'node:http';

import { createAccessVerifier } from './access.ts';
import {
  approvalsView,
  chatsView,
  conversationView,
  page,
  traceView,
} from './views.ts';

export { createAccessVerifier };

interface WebDependencies {
  logError?(): void;
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
          respond(response, 500, 'Internal server error');
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

  async #handle(request: IncomingMessage, response: ServerResponse) {
    const jwt = request.headers['cf-access-jwt-assertion'];
    const { access, allowLocalWithoutAccess } = this.#options;
    if (
      !(allowLocalWithoutAccess && isLocal(request)) &&
      !(access && typeof jwt === 'string' && (await this.#verify(jwt, access)))
    ) {
      respond(response, 403, 'Access denied');
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      respond(response, 405, 'Method not allowed');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const api = url.pathname.startsWith('/api/');
    const route = api ? url.pathname.slice(4) : url.pathname;
    const { reader } = this.#deps;
    const show = <T>(title: string, data: T, view: (data: T) => string) => {
      if (api)
        respond(
          response,
          200,
          JSON.stringify(data),
          'application/json; charset=utf-8',
        );
      else
        respond(
          response,
          200,
          page(title, view(data)),
          'text/html; charset=utf-8',
        );
    };
    if (route === '/' || (api && route === '/chats')) {
      show('Chats', reader.chats(), chatsView);
      return;
    }
    if (route === '/approvals') {
      show('Approvals and grants', reader.approvals(), approvalsView);
      return;
    }
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
        respond(response, 400, 'Invalid conversation or message cursor');
        return;
      }
      const data = reader.chat({ adapterId, chatId }, before);
      if (data) {
        show(data.chat.title || data.chat.chatId, data, conversationView);
        return;
      }
    }
    if (route === '/trace') {
      const taskId = url.searchParams.get('task');
      const data = taskId ? reader.trace(taskId) : undefined;
      if (data) {
        show('Task trace', data, traceView);
        return;
      }
    }
    respond(response, 404, 'Not found');
  }
}
