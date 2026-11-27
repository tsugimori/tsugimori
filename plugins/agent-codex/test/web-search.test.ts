import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { ServerFrame } from '../src/app-server.ts';

import { TurnOutput } from '../src/turn.ts';

test('records hosted and standalone web search from Codex app-server notifications', () => {
  // Captured from Codex 0.170.0 against a local mock provider. Thread and turn IDs were replaced.
  const frames: ServerFrame[] = JSON.parse(
    readFileSync(
      new URL('./fixtures/web-search.json', import.meta.url),
      'utf8',
    ),
  );
  const output = new TurnOutput();
  const events = frames.flatMap((frame) => output.events(frame));
  const starts = events.filter((event) => event.type === 'tool.started');
  const finishes = events.filter((event) => event.type === 'tool.finished');
  assert.equal(events.length, 12);
  assert.deepEqual(
    starts.map(({ callId, name }) => [callId, name]),
    finishes.map(({ callId, name }) => [callId, name]),
  );
  assert.ok(
    finishes.every(
      ({ name, status }) => name === 'web_search' && status === 'ok',
    ),
  );

  const note = 'Codex did not report web search result data';
  // Match the JSON persisted in the tool call, which omits undefined fields.
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(finishes.map(({ args, result }) => ({ args, result }))),
    ),
    [
      {
        args: { type: 'openPage', url: 'https://example.com/' },
        result: { status: 'completed', durationMs: 10, note },
      },
      {
        args: {
          type: 'search',
          queries: ['example domain', 'example documentation'],
        },
        result: { status: 'completed', durationMs: 9, note },
      },
      {
        args: {
          type: 'findInPage',
          url: 'https://example.com/',
          pattern: 'Example Domain',
        },
        result: { status: 'completed', durationMs: 9, note },
      },
      {
        args: {
          type: 'other',
          description: 'Codex did not specify the web search action',
        },
        result: { status: 'completed', durationMs: 10, note },
      },
      {
        args: { type: 'search', query: 'unavailable example' },
        result: { status: 'completed', durationMs: 11, note },
      },
      {
        args: { type: 'search', query: 'example domain' },
        result: {
          status: 'completed',
          durationMs: 14,
          resultCount: 1,
          urls: ['https://example.com/'],
          results: [
            {
              type: 'text_result',
              ref_id: 'turn0search0',
              title: 'Example Domain',
              url: 'https://example.com/',
              snippet: 'A domain for examples.',
            },
          ],
        },
      },
    ],
  );
});

test('records additional web search fields if the server supplies them', () => {
  const output = new TurnOutput();
  const item = { type: 'webSearch', id: 'find' };
  output.events({
    method: 'item/started',
    params: {
      item: { ...item, action: { type: 'findInPage', pattern: 'example' } },
      startedAtMs: 500,
    },
  });
  const sources = [{ title: 'Example', url: 'https://example.com/' }];
  const events = output.events({
    method: 'item/completed',
    params: {
      item: {
        ...item,
        status: 'failed',
        action: { type: 'other' },
        url: 'https://example.com/',
        sources,
        pageContent: '例',
        error: 'Read interrupted',
      },
      completedAtMs: 530,
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    {
      type: 'tool.finished',
      name: 'web_search',
      callId: 'find',
      status: 'error',
      args: {
        type: 'findInPage',
        url: 'https://example.com/',
        pattern: 'example',
      },
      result: {
        status: 'failed',
        durationMs: 30,
        resultCount: 1,
        urls: ['https://example.com/'],
        pageContentBytes: 3,
        sources,
        error: 'Read interrupted',
      },
    },
  ]);
});
