import type { LocalEndpoint } from '@tsugimori/plugin-sdk';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server,
  ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { request } from 'node:http';

const excluded = new Set([
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const sessionCookie = '__Host-tsugimori-preview';

function headers(source: IncomingHttpHeaders, fromApp: boolean) {
  const nominations =
    source.connection
      ?.toLowerCase()
      .split(',')
      .map((part) => part.trim()) ?? [];
  const result: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      excluded.has(key) ||
      nominations.includes(key) ||
      key.startsWith('cf-') ||
      key.startsWith('x-forwarded-') ||
      key === 'forwarded'
    )
      continue;
    result[key] = value;
  }
  if (fromApp) {
    if (source['set-cookie']) {
      result['set-cookie'] = source['set-cookie']
        .filter((value) => !reservedCookie(value))
        .map((value) => value.replace(/;\s*Domain\s*=[^;]*/gi, ''));
    }
    result['referrer-policy'] = 'no-referrer';
  } else {
    const cookies = source.cookie
      ?.split(';')
      .map((value) => value.trim())
      .filter((value) => !reservedCookie(value));
    result.cookie = cookies?.length ? cookies.join('; ') : undefined;
    delete result.authorization;
  }
  for (const key of Object.keys(result))
    if (result[key] === undefined) delete result[key];
  return result;
}

function reservedCookie(value: string) {
  const name = value.split('=', 1)[0]?.toLowerCase();
  return name === sessionCookie.toLowerCase() || !!name?.startsWith('cf_');
}

export function safeEndpoint(endpoint: LocalEndpoint) {
  if (
    !['127.0.0.1', '::1'].includes(endpoint.host) ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  )
    throw new Error('Preview requires a loopback execution endpoint');
}

export function send(response: ServerResponse, status: number, text: string) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(text);
}

export function originPath(request: IncomingMessage) {
  const path = request.url ?? '/';
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\'))
    return;
  return path;
}

export function proxy(
  incoming: IncomingMessage,
  response: ServerResponse,
  endpoint: LocalEndpoint,
  path: string,
  signal: AbortSignal,
) {
  const upstream = request(
    {
      hostname: endpoint.host,
      port: endpoint.port,
      method: incoming.method,
      path,
      headers: headers(incoming.headers, false),
      signal,
    },
    (app) => {
      response.writeHead(app.statusCode ?? 502, headers(app.headers, true));
      app.on('error', () => response.destroy());
      app.pipe(response);
    },
  );
  upstream.setTimeout(60_000, () => upstream.destroy());
  upstream.on('error', () => {
    if (!response.headersSent)
      send(response, 502, 'Preview service is unavailable');
    else response.destroy();
  });
  incoming.on('error', () => upstream.destroy());
  response.once('close', () => upstream.destroy());
  incoming.pipe(upstream);
}

export async function listen(server: Server, port: number) {
  const ready = Promise.withResolvers<void>();
  server.once('error', ready.reject);
  try {
    server.listen(port, '127.0.0.1', ready.resolve);
    await ready.promise;
    return (server.address() as AddressInfo).port;
  } finally {
    server.off('error', ready.reject);
  }
}

export async function close(server: Server) {
  if (!server.listening) return;
  const done = Promise.withResolvers<void>();
  server.close((error) => (error ? done.reject(error) : done.resolve()));
  server.closeAllConnections();
  await done.promise;
}
