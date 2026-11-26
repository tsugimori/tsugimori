import type {
  AgentImage,
  ImageLimits,
  InboundAttachment,
} from '@tsugimori/plugin-sdk';

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { lottieFrames, stickerEdge, stickerFrames } from './lottie.ts';

const frameBytes = stickerEdge * stickerEdge * 4;
const rawSticker = [
  '-f',
  'rawvideo',
  '-pixel_format',
  'rgba',
  '-video_size',
  `${stickerEdge}x${stickerEdge}`,
];
const maxVideoFrames = 60;

export class FfmpegMissing extends Error {}

export async function findFfmpeg() {
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const pathEnv = process.env.PATH;
  if (!pathEnv) return;
  for (const entry of pathEnv.split(delimiter)) {
    const path = resolve(entry, executable);
    try {
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' ||
          error.code === 'ENOTDIR' ||
          error.code === 'EACCES')
      ))
        throw error;
    }
  }
}

async function ffmpeg(
  command: string,
  input: Uint8Array,
  args: string[],
  maxBytes: number,
  signal: AbortSignal,
) {
  const controller = new AbortController();
  const child = spawn(
    command,
    [
      '-loglevel',
      'error',
      '-nostdin',
      '-filter_threads',
      '1',
      '-filter_complex_threads',
      '1',
      ...args,
    ],
    {
      env: { PATH: process.env.PATH },
      stdio: ['pipe', 'pipe', 'ignore'],
      signal: AbortSignal.any([
        signal,
        controller.signal,
        AbortSignal.timeout(10_000),
      ]),
    },
  );
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => {
      const missing = 'code' in error && error.code === 'ENOENT';
      reject(
        missing
          ? new FfmpegMissing('ffmpeg is unavailable on PATH')
          : new Error('ffmpeg media processing was interrupted'),
      );
    });
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg could not decode or encode this media'));
    });
  });
  const writing = pipeline([input], child.stdin).catch((error: unknown) => {
    // The decoder can close its input once it has the first frame.
    if (!(
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EPIPE' || error.code === 'ERR_STREAM_PREMATURE_CLOSE')
    ))
      throw error;
  });
  const reading = (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const bytes of child.stdout as AsyncIterable<Buffer>) {
      size += bytes.length;
      if (size > maxBytes)
        throw new Error('ffmpeg output exceeds the media processing limit');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  })();
  try {
    const [output] = await Promise.all([reading, exited, writing]);
    return output;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    controller.abort();
  }
}

function scale(limits: ImageLimits, edge: number) {
  const pixels = limits.maxPixels ?? edge * edge;
  const factor = `min(1,min(${edge}/max(iw,ih),sqrt(${pixels}/(iw*ih))))`;
  return `scale=w='max(1,floor(iw*${factor}))':h='max(1,floor(ih*${factor}))':flags=lanczos`;
}

const pipeInput = [
  '-protocol_whitelist',
  'pipe',
  '-threads',
  '1',
  '-max_pixels',
  '50000000',
];

async function videoFrames(
  command: string,
  input: Uint8Array,
  signal: AbortSignal,
) {
  const raw = await ffmpeg(
    command,
    input,
    [
      ...pipeInput,
      '-c:v',
      'libvpx-vp9',
      '-f',
      'webm',
      '-i',
      'pipe:0',
      '-vf',
      `fps=12,scale=${stickerEdge}:${stickerEdge}:force_original_aspect_ratio=decrease,format=rgba,pad=${stickerEdge}:${stickerEdge}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      '-frames:v',
      String(maxVideoFrames),
      '-an',
      '-pix_fmt',
      'rgba',
      '-threads',
      '1',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    frameBytes * maxVideoFrames,
    signal,
  );
  const count = raw.length / frameBytes;
  if (count < 1 || !Number.isInteger(count))
    throw new Error('WebM sticker has no complete frames');
  return Buffer.concat(
    Array.from({ length: stickerFrames }, (_, i) => {
      const frame = Math.round((i * (count - 1)) / (stickerFrames - 1));
      return raw.subarray(frame * frameBytes, (frame + 1) * frameBytes);
    }),
  );
}

function grid(limits: ImageLimits, edge: number) {
  const outputs = Array.from(
    { length: stickerFrames },
    (_, i) => `[frame${i}]`,
  );
  return [
    'split=4[a][b][c][d]',
    ...['a', 'b', 'c', 'd'].map(
      (label, i) =>
        `[${label}]select='eq(n,${i})',setpts=PTS-STARTPTS${outputs[i]}`,
    ),
    `${outputs.join('')}xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0,${scale(limits, edge)}`,
  ].join(';');
}

export async function prepareImage(
  input: Uint8Array,
  attachment: InboundAttachment,
  limits: ImageLimits,
  signal: AbortSignal,
  command = 'ffmpeg',
): Promise<AgentImage> {
  const animated =
    attachment.stickerFormat === 'lottie' ||
    attachment.stickerFormat === 'video';
  const frames =
    attachment.stickerFormat === 'lottie'
      ? await lottieFrames(input)
      : attachment.stickerFormat === 'video'
        ? await videoFrames(command, input, signal)
        : input;
  const png = attachment.kind === 'sticker';
  const mime = png ? 'image/png' : 'image/jpeg';
  for (let edge = limits.maxEdge; edge >= 1; edge = Math.floor(edge / 2)) {
    const output = await ffmpeg(
      command,
      frames,
      [
        ...pipeInput,
        ...(animated ? rawSticker : []),
        '-i',
        'pipe:0',
        '-an',
        '-sn',
        '-map_metadata',
        '-1',
        ...(animated
          ? ['-filter_complex', grid(limits, edge)]
          : ['-vf', scale(limits, edge)]),
        '-frames:v',
        '1',
        ...(png
          ? ['-c:v', 'png', '-pix_fmt', 'rgba']
          : ['-c:v', 'mjpeg', '-q:v', '4', '-pix_fmt', 'yuvj444p']),
        '-threads',
        '1',
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      Math.max(
        limits.maxBytes,
        Math.min(edge * edge, limits.maxPixels ?? Infinity) * 4 + 65_536,
      ),
      signal,
    );
    if (output.length > 0 && output.length <= limits.maxBytes)
      return { data: output.toString('base64'), mime };
  }
  throw new Error('Image could not be encoded within the agent size limit');
}
