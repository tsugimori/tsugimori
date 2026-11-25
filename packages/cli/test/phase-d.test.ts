import type { SetupDependencies } from '@tsugimori/core';

import claude from '@tsugimori/agent-claude-sdk';
import codex from '@tsugimori/agent-codex';
import { loadSettings } from '@tsugimori/config';
import { GuidedSetup, PluginRegistry } from '@tsugimori/core';
import { SqliteStore } from '@tsugimori/storage-sqlite';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { main } from '../src/index.ts';

const ok = { exitCode: 0, stdout: '', stderr: '' };
const missing = { ...ok, exitCode: 1 };
const asset = 'codex-package-x86_64-unknown-linux-musl.tar.gz';
const tarball = Buffer.from('fake archive');

async function fixture(t: TestContext, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tsugimori-phase-d-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(join(directory, 'tsugimori.json'), JSON.stringify(config));
  return directory;
}

function releases(
  version: string,
  digest = createHash('sha256').update(tarball).digest('hex'),
  name = asset,
) {
  const download = `https://github.com/openai/codex/releases/download/rust-v${version}/${name}`;
  const requested: string[] = [];
  const fetch: typeof globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (url === download) return new Response(tarball);
    assert.match(
      String(url),
      /^https:\/\/api\.github\.com\/repos\/openai\/codex\/releases\/(?:latest|tags\/rust-v.+)$/,
    );
    return Response.json({
      tag_name: 'rust-v' + version,
      assets: [
        {
          name,
          browser_download_url: download,
          digest: 'sha256:' + digest,
        },
      ],
    });
  };
  return { fetch, requested };
}

function cliRunner(
  commands: string[][],
  {
    archiveName = asset,
    entrypoint = 'bin/codex',
    listing,
    manifest,
    version = '1.2.3',
  }: {
    archiveName?: string;
    entrypoint?: string;
    listing?: string;
    manifest?: object;
    version?: string;
  } = {},
): NonNullable<SetupDependencies['runCommand']> {
  return async ([bin, ...args]) => {
    commands.push([bin, ...args]);
    if (bin === 'git' || bin === 'bwrap') return missing;
    if (bin === 'tar') {
      assert.equal(basename(args[1]!), archiveName);
      const helper = entrypoint.endsWith('.exe')
        ? 'codex-code-mode-host.exe'
        : 'codex-code-mode-host';
      if (args[0] === '-tzf')
        return {
          ...ok,
          stdout:
            listing ??
            [
              'codex-package.json',
              entrypoint,
              `${dirname(entrypoint)}/${helper}`,
              'codex-resources/bwrap',
              'codex-path/',
            ].join('\n'),
        };
      assert.deepEqual(args, ['-xzf', args[1], '-C', args[3]]);
      const directory = args[3]!;
      const binary = join(directory, entrypoint);
      await mkdir(dirname(binary), { recursive: true });
      await mkdir(join(directory, 'codex-resources'));
      await mkdir(join(directory, 'codex-path'));
      await writeFile(binary, 'fake binary');
      await writeFile(join(dirname(binary), helper), 'fake helper');
      await writeFile(
        join(directory, 'codex-resources', 'bwrap'),
        'fake sandbox',
      );
      await writeFile(
        join(directory, 'codex-package.json'),
        JSON.stringify({ layoutVersion: 1, version, entrypoint, ...manifest }),
      );
      return ok;
    }
    if (bin === 'apt-get' || bin === 'sudo') return ok;
    assert.fail(`Unexpected external command ${bin}`);
  };
}

test('doctor reads only enabled checks, reports repairs and leaves the workspace untouched', async (t) => {
  const workspace = await fixture(t, {
    storage: { path: 'uncreated/data.db' },
    platforms: [{ id: 'off', kind: 'telegram', enabled: false }],
    agents: [{ id: 'off', kind: 'codex', enabled: false }],
  });
  const logs = t.mock.method(console, 'log', () => {});
  const commands: string[][] = [];
  const status = await main(['doctor', workspace, '--json'], undefined, {
    runCommand: cliRunner(commands),
    fetch: async () => {
      assert.fail('Disabled plugins must not send requests');
    },
  });
  assert.equal(status, 1);
  const items = JSON.parse(String(logs.mock.calls[0]?.arguments[0]));
  assert.deepEqual(
    items.map((item: { id: string }) => item.id),
    ['node', 'database', 'git'],
  );
  assert.equal(items[1].status, 'ok');
  assert.equal(items[2].status, 'fail');
  assert.match(items[2].fix.command.join(' '), /apt-get install -y git$/);
  assert.deepEqual(commands, [
    ['git', '--version'],
    ['apt-get', '--version'],
  ]);
  assert.deepEqual(await readdir(workspace), ['tsugimori.json']);
});

