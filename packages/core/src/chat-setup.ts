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

import type { ChatChoices } from './chat-choices.ts';
import type { Command } from './chat-commands.ts';
import type { Logger } from './hooks.ts';
import type { Runtime } from './runtime.ts';
import type { GuidedSetup, SetupRequest } from './setup.ts';

import { untilAborted } from './abort.ts';
import { choiceLabel, supportsChoices } from './chat-choices.ts';
import { failureText } from './checks.ts';
import { describeError } from './errors.ts';
import { conversationId } from './outbound.ts';
import { SetupCancelled } from './setup.ts';
import { systemMessages } from './system-messages.ts';
import { reply } from './tasks.ts';

interface Pending {
  adapterId: string;
  chatId: string;
  messageId?: string;
  origin: string;
  respond(text: string): void;
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
  choices: ChatChoices;
  isOwner(adapterId: string, userId: string): boolean;
  log: Logger;
  redact(text: string): string;
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
        command !== 'remove' &&
        command !== 'status' &&
        command !== 'webhook',
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
    if (accepted) prompt.respond(message.text);
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
    const { log, redact, runtime, setup, store, trace } = this.#deps;
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
    if (this.#running) return false;
    const origin = conversationId(message);
    const originName = (
      message.chatTitle ||
      (message.chatKind === 'dm' ? m.directMessage : origin)
    ).replace(/\s+/gu, ' ');
    let promptClosed: Promise<void> | undefined;
    const category = request.mode === 'add' ? request.category : 'agent';
    const kind =
      request.mode === 'add'
        ? request.kind
        : (runtime.config.agents.find(({ id }) => id === request.id)?.kind ??
          'unknown');
    const secrets = new Set<string>();
    const errorText = (error: unknown) =>
      describeError(error, (text) => {
        for (const secret of secrets)
          text = text.replaceAll(secret, '[redacted]');
        return redact(text);
      });
    let step: string = request.mode;
    let tracedError: unknown;
    const done = (async () => {
      try {
        const result = await setup.run(request, {
          locale,
          show,
          signal: this.#shutdown.signal,
          cancelSignal: cancel.signal,
          measure: (name, run) => {
            step = name;
            const attrs = {
              adapterId,
              category,
              kind,
              step,
              error: null as string | null,
            };
            return trace.span('setup.step', attrs, async () => {
              try {
                return await run();
              } catch (error) {
                if (
                  !(error instanceof SetupError) &&
                  !(error instanceof SetupCancelled)
                ) {
                  attrs.error = errorText(error);
                  tracedError = error;
                }
                throw error;
              }
            });
          },
          waitForAttach: async (id) => {
            const wait = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
            try {
              while (!runtime.getAdapter(id))
                await delay(50, undefined, { signal: wait });
            } catch (error) {
              if (signal.aborted) throw error;
            }
          },
          waitForDetach: async (id) => {
            const wait = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
            while (runtime.getAgent(id))
              await delay(50, undefined, { signal: wait });
          },
          prompt: async ({ choices, secret = false, text }, progress) => {
            const closed = Promise.withResolvers<void>();
            promptClosed = closed.promise;
            const privatePrompt = secret && message.chatKind !== 'dm';
            const address: Omit<OutboundMessage, 'text'> = privatePrompt
              ? { chatId: message.userId }
              : reply(message, '');
            const messages = systemMessages(locale).choices;
            const options = secret ? [] : (choices ?? []);
            const response = Promise.withResolvers<string>();
            let timeout: AbortSignal | undefined;
            let answered = false;
            let feedback: Promise<void> | undefined;
            let buttons: Awaited<ReturnType<ChatChoices['send']>> | undefined;
            const respond = (
              answer: string,
              finish = buttons?.finish,
              label?: string,
            ) => {
              if (answered || signal.aborted || timeout?.aborted) return;
              answered = true;
              if (secret && answer.trim()) secrets.add(answer.trim());
              if (finish) {
                const typed = answer.trim();
                const value =
                  !typed || typed === '-' ? 'default' : typed.toLowerCase();
                const choice = options.find((choice) => choice.value === value);
                const display =
                  label ??
                  (choice
                    ? choiceLabel(choice, locale)
                    : Array.from(typed.replace(/\s+/gu, ' '))
                        .slice(0, 120)
                        .join(''));
                feedback = finish(messages.answer(display), true);
              }
              response.resolve(answer);
            };
            const pending: Pending = {
              adapterId,
              chatId: privatePrompt ? message.userId : origin,
              origin,
              secret,
              userId: message.userId,
              respond,
            };
            this.#pending = pending;
            if (secret && this.#running?.cancel === cancel)
              this.#running.secretChatId = pending.chatId;
            try {
              if (privatePrompt)
                await show(m.stepMessage(progress, m.sendingPrivately));
              signal.throwIfAborted();
              const current = platform();
              const inline = options.length > 0 && supportsChoices(current);
              const prompt = {
                ...address,
                text: secret
                  ? `${text} ${m.reply}\n${m.origin(originName)}`
                  : [
                      `${text} ${m.reply}`,
                      ...(!inline && options.length
                        ? [
                            messages.values(
                              options.map(({ value }) => value).join(' / '),
                            ),
                          ]
                        : []),
                    ].join('\n'),
              };
              if (inline)
                buttons = await this.#deps.choices.send(
                  current,
                  prompt,
                  message.userId,
                  options,
                  (choice, finish) =>
                    respond(choice.value, finish, choiceLabel(choice, locale)),
                  {
                    active: () =>
                      this.#pending === pending &&
                      !answered &&
                      !signal.aborted &&
                      !timeout?.aborted,
                  },
                );
              const receipt = buttons?.address ?? (await current.send(prompt));
              if (buttons) pending.chatId = conversationId(buttons.address);
              // A cancellation can arrive before the platform returns the prompt ID.
              if (secret || cancel.signal.aborted)
                store.markSetupSecret(
                  { adapterId, chatId: pending.chatId },
                  receipt.messageId,
                );
              pending.messageId = receipt.messageId;
              timeout = AbortSignal.timeout(10 * 60_000);
              try {
                return await untilAborted(
                  AbortSignal.any([signal, timeout]),
                  () => response.promise,
                );
              } catch (error) {
                if (!timeout.aborted) throw error;
                throw new SetupError(m.expired);
              }
            } finally {
              if (this.#pending === pending) this.#pending = undefined;
              try {
                await (feedback ??
                  buttons?.finish(
                    signal.aborted ? messages.cancelled : messages.expired,
                    true,
                  ));
              } finally {
                closed.resolve();
              }
            }
          },
        });
        if (this.#running?.cancel === cancel) this.#running.finished = true;
        if (cancel.signal.aborted) return;
        const finish = (text: string) =>
          show([text, result.summary].filter(Boolean).join('\n'));
        if (result.category === 'webhook' || result.summaryOnly) {
          if (result.summary) await show(result.summary);
          return;
        }
        if (!result.enabled) {
          await finish(m.disabled(result.id));
          return;
        }
        const attached = () =>
          result.category === 'agent'
            ? runtime.getAgent(result.id)
            : runtime.getAdapter(result.id);
        const wait = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        try {
          while (!attached()) await delay(50, undefined, { signal: wait });
          await finish(m.attached(result.id));
        } catch (error) {
          if (signal.aborted) throw error;
          const details = failureText(
            runtime.reports.filter(
              ({ target }) => target === `${result.category}/${result.id}`,
            ),
            locale,
          );
          await finish(m.saved(result.id) + '\n' + (details || m.checkStatus));
        }
      } catch (error) {
        if (error instanceof SetupCancelled) return error;
        if (!this.#shutdown.signal.aborted && !cancel.signal.aborted) {
          if (!(error instanceof SetupError)) {
            const attrs = {
              adapterId,
              category,
              kind,
              step,
              error: errorText(error),
            };
            log({ level: 'error', event: 'setup.failed', ...attrs });
            if (tracedError !== error)
              trace.record('setup.step', attrs, 0, 'error');
          }
          const text = error instanceof SetupError ? error.message : m.failed;
          await show(text).catch(() =>
            log({ level: 'warn', event: 'setup.feedback_failed', adapterId }),
          );
        } else if (cancel.signal.aborted) {
          return new SetupCancelled(m.failed);
        }
      }
      return undefined;
    })().finally(async () => {
      await promptClosed;
      this.#running = undefined;
    });
    this.#running = {
      adapterId,
      cancel,
      chatId: origin,
      done,
      userId: message.userId,
    };
    return true;
  }

  async stop() {
    this.#shutdown.abort();
    await this.#running?.done;
  }

  async detach(adapterId: string) {
    const run = this.#running;
    if (run?.adapterId !== adapterId) return;
    run.cancel.abort();
    await run.done;
  }
}
