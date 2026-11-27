import type { OutboundMessage, SendReceipt } from './index.ts';

export type MediaDestination = Pick<
  OutboundMessage,
  'chatId' | 'replyTo' | 'threadId'
>;

export interface MediaFile extends AttachmentContent {
  name: string;
}

export interface QueuedMedia {
  id: string;
  queued: true;
}

export type MediaReceipt = QueuedMedia | SendReceipt;

export interface MediaUpload extends MediaDestination {
  file: MediaFile;
  preview(maxBytes: number): Promise<AttachmentContent>;
}

export interface StickerChoice {
  description: string;
  emoji?: string;
  fileId: string;
  packageId?: string;
}

export interface PlatformSticker extends InboundAttachment {
  fileId: string;
  kind: 'sticker';
  stickerFormat: NonNullable<InboundAttachment['stickerFormat']>;
  thumbnail?: InboundAttachment;
  uniqueId: string;
}

export interface MessageSender {
  id: string;
  name?: string;
}

export interface AttachmentMetadata {
  emoji?: string;
  height?: number;
  index: number;
  keywords?: string[];
  kind:
    'animation' | 'audio' | 'file' | 'image' | 'sticker' | 'video' | 'voice';
  mime?: string;
  name?: string;
  set?: string;
  size?: number;
  stickerFormat?: 'lottie' | 'static' | 'video';
  stickerId?: string;
  width?: number;
}

export interface InboundAttachment extends AttachmentMetadata {
  /** Opaque platform reference. Kept out of agent context. */
  fileId?: string;
}

export interface ReplyTarget {
  albumId?: string;
  attachments?: readonly InboundAttachment[];
  id: string;
  quote?: string;
  sender?: MessageSender;
  text?: string;
}

export interface AttachmentContent {
  bytes: Uint8Array;
  mime?: string;
}

export interface AgentImage {
  /** Base64 without a data URL prefix. */
  data: string;
  mime: 'image/jpeg' | 'image/png';
  source?: { index: number; messageId: string };
}

export interface ImageLimits {
  maxBytes: number;
  maxEdge: number;
  maxPixels?: number;
  sourceMaxBytes?: number;
}

export function imageLimits(
  defaults: ImageLimits,
  options?: Record<string, unknown>,
): ImageLimits {
  const read = (key: string, fallback?: number) => {
    const value = options?.[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
      throw new Error(`${key} must be a positive integer`);
    return value;
  };
  return {
    ...defaults,
    maxBytes: read('imageMaxBytes') ?? defaults.maxBytes,
    maxEdge: read('imageMaxEdge') ?? defaults.maxEdge,
    maxPixels: read('imageMaxPixels', defaults.maxPixels),
    sourceMaxBytes: read('imageSourceMaxBytes', defaults.sourceMaxBytes),
  };
}

export interface ContextMessage {
  albumId?: string;
  at: number | null;
  attachments: AttachmentMetadata[];
  id: string;
  replyTo?: Omit<ReplyTarget, 'attachments'> & {
    attachments: AttachmentMetadata[];
  };
  sender: { id: string | null; name: string | null };
}

export function attachmentMetadata(
  attachment: InboundAttachment,
): AttachmentMetadata {
  const metadata = { ...attachment };
  delete metadata.fileId;
  return metadata;
}

export async function attachmentBytes(
  response: Response,
  maxBytes?: number,
  limitMessage = 'Attachment exceeds the download size limit',
) {
  if (maxBytes === undefined)
    return new Uint8Array(await response.arrayBuffer());
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error(limitMessage);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(limitMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}
