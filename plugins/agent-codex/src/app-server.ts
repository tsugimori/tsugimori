import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export type SpawnServer = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;
export type RpcId = number | string;

export interface ServerFrame {
  id?: RpcId;
  method: string;
  params: Record<string, unknown>;
}

export class RpcError extends Error {
  readonly code: number | undefined;

  constructor(code: unknown, message?: unknown) {
    super(
      reasoningEffortError(message) ??
        `Codex RPC rejected${typeof code === 'number' ? ` (${code})` : ''}`,
    );
    this.code = typeof code === 'number' ? code : undefined;
  }
}

// Provider errors may echo the request. Extract only the known reasoning error.
export function reasoningEffortError(message: unknown) {
  if (typeof message !== 'string') return;
  return /Unsupported value: '[a-z]{1,16}' is not supported with the '[\w.-]{1,80}' model\.(?: Supported values are: '[a-z]{1,16}'(?:(?:, and | and |, )'[a-z]{1,16}')*\.)?/u.exec(
    message,
  )?.[0];
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export class AppServer extends EventEmitter<{ frame: [ServerFrame] }> {
  readonly #child: ChildProcess;
  readonly #failure = new AbortController();
  readonly #closed = Promise.withResolvers<void>();
  readonly #requests = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<unknown>>
  >();
  #sequence = 0;
  #closing?: Promise<void>;

  constructor(
    spawnServer: SpawnServer = spawn,
    command: string,
    env: NodeJS.ProcessEnv,
  ) {
    super();
    this.#child = spawnServer(command, ['app-server', '--listen', 'stdio://'], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.#child.on('error', () =>
      this.fail('Could not launch Codex app-server'),
    );
    this.#child.once('exit', (code, signal) => {
      this.fail(`Codex app-server exited (${code ?? signal ?? 'unknown'})`);
    });
    this.#child.once('close', () => this.#closed.resolve());
    const { stdin, stdout } = this.#child;
    if (!stdin || !stdout) {
      this.fail('Codex app-server requires piped stdin and stdout');
      return;
    }
    stdin.on('error', () => this.fail('Codex app-server stdin closed'));
    stdout.on('error', () => this.fail('Codex app-server stdout closed'));
    const lines = createInterface({ input: stdout, crlfDelay: Infinity });
    lines.on('error', () => this.fail('Codex app-server output stream failed'));
    lines.on('line', (line) => this.#receive(line));
  }

  get signal() {
    return this.#failure.signal;
  }

  fail(message: string) {
    if (this.signal.aborted) return;
    const error = new Error(message);
    this.#failure.abort(error);
    for (const pending of this.#requests.values()) pending.reject(error);
    void this.close();
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closing = this.#closed.promise;
    this.#child.kill('SIGTERM');
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 1_000);
    timer.unref();
    return this.#closing.finally(() => clearTimeout(timer));
  }

  async request(
    method: string,
    params: object,
    timeoutMs = 30_000,
    { failOnTimeout = true } = {},
  ) {
    this.signal.throwIfAborted();
    const id = ++this.#sequence;
    const pending = Promise.withResolvers<unknown>();
    this.#requests.set(id, pending);
    const timeout = setTimeout(() => {
      const message = `Codex ${method} timed out`;
      if (failOnTimeout) this.fail(message);
      else pending.reject(new Error(message));
    }, timeoutMs);
    timeout.unref();
    try {
      // Observe the response immediately, even if the transport fails during the write.
      const [, result] = await Promise.all([
        this.#write({ id, method, params }),
        pending.promise,
      ]);
      return asRecord(result);
    } finally {
      clearTimeout(timeout);
      this.#requests.delete(id);
    }
  }

  notify(method: string) {
    return this.#write({ method });
  }

  answer(id: RpcId, result: object) {
    return this.#write({ id, result });
  }

  reject(id: RpcId) {
    return this.#write({
      id,
      error: { code: -32601, message: 'Unsupported app-server request' },
    });
  }

  #write(message: object) {
    const done = Promise.withResolvers<void>();
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    const { stdin } = this.#child;
    if (!stdin)
      return Promise.reject(new Error('Codex app-server stdin missing'));
    stdin.write(JSON.stringify(message) + '\n', (error) => {
      if (error) {
        this.fail('Could not write to Codex app-server');
        done.reject(this.signal.reason);
      } else done.resolve();
    });
    return done.promise;
  }

  #receive(line: string) {
    if (this.signal.aborted || !line.trim()) return;
    let payload: Record<string, unknown>;
    try {
      payload = asRecord(JSON.parse(line));
    } catch {
      this.fail('Codex app-server sent invalid JSON');
      return;
    }
    const { id, method } = payload;
    if (typeof method === 'string') {
      this.emit('frame', {
        id: typeof id === 'number' || typeof id === 'string' ? id : undefined,
        method,
        params: asRecord(payload.params),
      });
      return;
    }
    if (typeof id !== 'number') return;
    const pending = this.#requests.get(id);
    if (payload.error) {
      const { code, message } = asRecord(payload.error);
      pending?.reject(new RpcError(code, message));
    } else pending?.resolve(payload.result);
  }
}
