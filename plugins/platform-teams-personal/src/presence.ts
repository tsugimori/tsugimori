import { randomUUID } from 'node:crypto';

import type { teamsPersonalSession } from './auth.ts';
import type { Wait } from './wire.ts';

import { LoginRequired } from './auth.ts';
import { HttpError, request, waitFor } from './wire.ts';

function retryAfter(value: string | null) {
  if (!value) return 0;
  const ms = /^\d+(?:\.\d+)?$/u.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(2 ** 31 - 1, Math.max(0, ms)) : 0;
}

export function teamsPersonalPresence(
  fetch: typeof globalThis.fetch,
  auth: ReturnType<typeof teamsPersonalSession>,
  warn: (event: string) => void,
  wait: Wait = waitFor,
) {
  const id = randomUUID();
  const base = 'https://teams.live.com/ups/global/v1/me/';
  const interval = 60_000;
  let connection: AbortSignal | undefined;
  let desired = false;
  let running: { controller: AbortController; done: Promise<void> } | undefined;
  let removal: Promise<void> | undefined;
  let offlineRequested = false;
  let endpointToken: string | undefined;

  async function call(
    method: string,
    route: string,
    token: string,
    signal: AbortSignal,
    body?: Record<string, unknown>,
  ) {
    const response = await request(
      fetch,
      base + route,
      {
        method,
        headers: {
          'X-Skypetoken': token,
          'X-MS-Client-Consumer-Type': 'teams4life',
          'x-ms-client-user-agent': 'Teams-V2-Web',
          'x-ms-endpoint-id': id,
          'Content-Type': 'application/json',
        },
        body: body && JSON.stringify(body),
      },
      signal,
    );
    await response.body?.cancel();
    if (response.ok || (method === 'DELETE' && response.status === 404)) return;
    if (response.status === 401) auth.invalidate(token);
    throw new HttpError(
      response.status,
      retryAfter(response.headers.get('retry-after')),
    );
  }

  async function maintain(signal: AbortSignal) {
    let published = false;
    let failures = 0;
    while (!signal.aborted) {
      let next = interval;
      try {
        const { token } = await auth.get();
        signal.throwIfAborted();
        // Creation may have succeeded even if the response was lost.
        endpointToken = token;
        if (published)
          await call('POST', 'reportmyactivity/', token, signal, {
            endpointId: id,
            isActive: true,
          });
        else
          await call('PUT', 'endpoints/', token, signal, {
            id,
            availability: 'Available',
            activity: 'Available',
            deviceType: 'Web',
            activityReporting: 'Direct',
          });
        published = true;
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        warn('teams_personal.presence_refresh_failed');
        if (
          error instanceof LoginRequired ||
          (error instanceof HttpError && [401, 403].includes(error.status))
        )
          return;
        if (published && error instanceof HttpError && error.status === 404) {
          published = false;
          next = error.retryAfterMs ?? 0;
        } else {
          next = Math.max(
            Math.min(300_000, interval * 2 ** Math.min(failures++, 3)),
            error instanceof HttpError ? (error.retryAfterMs ?? 0) : 0,
          );
        }
      }
      if (next) await wait(next, signal);
    }
  }

  function start() {
    if (!desired || !connection || connection.aborted || running || removal)
      return;
    const controller = new AbortController();
    const signal = AbortSignal.any([connection, controller.signal]);
    const done = maintain(signal)
      .catch(() => {
        if (!signal.aborted) warn('teams_personal.presence_loop_failed');
      })
      .finally(() => {
        running = undefined;
        if (signal.aborted) start();
      });
    running = { controller, done };
  }

  function offline(signal: AbortSignal) {
    desired = false;
    offlineRequested = true;
    running?.controller.abort();
    removal ??= (async () => {
      await running?.done;
      if (endpointToken) {
        await call('DELETE', `endpoints/${id}`, endpointToken, signal);
        endpointToken = undefined;
      }
    })().finally(() => {
      removal = undefined;
      start();
    });
    return removal;
  }

  return {
    connect(signal: AbortSignal) {
      connection = signal;
      running?.controller.abort();
      start();
    },
    online() {
      desired = true;
      offlineRequested = false;
      start();
    },
    offline,
    async stop() {
      if (!offlineRequested) {
        try {
          await offline(AbortSignal.timeout(1000));
        } catch {
          warn('teams_personal.presence_cleanup_failed');
        }
      }
    },
  };
}
