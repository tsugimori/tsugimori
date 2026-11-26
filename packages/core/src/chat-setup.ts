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
import { SetupCancelled } from './setup.ts';
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

interface Running {
  adapterId: string;
  cancel: AbortController;
  chatId: string;
  done: Promise<SetupCancelled | undefined>;
  finished?: boolean;
  secretChatId?: string;
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
  #running?: Running;
  #pending?: Pending;
  readonly #cancelledSecretChats = new Map<string, number>();

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  async receive(
    adapter: PlatformAdapter,
    chat: ChatRef,
    message: InboundMessage,
    command?: Command['name'] | 'other-bot',
  ) {
    const { store, trace } = this.#deps;
    const prompt = this.#pending;
    const owner = this.#deps.isOwner(adapter.id, message.userId);
    if (command === 'cancel') {
      if (owner && !message.edited)
        await trace.span('trigger.command', { ...chat, command }, () =>
          this.#cancel(adapter, chat, message),
        );
      return true;
    }
    const eligible =
      prompt &&
      !this.#running?.cancel.signal.aborted &&
      command !== 'other-bot' &&
      owner &&
      prompt.adapterId === chat.adapterId &&
      prompt.userId === message.userId;
    const linked =
      eligible &&
      prompt.chatId === chat.chatId &&
      message.replyTo &&
      message.replyTo === prompt.messageId;
    const previouslySecret = store.isSetupSecret(chat, message.messageId);
    const privateReply = Boolean(
      message.replyTo && store.isSetupSecret(chat, message.replyTo),
    );
    const lateSecret = this.#cancelledSecretChats.size
      ? this.#cancelledSecretChats.get(
          JSON.stringify([chat.adapterId, chat.chatId, message.userId]),
        )
      : undefined;
    const secret =
      previouslySecret ||
      privateReply ||
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
      ) ||
      (lateSecret !== undefined &&
        Date.now() < lateSecret &&
        /^(?:[a-f\d]{32}|[A-Za-z\d+/_-]{80,}={0,2}|[A-Za-z\d._-]{8,}#[A-Za-z\d._-]+)$/i.test(
          message.text.trim(),
        ));
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
      this.#pending === prompt &&
      !this.#running?.cancel.signal.aborted &&
      !message.edited &&
      !previouslySecret &&
      (prompt.secret ? message.chatKind === 'dm' : !secret);
    if (accepted) prompt.response.resolve(message.text);
    else if (
      secret &&
      !privateReply &&
      eligible &&
      !message.edited &&
      !previouslySecret
    ) {
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

  async #cancel(
    adapter: PlatformAdapter,
    chat: ChatRef,
    message: InboundMessage,
  ) {
    const { runtime, store } = this.#deps;
    const m = systemMessages(runtime.config.locale).setup;
    const run = this.#running;
    const pending = this.#pending;
    if (
      !run ||
      run.finished ||
      run.cancel.signal.aborted ||
      run.adapterId !== adapter.id ||
      run.userId !== message.userId ||
      (chat.chatId !== run.chatId &&
        !(
          pending?.secret &&
          pending.chatId === chat.chatId &&
          message.chatKind === 'dm'
        ))
    ) {
      await adapter.send(reply(message, m.idle));
      return;
    }
    if (pending?.messageId)
      store.markSetupSecret(
        { adapterId: adapter.id, chatId: pending.chatId },
        pending.messageId,
      );
    if (run.secretChatId) {
      const now = Date.now();
      for (const [key, expires] of this.#cancelledSecretChats)
        if (expires <= now) this.#cancelledSecretChats.delete(key);
      for (const chatId of [run.chatId, run.secretChatId])
        this.#cancelledSecretChats.set(
          JSON.stringify([adapter.id, chatId, message.userId]),
          now + 10 * 60_000,
        );
    }
    this.#pending = undefined;
    run.cancel.abort();
    const cancelled = await run.done;
    await adapter.send(reply(message, cancelled?.message ?? m.idle));
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
    const cancel = new AbortController();
    const signal = AbortSignal.any([this.#shutdown.signal, cancel.signal]);
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
    const origin = conversationId(message);
    const originName = (
      message.chatTitle ||
      (message.chatKind === 'dm' ? m.directMessage : origin)
    ).replace(/\s+/gu, ' ');
    const done = (async () => {
      try {
        const result = await setup.run(request, {
          locale,
          show,
          signal: this.#shutdown.signal,
          cancelSignal: cancel.signal,
          measure: (step, run) =>
            trace.span('setup.step', { adapterId, step }, run),
          waitForDetach: async (id) => {
            const wait = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
            while (runtime.getAgent(id))
              await delay(50, undefined, { signal: wait });
          },
          prompt: async ({ secret = false, text }, progress) => {
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
            if (secret && this.#running?.cancel === cancel)
              this.#running.secretChatId = pending.chatId;
            try {
              if (privatePrompt)
                await show(m.stepMessage(progress, m.sendingPrivately));
              signal.throwIfAborted();
              const receipt = await platform().send({
                ...address,
                text: secret
                  ? `${text} ${m.reply}\n${m.origin(originName)}`
                  : `${text} ${m.reply}`,
              });
              // A cancellation can arrive before the platform returns the prompt ID.
              if (secret || cancel.signal.aborted)
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
        if (this.#running?.cancel === cancel) this.#running.finished = true;
        if (cancel.signal.aborted) return;
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
        if (error instanceof SetupCancelled) return error;
        if (!this.#shutdown.signal.aborted && !cancel.signal.aborted) {
          const text = error instanceof SetupError ? error.message : m.failed;
          await show(text).catch(() =>
            log({ level: 'warn', event: 'setup.feedback_failed', adapterId }),
          );
        } else if (cancel.signal.aborted) {
          return new SetupCancelled(m.failed);
        }
      }
      return undefined;
    })().finally(() => {
      this.#running = undefined;
    });
    this.#running = {
      adapterId,
      cancel,
      chatId: origin,
      done,
      userId: message.userId,
    };
  }

  async stop() {
    this.#shutdown.abort();
    await this.#running?.done;
  }
}
