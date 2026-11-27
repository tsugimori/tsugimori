import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import localSandboxPlugin, { LocalSandbox } from '../src/index.ts';

const namespaceArgs = ['--unshare-all', '--unshare-user', '--disable-userns'];

test('the bubblewrap probe and command both explicitly unshare the user namespace before disabling it', async (t) => {
  const workdir = await realpath(
    await mkdtemp(join(tmpdir(), 'tsugimori-exec-test-')),
  );
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const probes: (readonly string[])[] = [];
  await localSandboxPlugin.checks?.({
    arch: process.arch,
    credential: () => undefined,
    entry: { id: 'local-sandbox', kind: 'local-sandbox' },
    fetch,
    platform: 'linux',
    runCommand: async (args) => {
      probes.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    workspace: workdir,
  });
  assert.deepEqual(probes[1]?.slice(0, 4), ['bwrap', ...namespaceArgs]);

  const sandbox = new LocalSandbox({
    platform: 'linux',
    spawn(command, args) {
      assert.equal(command, 'bwrap');
      assert.deepEqual(args?.slice(0, 3), namespaceArgs);
      return spawn(process.execPath, ['-e', ''], { stdio: 'pipe' });
    },
  });
  const session = await sandbox.start({
    workdir,
    writable: [workdir],
    denyRead: [],
    network: 'none',
  });
  t.after(() => session.stop());
  assert.equal((await session.run(['true'], {})).exitCode, 0);
});

test('reference mounts use only the canonical workspace directory and refuse escaping symlinks', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'tsugimori-references-test-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const alias = join(root, 'alias');
  const workdir = join(workspace, 'chats', 'adapter', 'chat');
  const references = join(workspace, 'references');
  const outside = join(root, 'outside');
  await mkdir(workdir, { recursive: true });
  await mkdir(outside);
  await symlink(workspace, alias);

  const launches: (readonly string[])[] = [];
  const session = await new LocalSandbox({
    platform: 'linux',
    spawn(_command, args) {
      launches.push(args);
      return spawn(process.execPath, ['-e', ''], { stdio: 'pipe' });
    },
  }).start({
    workdir,
    writable: [workdir],
    denyRead: [],
    network: 'none',
    references: join(alias, 'references'),
  });
  t.after(() => session.stop());

  await session.run(['true'], {});
  assert.ok(!launches[0]?.includes('/references'));

  await symlink(outside, references);
  await assert.rejects(
    session.run(['true'], {}),
    /references directory must be local/,
  );
  await rm(references);
  await mkdir(references);

  await session.run(['true'], {});
  const args = launches[1]!;
  const target = args.indexOf('/references');
  assert.ok(target >= 2);
  assert.deepEqual(args.slice(target - 2, target + 1), [
    '--ro-bind',
    references,
    '/references',
  ]);
  assert.ok(!args.includes(workspace));

  await mkdir(join(references, 'nested'));
  await symlink(outside, join(references, 'nested', 'escape'));
  await assert.rejects(
    session.run(['true'], {}),
    /reference links must stay inside/,
  );
  assert.equal(launches.length, 2);
});

