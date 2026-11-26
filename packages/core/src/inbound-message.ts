import type {
  ChatRef,
  PlatformAdapter,
  ReplyTarget,
} from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';

import { parseCommand } from './chat-commands.ts';

export function hasPrivateArguments(name: string) {
  return (
    name === 'pair' || name === 'login' || name === 'add' || name === 'webhook'
  );
}

export function redactPairingCodes(text: string) {
  return text.replace(
    /(\/pair(?:@[a-z0-9_]+)?\s+)[\w-]{16}(?![\w-])/gi,
    '$1[redacted]',
  );
}

export function resolveReplyTarget(
  { store, bot }: { bot: PlatformAdapter['botIdentity']; store: Store },
  chat: ChatRef,
  reply: ReplyTarget | undefined,
  migratedFromChatId = '',
): { replyTo?: ReplyTarget; sensitiveReply?: boolean } {
  if (!reply) return {};
  const quoted = store.getMessage(chat, reply.id, migratedFromChatId, false);
  const command = reply.text
    ? parseCommand(reply.text, bot?.username)
    : undefined;
  if (
    quoted?.deleted ||
    store.isSetupSecret(chat, reply.id) ||
    (reply.text !== undefined &&
      redactPairingCodes(reply.text) !== reply.text) ||
    (reply.quote !== undefined &&
      redactPairingCodes(reply.quote) !== reply.quote) ||
    (command && command !== 'other-bot' && hasPrivateArguments(command.name))
  )
    return { replyTo: { id: reply.id }, sensitiveReply: true };

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
  return {
    replyTo: {
      ...reply,
      sender,
      text: quoted?.text ?? reply.text,
      attachments: quoted?.metadata?.attachments ?? reply.attachments,
      albumId: quoted?.albumId ?? reply.albumId,
    },
  };
}