test('setup prints package installs, verifies Codex archives and bumps pins only on upgrade', async (t) => {
  const workspace = await fixture(t, {
    exec: {},
    agents: [
      { id: 'bot', kind: 'codex', version: '1.2.3' },
      { id: 'off', kind: 'codex', enabled: false },
    ],
  });
  const logs = t.mock.method(console, 'log', () => {});
  const commands: string[][] = [];
  const registry = new PluginRegistry([codex]);
  const base = {
    platform: 'linux' as const,
    arch: 'x64',
    runCommand: cliRunner(commands),
  };
  const runtime = join(workspace, 'runtime', 'codex');
  const previous = join(runtime, '1.2.3');
  await mkdir(previous, { recursive: true });
  await writeFile(join(previous, 'codex'), 'old single-binary install');
  const initial = releases('1.2.3');
  assert.equal(await main(['doctor', workspace, '--json'], undefined, base), 1);
  const reports = JSON.parse(String(logs.mock.calls.at(-1)?.arguments[0]));
  const cli = reports.find((item: { id: string }) => item.id === 'codex-cli');
  assert.equal(cli?.status, 'fail');
  assert.equal(cli?.fix.hint, 'Run tsugimori setup --upgrade');
  const setupLogIndex = logs.mock.callCount();
  assert.equal(
    await main(['setup', workspace], undefined, {
      ...base,
      fetch: initial.fetch,
    }),
    0,
  );
  assert.match(
    String(logs.mock.calls[setupLogIndex]?.arguments[0]),
    /apt-get install -y git bubblewrap$/,
  );
  assert.equal(
    commands.some((argv) => argv.includes('install')),
    false,
  );
  assert.match(initial.requested[0]!, /tags\/rust-v1\.2\.3$/);
  assert.deepEqual(await readdir(runtime), ['1.2.3']);
  assert.deepEqual((await readdir(previous)).sort(), [
    'bin',
    'codex-package.json',
    'codex-path',
    'codex-resources',
  ]);
  assert.equal(
    await readFile(join(previous, 'bin', 'codex-code-mode-host'), 'utf8'),
    'fake helper',
  );
  assert.equal(
    await readFile(join(previous, 'codex-resources', 'bwrap'), 'utf8'),
    'fake sandbox',
  );
  assert.equal(
    (await loadSettings(workspace, registry)).agents[0]?.version,
    '1.2.3',
  );
  const corrupted = releases('1.2.4', 'b'.repeat(64));
  assert.equal(
    await main(['setup', workspace, '--upgrade'], undefined, {
      ...base,
      fetch: corrupted.fetch,
    }),
    1,
  );
  assert.deepEqual(
    commands.filter(([bin]) => bin === 'tar').map(([, flag]) => flag),
    ['-tzf', '-xzf'],
  );
  assert.deepEqual(await readdir(runtime), ['1.2.3']);
  assert.equal(
    (await loadSettings(workspace, registry)).agents[0]?.version,
    '1.2.3',
  );
  const upgrade = releases('1.2.4');
  assert.equal(
    await main(['setup', workspace, '--yes', '--upgrade'], undefined, {
      ...base,
      fetch: upgrade.fetch,
      runCommand: cliRunner(commands, { version: '1.2.4' }),
    }),
    0,
  );
  assert.match(upgrade.requested[0]!, /latest$/);
  assert.equal(commands.filter((argv) => argv.includes('install')).length, 1);
  assert.equal(
    (await loadSettings(workspace, registry)).agents[0]?.version,
    '1.2.4',
  );
  assert.equal(
    (await loadSettings(workspace, registry)).agents[1]?.version,
    undefined,
  );
});

