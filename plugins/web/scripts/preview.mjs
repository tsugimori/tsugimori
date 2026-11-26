import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renderFixtures } from './ssr.mjs';

const destination = '/tmp/tsugimori-console-preview';
const dist = new URL('../dist/ui/', import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('.vite/manifest.json', dist), 'utf8'),
);
const css = await readFile(
  new URL(manifest['index.html'].css[0], dist),
  'utf8',
);
await mkdir(destination, { recursive: true });

await renderFixtures(async ({ pages }) => {
  for (const { body, chatShell, file, header, title, viewport } of pages()) {
    const content = body
      .replace(/data-indent="([\d.]+)"/g, 'style="--indent:$1px"')
      .replace(
        /data-left="([\d.]+)" data-width="([\d.]+)"/g,
        'style="--left:$1%;--width:$2%"',
      );
    const shell = `${header}<main class="wrap">${content}</main>`;
    const html = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · tsugimori</title><style>${css}</style></head>
<body>${
      chatShell
        ? `<div class="chat-shell">${shell}</div>
<script>const pane = document.querySelector('.timeline-scroll'); pane.scrollTop = pane.scrollHeight;</script>`
        : shell
    }</body></html>`;
    if (viewport) {
      await writeFile(join(destination, file + '-content.html'), html);
      await writeFile(
        join(destination, file + '.html'),
        `<!doctype html><html lang="zh-TW"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · tsugimori</title><style>html{color-scheme:light dark}body{margin:0;display:grid;justify-content:center}iframe{border:0;width:min(${viewport}px,100vw);height:100dvh}</style><iframe title="${title}" src="./${file}-content.html"></iframe></html>`,
      );
    } else await writeFile(join(destination, file + '.html'), html);
  }
});
