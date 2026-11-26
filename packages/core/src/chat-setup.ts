import type {
  ChatRef,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { SetupError } from '@tsugimori/plugin-sdk';
import { setTimeout as delay } from 'node:timers/promises';

import type { Command } from './chat-commands.ts';
import type { Logger } from './hooks.ts';
import type { Runtime } from './runtime.ts';
import type { GuidedSetup, SetupRequest } from './setup.ts';

import { untilAborted } from './abort.ts';
import { failureText } from './checks.ts';
import { conversationId } from './outbound.ts';
import { systemMessages } from './system-messages.ts';
import { reply } from './tasks.ts';

interface Pending {
  adapterId: string;
  chatId: string;
  messageId?: string;
  origin: string;
  response: ReturnType<typeof Promise.withResolvers<string>>;
  secret: boolean;
  userId: string;
}

interface Dependencies {
  isOwner(adapterId: string, userId: string): boolean;
  log: Logger;
  runtime: Runtime;
  setup: GuidedSetup;
  store: Store;
  trace: Tracer;
}

export class ChatSetup {
  readonly #deps: Dependencies;
  readonly #shutdown = new AbortController();
  #running?: Promise<void>;
  #pending?: Pending;

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  async receive(
    adapter: PlatformAdapter,
    chat: ChatRef,
    message: InboundMessage,
    command?: Command['name'],
  ) {
    const { store } = this.#deps;
    const prompt = this.#pending;
    const owner = this.#deps.isOwner(adapter.id, message.userId);
    const eligible =
      prompt &&
      owner &&
      prompt.adapterId === chat.adapterId &&
      prompt.userId === message.userId;
    const linked =
      eligible &&
      prompt.chatId === chat.chatId &&
      message.replyTo &&
      message.replyTo === prompt.messageId;
    const previouslySecret = store.isSetupSecret(chat, message.messageId);
    const secret =
      previouslySecret ||
      Boolean(message.replyTo && store.isSetupSecret(chat, message.replyTo)) ||
      Boolean(
        eligible &&
        prompt.secret &&
        (prompt.chatId === chat.chatId || prompt.origin === chat.chatId) &&
        command !== 'add' &&
        command !== 'login' &&
        command !== 'status',
      ) ||
      /\b(?:\d{5,}:[A-Za-z0-9_-]{25,}|sk-ant-oat[A-Za-z0-9_-]{20,})\b/.test(
        message.text,
      );
    if (secret) {
      store.markSetupSecret(chat, message.messageId);
      try {
        await adapter.deleteMessage?.(message);
      } catch {
        this.#deps.log({
          level: 'warn',
          event: 'setup.secret_delete_failed',
          adapterId: adapter.id,
        });
      }
    }
    const accepted =
      linked &&
      !message.edited &&
      !previouslySecret &&
      (prompt.secret ? message.chatKind === 'dm' : !secret);
    if (accepted) prompt.response.resolve(message.text);
    else if (secret && owner && !message.edited && !previouslySecret) {
      const m = systemMessages(this.#deps.runtime.config.locale).setup;
      const text =
        message.chatKind === 'dm' ? m.replyPrivately : m.useDirectMessage;
      await adapter.send(reply(message, text)).catch(() =>
        this.#deps.log({
          level: 'warn',
          event: 'setup.secret_feedback_failed',
          adapterId: adapter.id,
        }),
      );
    }
    return Boolean(secret || linked);
  }

  async start(
    adapter: PlatformAdapter,
    message: InboundMessage,
    request: SetupRequest,
  ) {
    const { log, runtime, setup, store, trace } = this.#deps;
    const { locale } = runtime.config;
    const m = systemMessages(locale).setup;
    const adapterId = adapter.id;
    const signal = this.#shutdown.signal;
    const platform = () => {
      signal.throwIfAborted();
      const current = runtime.getAdapter(adapterId);
      if (!current || !this.#deps.isOwner(adapterId, message.userId))
        throw new SetupError(m.changedOwner);
      return current;
    };
    const show = async (text: string) => {
      await platform().send(reply(message, text));
    };
    if (this.#running) {
      await show(m.alreadyRunning);
      return;
    }
    this.#running = (async () => {
      try {
        const result = await setup.run(request, {
          locale,
          show,
          signal,
          measure: (step, run) =>
            trace.span('setup.step', { adapterId, step }, run),
          waitForDetach: async (id) => {
            const wait = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
            while (runtime.getAgent(id))
              await delay(50, undefined, { signal: wait });
          },
          prompt: async ({ secret = false, text }) => {
            const origin = conversationId(message);
            const privatePrompt = secret && message.chatKind !== 'dm';
            const address: Omit<OutboundMessage, 'text'> = privatePrompt
              ? { chatId: message.userId }
              : reply(message, '');
            const pending: Pending = {
              adapterId,
              chatId: privatePrompt ? message.userId : origin,
              origin,
              secret,
              userId: message.userId,
              response: Promise.withResolvers<string>(),
            };
            this.#pending = pending;
            try {
              if (privatePrompt) await show(m.sendingPrivately);
              signal.throwIfAborted();
              const receipt = await platform().send({
                ...address,
                text: text + ' ' + m.reply,
              });
              if (secret)
                store.markSetupSecret(
                  { adapterId, chatId: pending.chatId },
                  receipt.messageId,
                );
              pending.messageId = receipt.messageId;
              const timeout = AbortSignal.timeout(10 * 60_000);
              try {
                return await untilAborted(
                  AbortSignal.any([signal, timeout]),
                  () => pending.response.promise,
                );
              } catch (error) {
                if (!timeout.aborted) throw error;
                throw new SetupError(m.expired);
              }
            } finally {
              if (this.#pending === pending) this.#pending = undefined;
            }
          },
        });
        if (!result.enabled) {
          await show(m.disabled(result.id));
          return;
        }
        const attached = () =>
          result.category === 'agent'
            ? runtime.getAgent(result.id)
            : runtime.getAdapter(result.id);
        const wait = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        try {
          while (!attached()) await delay(50, undefined, { signal: wait });
          await show(m.attached(result.id));
        } catch (error) {
          if (signal.aborted) throw error;
          const details = failureText(
            runtime.reports.filter(
              ({ target }) => target === `${result.category}/${result.id}`,
            ),
            locale,
          );
          await show(m.saved(result.id) + '\n' + (details || m.checkStatus));
        }
      } catch (error) {
        if (!signal.aborted) {
          const text = error instanceof SetupError ? error.message : m.failed;
          await show(text).catch(() =>
            log({ level: 'warn', event: 'setup.feedback_failed', adapterId }),
          );
        }
      }
    })().finally(() => {
      this.#running = undefined;
    });
  }

  async stop() {
    this.#shutdown.abort();
    await this.#running;
  }
}
