import type {
  ChatRef,
  PlatformAdapter,
  ReplyTarget,
} from '@tsugimori/plugin-sdk';
import type { MessageRecord, Store } from '@tsugimori/storage';

import { parseCommand } from './chat-commands.ts';

const replyMessageLimit = 20;
const replyCharacterLimit = 12_000;
const pairingCode =
  /(\/pair(?:@[a-z0-9_]+)?\s+)(?:[\w-]{16}(?![\w-])|\[redacted\])/gi;

export function hasPrivateArguments(name: string) {
  return (
    name === 'pair' || name === 'login' || name === 'add' || name === 'webhook'
  );
}

export function redactPairingCodes(text: string) {
  return text.replace(pairingCode, '$1[redacted]');
}

type ThreadMessage = Omit<ReplyTarget, 'replyChain'>;

export function resolveReplyTarget(
  { store, bot }: { bot: PlatformAdapter['botIdentity']; store: Store },
  chat: ChatRef,
  reply: ReplyTarget | undefined,
  migratedFromChatId = '',
): { replyTo?: ReplyTarget; sensitiveReply?: boolean } {
  if (!reply) return {};
  const sensitive = (text: string | undefined, storedTarget = true) => {
    if (!text) return false;
    const command = parseCommand(text, bot?.username);
    return (
      text.search(pairingCode) !== -1 ||
      (command !== undefined &&
        command !== 'other-bot' &&
        (hasPrivateArguments(command.name) ||
          (!storedTarget &&
            (command.name === 'btw' || command.name === 'ask'))))
    );
  };
  const load = (id: string) =>
    store.getMessage(chat, id, migratedFromChatId, false);
  const canQuote = (message: MessageRecord) =>
    !sensitive(message.text) &&
    store.replyTargetVisible(chat, message.messageId, migratedFromChatId);
  let target = load(reply.id);
  // A side question supplied by the platform needs a stored target to establish the thread.
  if (
    sensitive(reply.text, target !== undefined) ||
    sensitive(reply.quote, target !== undefined) ||
    (target
      ? !canQuote(target)
      : !store.messageVisible(chat, reply.id, migratedFromChatId) ||
        store.isSetupSecret(chat, reply.id, migratedFromChatId))
  )
    return { replyTo: { id: reply.id }, sensitiveReply: true };

  let remaining = replyCharacterLimit;
  const fit = (value: string | undefined) => {
    if (value === undefined) return;
    const text = value.slice(0, remaining).replace(/[\uD800-\uDBFF]$/u, '');
    remaining -= text.length;
    return text;
  };
  const toThreadMessage = (
    message: MessageRecord | undefined,
    live: ThreadMessage,
  ) => {
    const quote = fit(live.quote);
    return {
      ...replyDetails(store, chat, bot, message, live),
      text: fit(message?.text ?? live.text),
      quote,
    };
  };
  const immediate = toThreadMessage(target, reply);
  if (!target) return { replyTo: immediate };
  const sensitiveReply =
    target.metadata?.sideQuestion === true ||
    !store.messageVisible(chat, reply.id, migratedFromChatId);
  const chain = [immediate];
  const visited = new Set([reply.id]);
  while (target.replyTo && chain.length < replyMessageLimit && remaining > 0) {
    const parentId = target.replyTo;
    if (visited.has(parentId)) break;
    const parent = load(parentId);
    if (!parent || !canQuote(parent)) break;
    const saved = target.metadata?.replyTo;
    chain.push(
      toThreadMessage(parent, {
        id: parentId,
        ...(saved?.id === parentId && {
          albumId: saved.albumId,
          attachments: saved.attachments,
          sender: saved.sender,
        }),
      }),
    );
    visited.add(parentId);
    target = parent;
  }
  return {
    replyTo: { ...immediate, replyChain: chain.reverse() },
    sensitiveReply,
  };
}

function replyDetails(
  store: Store,
  chat: ChatRef,
  bot: PlatformAdapter['botIdentity'],
  quoted: MessageRecord | undefined,
  reply: ThreadMessage,
): ThreadMessage {
  let sender = quoted?.metadata?.sender ?? reply.sender;
  if (!sender && quoted?.userId) {
    const { userId } = quoted;
    sender = {
      id: userId,
      name:
        quoted.metadata?.userDisplay ??
        store.getUser({ adapterId: chat.adapterId, userId })?.display ??
        undefined,
    };
  }
  if (!sender && quoted?.direction === 'outbound' && bot?.id)
    sender = { id: bot.id, name: bot.username };
  const attachments = quoted?.metadata?.attachments?.map((attachment) => {
    if (attachment.kind !== 'sticker' || attachment.stickerId)
      return attachment;
    const live = reply.attachments?.find(
      (item) =>
        item.kind === 'sticker' &&
        item.index === attachment.index &&
        item.set === attachment.set,
    );
    return live?.stickerId
      ? { ...attachment, stickerId: live.stickerId }
      : attachment;
  });
  return {
    id: reply.id,
    sender,
    attachments: attachments?.length ? attachments : reply.attachments,
    albumId: quoted?.albumId ?? reply.albumId,
  };
}
