import { DotLottie } from '@lottiefiles/dotlottie-web';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

export const stickerEdge = 256;
export const stickerFrames = 4;
let ready: Promise<void> | undefined;

// The pinned package exposes the software player through its protected API.
class SoftwarePlayer extends DotLottie {
  core() {
    if (!this._dotLottieCore)
      throw new Error('Lottie software player is unavailable');
    return this._dotLottieCore;
  }

  ready() {
    return new Promise<void>((resolve, reject) => {
      this.addEventListener('ready', () => resolve());
      this.addEventListener('loadError', () =>
        reject(new Error('Could not load Lottie wasm')),
      );
    });
  }
}

async function loadWasm() {
  const path = new URL(
    import.meta.resolve('@lottiefiles/dotlottie-web/dotlottie-player.wasm'),
  );
  const binary = await readFile(path);
  DotLottie.setWasmUrl(
    'data:application/wasm;base64,' + binary.toString('base64'),
  );
}

export async function lottieFrames(data: Uint8Array) {
  const json = gunzipSync(data, { maxOutputLength: 2 * 1024 * 1024 }).toString(
    'utf8',
  );
  await (ready ??= loadWasm());
  const player = new SoftwarePlayer({});
  try {
    await player.ready();
    const core = player.core();
    if (
      !core.setup_sw_target(stickerEdge, stickerEdge) ||
      !core.load_animation(json)
    )
      throw new Error('Invalid Lottie sticker');
    const count = core.total_frames();
    if (!Number.isFinite(count) || count < 1)
      throw new Error('Lottie sticker has no frames');
    const frames: Buffer[] = [];
    for (let i = 0; i < stickerFrames; i++) {
      core.set_frame(Math.floor((i * (count - 1)) / (stickerFrames - 1)));
      core.render();
      const pixels = core.get_pixel_buffer();
      if (pixels.length !== stickerEdge * stickerEdge * 4)
        throw new Error('Lottie sticker has no rendered pixel buffer');
      frames.push(Buffer.from(pixels));
    }
    return Buffer.concat(frames);
  } finally {
    player.destroy();
  }
}
