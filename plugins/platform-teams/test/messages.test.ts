import type { PlatformInboundEvent } from '@tsugimori/plugin-sdk';
import type { TestContext } from 'node:test';

import { SendFailure } from '@tsugimori/plugin-sdk';
import { platformHome } from '@tsugimori/plugin-sdk';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Data } from '../src/wire.ts';

import { downloadMedia } from '../src/attachments.ts';
import { microsoftAuth, teamsSession } from '../src/auth.ts';
import { chatApi } from '../src/chat-api.ts';
import { credentialStore } from '../src/credentials.ts';
import { inboundMessages } from '../src/history.ts';
import { normalizeMessage } from '../src/inbound.ts';
import { renderText } from '../src/text.ts';

const self = '8:live:self';
const peer = '8:live:peer';
const group = '19:example@thread.v2';
const start = Date.UTC(2026, 10, 28);
function message(chatId: string, offset: number, other: Data = {}) {
  return {
    id: String(start + offset),
    conversationid: chatId,
    from: `https://teams.live.com/contacts/${encodeURIComponent(peer)}`,
    imdisplayname: 'Peer',
    messagetype: 'RichText/Html',
    content: '<p>Hello &amp; good morning</p>',
    ...other,
  };
}

test('normalizes DMs, group mentions, quoted replies, edits, and deletions', () => {
  const dm = normalizeMessage(message(peer, 1), 'NewMessage', self);
  assert.equal(dm?.type, 'message');
  assert.equal(dm.chatKind, 'dm');
  assert.equal(dm.userId, peer);
  assert.equal(dm.userDisplay, 'Peer');
  assert.equal(dm.text, 'Hello & good morning');
  assert.equal(dm.at, start + 1);
  const quoted = message(group, 2, {
    properties: {
      qtdMsgs: JSON.stringify([{ messageId: String(start + 1), sender: self }]),
      mentions: JSON.stringify([{ mri: self }]),
    },
    content: `<blockquote itemid="${start + 1}" itemtype="http://schema.skype.com/Reply"><strong itemid="${self}">Bot</strong><p itemprop="preview">Original</p></blockquote><p><readonly>@Bot</readonly><br><a href="https://example.test/?a=1&amp;b=2">Link</a></p>`,
  });
  const edit = normalizeMessage(quoted, 'MessageUpdate', self);
  assert.equal(edit?.type, 'message');
  assert.equal(edit.edited, true);
  assert.equal(edit.chatKind, 'group');
  assert.equal(edit.mentionsBot, true);
  assert.equal(edit.repliesToBot, true);
  assert.equal(edit.text, '@Bot\nLink (https://example.test/?a=1&b=2)');
  assert.deepEqual(edit.replyTo, {
    id: String(start + 1),
    sender: { id: self, name: 'Bot' },
    text: 'Original',
  });
  const blockquoteOnly = normalizeMessage(
    { ...quoted, properties: {} },
    'NewMessage',
    self,
  );
  assert.equal(
    blockquoteOnly?.type === 'message' && blockquoteOnly.replyTo?.id,
    String(start + 1),
  );
  assert.deepEqual(
    normalizeMessage(
      { id: quoted.id, conversationid: group },
      'MessageRemoved',
      self,
    ),
    { type: 'delete', chatId: group, messageId: quoted.id },
  );
  assert.equal(
    normalizeMessage({ ...quoted, from: self }, 'NewMessage', self),
    undefined,
  );
  for (const messagetype of [
    'Control/Typing',
    'Control/ClearTyping',
    'ThreadActivity/TopicUpdate',
  ]) {
    assert.equal(
      normalizeMessage({ ...quoted, messagetype }, 'NewMessage', self),
      undefined,
    );
  }
});

