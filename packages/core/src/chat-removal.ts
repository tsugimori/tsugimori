import type { Config } from '@tsugimori/config';
import type {
  ChatRef,
  InboundMessage,
  PlatformAdapter,
} from '@tsugimori/plugin-sdk';
import type { RemovalTarget } from '@tsugimori/storage';

import { SetupError } from '@tsugimori/plugin-sdk';

import type {
  ChatChoices,
  ChoiceAddress,
  ChoiceReplacement,
} from './chat-choices.ts';
import type { Logger } from './hooks.ts';
import type { Outbound } from './outbound.ts';
import type { Removal, RemovalPlan } from './removal.ts';

import { choiceLabel, choiceReply, supportsChoices } from './chat-choices.ts';
import { formatRemovalPlan, removalMessages } from './removal-messages.ts';
import { systemMessages } from './system-messages.ts';
import { reply } from './tasks.ts';

type Finish = (text: string, retainPrompt?: boolean) => Promise<void>;

const confirmChoices = [
  { value: 'yes', label: 'Delete', localized: { 'zh-TW': '刪除' } },
  { value: 'no', label: 'Cancel', localized: { 'zh-TW': '取消' } },
] as const;

interface Dependencies {
  choices: ChatChoices;
  execute(
    plan: RemovalPlan,
    actor: string,
    originAdapter: string,
  ): Promise<string>;
  isOwner(adapterId: string, userId: string): boolean;
  log: Logger;
  outbound: Outbound;
  removal: Removal;
}

interface Pending extends ChatRef {
  finish?: Finish;
  messageIds: ReadonlySet<string>;
  plan: RemovalPlan;
  timer: NodeJS.Timeout;
  userId: string;
}

export class ChatRemoval {
  readonly #deps: Dependencies;
  #pending?: Pending;
  #sending = false;

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  async start(
    adapter: PlatformAdapter,
    chat: ChatRef,
    message: InboundMessage,
    target: RemovalTarget,
    locale: Config['locale'],
    replace?: ChoiceReplacement,
  ) {
    const { outbound, removal } = this.#deps;
    const m = removalMessages(locale);
    const send = async (text: string) => {
      if (adapter.updateChoices) await replace?.fallback();
      return outbound.send(
        adapter,
        choiceReply(adapter, reply(message, text), replace?.address),
      );
    };
    if (this.#pending || this.#sending) {
      await send(m.busy);
      return;
    }
    this.#sending = true;
    try {
      const plan = await removal.plan(target, {
        adapterId: adapter.id,
        locale,
      });
      const inline = supportsChoices(adapter);
      const text = formatRemovalPlan(plan, true, inline);
      let finish: Finish | undefined;
      let receipt;
      if (inline) {
        const buttons = await this.#deps.choices.send(
          adapter,
          reply(message, text),
          message.userId,
          confirmChoices,
          (choice, done, event) => {
            const current = this.#pending;
            if (current?.plan !== plan) return done(m.cancelled, true);
            return this.#decide(
              adapter,
              current,
              message,
              choice.value === 'yes',
              choiceLabel(choice, locale),
              event,
            );
          },
          { active: () => this.#pending?.plan === plan, replace },
        );
        finish = buttons.finish;
        receipt = { messageId: buttons.address.messageId };
      } else receipt = await send(text);
      const messageIds = new Set([
        receipt.messageId,
        ...(receipt.parts?.map((part) => part.messageId) ?? []),
      ]);
      const timer = setTimeout(() => {
        void this.#pending?.finish?.(
          systemMessages(plan.locale).choices.expired,
          true,
        );
        this.stop();
        // The next command can start a fresh confirmation when the prompt expires.
        this.#deps.log({
          level: 'info',
          event: 'remove.prompt_expired',
          target: `${plan.category}/${plan.id}`,
        });
      }, 10 * 60_000).unref();
      this.#pending = {
        ...chat,
        userId: message.userId,
        timer,
        plan,
        messageIds,
        finish,
      };
    } catch (error) {
      await send(error instanceof SetupError ? error.message : m.unavailable);
    } finally {
      this.#sending = false;
    }
  }

  async receive(
    adapter: PlatformAdapter,
    chat: ChatRef,
    message: InboundMessage,
    cancel: boolean,
  ) {
    const pending = this.#pending;
    if (
      !pending ||
      pending.adapterId !== chat.adapterId ||
      pending.chatId !== chat.chatId ||
      pending.userId !== message.userId ||
      !this.#deps.isOwner(adapter.id, message.userId) ||
      (!cancel &&
        (!message.replyTo || !pending.messageIds.has(message.replyTo.id)))
    )
      return false;
    if (message.edited) return true;
    await this.#decide(
      adapter,
      pending,
      message,
      !cancel && message.text.trim() === 'yes',
    );
    return true;
  }

  async #decide(
    adapter: PlatformAdapter,
    pending: Pending,
    message: InboundMessage,
    confirmed: boolean,
    label?: string,
    address?: ChoiceAddress,
  ) {
    this.stop();
    const m = removalMessages(pending.plan.locale);
    const choices = systemMessages(pending.plan.locale).choices;
    const feedback =
      !address || adapter.updateChoices
        ? pending.finish?.(
            label
              ? choices.answer(label)
              : confirmed
                ? choices.answer('yes')
                : choices.cancelled,
            true,
          )
        : undefined;
    const text = !confirmed
      ? m.cancelled
      : await this.#deps
          .execute(pending.plan, message.userId, adapter.id)
          .catch((error: unknown) =>
            error instanceof SetupError ? error.message : m.unavailable,
          );
    await feedback;
    await this.#deps.outbound.send(
      adapter,
      choiceReply(adapter, reply(message, text), address),
    );
  }

  stop(adapterId?: string) {
    if (adapterId !== undefined && this.#pending?.adapterId !== adapterId)
      return;
    clearTimeout(this.#pending?.timer);
    this.#pending = undefined;
  }
}
