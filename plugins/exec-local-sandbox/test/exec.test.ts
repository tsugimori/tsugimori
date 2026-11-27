import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import localSandboxPlugin, { LocalSandbox } from '../src/index.ts';

test('the bubblewrap probe and command both explicitly unshare the user namespace before disabling it', async (t) => {
  const workdir = await realpath(
    await mkdtemp(join(tmpdir(), 'tsugimori-exec-test-')),
  );
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const namespaceArgs = ['--unshare-all', '--unshare-user', '--disable-userns'];
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
