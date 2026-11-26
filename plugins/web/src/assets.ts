import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const assetPath = /^assets\/[A-Za-z0-9_.-]+$/;
const media: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
};

interface Entry {
  assets?: string[];
  css?: string[];
  file: string;
}

export class Assets {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  index() {
    return this.#read('index.html');
  }

  async get(path: string) {
    if (!assetPath.test(path) || path.endsWith('/..') || path.endsWith('/.'))
      return;
    const allowed = await this.#load();
    if (!allowed?.has(path)) return;
    const body = await this.#read(path);
    if (!body) return;
    return {
      body,
      type:
        media[path.slice(path.lastIndexOf('.') + 1)] ??
        'application/octet-stream',
    };
  }

  async #load() {
    const file = await this.#read('.vite/manifest.json');
    if (!file) return;
    const entries = Object.values(
      JSON.parse(file.toString('utf8')) as Record<string, Entry>,
    );
    return new Set(
      entries.flatMap(({ file, assets, css }) => [
        file,
        ...(css ?? []),
        ...(assets ?? []),
      ]),
    );
  }

  async #read(relative: string) {
    try {
      return await readFile(join(this.#directory, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
