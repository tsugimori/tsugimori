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