test('managed Codex setup rejects unsafe archive members and invalid manifests', async (t) => {
  for (const { options, message, tarFlags } of [
    {
      options: { listing: '/absolute' },
      message: /unsafe member path/,
      tarFlags: ['-tzf'],
    },
    {
      options: { listing: 'subdir/../file' },
      message: /unsafe member path/,
      tarFlags: ['-tzf'],
    },
    {
      options: { manifest: { entrypoint: 'bin/../codex' } },
      message: /invalid layout, version, or entrypoint/,
      tarFlags: ['-tzf', '-xzf'],
    },
    {
      options: { manifest: { layoutVersion: 2 } },
      message: /invalid layout, version, or entrypoint/,
      tarFlags: ['-tzf', '-xzf'],
    },
    {
      options: { manifest: { version: '3.2.1' } },
      message: /invalid layout, version, or entrypoint/,
      tarFlags: ['-tzf', '-xzf'],
    },
  ]) {
    const workspace = await fixture(t, {
      agents: [{ id: 'bot', kind: 'codex', version: '1.2.3' }],
    });
    const logs = t.mock.method(console, 'log', () => {});
    const commands: string[][] = [];
    const runtime = join(workspace, 'runtime', 'codex');
    const previous = join(runtime, '1.2.3');
    await mkdir(previous, { recursive: true });
    await writeFile(join(previous, 'codex'), 'old single-binary install');
    assert.equal(
      await main(['setup', workspace], undefined, {
        arch: 'x64',
        platform: 'linux',
        fetch: releases('1.2.3').fetch,
        runCommand: cliRunner(commands, options),
      }),
      1,
    );
    assert.match(String(logs.mock.calls.at(-1)?.arguments[0]), message);
    logs.mock.restore();
    assert.deepEqual(
      commands.filter(([bin]) => bin === 'tar').map(([, flag]) => flag),
      tarFlags,
    );
    assert.deepEqual(await readdir(runtime), ['1.2.3']);
    assert.deepEqual(await readdir(previous), ['codex']);
  }
});

test('managed Codex setup selects the Windows package and reports when it is missing', async (t) => {
  const workspace = await fixture(t, {
    agents: [{ id: 'bot', kind: 'codex' }],
  });
  const logs = t.mock.method(console, 'log', () => {});
  const commands: string[][] = [];
  const archiveName = 'codex-package-x86_64-pc-windows-msvc.tar.gz';
  const base = {
    arch: 'x64',
    platform: 'win32' as const,
    runCommand: cliRunner(commands, {
      archiveName,
      entrypoint: 'bin/codex.exe',
    }),
  };
  const legacyOnly = releases(
    '1.2.3',
    undefined,
    'codex-x86_64-pc-windows-msvc.exe.tar.gz',
  );
  assert.equal(
    await main(['setup', workspace], undefined, {
      ...base,
      fetch: legacyOnly.fetch,
    }),
    1,
  );
  assert.match(
    String(logs.mock.calls.at(-1)?.arguments[0]),
    /no managed package archive for x86_64-pc-windows-msvc/,
  );
  assert.equal(legacyOnly.requested.length, 1);
  const release = releases('1.2.3', undefined, archiveName);
  assert.equal(
    await main(['setup', workspace], undefined, {
      ...base,
      fetch: release.fetch,
    }),
    0,
  );
  assert.equal(basename(release.requested.at(-1)!), archiveName);
  assert.deepEqual(
    (await readdir(join(workspace, 'runtime', 'codex', '1.2.3', 'bin'))).sort(),
    ['codex-code-mode-host.exe', 'codex.exe'],
  );
});

