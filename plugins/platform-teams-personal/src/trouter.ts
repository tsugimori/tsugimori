import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';

import type { ChatToken } from './auth.ts';
import type { Data, Wait } from './wire.ts';

import { LoginRequired } from './auth.ts';
import { HttpError, json, object, request, string } from './wire.ts';

export type Socket = Pick<
  WebSocket,
  'addEventListener' | 'close' | 'readyState' | 'removeEventListener' | 'send'
>;

interface Dependencies {
  authorize(): Promise<ChatToken>;
  catchUp(signal: AbortSignal, loss: boolean): Promise<void>;
  fetch: typeof globalThis.fetch;
  invalidate(token: string): void;
  receive(body: Data, signal: AbortSignal): Promise<void>;
  registered(signal: AbortSignal): void;
  socket(url: URL): Socket;
  warn(event: string): void;
}

const entryHost = 'go.trouter.teams.microsoft.com';
const registrar = 'https://teams.microsoft.com/registrar/prod/v2/registrations';
const maxFrame = 1_048_576;

function trustedHost(host: string) {
  return (
    host.endsWith('.trouter.teams.microsoft.com') ||
    host.endsWith('.trouter.skype.com')
  );
}

function socketUrl(host: string, endpoint: string) {
  const url = new URL(`wss://${host}/v4/c`);
  url.search = new URLSearchParams({
    tc: JSON.stringify({
      cv: '2026.11.16.1',
      ua: 'TeamsCDL',
      hr: '',
      v: '1415/1.0.0.0',
    }),
    timeout: '70',
    epid: endpoint,
    con_num: `${Date.now()}_1`,
  }).toString();
  return url;
}

function redirectHost(input: string) {
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (
    !['https:', 'wss:'].includes(url.protocol) ||
    !trustedHost(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('Teams supplied an invalid Trouter redirect');
  return url.hostname;
}

function route(input: Data) {
  const raw = string(input.surl);
  const ttl = Number(input.ttl);
  if (
    !raw ||
    !URL.canParse(raw) ||
    !Number.isFinite(ttl) ||
    ttl < 60 ||
    ttl > 604_800
  )
    throw new Error('Teams supplied an invalid Trouter route');
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    !trustedHost(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '3443') ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith('/v4/f/')
  )
    throw new Error('Teams supplied an invalid Trouter route');
  return { path: url.href, ttl };
}

function headers(token: ChatToken) {
  return { 'X-Skypetoken': token.token, 'X-MS-Migration': 'True' };
}

function socketEvent(name: string, data: unknown) {
  return `5:::${JSON.stringify({ name, args: [data] })}`;
}

function unpack(body: string) {
  return gunzipSync(Buffer.from(body, 'base64'), {
    maxOutputLength: maxFrame,
  }).toString('utf8');
}

function messagingEnvelope(data: string) {
  const envelope = json(data);
  const id = envelope.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0)
    throw new Error(
      'Teams messaging request did not have an acknowledgment ID',
    );
  const url = string(envelope.url);
  if (
    !url ||
    !/\/messaging\/?$/iu.test(new URL(url, 'https://teams.live.com').pathname)
  )
    return { id };
  const body = string(envelope.body);
  if (!body) throw new Error('Teams messaging request did not have a body');
  const headers = object(envelope.headers);
  const encoding = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === 'x-microsoft-skype-content-encoding',
  )?.[1];
  let decoded = json(encoding === 'gzip' ? unpack(body) : body);
  if (typeof decoded.cp === 'string') decoded = json(unpack(decoded.cp));
  else if (typeof decoded.gp === 'string')
    decoded = json(Buffer.from(decoded.gp, 'base64').toString('utf8'));
  return { id, body: decoded };
}

