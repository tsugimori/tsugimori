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
    keywords: ['happy'],
    quotedMessageId: 'older',
  });
  assert.equal(sticker.text, '[sticker]');
  assert.deepEqual(sticker.attachments?.[0], {
    index: 0,
    kind: 'sticker',
    set: '1',
    stickerId: '11',
    keywords: ['happy'],
  });
  assert.deepEqual(sticker.replyTo, { id: 'older' });
  assert.deepEqual(
    incoming({ type: 'text', text: 'Read that file', quotedMessageId: 'older' })
      .replyTo,
    { id: 'older' },
  );
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
