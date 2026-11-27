import type { MediaFile } from '@tsugimori/plugin-sdk';
import type { IncomingMessage } from 'node:http';

import { sniffImageMime, ToolFailure } from '@tsugimori/plugin-sdk';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { extname } from 'node:path';

import { untilAborted } from './abort.ts';

const nonPublic = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // This network and unspecified
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // Carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24],
  ['192.88.99.0', 24], // Deprecated 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // Benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3], // Multicast, reserved, and limited broadcast
] as const)
  nonPublic.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['2001::', 23], // IETF protocol assignments, including Teredo
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 embeds an IPv4 destination
  ['3fff::', 20],
] as const)
  nonPublic.addSubnet(network, prefix, 'ipv6');
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');

function publicAddress(address: string) {
  switch (isIP(address)) {
    case 4:
      return !nonPublic.check(address, 'ipv4');
    case 6:
      // Global unicast excludes mapped IPv4, ULA, link-local and multicast.
      return (
        !address.includes('%') &&
        globalUnicast.check(address, 'ipv6') &&
        !nonPublic.check(address, 'ipv6')
      );
    default:
      return false;
  }
}

interface MediaResponse extends AsyncIterable<Uint8Array> {
  destroy(): void;
  headers: IncomingMessage['headers'];
  statusCode?: number;
}

export interface WebImageNetwork {
  connect(
    url: URL,
    address: string,
    signal: AbortSignal,
    accept: string,
  ): Promise<MediaResponse>;
  resolve(hostname: string): Promise<readonly string[]>;
}

function hostname(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

const network: WebImageNetwork = {
  async resolve(host) {
    return (await lookup(host, { all: true })).map(({ address }) => address);
  },
  connect(url, address, signal, accept) {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const host = hostname(url);
    return new Promise((resolve, reject) => {
      // The socket uses the checked IP. HTTP Host and TLS identity use the URL.
      const outgoing = request(
        {
          agent: false,
          hostname: address,
          port: url.port || undefined,
          path: url.pathname + url.search,
          servername: isIP(host) ? '' : host,
          rejectUnauthorized: true,
          signal,
          headers: {
            Host: url.host,
            'User-Agent': 'Tsugimori',
            Accept: accept,
          },
        },
        resolve,
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
  },
};

type DownloadKind = 'Audio' | 'Image';

function mediaUrl(kind: DownloadKind, source: string, base?: URL) {
  const url =
    base || /^https?:\/\//i.test(source) ? URL.parse(source, base) : null;
  if (kind === 'Audio' && url?.protocol !== 'https:')
    throw new ToolFailure('Expected an HTTPS audio URL');
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:')
    throw new ToolFailure('Expected an HTTP or HTTPS image URL');
  if (url.username || url.password)
    throw new ToolFailure(`${kind} URLs cannot contain credentials`);
  return url;
}

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

const redirects = new Set([301, 302, 303, 307, 308]);

export interface WebImage {
  file: MediaFile;
  sourceUrl: string;
}

export async function fetchWebImage(
  source: string,
  maxBytes: number,
  parentSignal: AbortSignal,
  io = network,
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
  io = network,
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
  io: WebImageNetwork,
) {
  const accept =
    kind === 'Image'
      ? 'image/jpeg, image/png, image/gif, image/webp'
      : 'audio/*, application/octet-stream';
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(15_000)]);
  try {
    return await untilAborted(signal, async () => {
      let url = mediaUrl(kind, source);
      for (let hops = 0; ; hops++) {
        const host = hostname(url);
        const addresses = isIP(host) ? [host] : await io.resolve(host);
        signal.throwIfAborted();
        if (addresses.some((address) => !publicAddress(address)))
          throw new ToolFailure(`${kind} URL points to a blocked address`);
        const address = addresses[0];
        if (!address)
          throw new ToolFailure(`${kind} host could not be resolved`);
        const response = await io.connect(url, address, signal, accept);
        try {
          signal.throwIfAborted();
          const status = response.statusCode ?? 0;
          if (redirects.has(status) && response.headers.location) {
            if (hops === 3)
              throw new ToolFailure(`Too many ${kind.toLowerCase()} redirects`);
            url = mediaUrl(kind, response.headers.location, url);
            continue;
          }
          if (status < 200 || status >= 300)
            throw new ToolFailure(`${kind} request returned HTTP ${status}`);
          const tooLarge = () =>
            new ToolFailure(`${kind} exceeds the platform size limit`);
          if (Number(response.headers['content-length']) > maxBytes)
            throw tooLarge();
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.byteLength;
            if (size > maxBytes) throw tooLarge();
            chunks.push(Buffer.from(chunk));
          }
          return { bytes: Buffer.concat(chunks, size), url };
        } finally {
          response.destroy();
        }
      }
    });
  } catch (error) {
    parentSignal.throwIfAborted();
    if (signal.aborted) throw new ToolFailure(`${kind} download timed out`);
    if (error instanceof ToolFailure) throw error;
    throw new ToolFailure(`${kind} download failed`);
  }
}
