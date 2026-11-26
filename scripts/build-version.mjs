import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const git = existsSync(new URL('.git', root))
  ? spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  : undefined;
const revision = git?.status === 0 ? git.stdout.trim() : '';
writeFileSync(new URL('packages/core/dist/build-revision', root), revision);
