import type { IncomingMessage, ServerResponse } from 'node:http';

import { createHmac, timingSafeEqual } from 'node:crypto';

const bodyLimit = 1024 * 1024;

export function webhookPath(id: string) {
  return `/line/${encodeURIComponent(id)}/`;
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