async function connection(
  deps: Dependencies,
  endpoint: string,
  host: string,
  token: ChatToken,
  parent: AbortSignal,
  ready: (signal: AbortSignal) => Promise<void>,
  redirect: (host: string) => void,
) {
  parent.throwIfAborted();
  const socket = deps.socket(socketUrl(host, endpoint));
  const local = new AbortController();
  const signal = AbortSignal.any([parent, local.signal]);
  const closed = Promise.withResolvers<void>();
  const timers = new Set<NodeJS.Timeout>();
  let failure: unknown;
  let connected = false;
  let authenticating = false;
  let sequence = 0;
  let lastFrame = Date.now();
  let queued = 0;
  let lane = Promise.resolve();

  function finish(error?: unknown) {
    if (local.signal.aborted) return;
    failure = error;
    local.abort();
    for (const timer of timers) clearTimeout(timer);
    socket.close();
    closed.resolve();
  }

  function schedule(ms: number, action: () => void) {
    if (signal.aborted) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        if (!signal.aborted) action();
      } catch (error) {
        finish(error);
      }
    }, ms);
    timers.add(timer);
  }

  function send(frame: string) {
    signal.throwIfAborted();
    if (socket.readyState !== 1) throw new Error('Teams WebSocket is closed');
    socket.send(frame);
  }

  async function register(connectedRoute: ReturnType<typeof route>) {
    const auth = await deps.authorize();
    const ttl = Math.min(connectedRoute.ttl, 3600);
    const response = await request(
      deps.fetch,
      registrar,
      {
        method: 'POST',
        headers: { ...headers(auth), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          registrationId: endpoint,
          nodeId: '',
          clientDescription: {
            appId: 'TeamsCDLWebWorker',
            aesKey: '',
            languageId: 'en-US',
            platform: '1415',
            templateKey: 'TeamsCDLWebWorker_2.7',
            platformUIVersion: '1415/1.0.0.0',
            productContext: 'TFL',
          },
          transports: {
            TROUTER: [{ context: '', path: connectedRoute.path, ttl }],
          },
        }),
      },
      signal,
    );
    await response.body?.cancel();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        deps.invalidate(auth.token);
      throw new HttpError(response.status);
    }
    schedule((ttl - 30) * 1000, () => {
      void register(connectedRoute).catch(finish);
    });
  }

  async function handle(frame: string) {
    if (signal.aborted) return;
    if (Buffer.byteLength(frame) > maxFrame)
      throw new Error('Teams WebSocket frame is too large');
    const parts = /^([0-8]):(\d*)(\+)?:(?::([\s\S]*))?$/u.exec(frame);
    if (!parts) throw new Error('Teams sent an invalid Socket.IO frame');
    const [, type, id, wantsAck, data = ''] = parts;
    if (type === '1') {
      if (authenticating)
        throw new Error('Teams repeated the authentication handshake');
      authenticating = true;
      send(socketEvent('user.authenticate', { headers: headers(token) }));
    } else if (type === '5') {
      const { name, args } = json(data);
      const details = (Array.isArray(args) && object(args[0])) || {};
      switch (name) {
        case 'trouter.connected': {
          if (!authenticating || connected)
            throw new Error('Unexpected Teams connected event');
          const connectedRoute = route(details);
          schedule((connectedRoute.ttl - 10) * 1000, () => finish());
          await register(connectedRoute);
          signal.throwIfAborted();
          connected = true;
          await ready(signal);
          break;
        }
        case 'trouter.reconnect': {
          const target = string(details.url);
          if (details.target === 'host' && target)
            redirect(redirectHost(target));
          finish();
          return;
        }
        case 'trouter.message_loss':
          if (!connected)
            throw new Error('Teams reported message loss before registration');
          await deps.catchUp(signal, true);
          send(
            socketEvent('trouter.processed_message_loss', {
              droppedIndicators: details.droppedIndicators ?? [],
            }),
          );
          break;
      }
      if (wantsAck && id) send(`6:${id}::`);
    } else if (type === '3') {
      if (!connected)
        throw new Error('Teams message arrived before registration');
      const envelope = messagingEnvelope(data);
      if (envelope.body) await deps.receive(envelope.body, signal);
      send(`3:::${JSON.stringify({ id: envelope.id, status: 200, body: '' })}`);
      if (wantsAck && id) send(`6:${id}::`);
    } else if (type === '0' || type === '7') {
      if (type === '7') deps.invalidate(token.token);
      finish(new Error('Teams disconnected the WebSocket'));
    }
  }

  const onMessage = (event: Event) => {
    if (signal.aborted) return;
    const value: unknown = (event as MessageEvent).data;
    if (typeof value !== 'string')
      return finish(new Error('Teams sent a binary WebSocket frame'));
    lastFrame = Date.now();
    if (value === '2::') {
      try {
        send('2::');
      } catch (error) {
        finish(error);
      }
      return;
    }
    if (++queued > 100)
      return finish(new Error('Teams WebSocket queue is full'));
    lane = lane
      .then(() => handle(value))
      .catch(finish)
      .finally(() => {
        queued--;
      });
  };
  const onClose = () => finish(new Error('Teams WebSocket closed'));
  const onError = () => finish(new Error('Teams WebSocket failed'));
  const onAbort = () => finish();
  function heartbeat() {
    if (Date.now() - lastFrame >= 90_000)
      return finish(new Error('Teams WebSocket heartbeat timed out'));
    if (connected) send(`5:${++sequence}+::{"name":"ping","args":[]}`);
    schedule(30_000, heartbeat);
  }

  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  parent.addEventListener('abort', onAbort, { once: true });
  schedule(30_000, () => {
    if (!connected) finish(new Error('Teams WebSocket registration timed out'));
  });
  schedule(Math.max(1, token.expiresAt - Date.now() - 45_000), () => finish());
  schedule(30_000, heartbeat);
  if (parent.aborted) finish();
  await closed.promise;
  socket.removeEventListener('message', onMessage);
  socket.removeEventListener('close', onClose);
  socket.removeEventListener('error', onError);
  parent.removeEventListener('abort', onAbort);
  await lane;
  if (failure) throw failure;
}

export async function listen(
  deps: Dependencies,
  endpoint: string,
  signal: AbortSignal,
  wait: Wait = (ms, signal) => delay(ms, undefined, { signal }),
) {
  let host = entryHost;
  let established = false;
  let failures = 0;
  while (!signal.aborted) {
    let redirected = false;
    try {
      const token = await deps.authorize();
      await connection(
        deps,
        endpoint,
        host,
        token,
        signal,
        async (connectionSignal) => {
          failures = 0;
          deps.registered(connectionSignal);
          if (established) await deps.catchUp(connectionSignal, false);
          else established = true;
        },
        (target) => {
          host = target;
          redirected = true;
        },
      );
    } catch (error) {
      if (signal.aborted) return;
      if (!established || error instanceof LoginRequired) throw error;
      deps.warn('teams_personal.trouter_disconnected');
    }
    if (!established && (!redirected || failures >= 3) && !signal.aborted)
      throw new Error('Teams disconnected before registration');
    if (signal.aborted) return;
    try {
      await wait(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
