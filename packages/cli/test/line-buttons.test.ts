import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

import { Gateway, PluginRegistry } from '@tsugimori/core';
import { LineAdapter } from '@tsugimori/platform-line';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { WebhookRoute } from '../../plugin-sdk/src/index.ts';

const secret = 'fake-channel-secret';
const owner = 'U' + '1'.repeat(32);
const member = 'U' + '2'.repeat(32);
const groupId = 'C' + '3'.repeat(32);
const adapterId = 'line-test';
const models = Array.from({ length: 24 }, (_, index) => `model-${index}`);

interface Delivery {
  id: string;
  items?: { action: { data: string; label: string } }[];
  replyToken?: string;
  text: string;
}

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), 'tsugimori-line-buttons-'));
  const store = new SqliteStore(':memory:');
  const approved = Promise.withResolvers<boolean>();
  const deliveries: Delivery[] = [];
  const routes = new Map<string, WebhookRoute>();
  const server = createServer((request, response) => {
    const route = routes.get(request.url ?? '');
    if (route) route(request, response);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const mockApi: typeof fetch = async (url, init) => {
    const { hostname, pathname } = new URL(String(url));
    assert.equal(hostname, 'api.line.me');
    if (pathname === '/v2/bot/info')
      return Response.json({
        userId: 'bot',
        basicId: '@bot',
        displayName: 'Bot',
      });
    if (pathname.includes('/member/') || pathname.includes('/profile/'))
      return Response.json({ displayName: 'LINE user' });
    if (pathname.endsWith('/loading/start')) return Response.json({});
    assert.match(pathname, /^\/v2\/bot\/message\/(reply|push)$/);
    const { messages, replyToken } = JSON.parse(String(init?.body));
    const sentMessages = messages.map(
      (message: {
        quickReply?: { items: Delivery['items'] };
        text: string;
      }) => {
        const id = String(deliveries.length + 1);
        deliveries.push({
          id,
          text: message.text,
          items: message.quickReply?.items,
          replyToken,
        });
        return { id };
      },
    );
    return Response.json({ sentMessages });
  };
  const registry = new PluginRegistry([
    {
      name: 'line',
      adapters: {
        line: ({ id }) =>
          new LineAdapter({ fetch: mockApi }, id, {
            ingress: {
              async register(path, route) {
                routes.set(path, route);
                return async () => {
                  routes.delete(path);
                };
              },
              status: () => ({ state: 'unconfigured' }),
              url: () => undefined,
            },
            mediaDirectory: join(workspace, 'line'),
            secret,
            token: 'fake-access-token',
          }),
      },
    },
    {
      name: 'demo',
      agents: {
        demo: ({ id }) => ({
          id,
          kind: 'demo',
          loop: 'external',
          listModels: () => models,
          async *run(_request, io) {
            approved.resolve(
              await io.requestApproval({
                action: 'test.line',
                resource: { type: 'global' },
              }),
            );
            yield { type: 'text.final', text: 'Finished' };
          },
        }),
      },
    },
  ]);
  const gateway = new Gateway({ registry, store, workspace, log: () => {} });
  t.after(async () => {
    try {
      await gateway.stop();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      store.close();
      await rm(workspace, { force: true, recursive: true });
    }
  });
  await writeFile(
    join(workspace, 'tsugimori.json'),
    JSON.stringify({
      owner: { [adapterId]: owner },
      platforms: [{ id: adapterId, kind: 'line' }],
      agents: [{ id: 'demo', kind: 'demo' }],
    }),
  );
  await gateway.start();
  const path = `/line/${adapterId}/`;
  await wait(() => routes.has(path) || undefined, t.signal);
  let eventId = 0;
  async function post(userId: string, event: object) {
    const replyToken = 'token-' + ++eventId;
    const body = JSON.stringify({
      events: [
        {
          ...event,
          source: { type: 'group', groupId, userId },
          webhookEventId: 'event-' + eventId,
          replyToken,
        },
      ],
    });
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      body,
      headers: {
        'x-line-signature': createHmac('sha256', secret)
          .update(body)
          .digest('base64'),
      },
    });
    await response.arrayBuffer();
    assert.equal(response.status, 200);
    return replyToken;
  }
  return {
    approved: approved.promise,
    gateway,
    store,
    delivery: (predicate: (delivery: Delivery) => boolean) =>
      wait(() => deliveries.find(predicate), t.signal),
    say: (text: string) =>
      post(owner, {
        type: 'message',
        message: {
          type: 'text',
          id: 'source-' + (eventId + 1),
          text,
          mention: { mentionees: [{ isSelf: true }] },
        },
      }),
    press: (data: string, userId = owner) =>
      post(userId, { type: 'postback', postback: { data } }),
  };
}

async function wait<T>(read: () => T | undefined, signal: AbortSignal) {
  let value: T | undefined;
  while ((value = read()) === undefined) await delay(5, undefined, { signal });
  return value;
}

test(
  'LINE approval buttons round-trip through core with group authorization',
  { timeout: 8000 },
  async (t) => {
    const f = await fixture(t);
    const originalToken = await f.say('Request approval');
    const prompt = await f.delivery(({ items }) => !!items);
    assert.equal(prompt.replyToken, originalToken);
    assert.deepEqual(
      prompt.items?.map(({ action }) => action.label),
      ['Approve', 'Deny'],
    );
    const approval = await wait(
      () =>
        f.store
          .listApprovals()
          .find(({ promptMessageId }) => !!promptMessageId),
      t.signal,
    );
    assert.equal(approval.promptMessageId, prompt.id);
    const data = prompt.items![0]!.action.data;

    const memberToken = await f.press(data, member);
    assert.equal(
      (await f.delivery(({ replyToken }) => replyToken === memberToken)).text,
      'Approval is unavailable.',
    );
    assert.equal(f.store.getApproval(approval.id)?.status, 'pending');

    const ownerToken = await f.press(data);
    assert.equal(
      (await f.delivery(({ replyToken }) => replyToken === ownerToken)).text,
      '✅ Approved',
    );
    assert.equal(await f.approved, true);
    await f.gateway.idle();
    assert.equal(f.store.getApproval(approval.id)?.status, 'approved');
    assert.equal(f.store.getApproval(approval.id)?.decidedBy, owner);
  },
);

test(
  'LINE paginates command choices and replies to the selected option',
  { timeout: 8000 },
  async (t) => {
    const f = await fixture(t);
    const sourceToken = await f.say('/model');
    const first = await f.delivery(
      ({ replyToken, items }) => replyToken === sourceToken && !!items,
    );
    assert.equal(first.items?.length, 12);
    assert.equal(first.items?.[0]?.action.label, 'model-0');
    await f.press(first.items!.at(-1)!.action.data);
    const second = await f.delivery(({ items }) => items?.length === 13);
    assert.equal(second.items?.[0]?.action.label, 'model-11');
    const selectToken = await f.press(second.items![0]!.action.data);
    const selected = await f.delivery(
      ({ replyToken }) => replyToken === selectToken,
    );
    assert.match(selected.text, /model-11/);
  },
);
