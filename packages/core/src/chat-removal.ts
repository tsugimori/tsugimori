import type { Config } from '@tsugimori/config';
import type {
  ChatRef,
  InboundMessage,
  PlatformAdapter,
} from '@tsugimori/plugin-sdk';
import type { RemovalTarget } from '@tsugimori/storage';

import { SetupError } from '@tsugimori/plugin-sdk';

import type { Logger } from './hooks.ts';
import type { Outbound } from './outbound.ts';
import type { Removal, RemovalPlan } from './removal.ts';

import { formatRemovalPlan, removalMessages } from './removal-messages.ts';
import { reply } from './tasks.ts';

interface Dependencies {
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
  ) {
    const { outbound, removal } = this.#deps;
    const m = removalMessages(locale);
    const send = (text: string) => outbound.send(adapter, reply(message, text));
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
      const receipt = await send(formatRemovalPlan(plan, true));
      const messageIds = new Set([
        receipt.messageId,
        ...(receipt.parts?.map((part) => part.messageId) ?? []),
      ]);
      const timer = setTimeout(() => {
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
        (!message.replyTo || !pending.messageIds.has(message.replyTo)))
    )
      return false;
    if (message.edited) return true;
    this.stop();
    const m = removalMessages(pending.plan.locale);
    const text =
      cancel || message.text.trim() !== 'yes'
        ? m.cancelled
        : await this.#deps
            .execute(pending.plan, message.userId, adapter.id)
            .catch((error: unknown) =>
              error instanceof SetupError ? error.message : m.unavailable,
            );
    await this.#deps.outbound.send(adapter, reply(message, text));
    return true;
  }

  stop(adapterId?: string) {
    if (adapterId !== undefined && this.#pending?.adapterId !== adapterId)
      return;
    clearTimeout(this.#pending?.timer);
    this.#pending = undefined;
  }
}
