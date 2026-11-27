import type {
  AdapterContext,
  MediaUpload,
  PlatformAdapter,
  PlatformFactory,
  QueuedMedia,
} from '@tsugimori/plugin-sdk';

import {
  definePlugin,
  platformHome,
  PlatformStartError,
  ToolFailure,
} from '@tsugimori/plugin-sdk';
import { randomUUID } from 'node:crypto';

import type { Socket } from './trouter.ts';
import type { Wait } from './wire.ts';

import { downloadMedia, fileMaxBytes, imageMaxBytes } from './attachments.ts';
import { LoginRequired, microsoftAuth, teamsSession } from './auth.ts';
import { chatApi } from './chat-api.ts';
import { credentialStore } from './credentials.ts';
import { inboundMessages } from './history.ts';
import { teamsPresence } from './presence.ts';
import { checks, loginCheck, teamsLogin } from './setup.ts';
import { listen } from './trouter.ts';
import { prepareImage, uploadMedia, validateUpload } from './upload.ts';
import { chatKind, mri, waitFor } from './wire.ts';

interface Dependencies {
  fetch?: typeof globalThis.fetch;
  socket?(url: URL): Socket;
  wait?: Wait;
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
    const warn = (event: string) => ctx.logWarning?.(event);
    const presence = teamsPresence(fetch, auth, warn, deps.wait);
    const images = new WeakMap<
      QueuedMedia,
      { message: MediaUpload; size: ReturnType<typeof prepareImage> }
    >();
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
        registered: (connection) => {
          presence.connect(connection);
          login = 'signed-in';
          ready.resolve();
        },
        warn,
      },
      endpoint,
      signal,
      deps.wait,
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
      images,
      inbound,
      listening,
      presence,
      ready: ready.promise,
      signal,
      warn,
    };
  }
  let active: ReturnType<typeof start> | undefined;
  let stopping: Promise<void> | undefined;

  function operation(signal?: AbortSignal) {
    if (!active) throw new Error('Teams receiver is stopped');
    const combined = signal
      ? AbortSignal.any([active.signal, signal])
      : active.signal;
    combined.throwIfAborted();
    return { session: active, signal: combined };
  }

  async function typing(chatId: string, signal: AbortSignal) {
    const current = operation(signal);
    const wait = deps.wait ?? waitFor;
    while (!current.signal.aborted) {
      try {
        await current.session.api.typing(chatId, current.signal);
      } catch {
        if (current.signal.aborted) return;
        current.session.warn('teams.typing_failed');
      }
      await wait(4000, current.signal);
    }
  }

  return {
    id,
    kind: 'teams',
    capabilities: {
      deleteEvents: true,
      files: { maxBytes: fileMaxBytes },
      images: { maxBytes: imageMaxBytes, queued: true },
      outboundPush: 'free',
      presence: { states: ['online', 'offline'], text: false },
      reactions: true,
      richText: true,
    },
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
        stopping = Promise.all([
          current.listening,
          current.presence.stop(),
          current.auth.stop(),
        ])
          .then(() => {
            if (active === current) active = undefined;
          })
          .finally(() => {
            stopping = undefined;
          });
      }
      await stopping;
    },
    async send(message, options) {
      const { session, signal } = operation(options?.signal);
      const { api, auth, getUser, images, inbound } = session;
      const handles = options?.media ?? [];
      const queued = [...new Set(handles)].map((handle) => {
        const item = images.get(handle);
        if (
          !item ||
          item.message.chatId !== message.chatId ||
          item.message.threadId !== message.threadId ||
          item.message.replyTo !== message.replyTo
        )
          throw new ToolFailure(
            'Teams queued image belongs to a different reply',
          );
        return { ...item, handle };
      });
      for (const { handle } of queued) images.delete(handle);
      const receipt = await api.send(
        message,
        signal,
        getUser,
        queued.length
          ? {
              kind: 'image',
              async upload() {
                const uploaded = [];
                for (const {
                  message: { file },
                  size,
                } of queued)
                  uploaded.push(
                    await uploadMedia(
                      fetch,
                      auth,
                      message.chatId,
                      file,
                      signal,
                      size,
                    ),
                  );
                return uploaded;
              },
            }
          : undefined,
      );
      inbound.observe(message.chatId);
      if (queued.length)
        return {
          ...receipt,
          parts: [
            {
              messageId: receipt.messageId,
              mediaIds: queued.map(({ handle }) => handle.id),
              text: message.text.trim() ? message.text : '[image]',
            },
          ],
        };
      return receipt;
    },
    async sendImage(message, signal) {
      const { session } = operation(signal);
      if (!chatKind(message.chatId))
        throw new ToolFailure('Invalid Teams conversation ID');
      const size = prepareImage(message.file);
      const handle = { id: randomUUID(), queued: true as const };
      session.images.set(handle, { message, size });
      return handle;
    },
    async sendFile(message, caller) {
      const { session, signal } = operation(caller);
      const { api, auth, inbound } = session;
      const { chatId, file, replyTo, threadId } = message;
      validateUpload(file, false);
      const receipt = await api.send(
        { chatId, replyTo, text: '', threadId },
        signal,
        session.getUser,
        {
          kind: 'file',
          upload: async () => [
            await uploadMedia(fetch, auth, chatId, file, signal),
          ],
        },
      );
      inbound.observe(chatId);
      return receipt;
    },
    async downloadAttachment(attachment, caller, maxBytes) {
      const { session, signal } = operation(caller);
      return downloadMedia(fetch, session.auth, attachment, signal, maxBytes);
    },
    async sendReaction(message, caller) {
      const { session, signal } = operation(caller);
      await session.api.react(
        message.chatId,
        message.messageId,
        message.emoji,
        signal,
      );
    },
    typing(chat, signal) {
      const current = active;
      if (!current || current.signal.aborted || signal.aborted) return;
      void typing(chat.chatId, signal).catch(() => {
        if (!signal.aborted && !current.signal.aborted)
          current.warn('teams.typing_failed');
      });
    },
    async setPresence({ state, text }, signal) {
      signal?.throwIfAborted();
      if (!active) throw new Error('Teams receiver is stopped');
      if (text !== undefined)
        throw new ToolFailure('Teams presence does not support status text');
      if (state === 'offline') {
        await active.presence.offline(signal ?? AbortSignal.timeout(1000));
      } else if (state === 'online') {
        active.signal.throwIfAborted();
        active.presence.online();
      } else {
        throw new ToolFailure('Unsupported Teams presence state');
      }
    },
    async deleteMessage(message) {
      const { session, signal } = operation();
      await session.api.deleteOwn(message.chatId, message.messageId, signal);
    },
    async updateChoices(update, caller) {
      const { session, signal } = operation(caller);
      await session.api.editOwn(
        update.messageId,
        update,
        signal,
        session.getUser,
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
