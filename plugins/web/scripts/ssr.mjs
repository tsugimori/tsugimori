import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const fromWeb = (relative) => fileURLToPath(new URL(relative, import.meta.url));

export async function renderFixtures(run) {
  const directory = await mkdtemp(join(tmpdir(), 'tsugimori-web-ssr-'));
  try {
    await build({
      configFile: fromWeb('../vite.config.ts'),
      logLevel: 'error',
      ssr: { noExternal: true },
      build: {
        ssr: fromWeb('../ui/src/fixtures.ts'),
        outDir: directory,
        manifest: false,
        rollupOptions: { output: { entryFileNames: 'fixtures.mjs' } },
      },
    });
    const fixtures = await import(
      pathToFileURL(join(directory, 'fixtures.mjs')).href
    );
    return await run(fixtures);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