test('renders Markdown, escaped links, code and explicit Teams mentions', () => {
  const output = renderText(
    {
      chatId: group,
      format: 'markdown',
      text: '**Bold** and _italic_\n[Link](https://example.test/?a=1&b=2)\n\n`<raw>`\n\n```\na  b\n\nc\n```',
      mentions: [peer, peer],
    },
    () => ({ display: '<Peer>', username: null }),
  );
  assert.match(
    output.content,
    /^<p><readonly .*&lt;Peer&gt;.*<strong>Bold<\/strong> and <em>italic<\/em>/,
  );
  assert.match(
    output.content,
    /<a href="https:\/\/example\.test\/\?a=1&amp;b=2">Link<\/a>/,
  );
  assert.match(
    output.content,
    /<\/p><p>&lt;raw&gt;<\/p><p>a&nbsp; b<br><br>c<\/p>$/,
  );
  assert.equal(JSON.parse(output.properties.mentions!)[0].mri, peer);
  assert.equal(
    renderText({
      chatId: group,
      text: 'a bc',
      entities: [{ offset: 2, length: 2, type: 'bold' }],
    }).content,
    '<p>a <strong>bc</strong></p>',
  );
  assert.doesNotMatch(
    renderText({
      chatId: group,
      format: 'markdown',
      text: '[unsafe](javascript:bad)',
    }).content,
    /href=/,
  );
});

async function fixtureApi(t: TestContext, respond: typeof globalThis.fetch) {
  const workspace = await mkdtemp(join(tmpdir(), 'teams-chat-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const credentials = credentialStore(
    workspace,
    platformHome(workspace, 'teams'),
  );
  await credentials.save({
    account: self,
    refreshToken: 'fixture',
    displayName: 'Fixture',
  });
  const signal = AbortSignal.timeout(3000);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).includes('oauth2')) {
      const form = init?.body as URLSearchParams;
      return Response.json({
        access_token: form.get('scope')?.includes('/Files.ReadWrite')
          ? 'fixture-graph'
          : 'fixture-access',
      });
    }
    if (String(input).includes('authz/consumer')) {
      const claims = Buffer.from(JSON.stringify({ skypeid: self })).toString(
        'base64url',
      );
      return Response.json({ skypeToken: `header.${claims}.signature` });
    }
    return respond(input, init);
  };
  const auth = teamsSession(microsoftAuth(fetch), credentials, self, signal);
  return { api: chatApi(fetch, auth), auth, fetch, signal };
}

test('retains attachment-only messages and separates captions from attachment markup', () => {
  const image = normalizeMessage(
    message(group, 1, {
      content:
        '<img itemtype="http://schema.skype.com/AMSImage" src="https://us.asm.skype.com/v1/objects/photo/views/imgo" alt="Picture &amp; title" itemscope="png" width="200" height="100">',
      amsreferences: ['photo'],
    }),
    'NewMessage',
    self,
  );
  assert.equal(image?.type, 'message');
  assert.equal(image.text, '');
  assert.deepEqual(image.attachments, [
    {
      fileId: '{"kind":"asm","id":"photo"}',
      index: 0,
      kind: 'image',
      mime: 'image/png',
      name: 'Picture & title',
      width: 200,
      height: 100,
    },
  ]);
  const refs = normalizeMessage(
    message(group, 1, {
      messagetype: 'RichText/Media_Picture',
      content: '',
      properties: { amsreferences: '["photo"]' },
    }),
    'NewMessage',
    self,
  );
  assert.equal(
    refs?.type === 'message' && refs.attachments?.[0]?.fileId,
    image.attachments?.[0]?.fileId,
  );

  const files = normalizeMessage(
    message(group, 2, {
      messagetype: 'RichText/Media_GenericFile',
      content:
        '<p>Caption</p><URIObject type="File.1" uri="https://api.asm.skype.com/v1/objects/document"><Title>Filename</Title><OriginalName v="a &amp; b.pdf"/><FileSize v="42"/></URIObject>',
      properties: {
        files: JSON.stringify([
          {
            title: 'Share.doc',
            fileInfo: { shareUrl: 'https://1drv.ms/x/fixture' },
          },
          {
            fileName: 'Drive.pdf',
            fileInfo: {
              siteUrl: 'https://tenant.sharepoint.com/personal/drive',
              itemId: 'drive!item',
            },
          },
          {
            title: 'Unknown',
            fileInfo: { shareUrl: 'https://sharepoint.com.invalid/sample' },
          },
        ]),
      },
    }),
    'NewMessage',
    self,
  );
  assert.equal(files?.type, 'message');
  assert.equal(files.text, 'Caption');
  assert.deepEqual(
    files.attachments?.map(({ name, index, kind, size }) => ({
      name,
      index,
      kind,
      size,
    })),
    [
      { name: 'a & b.pdf', index: 0, kind: 'file', size: 42 },
      { name: 'Share.doc', index: 1, kind: 'file', size: undefined },
      { name: 'Drive.pdf', index: 2, kind: 'file', size: undefined },
    ],
  );

  const untrusted = normalizeMessage(
    message(group, 3, {
      content:
        '<img itemtype="http://schema.skype.com/AMSImage" src="https://asm.skype.com.invalid/v1/objects/photo/views/imgo">',
    }),
    'NewMessage',
    self,
  );
  assert.equal(untrusted, undefined);
});

