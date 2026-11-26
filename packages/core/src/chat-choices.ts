import type { Config } from '@tsugimori/config';
import type {
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  PlatformInboundEvent,
  PromptChoice,
  SendReceipt,
} from '@tsugimori/plugin-sdk';
import type { Tracer } from '@tsugimori/trace';

import { randomBytes } from 'node:crypto';

import type { Command } from './chat-commands.ts';
import type { Logger } from './hooks.ts';

import { conversationId } from './outbound.ts';
import { systemMessages } from './system-messages.ts';

type Callback = Extract<PlatformInboundEvent, { type: 'callback' }>;
type Address = Pick<OutboundMessage, 'chatId' | 'threadId'> & {
  messageId: string;
};
type Finish = (text: string, retainPrompt?: boolean) => Promise<void>;

interface Dependencies {
  isOwner(adapter: PlatformAdapter, userId: string): boolean;
  locale(): Config['locale'];
  log: Logger;
  trace: Tracer;
}

const prefix = 'choice:';
const lifetime = 10 * 60_000;

export function supportsChoices(adapter: PlatformAdapter) {
  return (
    adapter.capabilities.inlineButtons && Boolean(adapter.respondToApproval)
  );
}

export function choiceLabel(choice: PromptChoice, locale: Config['locale']) {
  return locale === 'zh-TW'
    ? (choice.localized?.[locale] ?? choice.label)
    : choice.label;
}

interface PendingChoice {
  active(): boolean;
  adapter: PlatformAdapter;
  choose(): void | Promise<void>;
  finish: Finish;
  ready: Promise<Address | undefined>;
  userId: string;
}

interface ChoiceOptions {
  active?(): boolean;
  command?: Command['name'];
  deliver?(message: OutboundMessage): Promise<SendReceipt>;
  expires?: boolean;
}

interface LinkedReply {
  adapter: PlatformAdapter;
  claim(command: Command): Finish | undefined;
  userId: string;
}

export class ChatChoices {
  readonly #deps: Dependencies;
  readonly #pending = new Map<string, PendingChoice>();
  readonly #replies = new Map<string, LinkedReply>();

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  async send(
    adapter: PlatformAdapter,
    message: OutboundMessage,
    userId: string,
    choices: readonly PromptChoice[],
    select: (choice: PromptChoice, finish: Finish) => void | Promise<void>,
    {
      active = () => true,
      command,
      deliver = (outbound) => adapter.send(outbound),
      expires = false,
    }: ChoiceOptions = {},
  ) {
    const locale = this.#deps.locale();
    const m = systemMessages(locale).choices;
    const ready = Promise.withResolvers<Address | undefined>();
    let finished = false;
    let replyKey: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const buttons = choices.map((choice) => ({
      id: prefix + randomBytes(12).toString('hex'),
      label: choiceLabel(choice, locale),
      choice,
    }));
    const deactivate = () => {
      clearTimeout(timer);
      for (const { id } of buttons) this.#pending.delete(id);
      if (replyKey) this.#replies.delete(replyKey);
    };
    const finish: Finish = async (text, retainPrompt) => {
      if (finished) return;
      finished = true;
      deactivate();
      const address = await ready.promise;
      if (address)
        await this.#feedback(adapter, address, {
          decisionText: text,
          prompt: retainPrompt ? message.text : undefined,
          notice: '',
        });
    };
    for (const { id, choice } of buttons) {
      this.#pending.set(id, {
        adapter,
        active,
        userId,
        ready: ready.promise,
        finish,
        choose: () => {
          deactivate();
          return select(choice, finish);
        },
      });
    }
    try {
      const receipt = await deliver({
        ...message,
        buttons: buttons.map(({ id, label }) => ({ id, label })),
      });
      const delivered = receipt.parts?.find(
        ({ messageId }) => messageId === receipt.messageId,
      );
      const address = {
        chatId: delivered?.chatId ?? message.chatId,
        threadId:
          delivered?.chatId === undefined ? message.threadId : undefined,
        messageId: receipt.messageId,
      };
      if (command && !finished) {
        replyKey = this.#replyKey(adapter, address);
        this.#replies.set(replyKey, {
          adapter,
          userId,
          claim: (typed) => {
            if (
              typed.name !== command ||
              !choices.some(({ value }) => value === typed.args)
            )
              return;
            deactivate();
            return finish;
          },
        });
      }
      ready.resolve(address);
      if (expires && !finished) {
        timer = setTimeout(() => void finish(m.expired, true), lifetime);
        timer.unref();
      }
      return { address, finish };
    } catch (error) {
      deactivate();
      ready.resolve(undefined);
      throw error;
    }
  }

  claimReply(
    adapter: PlatformAdapter,
    message: InboundMessage,
    command: Command,
  ) {
    if (
      !message.replyTo ||
      !command.args ||
      !this.#deps.isOwner(adapter, message.userId)
    )
      return;
    const reply = this.#replies.get(
      this.#replyKey(adapter, {
        chatId: message.chatId,
        threadId: message.threadId,
        messageId: message.replyTo,
      }),
    );
    if (reply?.adapter === adapter && reply.userId === message.userId)
      return reply.claim(command);
  }

  async receive(adapter: PlatformAdapter, event: Callback, moved: boolean) {
    if (!event.callbackId.startsWith(prefix)) return false;
    const pending = this.#pending.get(event.callbackId);
    const { userId, queryId } = event;
    const owner = () => this.#deps.isOwner(adapter, userId);
    const address =
      !moved &&
      pending?.adapter === adapter &&
      pending.userId === userId &&
      owner()
        ? await pending.ready
        : undefined;
    const m = systemMessages(this.#deps.locale()).choices;
    if (
      !pending ||
      !address ||
      address.messageId !== event.messageId ||
      address.chatId !== event.chatId ||
      address.threadId !== event.threadId ||
      this.#pending.get(event.callbackId) !== pending ||
      !owner() ||
      !pending.active()
    ) {
      if (queryId)
        await this.#feedback(adapter, event, {
          queryId,
          notice: m.unavailable,
        });
      return true;
    }
    const answer = queryId
      ? this.#feedback(adapter, address, { queryId, notice: '' })
      : undefined;
    try {
      await pending.choose();
    } catch {
      this.#deps.log({
        level: 'error',
        event: 'choice.action_failed',
        adapterId: adapter.id,
      });
      await pending.finish(m.failed, true);
    }
    await answer;
    return true;
  }

  async stop() {
    if (!this.#pending.size) return;
    const finishes = new Set(
      [...this.#pending.values()].map(({ finish }) => finish),
    );
    const text = systemMessages(this.#deps.locale()).choices.expired;
    await Promise.all([...finishes].map((finish) => finish(text, true)));
  }

  #replyKey(
    adapter: PlatformAdapter,
    { chatId, threadId, messageId }: Address,
  ) {
    return JSON.stringify([adapter.id, chatId, threadId, messageId]);
  }

  async #feedback(
    adapter: PlatformAdapter,
    { chatId, messageId, threadId }: Address,
    feedback: {
      decisionText?: string;
      notice: string;
      prompt?: string;
      queryId?: string;
    },
  ) {
    try {
      await this.#deps.trace.span(
        'choice.feedback',
        { adapterId: adapter.id, chatId: conversationId({ chatId, threadId }) },
        () => adapter.respondToApproval?.({ chatId, messageId, ...feedback }),
      );
    } catch {
      this.#deps.log({
        level: 'warn',
        event: 'choice.feedback_failed',
        adapterId: adapter.id,
      });
    }
  }
}
