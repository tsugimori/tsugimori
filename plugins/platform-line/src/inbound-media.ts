import type { InboundAttachment } from '@tsugimori/plugin-sdk';

import { nonempty, record } from './api.ts';
import { validStickerId } from './sticker-image.ts';

export function lineAttachments(
  message: Record<string, unknown>,
  id: string,
): InboundAttachment[] {
  const kind = message.type;
  switch (kind) {
    case 'image':
    case 'video':
    case 'audio':
    case 'file': {
      const provider = record(message.contentProvider)?.type;
      // The content API serves uploads hosted by LINE.
      return [
        {
          index: 0,
          kind,
          fileId:
            provider === undefined || provider === 'line' ? id : undefined,
          name: nonempty(message.fileName),
          size:
            typeof message.fileSize === 'number' &&
            Number.isSafeInteger(message.fileSize) &&
            message.fileSize >= 0
              ? message.fileSize
              : undefined,
        },
      ];
    }
    case 'sticker': {
      const stickerId = nonempty(message.stickerId);
      return [
        {
          index: 0,
          kind,
          ...(validStickerId(stickerId) && {
            fileId: `sticker:${stickerId}`,
            stickerFormat: 'static',
          }),
          set: nonempty(message.packageId),
          stickerId,
          stickerResourceType: nonempty(message.stickerResourceType),
          keywords: Array.isArray(message.keywords)
            ? message.keywords.filter(
                (keyword: unknown): keyword is string =>
                  typeof keyword === 'string',
              )
            : undefined,
        },
      ];
    }
    default:
      return [];
  }
}
