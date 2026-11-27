import type {
  ContextMessage,
  InboundAttachment,
  ReplyTarget,
} from '@tsugimori/plugin-sdk';
import type { MessageRecord, Store } from '@tsugimori/storage';

import { attachmentMetadata } from '@tsugimori/plugin-sdk';

type AlbumSource = Partial<Pick<Store, 'messageAlbum'>>;
type Row = Pick<
  MessageRecord,
  | 'albumId'
  | 'displayName'
  | 'messageId'
  | 'metadata'
  | 'migratedFromChatId'
  | 'recordedAt'
  | 'replyTo'
  | 'userId'
>;

export function albumAttachments(members: readonly MessageRecord[]) {
  let index = 0;
  return members.flatMap((message) =>
    (message.metadata?.attachments ?? []).flatMap((attachment) => {
      const entry = { message, attachment: { ...attachment, index: index++ } };
      return message.deleted ? [] : [entry];
    }),
  );
}

function publicAttachments(attachments: readonly InboundAttachment[] = []) {
  return attachments.map(attachmentMetadata);
}

function publicReply(
  reply: ReplyTarget,
  attachments = reply.attachments,
): ContextMessage['replyTo'] {
  const { albumId, id, quote, sender, text } = reply;
  return {
    ...(albumId !== undefined && { albumId }),
    id,
    sender,
    text,
    attachments: publicAttachments(attachments),
    quote,
  };
}

export function messageContext(
  message: Row,
  album?: (
    albumId: string,
    migratedFromChatId: string,
  ) => ReturnType<typeof albumAttachments>,
  wholeAlbum = false,
): ContextMessage {
  const { metadata, messageId, migratedFromChatId } = message;
  const reply =
    metadata?.replyTo ??
    (message.replyTo ? { id: message.replyTo } : undefined);
  const attachments =
    message.albumId && album
      ? album(message.albumId, migratedFromChatId)
          .filter(
            ({ message }) => wholeAlbum || message.messageId === messageId,
          )
          .map(({ attachment }) => attachment)
      : metadata?.attachments;
  const repliedAlbum =
    reply?.albumId && album
      ? album(reply.albumId, migratedFromChatId)
      : undefined;
  const replyAttachments = repliedAlbum?.some(
    ({ message }) => message.messageId === reply?.id,
  )
    ? repliedAlbum.map(({ attachment }) => attachment)
    : reply?.attachments;
  return {
    ...(message.albumId != null && { albumId: message.albumId }),
    id: messageId,
    at: metadata?.at ?? message.recordedAt,
    sender: {
      id: metadata?.sender?.id ?? message.userId,
      name: metadata?.sender
        ? (metadata.sender.name ?? null)
        : (metadata?.userDisplay ?? message.displayName ?? null),
    },
    replyTo: reply && publicReply(reply, replyAttachments),
    attachments: publicAttachments(attachments),
  };
}

export function messageAlbumLookup(
  store: AlbumSource,
  chat: Pick<MessageRecord, 'adapterId' | 'chatId'>,
  privateSince?: number,
) {
  const cache = new Map<string, ReturnType<typeof albumAttachments>>();
  return (albumId: string, migratedFromChatId: string) => {
    const key = JSON.stringify([albumId, migratedFromChatId]);
    let album = cache.get(key);
    if (!album) {
      album = albumAttachments(
        store.messageAlbum?.(chat, albumId, migratedFromChatId) ?? [],
      ).filter(
        ({ message }) =>
          privateSince === undefined || message.seq > privateSince,
      );
      cache.set(key, album);
    }
    return album;
  };
}

export function privateReplyVisible(
  store: Partial<Pick<Store, 'getMessage'>>,
  chat: Pick<MessageRecord, 'adapterId' | 'chatId'>,
  id: string,
  migratedFromChatId: string,
  privateSince: number,
) {
  const target = store.getMessage?.(chat, id, migratedFromChatId, false);
  return target !== undefined && !target.deleted && target.seq > privateSince;
}