test('downloads ASM originals and Graph shares with isolated credentials and bounded bytes', async (t) => {
  const calls: string[] = [];
  let signed = 'https://public.dm.files.1drv.com/signed?fixture=proof';
  let size = 3;
  let length: string | undefined;
  let redirect = false;
  const { auth, fetch, signal } = await fixtureApi(t, async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.hostname);
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    if (url.hostname === 'graph.microsoft.com') {
      assert.equal(headers.get('Authorization'), 'Bearer fixture-graph');
      assert.equal(headers.get('Prefer'), 'redeemSharingLinkIfNecessary');
      const path = Buffer.from('https://1drv.ms/x/share', 'utf8').toString(
        'base64url',
      );
      assert.ok(
        [
          `/v1.0/shares/u!${path}/driveItem`,
          '/v1.0/drives/drive/items/drive!item',
        ].includes(url.pathname),
      );
      return Response.json({ size, '@microsoft.graph.downloadUrl': signed });
    }
    if (url.hostname === 'api.asm.skype.com') {
      assert.match(headers.get('Authorization') ?? '', /^skype_token /);
      assert.ok(
        [
          '/v1/objects/abc/views/original',
          '/v1/objects/abc/views/imgo',
        ].includes(url.pathname),
      );
      return new Response('abc', { headers: { 'Content-Type': 'image/png' } });
    }
    assert.equal(url.href, signed);
    assert.equal(init?.credentials, 'omit');
    assert.equal(headers.has('Authorization'), false);
    assert.equal(headers.has('Authentication'), false);
    if (redirect) return Response.redirect('https://untrusted.invalid/', 302);
    return new Response(
      'abc',
      length ? { headers: { 'Content-Length': length } } : undefined,
    );
  });
  const asm = {
    index: 0,
    kind: 'file' as const,
    fileId: '{"kind":"asm","id":"abc"}',
  };
  const share = {
    index: 1,
    kind: 'file' as const,
    fileId: '{"kind":"share","url":"https://1drv.ms/x/share"}',
  };
  const drive = {
    index: 2,
    kind: 'file' as const,
    fileId: '{"kind":"drive","drive":"drive","item":"drive!item"}',
  };
  for (const attachment of [
    asm,
    { ...asm, kind: 'image' as const },
    share,
    drive,
  ]) {
    const data = await downloadMedia(fetch, auth, attachment, signal);
    assert.equal(Buffer.from(data.bytes).toString(), 'abc');
  }
  assert.deepEqual(calls, [
    'api.asm.skype.com',
    'api.asm.skype.com',
    'graph.microsoft.com',
    'public.dm.files.1drv.com',
    'graph.microsoft.com',
    'public.dm.files.1drv.com',
  ]);
  await assert.rejects(
    downloadMedia(fetch, auth, asm, signal, 2),
    /download size limit/,
  );
  await assert.rejects(
    downloadMedia(fetch, auth, share, signal, 2),
    /download size limit/,
  );
  assert.equal(
    calls.at(-1),
    'graph.microsoft.com',
    'metadata checks before signed download',
  );
  length = '20000000';
  await assert.rejects(
    downloadMedia(fetch, auth, drive, signal),
    /download size limit/,
  );
  length = undefined;
  size = 1;
  await assert.rejects(
    downloadMedia(fetch, auth, drive, signal, 2),
    /download size limit/,
  );
  signed = 'https://files.1drv.com.invalid/private';
  await assert.rejects(
    downloadMedia(fetch, auth, share, signal),
    /Untrusted Teams attachment download host/,
  );
  assert.equal(calls.at(-1), 'graph.microsoft.com');
  await assert.rejects(
    downloadMedia(
      fetch,
      auth,
      {
        ...share,
        fileId:
          '{"kind":"share","url":"https://1drv.ms@untrusted.invalid/sample"}',
      },
      signal,
    ),
    /Invalid Teams attachment reference/,
  );
  signed = 'https://public.dm.files.1drv.com/redirect';
  redirect = true;
  await assert.rejects(downloadMedia(fetch, auth, share, signal), /HTTP 302/);
  assert.equal(calls.at(-1), 'public.dm.files.1drv.com');
});

