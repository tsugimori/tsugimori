import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const git = (args) =>
  spawnSync('git', args, {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
const head = existsSync(new URL('.git', root))
  ? git(['rev-parse', 'HEAD'])
  : undefined;
const status = head?.status === 0 ? git(['status', '--porcelain']) : undefined;
const info =
  head?.status === 0
    ? {
        commit: head.stdout.trim(),
        ...(status?.status === 0 && { dirty: Boolean(status.stdout.trim()) }),
        builtAt: new Date().toISOString(),
      }
    : { commit: 'unknown' };
writeFileSync(
  new URL('packages/core/dist/build-info.json', root),
  JSON.stringify(info) + '\n',
);
