import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import type { WebImageNetwork } from '../src/web-image.ts';

import { fetchWebAudio, fetchWebImage } from '../src/web-image.ts';

const url = 'https://images.example.test/example';
const signal = new AbortController().signal;
const publicAddress = '93.184.216.34';
const png = Buffer.from('89504e470d0a1a0a', 'hex');

test('web audio requires HTTPS and public addresses across redirects', async () => {
  for (const [location, failure] of [
    ['http://audio.example.test/speech.wav', /HTTPS audio URL/],
    ['https://127.0.0.1/speech.wav', /blocked address/],
  ] as const) {
    const response = Object.assign(Readable.from([]), {
      statusCode: 302,
      headers: { location },
    });
    await assert.rejects(
      fetchWebAudio(url, 100, signal, {
        resolve: async () => [publicAddress],
        async connect(target) {
          assert.equal(target.href, url);
          return response;
        },
      }),
      failure,
    );
    assert.equal(response.destroyed, true);
  }
});

test('web image downloads reject non-public DNS answers before connecting', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '::1',
    '::ffff:10.0.0.1',
    '100.64.1.1',
    '224.0.0.1',
    '0.0.0.0',
    '::',
    'fc00::1',
    'fe80::1',
    'ff00::1',
    '2001:db8::1',
  ]) {
    await assert.rejects(
      fetchWebImage(url, 100, signal, {
        resolve: async () => [publicAddress, address],
        connect: async () =>
          assert.fail('blocked DNS answer must not reach transport'),
      }),
      /blocked address/,
      address,
    );
  }
});

test('web image redirects resolve each destination and refuse private addresses and credentials', async () => {
  for (const [location, error] of [
    ['http://2130706433/private', /blocked address/],
    ['http://internal.example.test/private', /blocked address/],
    [
      'https://user:password@images.example.test/private',
      /cannot contain credentials/,
    ],
    ['file:///example.png', /HTTP or HTTPS/],
  ] as const) {
    const hosts: string[] = [];
    const response = Object.assign(Readable.from([]), {
      statusCode: 302,
      headers: { location },
    });
    let connections = 0;
    await assert.rejects(
      fetchWebImage(url, 100, signal, {
        async resolve(host) {
          hosts.push(host);
          return [
            host === 'internal.example.test' ? '10.0.0.1' : publicAddress,
          ];
        },
        async connect(target, address) {
          connections++;
          assert.equal(target.href, url);
          assert.equal(address, publicAddress);
          return response;
        },
      }),
      error,
    );
    assert.deepEqual(
      hosts,
      location.includes('internal')
        ? ['images.example.test', 'internal.example.test']
        : ['images.example.test'],
    );
    assert.equal(connections, 1);
    assert.equal(response.destroyed, true);
  }
});

test('web image fetch allows three redirects and returns the final URL and filename', async () => {
  let connections = 0;
  const io: WebImageNetwork = {
    resolve: async () => [publicAddress],
    async connect(_target, address) {
      assert.equal(address, publicAddress);
      const statusCode = ++connections <= 3 ? 302 : 200;
      return Object.assign(Readable.from([png]), {
        statusCode,
        headers: { location: '/picture' + connections + '.png' },
      });
    },
  };
  const { file, sourceUrl } = await fetchWebImage(url, png.length, signal, io);
  assert.equal(file.name, 'picture3.png');
  assert.equal(sourceUrl, 'https://images.example.test/picture3.png');
  assert.equal(connections, 4);
  await assert.rejects(
    fetchWebImage(url, 100, signal, {
      ...io,
      connect: async () =>
        Object.assign(Readable.from([]), {
          statusCode: 302,
          headers: { location: '/next' },
        }),
    }),
    /too many image redirects/i,
  );
});

test('web image fetch aborts a body over the byte cap and checks magic bytes', async () => {
  for (const [chunks, headers, error] of [
    [[png, Buffer.alloc(4)], {}, /size limit/],
    [[png], { 'content-length': '12' }, /size limit/],
    [[Buffer.from('<html>')], { 'content-type': 'image/png' }, /not an image/],
  ] as const) {
    const response = Object.assign(Readable.from(chunks), {
      statusCode: 200,
      headers,
    });
    await assert.rejects(
      fetchWebImage(url, png.length, signal, {
        resolve: async () => [publicAddress],
        connect: async () => response,
      }),
      error,
    );
    assert.equal(response.destroyed, true);
  }
});

test('the web image timeout includes DNS resolution', async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 15_000);
    return deadline.signal;
  });
  const resolving = Promise.withResolvers<void>();
  const addresses = Promise.withResolvers<string[]>();
  const download = fetchWebImage(url, png.length, signal, {
    resolve() {
      resolving.resolve();
      return addresses.promise;
    },
    connect: async () =>
      assert.fail('the request must not connect after the deadline'),
  });
  await resolving.promise;
  deadline.abort();
  await assert.rejects(download, /download timed out/);
  addresses.resolve([publicAddress]);
});
