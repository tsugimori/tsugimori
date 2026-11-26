import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

function builtRevision() {
  try {
    return readFileSync(
      new URL('./build-revision', import.meta.url),
      'utf8',
    ).trim();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return '';
    throw error;
  }
}

export const gatewayBuild = { version, revision: builtRevision() };