test('Codex add confirms the device-login account and /login runs only the login step', async (t) => {
  const workspace = await fixture(t);
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const registry = new PluginRegistry([codex]);
  const repo = releases('1.2.3');
  const commands: string[][] = [];
  const seen: string[] = [];
  let tested = 0;
  const entrypoint = 'alternate/codex-entry';
  const runner = cliRunner(commands, { entrypoint });
  const home = join(workspace, 'agents', 'codex-1', 'home');
  const setup = new GuidedSetup({
    registry,
    workspace,
    store,
    platform: 'linux',
    arch: 'x64',
    fetch: repo.fetch,
    testAgent: async () => {
      tested++;
    },
    async runCommand(args, options) {
      const [bin, command, subcommand] = args;
      if (bin === 'tar') return runner(args, options);
      assert.equal(
        bin,
        join(workspace, 'runtime', 'codex', '1.2.3', entrypoint),
      );
      assert.equal(options?.env?.CODEX_HOME, home);
      if (command === '--version') return { ...ok, stdout: 'codex-cli 1.2.3' };
      if (command === 'login' && subcommand === 'status') return ok;
      const io = { close() {}, write() {} };
      const onLine = options?.onLine;
      assert.ok(onLine);
      if (command === 'login') {
        await onLine('https://auth.openai.com/codex/device', io);
        await onLine('ABCD-EFGH', io);
        await onLine('unrelated output never relayed', io);
      } else {
        assert.equal(command, 'app-server');
        await onLine(JSON.stringify({ id: 1, result: {} }), io);
        await onLine(
          JSON.stringify({
            id: 2,
            result: {
              account: { type: 'chatgpt', email: 'test@example.test' },
            },
          }),
          io,
        );
      }
      return ok;
    },
  });
  const answers = ['no', 'yes', 'yes'];
  const io = {
    signal: AbortSignal.timeout(10_000),
    show: async (text: string) => {
      seen.push(text);
    },
    prompt: async ({ text }: { text: string }) => {
      assert.match(text, /test@example\.test/);
      return answers.shift()!;
    },
  };
  const request = {
    mode: 'add',
    category: 'agent',
    kind: 'codex',
    id: 'codex-1',
  } as const;
  await assert.rejects(setup.run(request, io), /not confirmed/);
  assert.deepEqual((await loadSettings(workspace, registry)).agents, []);
  await setup.run(request, io);
  assert.equal(
    (await loadSettings(workspace, registry)).agents[0]?.version,
    '1.2.3',
  );
  assert.ok(seen.some((text) => text.includes('ABCD-EFGH')));
  assert.ok(seen.every((text) => !text.includes('unrelated output')));
  assert.deepEqual(
    commands.filter(([bin]) => bin === 'tar').map(([, flag]) => flag),
    ['-tzf', '-xzf'],
  );
  assert.equal(tested, 1);
  await setup.run({ mode: 'login', id: 'codex-1' }, io);
  assert.equal(tested, 1);
  assert.equal(
    (await loadSettings(workspace, registry)).agents[0]?.enabled,
    true,
  );
});

test('Claude uses the SDK binary and keeps setup-token auth out of the config and progress', async (t) => {
  const workspace = await fixture(t);
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const registry = new PluginRegistry([claude]);
  const token = 'sk-ant-oat01-test-test-test-test-test-tests';
  const home = join(workspace, 'agents', 'claude-1', 'home');
  const prompts: boolean[] = [];
  const progress: string[] = [];
  let tested = false;
  const setup = new GuidedSetup({
    registry,
    workspace,
    store,
    testAgent: async (_entry, ctx) => {
      const key = (await loadSettings(workspace, registry)).agents[0]?.options
        ?.tokenEnv;
      assert.equal(key, undefined);
      assert.equal(
        ctx.credential('CLAUDE_CODE_OAUTH_TOKEN_636C617564652D31'),
        token,
      );
      tested = true;
    },
    async runCommand([cli, subcommand, action], options) {
      assert.match(cli, /claude-agent-sdk-[^/]+\/claude(?:\.exe)?$/);
      assert.equal(subcommand, 'auth');
      assert.equal(action, 'status');
      assert.equal(options?.env?.CLAUDE_CONFIG_DIR, home);
      assert.equal(options?.env?.CLAUDE_CODE_OAUTH_TOKEN, token);
      return { ...ok, stdout: '{"loggedIn":true}' };
    },
  });
  await mkdir(join(workspace, 'agents'), { recursive: true });
  await setup.run(
    { mode: 'add', category: 'agent', id: 'claude-1', kind: 'claude-sdk' },
    {
      signal: AbortSignal.timeout(5_000),
      show: async (text) => {
        progress.push(text);
      },
      prompt: async ({ secret }) => {
        prompts.push(Boolean(secret));
        return secret ? token : 'token';
      },
    },
  );
  assert.deepEqual(prompts, [false, true]);
  assert.ok(tested);
  assert.ok(
    !JSON.stringify(await loadSettings(workspace, registry)).includes(token),
  );
  assert.ok(!progress.join('\n').includes(token));
});

