import type { TestContext } from 'node:test';

import { loadSettings } from '@tsugimori/config';
import { PluginRegistry } from '@tsugimori/core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../src/index.ts';
import { readGatewayWebhook } from '../src/removal.ts';

async function workspace(t: TestContext, kind: string, long = false) {
  const parent = await mkdtemp(join(tmpdir(), 'tsm-remove-cli-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = long ? join(parent, 'workspace-'.repeat(12)) : parent;
  if (long) await mkdir(root);
  await writeFile(
    join(root, 'tsugimori.json'),
    JSON.stringify({
      platforms: [
        {
          id: 'old',
          kind,
          enabled: kind !== 'telegram',
          tokenEnv: 'OLD_TEST_TOKEN',
        },
      ],
    }),
  );
  return root;
}

function removeFromShell(root: string, answer: string, args: string[] = []) {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  return new Promise<string>((resolve, reject) => {
    const processHandle = spawn(process.execPath, [
      cli,
      'remove',
      'platform',
      'old',
      '--dir',
      root,
      ...args,
    ]);
    let output = '';
    let error = '';
    processHandle.stdout.setEncoding('utf8').on('data', (text: string) => {
      output += text;
    });
    processHandle.stderr.setEncoding('utf8').on('data', (text: string) => {
      error += text;
    });
    processHandle.on('error', reject);
    processHandle.on('close', (code) => {
      if (code) reject(new Error(error));
      else resolve(output);
    });
    processHandle.stdin.end(answer);
  });
}

test('CLI prints the plan, accepts an interactive cancellation and supports --yes', async (t) => {
  const root = await workspace(t, 'telegram');
  const cancelled = await removeFromShell(root, 'no\n');
  assert.match(cancelled, /Removal plan/);
  assert.match(cancelled, /Type yes to delete/);
  assert.match(cancelled, /Removal cancelled/);
  assert.equal(
    JSON.parse(await readFile(join(root, 'tsugimori.json'), 'utf8'))
      .platforms[0]?.id,
    'old',
  );
  const removed = await removeFromShell(root, '', ['--yes']);
  assert.match(removed, /Removal plan/);
  assert.match(removed, /Removed platform old/);
  assert.doesNotMatch(removed, /Type yes to delete/);
  assert.deepEqual((await loadSettings(root)).platforms, []);
  assert.equal((await readdir(join(root, 'data', 'backups'))).length, 1);
});

test('CLI removal in a running workspace waits for the gateway to stop the adapter', async (t) => {
  const root = await workspace(t, 'fake', process.platform === 'linux');
  const active = Promise.withResolvers<void>();
  const stops: string[] = [];
  const registry: PluginRegistry = new PluginRegistry([
    {
      name: 'fake',
      adapters: {
        fake: ({ id }) => ({
          capabilities: {},
          id,
          kind: 'fake',
          async start() {
            active.resolve();
          },
          async stop() {
            assert.equal(
              (await loadSettings(root, registry)).platforms[0]?.id,
              id,
            );
            stops.push(id);
          },
          async send() {
            return { messageId: 'fake' };
          },
        }),
      },
    },
  ]);
  const logs = t.mock.method(console, 'log', () => {});
  const daemon = main(['start', root], registry, {
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  try {
    await Promise.race([active.promise, daemon]);
    assert.deepEqual(await readGatewayWebhook(root, 'old'), {
      attached: true,
      paths: [],
      status: { state: 'unconfigured' },
    });
    await main(['remove', 'platform', 'old', '--dir', root, '--yes'], registry);
    assert.deepEqual(stops, ['old']);
    assert.match(
      String(logs.mock.calls.at(-1)?.arguments[0]),
      /Detached the instance/,
    );
    assert.deepEqual((await loadSettings(root, registry)).platforms, []);
  } finally {
    process.emit('SIGTERM', 'SIGTERM');
    await daemon;
  }
});
