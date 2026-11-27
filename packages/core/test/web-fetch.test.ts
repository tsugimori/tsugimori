import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import type { PublicWebNetwork } from '../src/public-web.ts';

import { fetchWebPage } from '../src/web-fetch.ts';

const url = 'https://public.example.test/';
const signal = new AbortController().signal;
const address = '93.184.216.34';

function response(body: string, contentType: string) {
  return Object.assign(Readable.from([Buffer.from(body)]), {
    headers: { 'content-type': contentType },
    statusCode: 200,
  });
}

function network(reply: ReturnType<typeof response>): PublicWebNetwork {
  return { resolve: async () => [address], connect: async () => reply };
}

test('web.fetch renders HTML as untrusted text and returns final response metadata', async () => {
  const page = response(
    '<head><title>ignored</title></head><p>Hello &amp; welcome.</p><script>ignored</script><p>Next.</p>',
    'text/html; charset=utf-8',
  );
  const result = await fetchWebPage(url, signal, {
    resolve: async () => [address],
    async connect(target, checked) {
      assert.equal(checked, address);
      return target.pathname === '/article'
        ? page
        : Object.assign(Readable.from([]), {
            statusCode: 302,
            headers: { location: '/article' },
          });
    },
  });
  assert.deepEqual(result, {
    url: url + 'article',
    status: 200,
    contentType: 'text/html',
    truncated: false,
    content: JSON.stringify({
      source: 'external',
      trust: 'untrusted',
      content: 'Hello & welcome.\n\nNext.',
    }),
  });
  assert.equal(page.destroyed, true);
});

test('web.fetch limits bytes and characters and skips binary bodies', async () => {
  const long = await fetchWebPage(
    url,
    signal,
    network(response('界'.repeat(12_001), 'text/plain')),
  );
  assert.ok('content' in long);
  assert.equal(JSON.parse(long.content).content.length, 12_000);
  assert.equal(long.truncated, true);

  const large = await fetchWebPage(
    url,
    signal,
    network(response('<script>' + ' '.repeat(512 * 1024), 'text/html')),
  );
  assert.equal(large.truncated, true);
  assert.ok('content' in large);
  assert.equal(JSON.parse(large.content).content, '');

  const binary = response('unread', 'image/png');
  const result = await fetchWebPage(url, signal, network(binary));
  assert.deepEqual(result, {
    url,
    status: 200,
    contentType: 'image/png',
    truncated: false,
  });
  assert.equal(binary.readableEnded, false);
  assert.equal(binary.destroyed, true);
});

test('web.fetch rejects a redirect whose DNS includes a private address', async () => {
  let connections = 0;
  await assert.rejects(
    fetchWebPage(url, signal, {
      resolve: async (host) =>
        host === 'internal.example.test' ? [address, '100.64.1.1'] : [address],
      async connect() {
        connections++;
        return Object.assign(Readable.from([]), {
          statusCode: 302,
          headers: {
            location: 'http://internal.example.test/',
          },
        });
      },
    }),
    /blocked address/,
  );
  assert.equal(connections, 1);
});
