import type { ApprovalRequest } from '@tsugimori/plugin-sdk';
import type { ScheduleRecord } from '@tsugimori/storage';

import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

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

function approvalFixture(t: TestContext, now?: () => number) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const chat = { adapterId: 'a', chatId: 'c' };
  const auth = new Auth({
    store,
    now,
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
  return { auth, chat, request, store, owner: { ...chat, userId: 'owner' } };
}

test('approvals require an owner and same-chat linkage by reply or callback', (t) => {
  const { auth, chat, request, store, owner } = approvalFixture(t);
  const approval = auth.createApproval(chat, 'task', 'member', request);
  store.linkApproval(approval.id, 'prompt');

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
    { id: approval.id, approved: true, decision: 'approve' },
  );
  assert.equal(
    auth.resolveApproval({ ...owner, replyTo: 'prompt', text: 'ok' }),
    undefined,
  );
  assert.equal(auth.hasGrant(chat, 'member', request), false);

  const next = auth.createApproval(chat, 'task', 'member', request);
  store.linkApproval(next.id, 'second');
  const callbackId = approvalCallbackId(next.id, 'approve');
  assert.equal(
    auth.resolveApproval({ ...owner, callbackId, messageId: 'wrong' }),
    undefined,
  );
  assert.deepEqual(
    auth.resolveApproval({ ...owner, callbackId, messageId: 'second' }),
    { id: next.id, approved: true, decision: 'approve' },
  );
  assert.equal(auth.hasGrant(chat, 'member', request), false);
  store.insertGrant({
    ...chat,
    id: 'standing',
    action: request.action,
    mode: 'always',
    grantedBy: owner.userId,
    grantedTo: 'member',
    scope: request.resource,
    createdAt: 0,
    consumedAt: null,
    revokedAt: null,
  });
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

test('replies map to approve or deny and the old always callback is rejected', (t) => {
  const { auth, chat, request, store, owner } = approvalFixture(t);
  const replies = {
    approve: [
      '同意',
      '好',
      '允許',
      '允許一次',
      '一律允許',
      'yes',
      'ok',
      'APPROVE',
      ' always ',
    ],
    deny: ['拒絕', '不', 'no', 'deny'],
  } as const;
  for (const decision of ['approve', 'deny'] as const) {
    for (const text of replies[decision]) {
      const { id } = auth.createApproval(chat, 'task', 'member', request);
      store.linkApproval(id, id);
      assert.equal(
        auth.resolveApproval({ ...owner, replyTo: id, text })?.decision,
        decision,
        text,
      );
    }
  }
  const { id } = auth.createApproval(chat, 'task', 'member', request);
  store.linkApproval(id, id);
  assert.equal(
    auth.resolveApproval({
      ...owner,
      callbackId: `approval:always:${id}`,
      messageId: id,
    }),
    undefined,
  );
  assert.equal(store.getApproval(id)?.status, 'pending');
  assert.ok(
    store
      .listGrants()
      .every(({ consumedAt, mode }) => mode === 'once' && consumedAt !== null),
  );
});

test('approval deadlines use the earlier of the first trigger and 24 hours', (t) => {
  let now = 100_000;
  const { auth, chat, owner, request, store } = approvalFixture(t, () => now);
  const ttl = 24 * 60 * 60_000;
  const generic = auth.createApproval(chat, 'task', 'member', request);
  assert.equal(generic.expiresAt, now + ttl);

  for (const delta of [60_000, 2 * ttl]) {
    const at = now + delta;
    const schedule: ScheduleRecord = {
      ...chat,
      action: { kind: 'message', text: 'Reminder' },
      address: { chatId: chat.chatId },
      createdBy: 'member',
      deliveryApprovedBy: null,
      id: 'schedule',
      mentions: [],
      missed: 'latest',
      nextDueAt: at,
      status: 'active',
      target: { chatId: chat.chatId },
      timezone: 'UTC',
      trigger: { kind: 'interval', at, minutes: 30 },
    };
    const approval = auth.createApproval(chat, 'task', 'member', request, {
      continuation: { kind: 'schedule', change: { schedule } },
    });
    const expiresAt = Math.min(at, now + ttl);
    assert.equal(approval.expiresAt, expiresAt);
    assert.equal(store.getApproval(approval.id)?.expiresAt, expiresAt);
    store.linkApproval(approval.id, approval.id);
    const input = {
      ...owner,
      callbackId: approvalCallbackId(approval.id, 'approve'),
      messageId: approval.id,
    };
    now = expiresAt;
    assert.equal(auth.resolveApproval(input)?.decision, 'expired');
    assert.deepEqual(
      store.expireApprovals(now, [chat.adapterId]).map(({ id }) => id),
      [approval.id],
    );
    assert.equal(auth.resolveApproval(input)?.decision, 'expired');
    assert.equal(store.getApproval(approval.id)?.status, 'expired');
    assert.deepEqual(store.listSchedules(chat), []);
  }
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
