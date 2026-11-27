import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { json, mri, string } from './wire.ts';

export interface SavedLogin {
  account: string;
  displayName: string;
  refreshToken: string;
}

export const credentialName = 'refresh-token.json';

function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function credentialStore(workspace: string, home: string) {
  async function directory(create: boolean) {
    let directory = await realpath(workspace);
    for (const part of relative(workspace, home).split(sep)) {
      directory = join(directory, part);
      if (create) {
        await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
          if (!(
            error instanceof Error &&
            'code' in error &&
            error.code === 'EEXIST'
          ))
            throw error;
        });
      }
      if (!(await lstat(directory)).isDirectory())
        throw new Error('Invalid Teams Personal credential directory');
    }
    if (create) await chmod(directory, 0o700);
    if ((await lstat(directory)).mode & 0o077)
      throw new Error('Unsafe Teams Personal credential directory permissions');
    return directory;
  }

  return {
    async read(): Promise<SavedLogin | undefined> {
      try {
        const file = await open(
          join(await directory(false), credentialName),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.mode & 0o077 || stat.size > 64_000)
            throw new Error('Unsafe Teams Personal credential file');
          const data = json(await file.readFile('utf8'));
          const account = mri(data.account);
          const displayName = string(data.displayName);
          const refreshToken = string(data.refreshToken);
          if (!account || !displayName || !refreshToken)
            throw new Error('Invalid Teams Personal credential file');
          return { account, displayName, refreshToken };
        } finally {
          await file.close();
        }
      } catch (error) {
        if (!missing(error))
          throw new Error('Could not read the Teams Personal login file');
      }
    },
    async save(login: SavedLogin) {
      try {
        const folder = await directory(true);
        const temporary = join(folder, `.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(login), {
            mode: 0o600,
            flag: 'wx',
          });
          await rename(temporary, join(folder, credentialName));
        } finally {
          await rm(temporary, { force: true });
        }
      } catch {
        throw new Error('Could not save the Teams Personal login file');
      }
    },
    async clear() {
      try {
        await rm(join(await directory(false), credentialName), { force: true });
      } catch (error) {
        if (!missing(error))
          throw new Error(
            'Could not clear the rejected Teams Personal login file',
          );
      }
    },
  };
}
