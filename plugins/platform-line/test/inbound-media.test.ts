import { ToolFailure } from '@tsugimori/plugin-sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LineApi } from '../src/api.ts';
import { mapEvent } from '../src/updates.ts';

function incoming(message: Record<string, unknown>) {
  const mapped = mapEvent(
    {
      type: 'message',
      source: { type: 'user', userId: 'sender' },
      timestamp: 123,
      message: { id: 'item', ...message },
    },
    { emit: () => Promise.resolve() },
  );
  assert.ok(mapped);
  return mapped.inbound;
}

test('maps LINE image, file and sticker metadata and the quoted message ID', () => {
  const image = incoming({ type: 'image', contentProvider: { type: 'line' } });
  assert.equal(image.text, '[image]');
  assert.equal(image.at, 123);
  assert.equal(image.attachments?.[0]?.fileId, 'item');
  assert.equal(image.attachments?.[0]?.kind, 'image');

  const file = incoming({ type: 'file', fileName: 'report.pdf', fileSize: 13 });
  assert.deepEqual(file.attachments?.[0], {
    index: 0,
    kind: 'file',
    name: 'report.pdf',
    size: 13,
    fileId: 'item',
  });
  const sticker = incoming({
    type: 'sticker',
    packageId: '1',
    stickerId: '11',
    stickerResourceType: 'ANIMATION',
    keywords: ['happy'],
    quotedMessageId: 'older',
  });
  assert.equal(sticker.text, '[sticker]');
  assert.deepEqual(sticker.attachments?.[0], {
    index: 0,
    kind: 'sticker',
    fileId: 'sticker:11',
    set: '1',
    stickerFormat: 'static',
    stickerId: '11',
    stickerResourceType: 'ANIMATION',
    keywords: ['happy'],
  });
  assert.deepEqual(sticker.replyTo, { id: 'older' });
  assert.deepEqual(
    incoming({ type: 'text', text: 'Read that file', quotedMessageId: 'older' })
      .replyTo,
    { id: 'older' },
  );
});

const sticker = {
  index: 0,
  kind: 'sticker',
  stickerId: '11',
  fileId: 'sticker:11',
} as const;
const stickerUrl =
  'https://stickershop.line-scdn.net/stickershop/v1/sticker/11';
const png = Buffer.from('89504e470d0a1a0a', 'hex');

test('LINE tries the iPhone sticker on Android 404 and omits credentials', async () => {
  const paths: string[] = [];
  const api = new LineApi(async (input, init) => {
    paths.push(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'GET');
    assert.ok(init?.signal);
    return paths.length === 1
      ? new Response('not found', { status: 404 })
      : new Response(png);
  }, 'fixture');
  const { bytes, mime } = await api.downloadAttachment(
    sticker,
    new AbortController().signal,
    png.length,
  );
  assert.deepEqual(paths, [
    `${stickerUrl}/android/sticker.png`,
    `${stickerUrl}/iPhone/sticker@2x.png`,
  ]);
  assert.equal(mime, 'image/png');
  assert.deepEqual(Buffer.from(bytes), png);
});

test('LINE rejects non-PNG and oversized sticker responses', async () => {
  const signal = new AbortController().signal;
  const cases: { bytes: BodyInit; headers?: HeadersInit }[] = [
    { bytes: png, headers: { 'Content-Type': 'image/gif' } },
    { bytes: Buffer.from('not PNG') },
    { bytes: Buffer.from('not PNG'), headers: { 'Content-Type': 'image/png' } },
    {
      bytes: png,
      headers: { 'Content-Length': '9', 'Content-Type': 'image/png' },
    },
    { bytes: Buffer.concat([png, Buffer.from('extra')]) },
  ];
  for (const { bytes, headers } of cases) {
    let requests = 0;
    const api = new LineApi(async () => {
      requests++;
      return new Response(bytes, { headers });
    }, 'fixture');
    await assert.rejects(
      api.downloadAttachment(sticker, signal, png.length),
      ToolFailure,
    );
    assert.equal(requests, 1);
  }
});

test('LINE sticker downloads never fetch a malformed sticker ID', async () => {
  let requests = 0;
  const api = new LineApi(async () => {
    requests++;
    return new Response(png);
  }, 'fixture');
  const signal = new AbortController().signal;
  for (const id of ['11/12', '11?extra', '11\n', '１２']) {
    const [attachment] = incoming({
      type: 'sticker',
      stickerId: id,
    }).attachments!;
    assert.equal(attachment?.fileId, undefined);
    await assert.rejects(
      api.downloadAttachment(attachment!, signal),
      ToolFailure,
    );
    await assert.rejects(
      api.downloadAttachment({ ...sticker, fileId: `sticker:${id}` }, signal),
      ToolFailure,
    );
  }
  assert.equal(requests, 0);
});

test('LINE fetches hosted message content with the channel token', async () => {
  const api = new LineApi(async (input, init) => {
    assert.equal(
      String(input),
      'https://api-data.line.me/v2/bot/message/item/content',
    );
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer fixture',
    );
    return new Response('abc', { headers: { 'Content-Type': 'image/png' } });
  }, 'fixture');
  const signal = new AbortController().signal;
  const photo = incoming({ type: 'image', contentProvider: { type: 'line' } });
  const result = await api.downloadAttachment(photo.attachments![0]!, signal);
  assert.equal(result.mime, 'image/png');
  assert.equal(Buffer.from(result.bytes).toString(), 'abc');
  const external = incoming({
    type: 'image',
    contentProvider: {
      type: 'external',
      originalContentUrl: 'https://example.invalid/photo',
    },
  });
  await assert.rejects(
    api.downloadAttachment(external.attachments![0]!, signal),
    /unavailable/,
  );
});
