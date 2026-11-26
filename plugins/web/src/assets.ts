import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const filePath = /^(?:[\w.-]+\/)*[\w.-]+$/;
const media: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const hashed =
  /^(?:_nuxt\/(?:[\w-]+[.-])?[\w-]{8,}\.(?:css|js|woff2?)|_nuxt\/builds\/meta\/[\w-]+\.json)$/;

export class Assets {
  readonly #directory: string;
  #files?: ReadonlySet<string>;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async page(path: string) {
    const name = path.replace(/^\/|\/$/g, '');
    const route = name ? name + '/index.html' : 'index.html';
    return (
      (await this.get(route)) ??
      (await this.get('200.html')) ??
      (await this.get('index.html'))
    );
  }

  async get(path: string) {
    if (
      !filePath.test(path) ||
      path.split('/').some((piece) => piece.startsWith('.'))
    )
      return;
    const allowed = await this.#load();
    if (!allowed?.has(path)) return;
    const body = await this.#read(path);
    if (!body) return;
    return {
      body,
      cache: hashed.test(path)
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
      type: media[extname(path)] ?? 'application/octet-stream',
    };
  }

  async #load() {
    if (this.#files) return this.#files;
    const file = await this.#read('files.json');
    if (file)
      this.#files = new Set(JSON.parse(file.toString('utf8')) as string[]);
    return this.#files;
  }

  async #read(relative: string) {
    try {
      return await readFile(join(this.#directory, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
