import { ToolFailure } from '@tsugimori/plugin-sdk';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { prepareAudio, prepareImage } from '../src/media.ts';

const signal = new AbortController().signal;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = !hasFfmpeg && 'ffmpeg is unavailable on PATH';
const limits = { maxEdge: 64, maxBytes: 8_000 };

function ffmpeg(args: string[], input?: Uint8Array) {
  return execFileSync(
    'ffmpeg',
    ['-loglevel', 'error', '-filter_threads', '1', ...args],
    { input },
  );
}

test('audio preparation reports a missing ffmpeg as a tool failure', async () => {
  const path = process.env.PATH;
  delete process.env.PATH;
  try {
    await assert.rejects(
      prepareAudio(
        { bytes: Buffer.alloc(0), name: 'speech.wav' },
        false,
        1000,
        signal,
      ),
      (error: unknown) =>
        error instanceof ToolFailure &&
        /ffmpeg is required to send audio/.test(error.message),
    );
  } finally {
    if (path !== undefined) process.env.PATH = path;
  }
});

test(
  'audio preparation fails when either encoded format exceeds the byte limit',
  { skip },
  async () => {
    const bytes = ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.25',
      '-f',
      'wav',
      'pipe:1',
    ]);
    for (const voice of [false, true]) {
      await assert.rejects(
        prepareAudio({ bytes, name: 'sine.wav' }, voice, 1000, signal),
        /Encoded audio exceeds/,
      );
    }
  },
);

function pngSize(png: Buffer) {
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

function pixels(image: Uint8Array, format: 'rgb24' | 'rgba') {
  return ffmpeg(
    [
      '-i',
      'pipe:0',
      '-pix_fmt',
      format,
      '-threads',
      '1',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    image,
  );
}

test(
  'resizes photos in memory to the configured long edge and byte limit',
  { skip },
  async () => {
    const bytes = ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=240x120',
      '-frames:v',
      '1',
      '-threads',
      '1',
      '-c:v',
      'png',
      '-f',
      'image2pipe',
      'pipe:1',
    ]);
    const image = await prepareImage(
      bytes,
      { kind: 'image', index: 0 },
      limits,
      signal,
    );
    assert.equal(image.mime, 'image/jpeg');
    const jpeg = Buffer.from(image.data, 'base64');
    assert.ok(jpeg.length <= limits.maxBytes);
    assert.equal(pixels(jpeg, 'rgb24').length, 64 * 32 * 3);

    const small = await prepareImage(
      bytes,
      { kind: 'image', index: 0 },
      { ...limits, maxBytes: 300 },
      signal,
    );
    assert.ok(Buffer.from(small.data, 'base64').length <= 300);
  },
);

test(
  'renders four evenly spaced WebM frames and preserves alpha',
  { skip },
  async () => {
    const input = ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=64x48:r=12:d=1,format=yuva420p,colorchannelmixer=aa=0.5',
      '-c:v',
      'libvpx-vp9',
      '-threads',
      '1',
      '-f',
      'webm',
      'pipe:1',
    ]);
    const grid = await prepareImage(
      input,
      { kind: 'sticker', index: 0, stickerFormat: 'video' },
      limits,
      signal,
    );
    const png = Buffer.from(grid.data, 'base64');
    assert.deepEqual(pngSize(png), [64, 64]);
    const rgba = pixels(png, 'rgba');
    const at = (x: number, y: number) =>
      rgba.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4);
    assert.equal(at(15, 0)[3], 0);
    assert.ok(at(15, 16)[3]! > 0 && at(15, 16)[3]! < 255);
    const tile = (x: number, y: number) =>
      Buffer.concat(
        Array.from({ length: 32 }, (_, row) => {
          const start = ((y + row) * 64 + x) * 4;
          return rgba.subarray(start, start + 32 * 4);
        }),
      );
    assert.notDeepEqual(tile(0, 0), tile(32, 32));
  },
);

test(
  'renders a TGS animation from package wasm into a four-frame grid',
  { skip },
  async () => {
    const fixture = await readFile(
      new URL('./fixtures/sticker.json', import.meta.url),
    );
    const grid = await prepareImage(
      gzipSync(fixture),
      { kind: 'sticker', index: 0, stickerFormat: 'lottie' },
      limits,
      signal,
    );
    const png = Buffer.from(grid.data, 'base64');
    assert.deepEqual(pngSize(png), [64, 64]);
    const rgba = pixels(png, 'rgba');
    const pixel = (x: number, y: number) => [
      ...rgba.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4),
    ];
    assert.deepEqual(pixel(3, 12), [255, 0, 0, 255]);
    assert.deepEqual(pixel(32 + 28, 32 + 12), [255, 0, 0, 255]);
    assert.equal(pixel(28, 12)[3], 0);
  },
);
