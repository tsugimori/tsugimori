import type { InboundAttachment } from '@tsugimori/plugin-sdk';

import {
  attachmentBytes,
  attachmentMime,
  sniffImageMime,
  ToolFailure,
} from '@tsugimori/plugin-sdk';

const cdn = 'https://stickershop.line-scdn.net/stickershop/v1/sticker';

export function validStickerId(
  stickerId: string | undefined,
): stickerId is string {
  return stickerId !== undefined && /^\d+$/.test(stickerId);
}

export async function downloadSticker(
  fetch: typeof globalThis.fetch,
  { fileId, stickerId }: InboundAttachment,
  signal: AbortSignal,
  maxBytes?: number,
) {
  const id =
    fileId === undefined ? stickerId : /^sticker:(\d+)$/.exec(fileId)?.[1];
  if (!validStickerId(id)) throw new ToolFailure('LINE sticker ID is invalid');

  const cdnSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const request = {
    credentials: 'omit',
    method: 'GET',
    redirect: 'error',
    signal: cdnSignal,
  } satisfies RequestInit;
  const unavailable = 'LINE sticker image is unavailable for download';
  try {
    signal.throwIfAborted();
    let response = await fetch(`${cdn}/${id}/android/sticker.png`, request);
    if (response.status === 404) {
      await response.body?.cancel();
      cdnSignal.throwIfAborted();
      response = await fetch(`${cdn}/${id}/iPhone/sticker@2x.png`, request);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ToolFailure(unavailable);
    }
    const mime = attachmentMime(response);
    if (mime !== undefined && mime.trim().toLowerCase() !== 'image/png') {
      await response.body?.cancel();
      throw new ToolFailure('LINE sticker image is not a PNG');
    }
    const bytes = await attachmentBytes(response, maxBytes);
    cdnSignal.throwIfAborted();
    if (sniffImageMime(bytes) !== 'image/png')
      throw new ToolFailure('LINE sticker image is not a PNG');
    return { bytes, mime: 'image/png' };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ToolFailure) throw error;
    throw new ToolFailure(unavailable, { cause: error });
  }
}
