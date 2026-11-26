import { ToolFailure } from '@tsugimori/plugin-sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BotApi } from '../src/api.ts';
import { mapUpdate } from '../src/updates.ts';

const bot = { id: '2', username: 'helper' };
const sender = { id: 3, first_name: 'Ada', last_name: 'Lee' };
const file = {
  file_id: 'remote-1',
  file_name: 'notes.pdf',
  file_size: 12,
  mime_type: 'application/pdf',
};
function incoming(content: Record<string, unknown>) {
  const mapped = mapUpdate(
    {
      message: {
        chat: { id: 5, type: 'private' },
        from: sender,
        date: 123,
        message_id: 7,
        ...content,
      },
    },
    bot,
  );
  assert.equal(mapped?.type, 'message');
  return mapped;
}

test('maps the reply snapshot and partial quote with the original document reference', () => {
  const message = incoming({
    text: 'Explain this extract',
    reply_to_message: {
      message_id: 6,
      from: sender,
      caption: 'Original caption',
      document: file,
    },
    quote: { text: 'Original' },
  });
  assert.equal(message.messageId, '7');
  assert.equal(message.at, 123_000);
  assert.equal(message.userDisplay, 'Ada Lee');
  assert.deepEqual(message.replyTo?.sender, { id: '3', name: 'Ada Lee' });
  assert.equal(message.replyTo?.id, '6');
  assert.equal(message.replyTo?.text, 'Original caption');
  assert.equal(message.replyTo?.quote, 'Original');
  assert.deepEqual(
    message.replyTo?.attachments?.map(
      ({ fileId, index, kind, mime, name, size }) => ({
        fileId,
        index,
        kind,
        mime,
        name,
        size,
      }),
    ),
    [
      {
        index: 0,
        kind: 'file',
        fileId: 'remote-1',
        name: 'notes.pdf',
        mime: 'application/pdf',
        size: 12,
      },
    ],
  );
});

test('keeps the largest photo and its media group on each native update', () => {
  const photo = [
    { file_id: 'large', width: 400, height: 200, file_size: 200 },
    { file_id: 'small', width: 40, height: 20 },
  ];
  const single = incoming({ photo });
  assert.equal(single.text, '[image]');
  assert.deepEqual(single.attachments?.[0], {
    index: 0,
    kind: 'image',
    fileId: 'large',
    width: 400,
    height: 200,
    mime: 'image/jpeg',
    size: 200,
    name: undefined,
  });
  assert.equal(incoming({ photo, media_group_id: 'album' }).albumId, 'album');
});

test('maps stickers, voice, audio, video and animations without dropping attachment-only messages', () => {
  for (const [flags, stickerFormat, mime] of [
    [{}, 'static', 'image/webp'],
    [{ is_video: true }, 'video', 'video/webm'],
    [{ is_animated: true }, 'lottie', 'application/x-tgsticker'],
  ] as const) {
    const message = incoming({
      sticker: { file_id: 'sticker', emoji: '🐈', set_name: 'cats', ...flags },
    });
    assert.equal(message.text, '[sticker]');
    const attachment = message.attachments?.[0];
    assert.equal(attachment?.stickerFormat, stickerFormat);
    assert.equal(attachment?.mime, mime);
    assert.equal(attachment?.emoji, '🐈');
    assert.equal(attachment?.set, 'cats');
  }

  for (const field of ['voice', 'audio', 'video', 'animation'] as const) {
    const message = incoming({
      [field]: { file_id: field },
      ...(field === 'animation' && { document: file }),
    });
    assert.equal(message.text, `[${field}]`);
    assert.equal(message.attachments?.[0]?.kind, field);
    assert.equal(message.attachments?.length, 1);
  }
});

test('Telegram downloads via getFile and enforces the 20 MB bot limit', async () => {
  const called: string[] = [];
  const bytes = Uint8Array.of(1, 2, 3);
  const api = new BotApi(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/getFile')) {
      called.push('getFile');
      assert.deepEqual(JSON.parse(String(init?.body)), { file_id: 'remote-1' });
      return Response.json({
        ok: true,
        result: { file_path: 'documents/file_1.pdf', file_size: bytes.length },
      });
    }
    assert.ok(url.pathname.endsWith('/documents/file_1.pdf'));
    called.push('download');
    return new Response(bytes);
  }, '1:test');
  const attachment = incoming({ document: file }).attachments![0]!;
  const signal = new AbortController().signal;
  await assert.rejects(
    api.downloadAttachment(
      { ...attachment, size: 20 * 1024 * 1024 + 1 },
      signal,
    ),
    (error: unknown) =>
      error instanceof ToolFailure && /20 MB/.test(error.message),
  );
  assert.deepEqual(called, []);
  assert.deepEqual(
    [...(await api.downloadAttachment(attachment, signal)).bytes],
    [...bytes],
  );
  assert.deepEqual(called, ['getFile', 'download']);

  const tooBig = new BotApi(
    async () =>
      Response.json(
        {
          ok: false,
          error_code: 400,
          description: 'Bad Request: file is too big',
        },
        { status: 400 },
      ),
    '1:test',
  );
  await assert.rejects(
    tooBig.downloadAttachment({ ...attachment, size: undefined }, signal),
    /20 MB/,
  );
});