test('Claude browser login relays the vendor URL, handles a partial code prompt and confirms identity', async (t) => {
  const workspace = await fixture(t);
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const registry = new PluginRegistry([claude]);
  const progress: string[] = [];
  const code = 'example-one-time#expected-state';
  const signIn =
    'https://claude.com/cai/oauth/authorize?state=random&code_challenge=example';
  const prompts: { secret?: boolean; text: string }[] = [];
  let written = '';
  const setup = new GuidedSetup({
    registry,
    workspace,
    store,
    testAgent: async () => {},
    async runCommand([, verb, action], options) {
      assert.equal(verb, 'auth');
      if (action === 'status')
        return {
          ...ok,
          stdout: '{"loggedIn":true,"email":"owner@example.test"}',
        };
      assert.equal(action, 'login');
      const onChunk = options?.onChunk;
      assert.ok(onChunk);
      const io = {
        close() {},
        write(text: string) {
          written += text;
        },
      };
      await onChunk('Opening ' + signIn.slice(0, 45), io);
      await onChunk(signIn.slice(45) + '\nPaste code ', io);
      await onChunk('here > ', io);
      return ok;
    },
  });
  await setup.run(
    { mode: 'add', category: 'agent', id: 'claude', kind: 'claude-sdk' },
    {
      signal: AbortSignal.timeout(5_000),
      show: async (text) => {
        progress.push(text);
      },
      prompt: async (question) => {
        prompts.push(question);
        return prompts.length === 1 ? 'login' : question.secret ? code : 'yes';
      },
    },
  );
  assert.equal(written, code + '\n');
  assert.match(prompts[2]?.text ?? '', /owner@example\.test/);
  assert.ok(progress.some((text) => text.includes(signIn)));
  assert.ok(!progress.join('\n').includes(code));
});

test('doctor distinguishes bubblewrap namespaces from named and Quick Cloudflare preview checks', async (t) => {
  const workspace = await fixture(t, {
    exec: {},
    preview: {
      named: {
        tunnelId: '12345678-1234-1234-1234-123456789012',
        zoneId: '0'.repeat(32),
        domain: 'example.test',
        accessAud: 'fake-expected-audience',
        accessTeam: 'example',
        ownerEmail: 'owner@example.test',
        tokenEnv: 'TEST_PHASE_D_CLOUDFLARE',
      },
    },
  });
  const logs = t.mock.method(console, 'log', () => {});
  process.env.TEST_PHASE_D_CLOUDFLARE = 'fake-api-token';
  t.after(() => {
    delete process.env.TEST_PHASE_D_CLOUDFLARE;
  });
  const status = await main(['doctor', workspace], undefined, {
    platform: 'linux',
    async runCommand([bin, arg]) {
      switch (bin) {
        case 'git':
          return ok;
        case 'bwrap':
          return arg === '--version' ? ok : missing;
        case 'cloudflared':
          return missing;
        default:
          assert.fail(`Unexpected command ${bin}`);
      }
    },
    async fetch(url, options) {
      assert.match(String(url), /api\.cloudflare\.com.*\/dns_records\?/);
      assert.equal(
        new Headers(options?.headers).get('authorization'),
        'Bearer fake-api-token',
      );
      return Response.json({ success: true, result: [] });
    },
  });
  assert.equal(status, 1);
  const output = String(logs.mock.calls[0]?.arguments[0]);
  assert.match(output, /\[OK\].*Bubblewrap is available/);
  assert.match(output, /\[FAIL\].*Unprivileged user namespaces/);
  assert.match(output, /\[FAIL\].*Cloudflare Tunnel CLI/);
  assert.match(output, /\[OK\].*Cloudflare DNS credentials/);
  assert.ok(!output.includes('fake-api-token'));
});
