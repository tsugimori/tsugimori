import type {
  AdapterContext,
  PlatformInboundEvent,
} from '@tsugimori/plugin-sdk';

import { createHash } from 'node:crypto';

import type { chatApi } from './chat-api.ts';
import type { Change } from './inbound.ts';
import type { Data } from './wire.ts';

import { arrival, normalizeMessage, notification } from './inbound.ts';
import { messageId, object } from './wire.ts';

interface Observation {
  deleted: boolean;
  fingerprint: string;
  revision?: number;
}

interface Conversation {
  latest: number;
  seen: Map<string, Observation>;
}

const overlap = 2 * 60_000;
const maxPages = 5;

function revisionOf(raw: Data) {
  const properties = object(raw.properties);
  const stamp = raw.version ?? properties?.edittime;
  if (stamp !== undefined && /^\d+$/u.test(String(stamp))) return Number(stamp);
  const time = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
  if (Number.isFinite(time)) return time;
}

function fingerprint(event: PlatformInboundEvent) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        event.type === 'message'
          ? [event.text, event.mentionsBot, event.replyTo?.id]
          : [event.type],
      ),
    )
    .digest('base64url');
}

export function inboundMessages(
  ctx: AdapterContext,
  api: Pick<ReturnType<typeof chatApi>, 'page'>,
  account: string,
  startedAt = Date.now(),
) {
  const chats = new Map<string, Conversation>();
  function observe(chat: string) {
    let state = chats.get(chat);
    if (!state) {
      state = { latest: startedAt, seen: new Map() };
      chats.set(chat, state);
    }
    return state;
  }

  async function deliver(
    raw: Data,
    change: Change,
    signal: AbortSignal,
    chat?: string,
  ) {
    const event = normalizeMessage(raw, change, account, chat);
    if (!event || (event.type !== 'message' && event.type !== 'delete')) return;
    const state = observe(event.chatId);
    const previous = state.seen.get(event.messageId);
    const current = {
      deleted: event.type === 'delete',
      fingerprint: fingerprint(event),
      revision: revisionOf(raw),
    };
    if (previous?.deleted) return;
    if (previous && !current.deleted) {
      const older =
        previous.revision !== undefined &&
        current.revision !== undefined &&
        current.revision < previous.revision;
      if (older) return;
      if (previous.fingerprint === current.fingerprint) {
        previous.revision = current.revision ?? previous.revision;
        return;
      }
      // History can overlap a newer live edit. Require a comparable version to replace it.
      if (
        change === 'NewMessage' ||
        (chat &&
          (current.revision === undefined ||
            (previous.revision !== undefined &&
              current.revision <= previous.revision)))
      )
        return;
    }
    signal.throwIfAborted();
    await ctx.emit(event);
    state.seen.set(event.messageId, current);
    state.latest = Math.max(state.latest, arrival(raw) ?? startedAt);
  }

  async function recover(
    chat: string,
    state: Conversation,
    signal: AbortSignal,
  ) {
    const floor = Math.max(startedAt, state.latest - overlap);
    const found: { at: number; nativeId: bigint; raw: Data }[] = [];
    let next: string | undefined;
    let covered = false;
    for (let index = 0; index < maxPages; index++) {
      const page = await api.page(chat, next, signal);
      for (const raw of page.messages) {
        const id = messageId(raw.id);
        const at = arrival(raw);
        if (!id || at === undefined) continue;
        if (at < floor) covered = true;
        else found.push({ raw, at, nativeId: BigInt(id) });
      }
      next = page.next;
      if (!next || covered) break;
    }
    found.sort(
      (a, b) =>
        a.at - b.at ||
        (a.nativeId < b.nativeId ? -1 : Number(a.nativeId > b.nativeId)),
    );
    for (const { raw } of found) {
      const id = messageId(raw.id)!;
      await deliver(
        raw,
        state.seen.has(id) ? 'MessageUpdate' : 'NewMessage',
        signal,
        chat,
      );
    }
    if (next && !covered)
      ctx.logWarning?.('teams.history_gap', `${chat}: page limit reached`);
  }

  return {
    observe,
    async receive(body: Data, signal: AbortSignal) {
      const item = notification(body);
      if (item) await deliver(item.resource, item.change, signal);
    },
    async catchUp(signal: AbortSignal, loss: boolean) {
      if (loss && !chats.size)
        ctx.logWarning?.(
          'teams.history_gap',
          'No previously observed conversations',
        );
      for (const [chat, state] of [...chats]) {
        signal.throwIfAborted();
        try {
          await recover(chat, state, signal);
        } catch {
          signal.throwIfAborted();
          ctx.logWarning?.(
            'teams.history_gap',
            `${chat}: history read or delivery failed`,
          );
        }
      }
      if (loss && chats.size)
        ctx.logWarning?.(
          'teams.message_loss',
          'Only previously observed conversations can be recovered',
        );
    },
  };
}
