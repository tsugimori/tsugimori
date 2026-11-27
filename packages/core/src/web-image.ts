import type { MediaFile } from '@tsugimori/plugin-sdk';

import { sniffImageMime, ToolFailure } from '@tsugimori/plugin-sdk';
import { extname } from 'node:path';

import type { PublicWebNetwork } from './public-web.ts';

import { readWebBody, requestPublicWeb } from './public-web.ts';

export type WebImageNetwork = PublicWebNetwork;
type DownloadKind = 'Audio' | 'Image';

const imageExtensions = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
} as const;

function urlFilename(url: URL) {
  const segment = url.pathname.split('/').at(-1) ?? '';
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
  }
  return name
    .replace(/[^\p{L}\p{N}_.-]+/gu, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
}

function imageFile(url: URL, bytes: Buffer): MediaFile {
  const mime = sniffImageMime(bytes);
  if (!mime) throw new ToolFailure('Downloaded content is not an image');
  const extensions: readonly string[] = imageExtensions[mime];
  const name = urlFilename(url);
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length).slice(0, 100);
  return {
    bytes,
    mime,
    name:
      (stem || 'image') +
      (extensions.includes(extension.toLowerCase())
        ? extension
        : extensions[0]),
  };
}

export interface WebImage {
  file: MediaFile;
  sourceUrl: string;
}

export async function fetchWebImage(
  source: string,
  maxBytes: number,
  parentSignal: AbortSignal,
  io?: WebImageNetwork,
): Promise<WebImage> {
  const { bytes, url } = await fetchWebMedia(
    'Image',
    source,
    maxBytes,
    parentSignal,
    io,
  );
  return { file: imageFile(url, bytes), sourceUrl: url.href };
}

export async function fetchWebAudio(
  source: string,
  maxBytes: number,
  parentSignal: AbortSignal,
  io?: WebImageNetwork,
): Promise<MediaFile> {
  const { bytes, url } = await fetchWebMedia(
    'Audio',
    source,
    maxBytes,
    parentSignal,
    io,
  );
  return { bytes, name: urlFilename(url).slice(0, 120) || 'audio' };
}

async function fetchWebMedia(
  kind: DownloadKind,
  source: string,
  maxBytes: number,
  parentSignal: AbortSignal,
  io?: WebImageNetwork,
) {
  const accept =
    kind === 'Image'
      ? 'image/jpeg, image/png, image/gif, image/webp'
      : 'audio/*, application/octet-stream';
  return requestPublicWeb(
    {
      accept,
      kind,
      source,
      parentSignal,
      io,
      httpsOnly: kind === 'Audio',
      timeoutMs: 15_000,
    },
    async (response, url, status) => {
      if (status < 200 || status >= 300)
        throw new ToolFailure(`${kind} request returned HTTP ${status}`);
      const tooLarge = () =>
        new ToolFailure(`${kind} exceeds the platform size limit`);
      if (Number(response.headers['content-length']) > maxBytes)
        throw tooLarge();
      const { bytes, truncated } = await readWebBody(response, maxBytes);
      if (truncated) throw tooLarge();
      return { bytes, url };
    },
  );
}
