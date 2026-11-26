import type { Gateway, RemovalPlan, RemovalTarget } from '@tsugimori/core';
import type { Server, Socket } from 'node:net';

import {
  formatRemovalPlan,
  removalMessages,
  SetupError,
} from '@tsugimori/core';
import {
  lstat,
  mkdir,
  open as openFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { terminalIO } from './setup.ts';

type WebhookInfo = ReturnType<Gateway['webhookInfo']>;

interface Controller {
  execute(plan: RemovalPlan): Promise<string>;
  plan(target: RemovalTarget): Promise<RemovalPlan>;
  webhookInfo?(platformId?: string): Promise<WebhookInfo>;
}

type Response =
  | { locale: RemovalPlan['locale']; plan: string }
  | { error: string }
  | { result: string }
  | { webhook: WebhookInfo };

type SocketClaim =
  | { close?: never; socket: Socket }
  | { close(): Promise<void>; socket?: never };

function errorCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code;
}

function open(path: string) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('error', reject);
    socket.once('connect', () => resolve(socket));
  });
}

function listen(server: Server, path: string) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function endpoint(workspace: string, create = true) {
  const root = await realpath(workspace);
  const data = join(root, 'data');
  if (create) await mkdir(data, { recursive: true, mode: 0o700 });
  if ((await realpath(data)) !== data)
    throw new SetupError(
      'The workspace data directory must not be a symbolic link.',
    );
  const directory = join(data, '.remove');
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new SetupError(
      'The workspace removal socket directory must belong to the current user and have mode 0700.',
    );
  const path = join(directory, 'gateway.sock');
  // A pathname UNIX socket has a short, platform-specific limit. Reject it before listen can truncate it.
  if (Buffer.byteLength(path) < 104) return { path };
  if (process.platform !== 'linux')
    throw new SetupError(
      'The workspace path is too long for its local removal socket.',
    );
  const directoryHandle = await openFile(directory, 'r');
  return {
    directoryHandle,
    path: `/proc/self/fd/${directoryHandle.fd}/gateway.sock`,
  };
}

function removeTarget(target: unknown): RemovalTarget {
  if (
    !target ||
    typeof target !== 'object' ||
    !('category' in target) ||
    (target.category !== 'agent' && target.category !== 'platform') ||
    !('id' in target) ||
    typeof target.id !== 'string' ||
    target.id.length > 512
  )
    throw new SetupError('Invalid removal target.');
  return { category: target.category, id: target.id };
}

