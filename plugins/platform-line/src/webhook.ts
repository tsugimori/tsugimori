import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export const defaultListen = '127.0.0.1:8789';
export const listenPattern = '^(127\\.0\\.0\\.1|\\[::1\\]):([0-9]{1,5})$';
const bodyLimit = 1024 * 1024;
type Route = (request: IncomingMessage, response: ServerResponse) => void;

interface Listener {
  closing?: Promise<void>;
  ready: Promise<void>;
  routes: Map<string, Route>;
  server: Server;
}

const listeners = new Map<string, Listener>();

export function listenAddress(value: unknown = defaultListen) {
  const match =
    typeof value === 'string' && new RegExp(listenPattern).exec(value);
  if (!match || Number(match[2]) > 65535)
    throw new Error(
      'LINE listen must use 127.0.0.1 or [::1] and a valid port.',
    );
  return {
    host: match[1] === '[::1]' ? '::1' : '127.0.0.1',
    port: Number(match[2]),
  };
}

function addressKey({ host, port }: ReturnType<typeof listenAddress>) {
  return `${host}:${port}`;
}

export function hasLineListener(address: ReturnType<typeof listenAddress>) {
  return listeners.get(addressKey(address))?.server.listening === true;
}

export async function listen(
  server: Server,
  address: ReturnType<typeof listenAddress>,
) {
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  try {
    server.listen(address, listening.resolve);
    await listening.promise;
  } finally {
    server.off('error', listening.reject);
  }
}

export async function closeServer(server: Server) {
  if (!server.listening) return;
  const closed = Promise.withResolvers<void>();
  server.close((error) => (error ? closed.reject(error) : closed.resolve()));
  server.closeAllConnections();
  await closed.promise;
}

export function webhookPath(id: string) {
  return `/line/${encodeURIComponent(id)}/`;
}

export async function registerWebhook(
  address: ReturnType<typeof listenAddress>,
  id: string,
  route: Route,
  signal: AbortSignal,
) {
  const key = addressKey(address);
  let listener = listeners.get(key);
  while (listener?.closing) {
    signal.throwIfAborted();
    await listener.closing;
    listener = listeners.get(key);
  }
  signal.throwIfAborted();
  if (!listener) {
    const routes = new Map<string, Route>();
    const server = createServer((request, response) => {
      const pathname = request.url?.split('?', 1)[0];
      const match =
        pathname && /^\/line\/([^/]+)(?:\/(?:webhook)?)?$/.exec(pathname);
      const handler =
        request.method === 'POST' && match && routes.get(`/line/${match[1]}/`);
      if (handler) handler(request, response);
      else response.writeHead(404).end();
    });
    const ready = listen(server, address).catch((error: unknown) => {
      listeners.delete(key);
      throw error;
    });
    listener = { ready, routes, server };
    listeners.set(key, listener);
  }
  const path = webhookPath(id);
  const { ready, routes, server } = listener;
  if (routes.has(path))
    throw new Error('LINE webhook path is already registered');
  routes.set(path, route);
  await ready;
  return async () => {
    routes.delete(path);
    if (routes.size === 0) {
      listener.closing = closeServer(server).finally(() =>
        listeners.delete(key),
      );
      await listener.closing;
    }
  };
}

export async function webhook(
  request: IncomingMessage,
  response: ServerResponse,
  secret: string,
  receive: (events: unknown[]) => void,
) {
  if (Number(request.headers['content-length']) > bodyLimit) {
    response.writeHead(413, { Connection: 'close' }).end();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > bodyLimit) {
      response.writeHead(413, { Connection: 'close' }).end();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, size);
  const signature = request.headers['x-line-signature'];
  const expected = createHmac('sha256', secret).update(body).digest('base64');
  if (
    typeof signature !== 'string' ||
    Buffer.byteLength(signature) !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    response.writeHead(401).end();
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    response.writeHead(400).end();
    return;
  }
  const events = (payload as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) {
    response.writeHead(400).end();
    return;
  }
  response.writeHead(200).end(() => receive(events));
}
