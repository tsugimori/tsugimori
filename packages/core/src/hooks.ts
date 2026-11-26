import type { HookEvents, HookName } from '@tsugimori/plugin-sdk';
import type { Tracer } from '@tsugimori/trace';

import type { PluginRegistry } from './registry.ts';

import { untilAborted } from './abort.ts';

export type Logger = (entry: {
  adapterId?: string;
  attempt?: number;
  chatId?: string;
  check?: string;
  code?: number;
  error?: string;
  event: string;
  level: 'error' | 'info' | 'warn';
  migratedToChatId?: string;
  nextDelayMs?: number | null;
  reason?: string;
  retryAfterMs?: number;
  scheduleId?: string;
  scope?: string;
  target?: string;
  taskId?: string;
}) => void;

export const logToStderr: Logger = (entry) =>
  console.error(JSON.stringify(entry));

export class HookRunner {
  readonly #registry: PluginRegistry;
  readonly #trace: Tracer;
  readonly #log: Logger;
  readonly #background = new Set<Promise<void>>();
  readonly #shutdown = new AbortController();

  constructor({
    registry,
    trace,
    log,
  }: {
    log: Logger;
    registry: PluginRegistry;
    trace: Tracer;
  }) {
    this.#registry = registry;
    this.#trace = trace;
    this.#log = log;
  }

  async emit<N extends HookName>(name: N, event: HookEvents[N]) {
    for (const plugin of this.#registry.plugins) {
      const hook = plugin.hooks?.[name];
      if (!hook) continue;
      const run = () =>
        this.#trace
          .span('hook.run', { hook: name, plugin: plugin.name }, async () => {
            if (hook.mode === 'async') {
              const { signal } = this.#shutdown;
              await untilAborted(signal, async () => hook.run(event, signal));
              return;
            }
            const timeout = new AbortController();
            const expired = new Error('Hook timed out');
            const deadline = performance.now() + hook.timeoutMs;
            const timer = setTimeout(
              () => timeout.abort(expired),
              hook.timeoutMs,
            );
            try {
              await untilAborted(timeout.signal, async () =>
                hook.run(event, timeout.signal),
              );
              if (performance.now() > deadline) throw expired;
            } finally {
              clearTimeout(timer);
              timeout.abort();
            }
          })
          .catch(() => {
            if (!this.#shutdown.signal.aborted)
              this.#log({ level: 'error', event: 'hook.failed' });
          });

      if (hook.mode === 'sync') {
        await run();
      } else {
        const pending = new Promise<void>((resolve, reject) => {
          setImmediate(() => {
            void run().then(resolve, reject);
          });
        });
        this.#background.add(pending);
        void pending.finally(() => this.#background.delete(pending));
      }
    }
  }

  async stop() {
    this.#shutdown.abort();
    await Promise.all(this.#background);
  }
}
