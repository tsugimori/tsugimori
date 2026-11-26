import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
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

function errorCode(error: unknown) {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

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
  await writeWorkspaceFile(join(workdir, 'agents.json'), contents);
  if (record) await recordWorkspace(workdir, userId, true);
}

export async function writeWorkspaceFile(
  path: string,
  contents: Buffer | string,
  mode = 0o600,
) {
  const temporary = join(dirname(path), `.tsugimori-${randomUUID()}`);
  const file = await open(temporary, 'wx', mode);
  try {
    try {
      await file.writeFile(contents);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function recordMemory(
  workdir: string,
  action: 'add' | 'remove' | 'replace',
  reason: string,
  approvedBy: string,
) {
  let step = 'inspect Git worktree';
  const run = (args: string[], timeout = 10_000) =>
    git(
      'git',
      [
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
          PATH: environment.PATH,
          LANG: environment.LANG,
          HOME: process.env.HOME,
          SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
          GIT_TERMINAL_PROMPT: environment.GIT_TERMINAL_PROMPT,
        },
        timeout,
        killSignal: 'SIGKILL',
      },
    );
  try {
    const marker = await lstat(join(workdir, '.git')).catch(
      (error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      },
    );
    if (!marker || (!marker.isFile() && !marker.isDirectory())) return;
    const root = await run(['rev-parse', '--show-toplevel']);
    if ((await realpath(root.stdout.replace(/\n$/, ''))) !== workdir) return;
    const remotes = await run(['remote']);
    if (!remotes.stdout.split('\n').includes('origin')) return;

    step = 'stage MEMORY.md';
    await run(['add', '--', 'MEMORY.md']);
    step = 'commit MEMORY.md';
    const changed = await run([
      'diff',
      '--cached',
      '--quiet',
      '--',
      'MEMORY.md',
    ]).then(
      () => false,
      (error: unknown) => {
        if (errorCode(error) !== 1) throw error;
        return true;
      },
    );
    if (changed) {
      const identity = [];
      for (const [key, fallback] of [
        ['user.name', 'tsugimori'],
        ['user.email', 'tsugimori@localhost'],
      ] as const) {
        const configured = await run(['config', '--local', '--get', key]).catch(
          (error: unknown) => {
            if (errorCode(error) !== 1) throw error;
          },
        );
        const value = configured?.stdout.replace(/\n$/, '') || fallback;
        const field = key.slice('user.'.length);
        identity.push(
          '-c',
          `author.${field}=${value}`,
          '-c',
          `committer.${field}=${value}`,
        );
      }
      await run([
        ...identity,
        'commit',
        '--quiet',
        '--only',
        '--cleanup=verbatim',
        '-m',
        `memory: ${action} via tsugimori`,
        '-m',
        `Reason: ${reason}\nApprover native ID: ${approvedBy}`,
        '--',
        'MEMORY.md',
      ]);
    }
    step = 'push to origin';
    await run(['push', 'origin', 'HEAD'], 30_000);
  } catch (error) {
    const code = errorCode(error);
    const timedOut =
      error instanceof Error && 'killed' in error && error.killed;
    return `${step}${timedOut ? ' timed out' : typeof code === 'number' ? ` failed (exit ${code})` : ' failed'}`;
  }
}
