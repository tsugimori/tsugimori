import type { InboundAttachment, PlatformSticker } from '@tsugimori/plugin-sdk';

import { record } from './api.ts';

const media = [
  ['animation', 'animation', 'video/mp4'],
  ['document', 'file', undefined],
  ['video', 'video', 'video/mp4'],
  ['voice', 'voice', 'audio/ogg'],
  ['audio', 'audio', undefined],
] as const;

function number(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return value;
}

function string(value: unknown) {
  if (typeof value === 'string' && value) return value;
}

function attachment(
  file: Record<string, unknown> | undefined,
  kind: InboundAttachment['kind'],
  mime?: string,
): (InboundAttachment & { fileId: string }) | undefined {
  const fileId = string(file?.file_id);
  if (!file || !fileId) return;
  return {
    index: 0,
    kind,
    fileId,
    mime: string(file.mime_type) ?? mime,
    size: number(file.file_size),
    name: string(file.file_name),
    width: number(file.width),
    height: number(file.height),
  };
}

export function telegramAttachments(
  message: Record<string, unknown>,
): InboundAttachment[] {
  if (Array.isArray(message.photo)) {
    let largest: Record<string, unknown> | undefined;
    let largestArea = -1;
    for (const value of message.photo as unknown[]) {
      const photo = record(value);
      const area = (number(photo?.width) ?? 0) * (number(photo?.height) ?? 0);
      if (photo && string(photo.file_id) && area >= largestArea) {
        largest = photo;
        largestArea = area;
      }
    }
    const image = attachment(largest, 'image', 'image/jpeg');
    if (image) return [image];
  }
  const sticker = stickerAttachment(record(message.sticker));
  if (sticker) return [sticker];
  // Telegram includes a document alongside an animation for older clients.
  for (const [field, kind, mime] of media) {
    const file = attachment(record(message[field]), kind, mime);
    if (file) return [file];
  }
  return [];
}

function stickerAttachment(
  sticker: Record<string, unknown> | undefined,
): Omit<PlatformSticker, 'uniqueId'> | undefined {
  if (!sticker) return;
  const stickerFormat =
    sticker.is_video === true
      ? 'video'
      : sticker.is_animated === true
        ? 'lottie'
        : 'static';
  const mime = {
    lottie: 'application/x-tgsticker',
    static: 'image/webp',
    video: 'video/webm',
  }[stickerFormat];
  const file = attachment(sticker, 'sticker', mime);
  if (file)
    return {
      ...file,
      kind: 'sticker',
      emoji: string(sticker.emoji),
      set: string(sticker.set_name),
      stickerFormat,
    };
}

export function telegramSetSticker(
  value: unknown,
  set: string,
  index: number,
): PlatformSticker {
  const recordValue = record(value);
  const sticker = stickerAttachment(recordValue);
  const uniqueId = string(recordValue?.file_unique_id);
  if (!sticker || !uniqueId)
    throw new Error('Telegram returned an invalid sticker');
  const thumbnail = attachment(record(recordValue?.thumbnail), 'sticker');
  return {
    ...sticker,
    set,
    index,
    uniqueId,
    thumbnail: thumbnail && { ...thumbnail, stickerFormat: 'static' },
  };
}

export function telegramText(message: Record<string, unknown>) {
  return string(message.text) ?? string(message.caption) ?? '';
}
