import type { AddressInfo, Socket } from 'node:net';

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function listening(
  server: ReturnType<typeof createServer>,
  address: { host: string; port: number } | string,
) {
  const done = Promise.withResolvers<void>();
  server.once('error', done.reject);
  if (typeof address === 'string') server.listen(address, done.resolve);
  else server.listen(address, done.resolve);
  try {
    await done.promise;
  } finally {
    server.off('error', done.reject);
  }
}

export async function createRelay() {
  const directory = await mkdtemp(join(tmpdir(), 'tsugimori-exec-'));
  const path = join(directory, 'relay.sock');
  const sockets = new Set<Socket>();
  const workers = new Set<Socket>();
  const clients = new Set<Socket>();

  function pair() {
    while (workers.size && clients.size) {
      const worker = workers.values().next().value!;
      const client = clients.values().next().value!;
      workers.delete(worker);
      clients.delete(client);
      worker.write('x');
      client.pipe(worker).pipe(client);
      client.once('close', () => worker.destroy());
      worker.once('close', () => client.destroy());
    }
  }

  function accept(pending: Set<Socket>) {
    return (socket: Socket) => {
      if (sockets.size >= 64) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      pending.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => {
        sockets.delete(socket);
        pending.delete(socket);
      });
      pair();
    };
  }

  const unix = createServer(accept(workers));
  const tcp = createServer(accept(clients));
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [unix, tcp].map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await listening(unix, path);
    await listening(tcp, { host: '127.0.0.1', port: 0 });
    return {
      path,
      endpoint: {
        host: '127.0.0.1',
        port: (tcp.address() as AddressInfo).port,
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
