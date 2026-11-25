import type { CommandRunner } from '@tsugimori/plugin-sdk';

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const runCommand: CommandRunner = ([command, ...args], options = {}) =>
  new Promise((resolve, reject) => {
    const {
      cwd,
      env,
      input,
      interactive,
      keepInputOpen,
      onChunk,
      onLine,
      signal,
      timeoutMs = 10_000,
    } = options;
    const child = spawn(command, args, {
      cwd,
      env,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      stdio: interactive
        ? 'inherit'
        : [
            input === undefined && !keepInputOpen ? 'ignore' : 'pipe',
            'pipe',
            'pipe',
          ],
    });
    let stdout = '';
    let stderr = '';
    let output = Promise.resolve();
    const io = {
      close: () => {
        child.stdin?.end();
      },
      write: (text: string) => {
        if (!child.stdin?.writableEnded) child.stdin?.write(text);
      },
    };
    child.stdin?.on('error', reject);
    if (input !== undefined) io.write(input);
    if (!keepInputOpen) io.close();
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (error: unknown) => {
      reject(error);
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1_000);
      killTimer.unref();
    };
    child.on('error', terminate);
    const enqueue = (run: () => void | Promise<void>) => {
      output = output.then(run);
      void output.catch(terminate);
    };
    if (child.stdout && child.stderr) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          if (stream === child.stdout) stdout = (stdout + chunk).slice(-65_536);
          else stderr = (stderr + chunk).slice(-65_536);
          if (onChunk) enqueue(() => onChunk(chunk, io));
        });
        if (onLine) {
          const lines = createInterface({ input: stream });
          lines.on('line', (line) => enqueue(() => onLine(line, io)));
        }
      }
    }
    child.once('close', (exitCode) => {
      clearTimeout(killTimer);
      void output.then(() => resolve({ exitCode, stderr, stdout }), reject);
    });
  });
