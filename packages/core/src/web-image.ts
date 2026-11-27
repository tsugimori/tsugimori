import type { MediaFile } from '@tsugimori/plugin-sdk';
import type { IncomingMessage } from 'node:http';

import { ToolFailure } from '@tsugimori/plugin-sdk';
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

interface ImageResponse extends AsyncIterable<Uint8Array> {
  destroy(): void;
  headers: IncomingMessage['headers'];
  statusCode?: number;
}

export interface WebImageNetwork {
  connect(
    url: URL,
    address: string,
    signal: AbortSignal,
  ): Promise<ImageResponse>;
  resolve(hostname: string): Promise<readonly string[]>;
}

function hostname(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

const network: WebImageNetwork = {
  async resolve(host) {
    return (await lookup(host, { all: true })).map(({ address }) => address);
  },
  connect(url, address, signal) {
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
            Accept: 'image/jpeg, image/png, image/gif, image/webp',
          },
        },
        resolve,
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
  },
};

function imageUrl(source: string, base?: URL) {
  const url =
    base || /^https?:\/\//i.test(source) ? URL.parse(source, base) : null;
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:')
    throw new ToolFailure('Expected an HTTP or HTTPS image URL');
  if (url.username || url.password)
    throw new ToolFailure('Image URLs cannot contain credentials');
  return url;
}

const formats = [
  { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'], magic: 'ffd8ff' },
  { mime: 'image/png', extensions: ['.png'], magic: '89504e470d0a1a0a' },
  { mime: 'image/gif', extensions: ['.gif'], magic: '474946383761' },
  { mime: 'image/gif', extensions: ['.gif'], magic: '474946383961' },
  { mime: 'image/webp', extensions: ['.webp'], magic: '52494646' },
].map(({ magic, ...format }) => ({
  ...format,
  magic: Buffer.from(magic, 'hex'),
}));

function imageFile(url: URL, bytes: Buffer): MediaFile {
  const format = formats.find(
    ({ mime, magic }) =>
      bytes.subarray(0, magic.length).equals(magic) &&
      (mime !== 'image/webp' || bytes.toString('latin1', 8, 12) === 'WEBP'),
  );
  if (!format) throw new ToolFailure('Downloaded content is not an image');
  const segment = url.pathname.split('/').at(-1) ?? '';
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
  }
  name = name
    .replace(/[^\p{L}\p{N}_.-]+/gu, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length).slice(0, 100);
  return {
    bytes,
    mime: format.mime,
    name:
      (stem || 'image') +
      (format.extensions.includes(extension.toLowerCase())
        ? extension
        : format.extensions[0]),
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
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(15_000)]);
  try {
    return await untilAborted(signal, async () => {
      let url = imageUrl(source);
      for (let hops = 0; ; hops++) {
        const host = hostname(url);
        const addresses = isIP(host) ? [host] : await io.resolve(host);
        signal.throwIfAborted();
        if (addresses.some((address) => !publicAddress(address)))
          throw new ToolFailure('Image URL points to a blocked address');
        const address = addresses[0];
        if (!address) throw new ToolFailure('Image host could not be resolved');
        const response = await io.connect(url, address, signal);
        try {
          signal.throwIfAborted();
          const status = response.statusCode ?? 0;
          if (redirects.has(status) && response.headers.location) {
            if (hops === 3) throw new ToolFailure('Too many image redirects');
            url = imageUrl(response.headers.location, url);
            continue;
          }
          if (status < 200 || status >= 300)
            throw new ToolFailure(`Image request returned HTTP ${status}`);
          const tooLarge = () =>
            new ToolFailure('Image exceeds the platform size limit');
          if (Number(response.headers['content-length']) > maxBytes)
            throw tooLarge();
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.byteLength;
            if (size > maxBytes) throw tooLarge();
            chunks.push(Buffer.from(chunk));
          }
          return {
            file: imageFile(url, Buffer.concat(chunks, size)),
            sourceUrl: url.href,
          };
        } finally {
          response.destroy();
        }
      }
    });
  } catch (error) {
    parentSignal.throwIfAborted();
    if (signal.aborted) throw new ToolFailure('Image download timed out');
    if (error instanceof ToolFailure) throw error;
    throw new ToolFailure('Image download failed');
  }
}
