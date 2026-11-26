import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

export function encodeText(value: string, binary: true): Buffer;
export function encodeText(value: string, binary?: boolean): string | Buffer;
export function encodeText(value: string, binary = false): string | Buffer {
  const bytes = Buffer.from(value);
  if (bytes.length > 512)
    return Buffer.concat([Buffer.from([1]), zstdCompressSync(bytes)]);
  return binary ? Buffer.concat([Buffer.from([0]), bytes]) : value;
}

export function decodeText(value: string | Uint8Array) {
  if (typeof value === 'string') return value;
  const data = value.subarray(1);
  switch (value[0]) {
    case 0:
      return Buffer.from(data).toString();
    case 1:
      return zstdDecompressSync(data).toString();
    default:
      throw new Error('Unknown record codec');
  }
}

export function encodeRecord(value: unknown, binary: true): Buffer;
export function encodeRecord(value: unknown, binary?: boolean): string | Buffer;
export function encodeRecord(value: unknown, binary = false) {
  return encodeText(JSON.stringify(value), binary);
}

export function decodeRecord<T>(value: string | Uint8Array): T {
  return JSON.parse(decodeText(value)) as T;
}
