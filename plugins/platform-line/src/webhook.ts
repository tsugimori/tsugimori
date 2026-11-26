import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { createHmac, timingSafeEqual } from 'node:crypto';

export const defaultListen = '127.0.0.1:8788';
export const listenPattern = '^(127\\.0\\.0\\.1|\\[::1\\]):([0-9]{1,5})$';
const bodyLimit = 1024 * 1024;

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
  return `/line/${encodeURIComponent(id)}/webhook`;
}

export async function webhook(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  secret: string,
  receive: (events: unknown[]) => void,
) {
  if (request.method !== 'POST' || request.url !== path) {
    response.writeHead(404).end();
    return;
  }
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
