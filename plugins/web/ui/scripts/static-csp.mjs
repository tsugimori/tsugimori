import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function assertStaticCsp(directory) {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(directory.length)
        .replace(/^\//, ''),
    )
    .filter((path) => path !== 'files.json')
    .sort();
  const allowed = new Set(files);
  for (const path of files) {
    if (!/\.(?:html|js)$/.test(path)) continue;
    const contents = await readFile(join(directory, path), 'utf8');
    if (path.endsWith('.js')) {
      const inline =
        /createElement\(\s*['"\x60]style['"\x60]|insertAdjacentHTML\([^)]*<style\b|\.innerHTML\s*=\s*['"\x60]<style\b/i;
      assert.ok(
        !inline.test(contents),
        path + ' contains a stylesheet injector',
      );
      continue;
    }
    assert.doesNotMatch(contents, /<style\b|\s(?:style|on[a-z]+)\s*=/i, path);
    for (const [tag, attributes, body] of contents.matchAll(
      /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
    )) {
      const src = /\ssrc="\/([^"]+)"/.exec(attributes)?.[1];
      assert.ok(
        src && allowed.has(src) && !body.trim(),
        path + ' contains an inline or unlisted script: ' + tag,
      );
    }
  }
  for (const route of [
    'index.html',
    '200.html',
    'tasks/index.html',
    'task/index.html',
    'chat/index.html',
    'ops/index.html',
  ]) {
    assert.ok(allowed.has(route), 'Missing console page ' + route);
    const html = await readFile(join(directory, route), 'utf8');
    assert.match(html, /<head>[^]*<script src="\/theme\.js"><\/script>/, route);
    assert.match(
      html,
      /<script src="\/_nuxt\/payload-[\da-f]{16}\.js"><\/script>/,
      route,
    );
  }
  return files;
}
