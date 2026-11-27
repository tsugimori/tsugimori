import type {
  ContextBlock,
  InboundAttachment,
  PlatformAdapter,
  ToolDefinition,
} from '@tsugimori/plugin-sdk';
import type { MessageRecord, Store } from '@tsugimori/storage';

import { albumAttachments } from '@tsugimori/context';
import { ToolFailure } from '@tsugimori/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

export function visual(
  attachment: Pick<
    InboundAttachment,
    'kind' | 'mime' | 'name' | 'stickerFormat'
  >,
) {
  return (
    attachment.kind === 'image' ||
    (attachment.kind === 'file' &&
      (/^image\/(?:jpeg|png|webp|gif|bmp|tiff|avif|heic)$/i.test(
        attachment.mime ?? '',
      ) ||
        ((!attachment.mime || attachment.mime === 'application/octet-stream') &&
          /\.(?:jpe?g|png|webp|gif|bmp|tiff?|avif|heic)$/i.test(
            attachment.name ?? '',
          )))) ||
    (attachment.kind === 'sticker' && Boolean(attachment.stickerFormat))
  );
}

function hasLineStickerId(
  platformKind: string,
  attachment: Pick<InboundAttachment, 'kind' | 'stickerId'>,
) {
  return (
    platformKind === 'line' &&
    attachment.kind === 'sticker' &&
    Boolean(attachment.stickerId)
  );
}

export function attachmentTool(
  {
    store,
    workdir,
  }: {
    store: Store;
    workdir(chat: Pick<MessageRecord, 'adapterId' | 'chatId'>): Promise<string>;
  },
  adapter: PlatformAdapter,
  temporaryFiles?: Set<string>,
): ToolDefinition {
  return {
    name: 'attachment.get',
    description:
      'Download an attachment from this conversation into the chat workspace. Use a message ID and attachment index from chat history. Image files are available until the task ends.',
    schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', minLength: 1 },
        index: {
          type: 'integer',
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
      required: ['messageId', 'index'],
      additionalProperties: false,
    },
    async run(args, { chat, signal }) {
      const { messageId, index } = args as { index: number; messageId: string };
      const items = findAttachments(store, chat, messageId);
      const attachment = items.find(
        (item) => item.attachment.index === index,
      )?.attachment;
      if (!attachment)
        throw new ToolFailure('Attachment not found in this conversation');
      if (
        !adapter.downloadAttachment ||
        (!attachment.fileId && !hasLineStickerId(adapter.kind, attachment))
      )
        throw new ToolFailure(
          'The platform does not provide a download for this attachment',
        );
      const { bytes, mime } = await adapter.downloadAttachment(
        attachment,
        signal,
      );
      signal.throwIfAborted();
      const contentType = mime ?? attachment.mime ?? 'application/octet-stream';
      const ephemeral =
        visual({ ...attachment, mime: contentType }) ||
        contentType.startsWith('image/');
      if (ephemeral && !temporaryFiles)
        throw new ToolFailure('Image downloads require an active chat task');
      const extension = extname(attachment.name ?? '').toLowerCase();
      const suffix = /^\.[a-z0-9]{1,10}$/.test(extension)
        ? extension
        : (mediaExtensions.get(contentType) ?? '');
      const path = join(
        await workdir(chat),
        'attachment-' + randomUUID() + suffix,
      );
      try {
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600, signal });
        signal.throwIfAborted();
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        ))
          await rm(path, { force: true });
        throw error;
      }
      if (ephemeral) temporaryFiles?.add(path);
      return { path, mime: contentType, size: bytes.byteLength };
    },
  };
}

const mediaExtensions = new Map([
  ['application/pdf', '.pdf'],
  ['application/x-tgsticker', '.tgs'],
  ['audio/ogg', '.ogg'],
  ['image/gif', '.gif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
]);

export function findAttachments(
  store: Store,
  chat: Pick<MessageRecord, 'adapterId' | 'chatId'>,
  id: string,
  migratedFromChatId = '',
) {
  const row =
    store.getMessage(chat, id, migratedFromChatId, false) ??
    (migratedFromChatId === ''
      ? store.getMessage(chat, id, undefined, false)
      : undefined);
  if (row?.deleted || store.isSetupSecret(chat, id)) return [];
  const quoted = row?.metadata?.attachments?.length
    ? undefined
    : store.quotedAttachmentMessage(
        chat,
        id,
        row?.migratedFromChatId ?? migratedFromChatId,
      )?.metadata?.replyTo;
  const albumId = row?.albumId;
  if (albumId) {
    const members = store.messageAlbum(chat, albumId, row.migratedFromChatId);
    if (members.length) {
      return albumAttachments(members).map(({ attachment }) => ({
        albumFirstSeq: members[0]!.seq,
        attachment,
        id,
      }));
    }
  }
  return (row?.metadata?.attachments ?? quoted?.attachments ?? []).map(
    (attachment) => ({ attachment, id, albumFirstSeq: undefined }),
  );
}

export function turnAttachments(
  store: Store,
  chat: Pick<MessageRecord, 'adapterId' | 'chatId'>,
  platformKind: string,
  blocks: readonly ContextBlock[],
  migratedFromChatId: string,
  afterSeq: number | undefined,
  includeReplies: boolean,
) {
  // Older LINE stickers have only a sticker ID. The adapter can still fetch them.
  const isVisual = (attachment: InboundAttachment) =>
    visual(attachment) || hasLineStickerId(platformKind, attachment);
  const ids = new Map<string, Set<number>>();
  for (const { message } of blocks) {
    for (const part of [
      message,
      includeReplies ? message?.replyTo : undefined,
    ]) {
      if (!part) continue;
      for (const attachment of part.attachments) {
        if (!isVisual(attachment)) continue;
        let described = ids.get(part.id);
        if (!described) ids.set(part.id, (described = new Set()));
        if (attachment.kind === 'sticker' && attachment.description)
          described.add(attachment.index);
      }
    }
  }
  const groups = new Set<number>();
  return [...ids].flatMap(([id, described]) => {
    const items = findAttachments(store, chat, id, migratedFromChatId);
    const album = items[0]?.albumFirstSeq;
    const images = items.filter(
      ({ attachment }) =>
        isVisual(attachment) &&
        !described.has(attachment.index) &&
        (attachment.fileId || hasLineStickerId(platformKind, attachment)),
    );
    if (album === undefined) return images;
    if (groups.has(album) || (afterSeq !== undefined && album <= afterSeq))
      return [];
    groups.add(album);
    return images.slice(0, 4);
  });
}
