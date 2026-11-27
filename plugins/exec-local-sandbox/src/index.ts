import type {
  ExecBackend,
  ExecScope,
  ExecSession,
  RunOptions,
} from '@tsugimori/plugin-sdk';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { definePlugin, ToolFailure } from '@tsugimori/plugin-sdk';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRelay } from './relay.ts';

const sandboxRoot = '/workspace';
const sandboxReferences = '/references';
const node = '/run/bin/node';
const worker = '/run/tsugimori-worker.ts';
const control = '/run/tsugimori-control.sock';
const system = [
  '/usr',
  '/bin',
  '/lib',
  '/lib64',
  '/etc/ssl/certs',
  '/etc/localtime',
];
const maxOutput = 1024 * 1024;
const namespaceArgs = [
  '--unshare-all',
  '--unshare-user',
  '--disable-userns',
] as const;
const workerFile = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
    import.meta.url,
  ),
);

function inside(root: string, path: string) {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function existing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      !['ENOENT', 'ENOTDIR'].includes(String(error.code))
    )
      throw error;
  }
}

async function checkReferenceLinks(
  directory: string,
  workspace: string,
  denied: ReadonlySet<string>,
) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (denied.has(path)) continue;
    if (entry.isDirectory()) await checkReferenceLinks(path, workspace, denied);
    else if (entry.isSymbolicLink()) {
      const target = await realpath(path).catch(() => undefined);
      if (!target || !inside(workspace, target))
        throw new ToolFailure(
          'Shared reference links must stay inside the workspace',
        );
    }
  }
}

async function referenceMount(source: string, denyRead: string[]) {
  const workspace = await realpath(dirname(source));
  const path = join(workspace, basename(source));
  if (denyRead.some((host) => inside(host, source) || inside(host, path)))
    return;
  const entry = await existing(path);
  if (!entry) return;
  if (!entry.isDirectory() || (await realpath(path)) !== path)
    throw new ToolFailure('The shared references directory must be local');

  const denied = denyRead.flatMap((host) => {
    if (inside(source, host)) return [join(path, relative(source, host))];
    return inside(path, host) ? [host] : [];
  });
  const masks = new Set(
    denied.filter(
      (host) =>
        !denied.some((parent) => parent !== host && inside(parent, host)),
    ),
  );
  await checkReferenceLinks(path, workspace, masks);
  return { path, masks };
}

type Relay = Awaited<ReturnType<typeof createRelay>>;

interface BackendDependencies {
  command?: string;
  platform?: string;
  spawn?(
    command: string,
    args: readonly string[],
    options: { stdio: 'pipe' },
  ): ChildProcessWithoutNullStreams;
}

export class LocalSandbox implements ExecBackend {
  readonly id = 'local-sandbox';
  readonly #deps: BackendDependencies;

  constructor(deps: BackendDependencies = {}) {
    this.#deps = deps;
  }