async function serve(socket: Socket, controller: Controller) {
  const input = createInterface({ input: socket, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  socket.setTimeout(10 * 60_000, () => socket.destroy());
  let response: Response;
  try {
    const request = await lines.next();
    if (request.done) return;
    const payload: unknown = JSON.parse(request.value);
    if (
      payload &&
      typeof payload === 'object' &&
      'action' in payload &&
      payload.action === 'webhook-status' &&
      controller.webhookInfo
    ) {
      const id =
        'platformId' in payload && typeof payload.platformId === 'string'
          ? payload.platformId
          : undefined;
      socket.end(
        JSON.stringify({ webhook: await controller.webhookInfo(id) }) + '\n',
      );
      return;
    }
    const plan = await controller.plan(removeTarget(payload));
    const preview: Response = {
      plan: formatRemovalPlan(plan),
      locale: plan.locale,
    };
    socket.write(JSON.stringify(preview) + '\n');
    const answer = await lines.next();
    if (answer.done) return;
    socket.setTimeout(0);
    response = {
      result:
        answer.value === 'yes'
          ? await controller.execute(plan)
          : removalMessages(plan.locale).cancelled,
    };
  } catch (error) {
    response = {
      error:
        error instanceof SetupError
          ? error.message
          : 'Unable to complete removal through the running gateway.',
    };
  } finally {
    input.close();
  }
  socket.end(JSON.stringify(response) + '\n');
}

// The listening socket also serializes gateway startup with standalone removals.
async function claimSocket(
  path: string,
  controller?: Controller,
): Promise<SocketClaim> {
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    socket.on('error', () => socket.destroy());
    if (!controller) {
      socket.end(
        JSON.stringify({ error: 'A standalone removal is in progress.' }) +
          '\n',
      );
      return;
    }
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
    void serve(socket, controller).catch(() => socket.destroy());
  });
  try {
    await listen(server, path);
  } catch (error) {
    if (!errorCode(error, 'EADDRINUSE')) throw error;
    const stale = await lstat(path).catch((error: unknown) => {
      if (!errorCode(error, 'ENOENT')) throw error;
    });
    if (!stale) return claimSocket(path, controller);
    if (!stale.isSocket())
      throw new SetupError('The workspace removal socket path is occupied.');
    try {
      return { socket: await open(path) };
    } catch (connectError) {
      if (
        !errorCode(connectError, 'ECONNREFUSED') &&
        !errorCode(connectError, 'ENOENT')
      )
        throw connectError;
    }
    const current = await lstat(path).catch((error: unknown) => {
      if (!errorCode(error, 'ENOENT')) throw error;
    });
    if (current?.ino === stale.ino && current.dev === stale.dev)
      await unlink(path).catch((error: unknown) => {
        if (!errorCode(error, 'ENOENT')) throw error;
      });
    return claimSocket(path, controller);
  }
  return {
    close: async () => {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function claim(
  workspace: string,
  controller?: Controller,
): Promise<SocketClaim> {
  const { directoryHandle, path } = await endpoint(workspace);
  try {
    const claimed = await claimSocket(path, controller);
    if (claimed.socket) {
      await directoryHandle?.close();
      return claimed;
    }
    return {
      close: async () => {
        try {
          await claimed.close();
        } finally {
          await directoryHandle?.close();
        }
      },
    };
  } catch (error) {
    await directoryHandle?.close();
    throw error;
  }
}

export async function listenForRemoval(
  workspace: string,
  controller: Controller,
) {
  const claimed = await claim(workspace, controller);
  if (claimed.socket) {
    claimed.socket.destroy();
    throw new SetupError(
      'A gateway or removal is already active in this workspace.',
    );
  }
  return claimed.close;
}

export async function readGatewayWebhook(
  workspace: string,
  platformId?: string,
) {
  let socket: Socket;
  try {
    const { directoryHandle, path } = await endpoint(workspace, false);
    try {
      socket = await open(path);
    } finally {
      await directoryHandle?.close();
    }
  } catch (error) {
    if (errorCode(error, 'ENOENT') || errorCode(error, 'ECONNREFUSED')) return;
    throw error;
  }
  const input = createInterface({ input: socket, crlfDelay: Infinity });
  socket.setTimeout(2_000, () => socket.destroy());
  try {
    socket.write(
      JSON.stringify({ action: 'webhook-status', platformId }) + '\n',
    );
    const line = await input[Symbol.asyncIterator]().next();
    if (!line.done) {
      const response: Response = JSON.parse(line.value);
      if ('webhook' in response) return response.webhook;
    }
    throw new SetupError(
      'Could not read webhook status from the running gateway.',
    );
  } finally {
    input.close();
    socket.destroy();
  }
}

async function confirm(locale: RemovalPlan['locale'], yes: boolean) {
  if (yes) return true;
  const terminal = terminalIO();
  try {
    const text =
      locale === 'zh-TW'
        ? '輸入 yes 以刪除，其他輸入會取消。'
        : 'Type yes to delete. Any other answer cancels.';
    return (await terminal.prompt({ text })).trim() === 'yes';
  } catch (error) {
    if (!terminal.signal.aborted && !terminal.cancelSignal.aborted) throw error;
    return false;
  } finally {
    terminal.close();
  }
}

async function remoteRemove(
  socket: Socket,
  target: RemovalTarget,
  yes: boolean,
) {
  const input = createInterface({ input: socket, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  const next = async (): Promise<Response> => {
    const { value, done } = await lines.next();
    if (done)
      throw new SetupError('The gateway closed the removal connection.');
    return JSON.parse(value);
  };
  try {
    socket.write(JSON.stringify(target) + '\n');
    const preview = await next();
    if ('error' in preview) throw new SetupError(preview.error);
    if (!('plan' in preview))
      throw new SetupError('The gateway did not return a removal plan.');
    console.log(preview.plan);
    socket.write(
      ((await confirm(preview.locale, yes)) ? 'yes' : 'cancel') + '\n',
    );
    const outcome = await next();
    if ('error' in outcome) throw new SetupError(outcome.error);
    if (!('result' in outcome))
      throw new SetupError('The gateway did not return a removal result.');
    console.log(outcome.result);
  } finally {
    input.close();
    socket.destroy();
  }
}

export async function runRemoval(
  workspace: string,
  target: RemovalTarget,
  yes: boolean,
  offline: (
    confirmPlan: (plan: RemovalPlan) => Promise<boolean>,
  ) => Promise<void>,
) {
  const claimed = await claim(workspace);
  if (claimed.socket) return remoteRemove(claimed.socket, target, yes);
  try {
    await offline(async (plan) => {
      console.log(formatRemovalPlan(plan));
      return confirm(plan.locale, yes);
    });
  } finally {
    await claimed.close();
  }
}
