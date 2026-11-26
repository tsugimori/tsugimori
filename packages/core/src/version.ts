import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

function readBuildInfo(): {
  builtAt?: string;
  commit: string;
  dirty?: boolean;
} {
  try {
    return JSON.parse(
      readFileSync(new URL('./build-info.json', import.meta.url), 'utf8'),
    ) as ReturnType<typeof readBuildInfo>;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { commit: 'unknown' };
    throw error;
  }
}

export const buildInfo = readBuildInfo();
export const gatewayBuild = {
  version,
  revision: buildInfo.commit === 'unknown' ? '' : buildInfo.commit.slice(0, 7),
};
