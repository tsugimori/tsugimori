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
    if (String(input).includes('oauth2'))
      return Response.json({ access_token: 'fixture-access' });
    if (String(input).includes('authz/consumer')) {
      const claims = Buffer.from(JSON.stringify({ skypeid: self })).toString(
        'base64url',
      );
      return Response.json({ skypeToken: `header.${claims}.signature` });
    }
    return respond(input, init);
  };
  return {
    api: chatApi(
      fetch,
      teamsSession(microsoftAuth(fetch), credentials, self, signal),
    ),
    signal,
  };
}

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
