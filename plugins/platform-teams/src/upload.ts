import type { MediaFile } from '@tsugimori/plugin-sdk';

import { sniffImageMime, ToolFailure } from '@tsugimori/plugin-sdk';

import type { teamsSession } from './auth.ts';

import {
  asmId,
  asmObjects,
  asmRequest,
  fileMaxBytes,
  imageMaxBytes,
  imageSchema,
} from './attachments.ts';
import { escapeHtml } from './text.ts';
import { chatKind, readJson } from './wire.ts';

interface Dimensions {
  height: number;
  width: number;
}

type Image = Dimensions & { subtype: 'gif' | 'jpeg' | 'png' | 'webp' };

function jpegSize(data: Buffer): Dimensions | undefined {
  let offset = 2;
  while (offset + 4 <= data.length && data[offset++] === 0xff) {
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (
      !marker ||
      marker === 0xda ||
      marker === 0xd9 ||
      offset + 2 > data.length
    )
      return;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker) &&
      length >= 8
    )
      return {
        width: data.readUInt16BE(offset + 5),
        height: data.readUInt16BE(offset + 3),
      };
    offset += length;
  }
}

function webpSize(data: Buffer): Dimensions | undefined {
  // The first chunk is the image header in all three WebP containers.
  if (data.length < 25) return;
  const length = data.readUInt32LE(16);
  if (length > data.length - 20) return;
  switch (data.toString('ascii', 12, 16)) {
    case 'VP8X':
      if (length >= 10)
        return {
          width: data.readUIntLE(24, 3) + 1,
          height: data.readUIntLE(27, 3) + 1,
        };
      return;
    case 'VP8L': {
      if (length < 5 || data[20] !== 0x2f) return;
      const bits = data.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    case 'VP8 ':
      if (
        length >= 10 &&
        data.readUIntBE(23, 3) === 0x9d012a &&
        (data[20]! & 1) === 0
      )
        return {
          width: data.readUInt16LE(26) & 0x3fff,
          height: data.readUInt16LE(28) & 0x3fff,
        };
      return;
  }
}

function imageSize(data: Buffer): Image | undefined {
  const mime = sniffImageMime(data);
  if (
    data.length >= 24 &&
    mime === 'image/png' &&
    data.readUInt32BE(8) === 13 &&
    data.toString('ascii', 12, 16) === 'IHDR'
  )
    return {
      subtype: 'png',
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  if (data.length >= 10 && mime === 'image/gif')
    return {
      subtype: 'gif',
      width: data.readUInt16LE(6),
      height: data.readUInt16LE(8),
    };
  if (mime === 'image/jpeg') {
    const size = jpegSize(data);
    if (size) return { ...size, subtype: 'jpeg' };
  }
  if (mime === 'image/webp') {
    const size = webpSize(data);
    if (size) return { ...size, subtype: 'webp' };
  }
}

export function validateUpload(file: MediaFile, image: boolean) {
  const max = image ? imageMaxBytes : fileMaxBytes;
  if (!file.bytes.byteLength || file.bytes.byteLength > max)
    throw new ToolFailure(
      `Teams uploads require 1 byte to ${max / 1024 ** 2} MiB`,
    );
  if (
    !file.name.trim() ||
    file.name.length > 200 ||
    /[\p{Cc}/\\]/u.test(file.name)
  )
    throw new ToolFailure('Invalid Teams attachment filename');
}

export function prepareImage(file: MediaFile) {
  validateUpload(file, true);
  const { buffer, byteOffset, byteLength } = file.bytes;
  const size = imageSize(Buffer.from(buffer, byteOffset, byteLength));
  if (
    !size ||
    !size.width ||
    !size.height ||
    size.width * size.height > 25_000_000
  )
    throw new ToolFailure(
      'Teams requires a JPEG, PNG, GIF, or WebP of up to 25 million pixels',
    );
  return size;
}

export interface Uploaded {
  html: string;
  id: string;
}

export async function uploadMedia(
  fetch: typeof globalThis.fetch,
  auth: ReturnType<typeof teamsSession>,
  chat: string,
  file: MediaFile,
  signal: AbortSignal,
  image?: Image,
): Promise<Uploaded> {
  if (!chatKind(chat)) throw new ToolFailure('Invalid Teams conversation ID');
  const { bytes, name } = file;
  const created = await readJson(
    await asmRequest(
      fetch,
      auth,
      '',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: image ? 'pish/image' : 'sharing/file',
          ...(image && { sharingMode: 'Inline' }),
          filename: name,
          permissions: { [chat]: ['read'] },
        }),
      },
      signal,
    ),
  );
  const id = asmId(created.id);
  if (!id) throw new Error('Teams returned an invalid attachment object ID');
  const uploaded = await asmRequest(
    fetch,
    auth,
    `${id}/content/${image ? 'imgpsh' : 'original'}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    },
    signal,
  );
  await uploaded.body?.cancel();
  const base = asmObjects + id;
  const escaped = escapeHtml(name);
  if (!image)
    return {
      id,
      html: `<URIObject type="File.1" uri="${base}"><Title>${escaped}</Title><Description></Description><OriginalName v="${escaped}"/><FileSize v="${bytes.byteLength}"/></URIObject>`,
    };
  const scale = Math.min(1, 400 / image.width, 250 / image.height);
  return {
    id,
    html: `<p><img src="${base}/views/imgo" itemtype="${imageSchema}" itemscope="${image.subtype}" width="${image.width * scale}" height="${image.height * scale}" alt="${escaped}" id="x_${id}" itemid="${id}"></p>`,
  };
}
