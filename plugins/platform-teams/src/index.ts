import type {
  AdapterContext,
  OutboundMessage,
  PlatformAdapter,
  PlatformFactory,
} from '@tsugimori/plugin-sdk';

import {
  definePlugin,
  platformHome,
  PlatformStartError,
} from '@tsugimori/plugin-sdk';
import { randomUUID } from 'node:crypto';

import type { Socket } from './trouter.ts';

import { LoginRequired, microsoftAuth, teamsSession } from './auth.ts';
import { chatApi } from './chat-api.ts';
import { credentialStore } from './credentials.ts';
import { inboundMessages } from './history.ts';
import { checks, loginCheck, teamsLogin } from './setup.ts';
import { listen } from './trouter.ts';
import { mri } from './wire.ts';

interface Dependencies {
  fetch?: typeof globalThis.fetch;
  socket?(url: URL): Socket;
}

export function createTeamsAdapter(
  deps: Dependencies,
  {
    account,
    home,
    id,
    workspace,
  }: { account?: string; home: string; id: string; workspace: string },
): PlatformAdapter {
  const fetch = deps.fetch ?? globalThis.fetch;
  const store = credentialStore(workspace, home);
  const microsoft = microsoftAuth(fetch);
  const endpoint = randomUUID();
  let login: PlatformAdapter['login'];

  function start(ctx: AdapterContext) {
    const controller = new AbortController();
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, controller.signal])
      : controller.signal;
    const auth = teamsSession(microsoft, store, account, signal);
    const api = chatApi(fetch, auth);
    const inbound = inboundMessages(ctx, api, account ?? '');
    const ready = Promise.withResolvers<void>();
    let gatewayReady = !ctx.ready;
    async function waitForGateway(signal: AbortSignal) {
      signal.throwIfAborted();
      if (gatewayReady) return;
      const stopped = Promise.withResolvers<void>();
      const stop = () => stopped.resolve();
      signal.addEventListener('abort', stop, { once: true });
      try {
        await Promise.race([ctx.ready, stopped.promise]);
        signal.throwIfAborted();
        gatewayReady = true;
      } finally {
        signal.removeEventListener('abort', stop);
      }
    }
    const listening = listen(
      {
        authorize: () => auth.get(),
        invalidate: (token) => auth.invalidate(token),
        catchUp: async (signal, loss) => {
          await waitForGateway(signal);
          await inbound.catchUp(signal, loss);
        },
        fetch,
        socket: deps.socket ?? ((url) => new WebSocket(url)),
        receive: async (body, signal) => {
          await waitForGateway(signal);
          await inbound.receive(body, signal);
        },
        registered: () => {
          login = 'signed-in';
          ready.resolve();
        },
        warn: (event) => ctx.logWarning?.(event),
      },
      endpoint,
      signal,
    ).then(
      () => {
        ready.reject(signal.reason ?? new Error('Teams receiver stopped'));
      },
      (error: unknown) => {
        if (error instanceof LoginRequired || auth.required) {
          login = 'required';
          const failure = loginCheck(id);
          ready.reject(new PlatformStartError(failure.detail, { failure }));
          if (!signal.aborted)
            ctx.logWarning?.('teams.login_required', failure.fix?.hint);
        } else {
          ready.reject(new Error('Could not start the Teams receiver'));
          if (!signal.aborted) ctx.logWarning?.('teams.receiver_failed');
        }
      },
    );
    return {
      api,
      auth,
      controller,
      getUser: ctx.getUser,
      inbound,
      listening,
      ready: ready.promise,
      signal,
    };
  }
  let active: ReturnType<typeof start> | undefined;
  let stopping: Promise<void> | undefined;

  return {
    id,
    kind: 'teams',
    capabilities: { deleteEvents: true, outboundPush: 'free', richText: true },
    get login() {
      return active?.auth.required ? 'required' : login;
    },
    get botIdentity() {
      return account ? { id: account, username: account } : undefined;
    },
    async start(ctx) {
      await stopping;
      ctx.signal?.throwIfAborted();
      active ??= start(ctx);
      await active.ready;
    },
    async stop() {
      if (active && !stopping) {
        const current = active;
        current.controller.abort();
        stopping = Promise.all([current.listening, current.auth.stop()])
          .then(() => {
            if (active === current) active = undefined;
          })
          .finally(() => {
            stopping = undefined;
          });
      }
      await stopping;
    },
    async send(message: OutboundMessage, options) {
      if (!active) throw new Error('Teams receiver is stopped');
      const { api, getUser, inbound, signal } = active;
      const receipt = await api.send(
        message,
        options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
        getUser,
      );
      inbound.observe(message.chatId);
      return receipt;
    },
    async deleteMessage(message) {
      if (!active) throw new Error('Teams receiver is stopped');
      await active.api.deleteOwn(
        message.chatId,
        message.messageId,
        active.signal,
      );
    },
  };
}

const teams: PlatformFactory = ({ id, options }, { fetch, workspace }) =>
  createTeamsAdapter(
    { fetch },
    {
      id,
      account: mri(options?.accountMri),
      workspace,
      home: platformHome(workspace, id),
    },
  );

export default definePlugin({
  name: 'platform-teams',
  adapters: { teams },
  checks,
  credentialNames: () => [],
  setupSteps: [teamsLogin()],
});