  async start(scope: ExecScope) {
    if ((this.#deps.platform ?? process.platform) !== 'linux')
      throw new ToolFailure(
        'Local sandbox execution requires Linux and bubblewrap. Seatbelt is unavailable.',
      );
    if (
      (await realpath(scope.workdir)) !== scope.workdir ||
      scope.writable.length !== 1 ||
      scope.writable[0] !== scope.workdir
    )
      throw new ToolFailure('Expected exactly one canonical chat workdir');
    return new Session(scope, this.#deps);
  }
}

class Session implements ExecSession {
  readonly #scope: ExecScope;
  readonly #deps: BackendDependencies;
  readonly #closed = new AbortController();
  readonly #children = new Map<Promise<unknown>, string | undefined>();
  readonly #ports = new Map<
    number,
    {
      child: ChildProcessWithoutNullStreams;
      closed: AbortController;
      relay: Relay;
      taskId?: string;
    }
  >();
  readonly #opening = new Set<number>();

  constructor(scope: ExecScope, deps: BackendDependencies) {
    this.#scope = scope;
    this.#deps = deps;
  }

  async stop() {
    this.#closed.abort();
    await Promise.allSettled(this.#children.keys());
  }

  async stopTask(taskId: string) {
    for (const job of this.#ports.values())
      if (job.taskId === taskId) job.child.kill('SIGKILL');
    await Promise.allSettled(
      [...this.#children].flatMap(([child, owner]) =>
        owner === taskId ? [child] : [],
      ),
    );
  }

  async exposePort(port: number) {
    const job = this.#ports.get(port);
    if (!job || job.child.exitCode !== null || job.child.signalCode !== null)
      throw new ToolFailure(
        'This port has no running service in the chat sandbox',
      );
    return { ...job.relay.endpoint, closed: job.closed.signal };
  }

  async run(cmd: string[], opts: RunOptions = {}) {
    if (!cmd.length || cmd.some((part) => part.includes('\0')))
      throw new ToolFailure('Expected a command and arguments');
    if (opts.backgroundPort !== undefined) {
      const starting = this.#serve(cmd, {
        ...opts,
        backgroundPort: opts.backgroundPort,
      });
      this.#children.set(starting, opts.taskId);
      try {
        await starting;
      } finally {
        this.#children.delete(starting);
      }
      return { exitCode: null, stdout: 'Sandbox service started', stderr: '' };
    }
    const result = await this.#run(cmd, opts);
    return { ...result, stdout: result.stdout.toString('utf8') };
  }

  async readFile(
    path: string,
    opts: Pick<RunOptions, 'signal' | 'taskId'> = {},
  ) {
    const result = await this.#run(
      [node, worker, 'read', this.#path(path)],
      opts,
    );
    if (result.exitCode !== 0)
      throw new ToolFailure('Could not read the chat file');
    return result.stdout;
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    opts: Pick<RunOptions, 'signal' | 'taskId'> = {},
  ) {
    if (data.byteLength > maxOutput)
      throw new ToolFailure('Chat file exceeds 1 MiB');
    const result = await this.#run(
      [node, worker, 'write', this.#path(path)],
      opts,
      data,
    );
    if (result.exitCode !== 0)
      throw new ToolFailure('Could not write the chat file');
  }

  #path(path: string) {
    const { workdir, denyRead } = this.#scope;
    const host = resolve(workdir, path);
    if (
      !inside(workdir, host) ||
      host === workdir ||
      denyRead.some((root) => inside(root, host))
    )
      throw new ToolFailure('File is outside the accessible chat workspace');
    return join(sandboxRoot, relative(workdir, host));
  }

  async #args(relay?: Relay) {
    const { workdir, denyRead, network, references } = this.#scope;
    const args = [
      ...namespaceArgs,
      '--die-with-parent',
      '--new-session',
      '--clearenv',
      '--setenv',
      'PATH',
      '/run/bin:/usr/local/bin:/usr/bin:/bin',
      '--setenv',
      'HOME',
      '/tmp',
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--setenv',
      'LANG',
      'C.UTF-8',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--dir',
      '/run',
      '--bind',
      workdir,
      sandboxRoot,
      '--ro-bind',
      process.execPath,
      node,
      '--ro-bind',
      workerFile,
      worker,
      '--chdir',
      sandboxRoot,
    ];
    for (const path of system) args.push('--ro-bind-try', path, path);
    if (network === 'allow') {
      args.push('--share-net');
      for (const path of [
        '/etc/resolv.conf',
        '/etc/hosts',
        '/etc/nsswitch.conf',
      ])
        args.push('--ro-bind-try', path, path);
    }
    if (relay) {
      for (const name of ['rules', 'skills']) {
        const path = join(workdir, name);
        await mkdir(path, { recursive: true });
        if ((await realpath(path)) !== path)
          throw new ToolFailure(
            'Chat rules and skills directories must be local',
          );
        args.push('--ro-bind', path, join(sandboxRoot, name));
      }
    }
    const mount = references && (await referenceMount(references, denyRead));
    if (mount) args.push('--ro-bind', mount.path, sandboxReferences);
    const masks = denyRead.flatMap((host) => {
      if (host === workdir)
        throw new ToolFailure('Cannot deny the complete chat workdir');
      if (inside(workdir, host))
        return [[host, join(sandboxRoot, relative(workdir, host))] as const];
      if (system.some((root) => inside(root, host)))
        return [[host, host] as const];
      return [];
    });
    if (mount)
      for (const host of mount.masks)
        masks.push([host, join(sandboxReferences, relative(mount.path, host))]);
    for (const [host, target] of masks) {
      const info = await existing(host);
      if (info?.isDirectory())
        args.push('--tmpfs', target, '--remount-ro', target);
      else if (info?.isFile()) args.push('--ro-bind', '/dev/null', target);
      else if (info?.isSymbolicLink())
        throw new ToolFailure('Sandbox deny paths must not be symbolic links');
    }
    if (relay) args.push('--ro-bind', relay.path, control);
    return args;
  }

  async #launch(cmd: string[], opts: RunOptions, relay?: Relay) {
    const signal = AbortSignal.any([
      this.#closed.signal,
      opts.signal ?? new AbortController().signal,
    ]);
    signal.throwIfAborted();
    const args = await this.#args(relay);
    signal.throwIfAborted();
    const child = (this.#deps.spawn ?? spawn)(
      this.#deps.command ?? 'bwrap',
      [...args, '--', ...cmd],
      { stdio: 'pipe' },
    );
    const done = Promise.withResolvers<number | null>();
    const abort = () => child.kill('SIGKILL');
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error: NodeJS.ErrnoException) => {
      done.reject(
        error.code === 'ENOENT'
          ? new ToolFailure(
              'bubblewrap (bwrap) is required for local execution',
            )
          : new ToolFailure('Could not launch bubblewrap'),
      );
    });
    child.once('close', (code) => done.resolve(code));
    const completion = done.promise.finally(cleanup);
    this.#children.set(completion, opts.taskId);
    void completion.then(
      () => this.#children.delete(completion),
      () => this.#children.delete(completion),
    );
    return { child, completion, signal };
  }

  async #run(cmd: string[], opts: RunOptions, input?: Uint8Array) {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
    const signal = opts.signal
      ? AbortSignal.any([timeout, opts.signal])
      : timeout;
    const { child, completion } = await this.#launch(cmd, {
      signal,
      taskId: opts.taskId,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const collect = (output: Buffer[]) => (data: Buffer) => {
      size += data.length;
      if (size > maxOutput) child.kill('SIGKILL');
      else output.push(data);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE')
        child.kill('SIGKILL');
    });
    child.stdin.end(input);
    const exitCode = await completion;
    signal.throwIfAborted();
    if (size > maxOutput)
      throw new ToolFailure('Sandbox command exceeded 1 MiB of output');
    if (
      exitCode !== 0 &&
      Buffer.concat(stderr).toString('utf8').startsWith('bwrap:')
    )
      throw new ToolFailure('bubblewrap could not create the chat sandbox');
    return {
      exitCode,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };
  }

  async #serve(cmd: string[], opts: RunOptions & { backgroundPort: number }) {
    const port = opts.backgroundPort;
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      this.#scope.network !== 'none'
    )
      throw new ToolFailure(
        'Preview services require an isolated sandbox and a valid port',
      );
    if (
      this.#ports.size + this.#opening.size >= 8 ||
      this.#ports.has(port) ||
      this.#opening.has(port)
    )
      throw new ToolFailure(
        'The sandbox service limit or port is already in use',
      );
    this.#opening.add(port);
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
    const starting = AbortSignal.any([
      timeout,
      this.#closed.signal,
      ...(opts.signal ? [opts.signal] : []),
    ]);
    let relay: Relay | undefined;
    let started = false;
    try {
      relay = await createRelay();
      starting.throwIfAborted();
      const { child, completion } = await this.#launch(
        [node, worker, 'serve', String(port), ...cmd],
        { taskId: opts.taskId },
        relay,
      );
      const closed = new AbortController();
      const ready = Promise.withResolvers<void>();
      const stop = () => {
        child.kill('SIGKILL');
        ready.reject(new ToolFailure('Sandbox service did not start'));
      };
      starting.addEventListener('abort', stop, { once: true });
      if (starting.aborted) stop();
      const liveRelay = relay;
      const cleanup = completion.then(
        async () => {
          ready.reject(
            new ToolFailure('Sandbox service exited before it was ready'),
          );
          this.#ports.delete(port);
          closed.abort();
          await liveRelay.stop();
        },
        async (error: unknown) => {
          ready.reject(error);
          await liveRelay.stop();
        },
      );
      this.#children.set(cleanup, opts.taskId);
      void cleanup.then(
        () => this.#children.delete(cleanup),
        () => this.#children.delete(cleanup),
      );
      child.stdin.end();
      child.stderr.resume();
      child.stdout.once('data', () => ready.resolve());
      try {
        await ready.promise;
        starting.throwIfAborted();
        this.#ports.set(port, { child, relay, closed, taskId: opts.taskId });
        started = true;
      } finally {
        starting.removeEventListener('abort', stop);
        if (!started) {
          child.kill('SIGKILL');
          await cleanup;
        }
        relay = undefined;
      }
    } finally {
      this.#opening.delete(port);
      if (!started) await relay?.stop();
    }
  }
}

