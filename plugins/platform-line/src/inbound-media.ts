import type { InboundAttachment } from '@tsugimori/plugin-sdk';

import { nonempty, record } from './api.ts';

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
    case 'sticker':
      return [
        {
          index: 0,
          kind,
          set: nonempty(message.packageId),
          stickerId: nonempty(message.stickerId),
          keywords: Array.isArray(message.keywords)
            ? message.keywords.filter(
                (keyword: unknown): keyword is string =>
                  typeof keyword === 'string',
              )
            : undefined,
        },
      ];
    default:
      return [];
  }
}
