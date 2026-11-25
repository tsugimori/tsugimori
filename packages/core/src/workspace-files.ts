import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const git = promisify(execFile);

const environment = {
  PATH: process.env.PATH,
  LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

async function repository(workdir: string) {
  const gitdir = join(workdir, '.git');
  try {
    if (!(await lstat(gitdir)).isDirectory())
      throw new Error('Expected a private chat Git directory');
    if (!(await lstat(join(gitdir, 'config'))).isFile())
      throw new Error('Expected a private chat Git configuration');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
    try {
      await git('git', ['init', '--quiet', '--template=', workdir], {
        env: { ...environment, GIT_CEILING_DIRECTORIES: dirname(workdir) },
      });
    } catch (initError) {
      if (isMissingGit(initError)) return;
      throw initError;
    }
  }
  return gitdir;
}

function isMissingGit(error: unknown) {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ENOENT' &&
    'path' in error &&
    error.path === 'git'
  );
}

export async function prepareWorkspace(workdir: string, record: boolean) {
  if (record) await repository(workdir);
  for (const name of ['rules', 'skills'])
    await mkdir(join(workdir, name), { recursive: true });
}

export async function recordWorkspace(
  workdir: string,
  userId: string,
  settings = false,
) {
  const gitdir = await repository(workdir);
  if (!gitdir) return;
  const run = (...args: string[]) =>
    git(
      'git',
      [
        '--git-dir',
        gitdir,
        '--work-tree',
        workdir,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        cwd: workdir,
        env: {
          ...environment,
          GIT_AUTHOR_NAME: encodeURIComponent(userId),
          GIT_AUTHOR_EMAIL: `native+${encodeURIComponent(userId)}@tsugimori.invalid`,
          GIT_COMMITTER_NAME: 'Tsugimori',
          GIT_COMMITTER_EMAIL: 'workspace@tsugimori.invalid',
        },
      },
    );
  const paths = settings ? ['agents.json'] : ['rules', 'skills'];
  const pending = await run(
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...paths,
  );
  if (!pending.stdout) return;
  await run('add', '--all', '--', ...paths);
  const staged = await run(
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--',
    ...paths,
  );
  const stagedPaths = staged.stdout.split('\0');
  const changed = paths.filter((path) =>
    stagedPaths.some((name) => name === path || name.startsWith(path + '/')),
  );
  if (changed.length)
    await run(
      'commit',
      '--quiet',
      '--only',
      '-m',
      settings ? 'Update chat agent settings' : 'Update chat rules and skills',
      '--',
      ...changed,
    );
}

export async function writeWorkspaceSettings(
  workdir: string,
  contents: string,
  userId: string,
  record: boolean,
) {
  const temporary = join(workdir, `.tsugimori-${randomUUID()}`);
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(workdir, 'agents.json'));
    if (record) await recordWorkspace(workdir, userId, true);
  } finally {
    await rm(temporary, { force: true });
  }
}
