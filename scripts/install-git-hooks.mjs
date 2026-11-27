import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Deployed copies and tarball installs have no Git checkout; skip quietly there.
if (existsSync('.git')) {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    stdio: 'inherit',
  });
}
