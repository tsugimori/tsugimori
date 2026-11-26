import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { assertStaticCsp } from './static-csp.mjs';

const source = new URL('../.output/public/', import.meta.url);
const output = new URL('../../dist/ui/', import.meta.url);

await rm(output, { force: true, recursive: true });
await cp(source, output, { recursive: true });
await mkdir(new URL('_nuxt/', output), { recursive: true });

for (const file of await readdir(output, { recursive: true })) {
  if (!file.endsWith('.html')) continue;
  const page = new URL(file, output);
  const payloads = new Map();
  const html = (await readFile(page, 'utf8')).replace(
    /<script>(window\.__NUXT__=[\s\S]*?)<\/script>/g,
    (_, code) => {
      const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
      const path = '_nuxt/payload-' + hash + '.js';
      payloads.set(path, code);
      return '<script src="/' + path + '"></script>';
    },
  );
  for (const [path, code] of payloads)
    await writeFile(new URL(path, output), code);
  await writeFile(page, html);
}

const files = await assertStaticCsp(fileURLToPath(output));
await writeFile(new URL('files.json', output), JSON.stringify(files));