export default definePlugin({
  name: 'exec-local-sandbox',
  async checks({ platform, runCommand }) {
    const capabilities = ['exec'];
    if (platform !== 'linux')
      return [
        {
          id: 'bubblewrap',
          title: 'Local sandbox',
          status: 'fail',
          detail: 'The local execution backend currently requires Linux.',
          localized: {
            'zh-TW': { title: '本機沙箱', hint: '請在 Linux 上執行本機沙箱。' },
          },
          capabilities,
        },
      ];
    const available = async (argv: [string, ...string[]]) => {
      try {
        return (await runCommand(argv)).exitCode === 0;
      } catch {
        return false;
      }
    };
    if (!(await available(['bwrap', '--version'])))
      return [
        {
          id: 'bubblewrap',
          title: 'Bubblewrap',
          status: 'fail',
          detail:
            'Bubblewrap is unavailable. Shell and file tools are disabled.',
          fix: { hint: 'Run tsugimori setup to see the install command.' },
          localized: {
            'zh-TW': {
              title: 'Bubblewrap',
              hint: '請執行 tsugimori setup 查看安裝指令。',
            },
          },
          capabilities,
        },
      ];
    const namespaces = await available([
      'bwrap',
      ...namespaceArgs,
      '--ro-bind',
      '/',
      '/',
      '--',
      '/bin/true',
    ]);
    return [
      {
        id: 'bubblewrap',
        title: 'Bubblewrap',
        status: 'ok',
        detail: 'Bubblewrap is available.',
      },
      {
        id: 'user-namespaces',
        title: 'Unprivileged user namespaces',
        status: namespaces ? 'ok' : 'fail',
        detail: namespaces
          ? 'Bubblewrap can create isolated namespaces.'
          : 'Bubblewrap cannot create isolated namespaces. Shell and file tools are disabled.',
        fix: namespaces
          ? undefined
          : {
              hint: 'Check your distribution’s user namespace and AppArmor configuration.',
            },
        localized: {
          'zh-TW': {
            title: '非特權使用者命名空間',
            hint: '請檢查系統的使用者命名空間及 AppArmor 設定。',
          },
        },
        capabilities,
      },
    ];
  },
  execBackends: [new LocalSandbox()],
});
