import type { ApprovalRequest } from '@tsugimori/plugin-sdk';

import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approvalCallbackId, Auth } from '../src/index.ts';

test('pairing binds a fresh one-time code to its adapter and native user', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  let now = 0;
  const auth = new Auth({ store, now: () => now });
  const expired = auth.createPairingCode('a');
  now = 10 * 60_000;
  assert.equal(auth.claimPairing('a', 'owner', expired), false);
  const code = auth.createPairingCode('a');
  assert.equal(auth.claimPairing('another', 'owner', code), false);
  assert.equal(auth.claimPairing('a', 'owner', code), true);
  assert.equal(auth.isOwner({ adapterId: 'a', userId: 'owner' }), true);
  assert.equal(auth.isOwner({ adapterId: 'another', userId: 'owner' }), false);
  assert.equal(auth.claimPairing('a', 'member', code), false);
  assert.throws(() => auth.createPairingCode('a'), /already has an owner/);
});

test('approvals require an owner and same-chat linkage by reply or callback', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const chat = { adapterId: 'a', chatId: 'c' };
  const auth = new Auth({
    store,
    configuredOwner: (id) => (id === 'a' ? 'owner' : undefined),
  });
  store.createTask({
    ...chat,
    id: 'task',
    sourceMessageId: 'source',
    status: 'running',
    agentId: 'agent',
    model: 'model',
    createdAt: 0,
    startedAt: 0,
    finishedAt: null,
  });
  const request: ApprovalRequest = {
    action: 'tool.use',
    resource: { type: 'project', id: 'p' },
  };
  const approval = auth.createApproval(chat, 'task', 'member', request);
  store.linkApproval(approval.id, 'prompt');
  const owner = { ...chat, userId: 'owner' };

  assert.equal(auth.resolveApproval({ ...owner, text: 'ok' }), undefined);
  assert.equal(auth.resolveApproval({ ...owner, text: '好' }), undefined);
  assert.equal(
    auth.resolveApproval({
      ...owner,
      userId: 'member',
      replyTo: 'prompt',
      text: 'ok',
    }),
    undefined,
  );
  assert.equal(
    auth.resolveApproval({
      ...owner,
      chatId: 'other',
      replyTo: 'prompt',
      text: 'ok',
    }),
    undefined,
  );
  assert.equal(
    auth.resolveApproval({ ...owner, replyTo: 'wrong', text: 'ok' }),
    undefined,
  );
  assert.equal(store.getApproval(approval.id)?.status, 'pending');
  assert.deepEqual(
    auth.resolveApproval({ ...owner, replyTo: 'prompt', text: '好' }),
    { id: approval.id, approved: true, decision: 'once' },
  );
  assert.equal(
    auth.resolveApproval({ ...owner, replyTo: 'prompt', text: 'ok' }),
    undefined,
  );
  assert.equal(auth.hasGrant(chat, 'member', request), false);

  const next = auth.createApproval(chat, 'task', 'member', request);
  store.linkApproval(next.id, 'second');
  const callbackId = approvalCallbackId(next.id, 'always');
  assert.equal(
    auth.resolveApproval({ ...owner, callbackId, messageId: 'wrong' }),
    undefined,
  );
  assert.deepEqual(
    auth.resolveApproval({ ...owner, callbackId, messageId: 'second' }),
    { id: next.id, approved: true, decision: 'always' },
  );
  assert.equal(
    auth.hasGrant(chat, 'member', { ...request, action: 'other' }),
    false,
  );
  assert.equal(
    auth.hasGrant(chat, 'member', {
      ...request,
      resource: { type: 'project', id: 'other' },
    }),
    false,
  );
  assert.equal(auth.hasGrant(chat, 'owner', request), false);
  assert.equal(
    auth.hasGrant({ ...chat, chatId: 'other' }, 'member', request),
    false,
  );
  assert.equal(auth.hasGrant(chat, 'member', request), true);
  assert.equal(auth.hasGrant(chat, 'member', request), true);
});

test('a once grant is consumed atomically and only applies to its path scope', (t) => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const chat = { adapterId: 'a', chatId: 'c' };
  const auth = new Auth({ store, configuredOwner: () => 'owner' });
  const action = 'test.write';
  store.insertGrant({
    ...chat,
    id: 'once',
    action,
    mode: 'once',
    grantedBy: 'owner',
    grantedTo: 'member',
    scope: { type: 'path', path: '/work/chat', recursive: true },
    createdAt: 0,
    consumedAt: null,
    revokedAt: null,
  });
  const authorize = (path: string) =>
    auth.hasGrant(chat, 'member', {
      action,
      resource: { type: 'path', path },
    });
  assert.equal(authorize('/work/chat-other/file'), false);
  assert.equal(authorize('/work/chat/sub/file'), true);
  assert.equal(authorize('/work/chat/sub/file'), false);
});
