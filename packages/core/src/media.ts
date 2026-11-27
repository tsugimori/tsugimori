import type {
  AgentImage,
  ImageLimits,
  InboundAttachment,
  MediaDestination,
  MediaFile,
  MediaUpload,
} from '@tsugimori/plugin-sdk';

import { ToolFailure } from '@tsugimori/plugin-sdk';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, extname, join, resolve } from 'node:path';
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

class FfmpegOutputLimit extends Error {}

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
        throw new FfmpegOutputLimit(
          'ffmpeg output exceeds the media processing limit',
        );
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

export async function prepareAudio(
  file: MediaFile,
  voice: boolean,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Pick<MediaUpload, 'audioDurationMs' | 'file'>> {
  signal.throwIfAborted();
  const command = await findFfmpeg();
  const missing = () =>
    new ToolFailure(
      'ffmpeg is required to send audio. Install it and make it available on PATH.',
    );
  if (!command) throw missing();

  const input = [
    ...pipeInput,
    '-protocol_whitelist',
    'cache,pipe',
    '-read_ahead_limit',
    '-1',
    '-abort_on',
    'empty_output',
    '-i',
    'cache:pipe:0',
    '-map',
    '0:a:0',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-threads',
    '1',
  ];
  const name = basename(file.name, extname(file.name)) || 'audio';
  const tooLarge = () =>
    new ToolFailure(
      `Encoded audio exceeds the platform's ${maxBytes / 1024 ** 2} MB size limit`,
    );
  let directory: string | undefined;
  try {
    if (voice) {
      const bytes = await ffmpeg(
        command,
        file.bytes,
        [
          ...input,
          '-ac',
          '1',
          '-ar',
          '48000',
          '-c:a',
          'libopus',
          '-b:a',
          '48k',
          '-f',
          'ogg',
          'pipe:1',
        ],
        maxBytes,
        signal,
      );
      if (!bytes.length)
        throw new ToolFailure('Audio contains no playable samples');
      return { file: { bytes, name: `${name}.ogg`, mime: 'audio/ogg' } };
    }

    // M4A needs seekable output for its playback metadata and fast-start header.
    directory = await mkdtemp(join(tmpdir(), 'tsugimori-audio-'));
    const output = join(directory, 'audio.m4a');
    const progress = await ffmpeg(
      command,
      file.bytes,
      [
        '-progress',
        'pipe:1',
        ...input,
        '-ac',
        '2',
        '-ar',
        '48000',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        // Allow limited muxer overhead before rejecting the entire oversized output.
        '-fs',
        String(maxBytes + 65_536),
        '-f',
        'ipod',
        output,
      ],
      65_536,
      signal,
    );
    if ((await stat(output)).size > maxBytes) throw tooLarge();
    const timestamp = [
      ...progress.toString().matchAll(/^out_time_us=(\d+)$/gm),
    ].at(-1)?.[1];
    const duration = Math.round(Number(timestamp) / 1_000);
    if (!Number.isSafeInteger(duration) || duration <= 0)
      throw new ToolFailure('Audio contains no playable samples');
    const bytes = await readFile(output, { signal });
    return {
      audioDurationMs: duration,
      file: { bytes, name: `${name}.m4a`, mime: 'audio/mp4' },
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ToolFailure) throw error;
    if (error instanceof FfmpegMissing) throw missing();
    if (error instanceof FfmpegOutputLimit) throw tooLarge();
    throw new ToolFailure('Could not decode and encode this audio with ffmpeg');
  } finally {
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
  }
}

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
  const seekableVideo =
    attachment.kind === 'video' && attachment.mime === 'video/mp4';
  const png = attachment.kind === 'sticker';
  const mime = png ? 'image/png' : 'image/jpeg';
  for (let edge = limits.maxEdge; edge >= 1; edge = Math.floor(edge / 2)) {
    const output = await ffmpeg(
      command,
      frames,
      [
        ...pipeInput,
        ...(animated ? rawSticker : []),
        ...(seekableVideo
          ? [
              '-protocol_whitelist',
              'cache,pipe',
              '-read_ahead_limit',
              '-1',
              '-f',
              'mov',
            ]
          : []),
        '-i',
        seekableVideo ? 'cache:pipe:0' : 'pipe:0',
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

/** Assemble one row-major sheet from the same thumbnails used for agent image input. */
export async function prepareStickerGrid(
  thumbnails: readonly AgentImage[],
  limits: ImageLimits,
  signal: AbortSignal,
  command: string,
): Promise<AgentImage> {
  const columns = Math.min(4, thumbnails.length);
  const rows = Math.ceil(thumbnails.length / columns);
  const edge = Math.min(
    128,
    Math.floor(limits.maxEdge / Math.max(rows, columns)),
    Math.floor(Math.sqrt((limits.maxPixels ?? Infinity) / (rows * columns))),
  );
  if (!Number.isFinite(edge) || edge < 1)
    throw new Error('Sticker grid exceeds the agent image dimensions');
  const width = columns * edge;
  const height = rows * edge;
  const rowBytes = edge * 3;
  const frames = Buffer.alloc(width * height * 3, 235);
  for (const [index, thumbnail] of thumbnails.entries()) {
    const tile = await ffmpeg(
      command,
      Buffer.from(thumbnail.data, 'base64'),
      [
        ...pipeInput,
        '-i',
        'pipe:0',
        '-vf',
        `scale=${edge}:${edge}:force_original_aspect_ratio=decrease,format=rgba,pad=${edge}:${edge}:(ow-iw)/2:(oh-ih)/2:color=white@0`,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgba',
        '-threads',
        '1',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      edge * edge * 4,
      signal,
    );
    if (tile.length !== edge * edge * 4)
      throw new Error('Could not render a complete sticker thumbnail');
    const tileRow = Math.floor(index / columns) * edge;
    const tileColumn = (index % columns) * rowBytes;
    for (let y = 0; y < edge; y++) {
      const offset = (tileRow + y) * width * 3 + tileColumn;
      for (let x = 0; x < edge; x++) {
        const start = (y * edge + x) * 4;
        const alpha = tile[start + 3]! / 255;
        for (let channel = 0; channel < 3; channel++)
          frames[offset + x * 3 + channel] = Math.round(
            tile[start + channel]! * alpha + 235 * (1 - alpha),
          );
      }
    }
  }
  for (const quality of [4, 10, 20, 31]) {
    const jpeg = await ffmpeg(
      command,
      frames,
      [
        ...pipeInput,
        '-f',
        'rawvideo',
        '-pixel_format',
        'rgb24',
        '-video_size',
        `${width}x${height}`,
        '-i',
        'pipe:0',
        '-frames:v',
        '1',
        '-c:v',
        'mjpeg',
        '-pix_fmt',
        'yuvj444p',
        '-q:v',
        String(quality),
        '-threads',
        '1',
        '-f',
        'image2pipe',
        'pipe:1',
      ],
      Math.max(limits.maxBytes, frames.byteLength + 65_536),
      signal,
    );
    if (jpeg.length && jpeg.length <= limits.maxBytes)
      return { data: jpeg.toString('base64'), mime: 'image/jpeg' };
  }
  throw new Error(
    'Sticker grid could not be encoded within the agent size limit',
  );
}

export function mediaUpload(
  address: MediaDestination,
  {
    audioDurationMs,
    file,
    sourceUrl,
  }: Pick<MediaUpload, 'audioDurationMs' | 'file' | 'sourceUrl'>,
  signal: AbortSignal,
): MediaUpload {
  return {
    ...address,
    file,
    ...(audioDurationMs !== undefined && { audioDurationMs }),
    ...(sourceUrl !== undefined && { sourceUrl }),
    async preview(maxBytes) {
      const ffmpeg = await findFfmpeg();
      if (!ffmpeg)
        throw new ToolFailure(
          'ffmpeg is required to prepare this media preview',
        );
      try {
        const image = await prepareImage(
          file.bytes,
          {
            index: 0,
            kind: file.mime === 'video/mp4' ? 'video' : 'image',
            mime: file.mime,
          },
          { maxBytes, maxEdge: 640 },
          signal,
          ffmpeg,
        );
        return { bytes: Buffer.from(image.data, 'base64'), mime: image.mime };
      } catch {
        signal.throwIfAborted();
        throw new ToolFailure('Could not prepare this media preview');
      }
    },
  };
}
