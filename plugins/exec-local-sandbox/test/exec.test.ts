import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LocalSandbox } from '../src/index.ts';

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