test('ambiguous Teams send reads back its reserved ID with native reply metadata', async (t) => {
  let clientId: string | undefined;
  let writes = 0;
  const { api, signal } = await fixtureApi(t, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'teams.live.com');
    if (url.pathname.endsWith('/123'))
      return Response.json(message(group, 1, { id: '123' }));
    if (init?.method === 'POST') {
      writes++;
      const body = JSON.parse(String(init.body));
      clientId = body.clientmessageid;
      assert.match(clientId ?? '', /^\d+$/);
      assert.equal(body.messagetype, 'RichText/Html');
      assert.match(body.content, /<blockquote.*itemid="123"/);
      assert.equal(JSON.parse(body.properties.qtdMsgs)[0].sender, peer);
      return new Response(null, { status: 503 });
    }
    assert.equal(url.searchParams.get('view'), 'msnp24Equivalent');
    return Response.json({
      messages: [
        message(group, 2, { clientmessageid: clientId }),
        message(group, 3, { clientmessageid: clientId, fromId: self }),
      ],
    });
  });
  const receipt = await api.send(
    { chatId: group, text: 'Reply', replyTo: '123' },
    signal,
  );
  assert.equal(receipt.messageId, String(start + 3));
  assert.equal(writes, 1);
});

test('missing readback leaves delivery unknown and sends no second POST', async (t) => {
  const methods: (string | undefined)[] = [];
  const { api, signal } = await fixtureApi(t, async (_input, init) => {
    methods.push(init?.method);
    return init?.method === 'POST'
      ? new Response(null, { status: 502 })
      : Response.json({ messages: [] });
  });
  await assert.rejects(
    api.send({ chatId: group, text: 'One write' }, signal),
    (error: unknown) => error instanceof SendFailure && error.deliveryUnknown,
  );
  assert.deepEqual(methods, ['POST', 'GET']);
});

test('catch-up pages overlap live notifications and dedupes across repeated repairs', async () => {
  const events: PlatformInboundEvent[] = [];
  const signal = AbortSignal.timeout(1000);
  const warnings: string[] = [];
  const first = message(group, 1);
  const missing = message(group, 2, { content: '<p>Missing</p>' });
  const stale = message(group, -1);
  const inbound = inboundMessages(
    {
      emit: async (event) => {
        events.push(event);
      },
      logWarning: (_event, reason) => {
        if (reason) warnings.push(reason);
      },
    },
    {
      async page(chat, next) {
        assert.equal(chat, group);
        return next
          ? { messages: [first, stale], next: 'older' }
          : { messages: [missing, first], next: 'second' };
      },
    },
    self,
    start,
  );
  await inbound.receive(
    { resourceType: 'NewMessage', resource: first },
    signal,
  );
  await inbound.catchUp(signal, false);
  await inbound.receive(
    { resourceType: 'NewMessage', resource: missing },
    signal,
  );
  await inbound.catchUp(signal, false);
  assert.deepEqual(
    events.map(
      (event) => event.type === 'message' && [event.messageId, event.edited],
    ),
    [
      [first.id, false],
      [missing.id, false],
    ],
  );
  assert.deepEqual(warnings, []);
});