test('bubblewrap shares read-only references between chats and masks denied files', async (t) => {
  const probe = spawnSync('bwrap', [
    ...namespaceArgs,
    '--ro-bind',
    '/',
    '/',
    '--',
    '/bin/true',
  ]);
  if (probe.status !== 0) {
    t.skip('bubblewrap with user namespaces is unavailable');
    return;
  }

  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), 'tsugimori-references-test-')),
  );
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const references = join(workspace, 'references');
  const privateDir = join(references, 'private');
  const privateFile = join(references, 'hidden.tsv');
  const data = join(workspace, 'data');
  const rootFile = join(workspace, 'AGENTS.md');
  const captions = '1\tSpongeBob waves\n';
  await mkdir(privateDir, { recursive: true });
  await mkdir(data);
  await writeFile(rootFile, 'Workspace rules');
  await writeFile(join(data, 'internal'), 'Workspace data');
  await writeFile(join(references, 'captions.tsv'), captions);
  await writeFile(join(privateDir, 'internal'), 'Private directory');
  await writeFile(privateFile, 'Private file');
  await symlink('captions.tsv', join(references, 'index.tsv'));
  await symlink('hidden.tsv', join(references, 'hidden-link.tsv'));

  const sandbox = new LocalSandbox();
  for (const chat of ['first', 'second']) {
    const workdir = join(workspace, 'chats', 'adapter', chat);
    await mkdir(workdir, { recursive: true });
    const session = await sandbox.start({
      workdir,
      writable: [workdir],
      network: 'none',
      denyRead: [privateDir, privateFile],
      references,
    });
    t.after(() => session.stop());

    const contents = await session.run(
      ['/bin/cat', '/references/index.tsv'],
      {},
    );
    assert.equal(contents.exitCode, 0);
    assert.equal(contents.stdout, captions);
    const write = await session.run(
      ['/bin/sh', '-c', 'printf changed > /references/captions.tsv'],
      {},
    );
    assert.notEqual(write.exitCode, 0);
    const masked = await session.run(
      ['/bin/cat', '/references/hidden.tsv', '/references/hidden-link.tsv'],
      {},
    );
    assert.equal(masked.stdout, '');
    const inaccessible = await session.run(
      [
        '/bin/sh',
        '-c',
        'for path do [ ! -e "$path" ] || exit 1; done',
        'sh',
        '/references/private/internal',
        '/references/AGENTS.md',
        '/workspace/AGENTS.md',
        '/data/internal',
        '/references/data/internal',
        rootFile,
      ],
      {},
    );
    assert.equal(inaccessible.exitCode, 0);
  }
  assert.equal(
    await readFile(join(references, 'captions.tsv'), 'utf8'),
    captions,
  );
});

test('execution fails closed when bubblewrap is unavailable and cannot expose an arbitrary port', async (t) => {
  const workdir = await realpath(
    await mkdtemp(join(tmpdir(), 'tsugimori-exec-test-')),
  );
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const sandbox = new LocalSandbox({
    platform: 'linux',
    command: join(workdir, 'missing-bubblewrap'),
  });
  const session = await sandbox.start({
    workdir,
    writable: [workdir],
    denyRead: [],
    network: 'none',
  });
  t.after(() => session.stop());
  await assert.rejects(session.exposePort(8787), /no running service/);
  await assert.rejects(session.readFile('../other-chat'), /outside/);
  await assert.rejects(session.run(['true'], {}), /bubblewrap.*required/);
});

test(
  'stopping a task closes its background service and leaves earlier services running',
  { timeout: 5000 },
  async (t) => {
    const workdir = await realpath(
      await mkdtemp(join(tmpdir(), 'tsugimori-exec-test-')),
    );
    t.after(() => rm(workdir, { recursive: true, force: true }));
    const session = await new LocalSandbox({
      platform: 'linux',
      spawn() {
        return spawn(
          process.execPath,
          ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
          {
            stdio: 'pipe',
          },
        );
      },
    }).start({ workdir, writable: [workdir], denyRead: [], network: 'none' });
    t.after(() => session.stop());
    await session.run(['serve'], { backgroundPort: 8000, taskId: 'previous' });
    await session.run(['serve'], { backgroundPort: 8001, taskId: 'active' });
    const previous = await session.exposePort(8000);
    const active = await session.exposePort(8001);

    await session.stopTask('active');
    assert.equal(active.closed?.aborted, true);
    assert.equal(previous.closed?.aborted, false);
    await assert.rejects(session.exposePort(8001), /no running service/);
  },
);

test('a missing command is reported as not found instead of a sandbox failure', async (t) => {
  const probe = spawnSync('bwrap', [
    ...namespaceArgs,
    '--ro-bind',
    '/',
    '/',
    '--',
    '/bin/true',
  ]);
  if (probe.status !== 0) {
    t.skip('bubblewrap with user namespaces is unavailable');
    return;
  }
  const workdir = await realpath(
    await mkdtemp(join(tmpdir(), 'tsugimori-missing-command-test-')),
  );
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const session = await new LocalSandbox().start({
    workdir,
    writable: [workdir],
    network: 'none',
    denyRead: [],
  });
  t.after(() => session.stop());
  await assert.rejects(
    session.run(['tsugimori-no-such-command'], {}),
    /Command not found in the chat sandbox: tsugimori-no-such-command/,
  );
});
