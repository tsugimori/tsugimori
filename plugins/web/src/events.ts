import type { AdminEvent } from '@tsugimori/plugin-sdk';
import type { ServerResponse } from 'node:http';

const capacity = 500;
const maxQueuedBytes = 4 * 1024 * 1024;
const connections = new Set<ServerResponse>();
// A reconnect after a process restart falls outside the new replay window.
let sequence = Date.now() * 1000;

export class AdminEvents {
  readonly #streams = new Set<ServerResponse>();
  readonly #history: { frame: string; id: number }[] = [];
  readonly #pingMs: number;
  #discarded = sequence;
  #latest = sequence;
  #ping?: NodeJS.Timeout;

  constructor(pingMs = 20_000) {
    this.#pingMs = pingMs;
  }

  publish(event: AdminEvent) {
    const id = ++sequence;
    const { kind, ...data } = event;
    const name = kind === 'reload' ? 'reset' : kind;
    const frame = `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    this.#latest = id;
    this.#history.push({ id, frame });
    if (this.#history.length > capacity)
      this.#discarded = this.#history.shift()!.id;
    for (const stream of this.#streams) this.#write(stream, frame);
    if (kind === 'reload') this.close();
  }

  open(response: ServerResponse, last: string | undefined) {
    if (connections.size >= 8) {
      const oldest = connections.values().next().value!;
      connections.delete(oldest);
      oldest.end();
    }
    this.#streams.add(response);
    connections.add(response);
    response.once('close', () => {
      connections.delete(response);
      this.#streams.delete(response);
      if (this.#streams.size === 0) this.#stopPing();
    });
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const id =
      last !== undefined && /^\d+$/.test(last) ? Number(last) : undefined;
    if (last === undefined) {
      this.#write(response, `id: ${this.#latest}\nevent: ready\ndata: {}\n\n`);
    } else if (id === undefined || id < this.#discarded || id > this.#latest) {
      this.#write(response, `id: ${this.#latest}\nevent: reset\ndata: {}\n\n`);
    } else {
      for (const item of this.#history) {
        if (item.id > id) this.#write(response, item.frame);
      }
    }
    this.#ping ??= setInterval(() => {
      for (const stream of this.#streams) this.#write(stream, ': ping\n\n');
    }, this.#pingMs);
  }

  close() {
    this.#stopPing();
    for (const stream of this.#streams) {
      connections.delete(stream);
      stream.end();
    }
    this.#streams.clear();
  }

  #stopPing() {
    clearInterval(this.#ping);
    this.#ping = undefined;
  }

  #write(stream: ServerResponse, data: string) {
    if (stream.writableEnded) return;
    if (stream.writableLength > maxQueuedBytes) stream.destroy();
    else stream.write(data);
  }
}
