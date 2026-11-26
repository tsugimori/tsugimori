import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { noPluginKinds, parseConfig, parseEnv, watch } from '../src/index.ts';

test('validates workspace JSON and accepts disabled, unregistered plugin kinds', () => {
  const config = parseConfig(
    JSON.stringify({
      platforms: [
        { id: 'other:main', kind: 'other', enabled: false, custom: true },
      ],
      agents: [{ id: 'test', kind: 'fake', model: 'test-model' }],
    }),
    { ...noPluginKinds, agentKinds: new Set(['fake']) },
  );
  assert.equal(config.platforms[0]?.enabled, false);
  assert.equal(config.agents[0]?.enabled, true);
  assert.equal(config.agents[0]?.compactAt, 250_000);
  assert.equal(config.context.recentMessages, 30);
  assert.equal(config.locale, 'en');
  assert.equal(parseConfig('{"locale":"zh-TW"}').locale, 'zh-TW');
  assert.throws(() => parseConfig('{"locale":"zh-CN"}'), /locale/);
  assert.equal(config.storage.path, 'data/tsugimori.db');
  assert.throws(
    () => parseConfig('{"agents":[{"id":"bad","kind":"random"}]}'),
    /Unknown agent kind/,
  );
  assert.throws(
    () => parseConfig('{"context":{"recentMessages":0}}'),
    /recentMessages/,
  );
  assert.throws(() => parseConfig('{"timezone":"unknown"}'), /time zone/);
  assert.throws(
    () => parseConfig('{"platforms":[{"id":"..","kind":"test"}]}'),
    /pattern/,
  );
});

test('preserves per-agent compaction thresholds and rejects invalid counts', () => {
  const agent = { id: 'fake', kind: 'fake', enabled: false };
  const compactAt = (value: unknown) =>
    parseConfig(JSON.stringify({ agents: [{ ...agent, compactAt: value }] }))
      .agents[0]?.compactAt;
  assert.equal(compactAt(180_000), 180_000);
  for (const invalid of [0, -1, 1.5, '250000', null])
    assert.throws(() => compactAt(invalid), /\/agents\/0\/compactAt/);
});

test('validates public webhook base URLs at workspace and LINE instance scope', () => {
  const workspace = (publicBaseUrl: unknown) =>
    parseConfig(JSON.stringify({ webhooks: { publicBaseUrl } }));
  const line = (publicUrl: unknown) =>
    parseConfig(
      JSON.stringify({
        platforms: [{ kind: 'line', id: 'main', enabled: false, publicUrl }],
      }),
    );
  assert.equal(
    workspace('https://webhooks.example.com').webhooks?.publicBaseUrl,
    'https://webhooks.example.com',
  );
  assert.equal(
    line('https://webhooks.example.com/prefix/').platforms[0]?.publicUrl,
    'https://webhooks.example.com/prefix/',
  );
  for (const value of [
    null,
    'http://example.com',
    'https:///prefix',
    'https://example.com:99999',
    'https://name@example.com',
    'https://example.com/path?',
    'https://example.com/path#',
    'https://%00/path',
  ]) {
    assert.throws(() => workspace(value), /\/webhooks\/publicBaseUrl/);
    assert.throws(() => line(value), /\/platforms\/0\/publicUrl/);
  }
});

test('validates and preserves optional per-agent service tiers', () => {
  const tier = (serviceTier: unknown) =>
    parseConfig(
      JSON.stringify({
        agents: [{ id: 'codex', kind: 'codex', enabled: false, serviceTier }],
      }),
    ).agents[0]?.serviceTier;
  assert.equal(tier(undefined), undefined);
  for (const value of ['fast', 'default', 'provider-specific'])
    assert.equal(tier(value), value);
  for (const invalid of ['', '  ', 5, false, null, {}])
    assert.throws(() => tier(invalid), /\/agents\/0\/serviceTier/);
});

test('defaults and validates conversation summary settings', () => {
  const settings = (summary: object) =>
    parseConfig(JSON.stringify({ context: { summary } })).context.summary;
  const defaults = {
    maxMessages: 200,
    minIntervalMinutes: 15,
    minMessages: 20,
    thinking: 'low',
    timeoutMs: 120_000,
  };
  assert.deepEqual(parseConfig('{}').context.summary, defaults);
  assert.deepEqual(settings({}), defaults);
  const overrides = {
    maxMessages: 40,
    minIntervalMinutes: 5,
    minMessages: 50,
    thinking: 'medium',
    timeoutMs: 180_000,
  };
  assert.deepEqual(settings(overrides), overrides);
  assert.equal(settings({ minIntervalMinutes: 0 })?.minIntervalMinutes, 0);
  for (const [name, invalid] of [
    ['maxMessages', 0],
    ['maxMessages', 1.5],
    ['maxMessages', Number.MAX_SAFE_INTEGER + 1],
    ['minIntervalMinutes', -1],
    ['minIntervalMinutes', 1.5],
    ['minIntervalMinutes', 35_792],
    ['minMessages', 0],
    ['minMessages', 1.5],
    ['thinking', ''],
    ['thinking', 1],
    ['timeoutMs', 0],
    ['timeoutMs', 2 ** 31],
  ] as const)
    assert.throws(
      () => settings({ [name]: invalid }),
      new RegExp(`/context/summary/${name}`),
    );
});

test('Codex async compaction is a boolean opt-in', () => {
  const options = (value: object) =>
    parseConfig(
      JSON.stringify({
        agents: [
          { id: 'codex', kind: 'codex', enabled: false, options: value },
        ],
      }),
    ).agents[0]?.options;
  assert.equal(options({})?.asyncCompaction, false);
  assert.equal(options({ asyncCompaction: true })?.asyncCompaction, true);
  assert.throws(() => options({ asyncCompaction: 'true' }), /asyncCompaction/);
});

test('parses shell-style assignments without evaluating them or leaking errors', () => {
  const values = parseEnv(
    '# comment\nexport A="one # two" # comment\nB=plain#comment\nC=\'literal\\n\'\nD="one\\ntwo"\nE=$A\n',
  );
  assert.deepEqual(
    [...values],
    [
      ['A', 'one # two'],
      ['B', 'plain'],
      ['C', 'literal\\n'],
      ['D', 'one\ntwo'],
      ['E', '$A'],
    ],
  );
  assert.throws(() => parseEnv('invalid assignment'), /line 1/);
});

test(
  'reloads validated config and keeps the last good value on invalid edits',
  { timeout: 5_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'tsugimori-config-'));
    const config = join(root, 'tsugimori.json');
    await writeFile(config, '{}');

    const accepted: number[] = [];
    const errors: unknown[] = [];
    const close = watch(root, noPluginKinds, {
      debounceMs: 20,
      onConfig: ({ config }) => {
        accepted.push(config.context.recentMessages);
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    t.after(async () => {
      await close();
      await rm(root, { recursive: true, force: true });
    });
    while (!accepted.length) await delay(10, undefined, { signal: t.signal });
    assert.equal(accepted.at(-1), 30);

    await writeFile(config, '{"context":{"recentMessages":0}}');
    while (!errors.length) await delay(10, undefined, { signal: t.signal });
    assert.equal(accepted.at(-1), 30);

    const replacement = join(root, 'replacement.json');
    await writeFile(replacement, '{"context":{"recentMessages":12}}');
    await rename(replacement, config);
    while (accepted.at(-1) !== 12)
      await delay(10, undefined, { signal: t.signal });
    assert.equal(accepted.at(-1), 12);
  },
);
