import type { Store, TraceSpan } from '@tsugimori/storage';

const batchSize = 100;

interface TraceOptions {
  flushDelayMs?: number;
  onError?(error: unknown): void;
  ringSize?: number;
}

export class Tracer {
  readonly #store: Pick<Store, 'writeTraceSpans'>;
  readonly #options: TraceOptions;
  readonly #ring: TraceSpan[] = [];
  #ringPosition = 0;
  #pending: TraceSpan[] = [];
  #timer?: NodeJS.Timeout;
  #flushing?: Promise<void>;

  constructor(
    store: Pick<Store, 'writeTraceSpans'>,
    options: TraceOptions = {},
  ) {
    this.#store = store;
    this.#options = options;
  }

  get recent(): readonly TraceSpan[] {
    return [
      ...this.#ring.slice(this.#ringPosition),
      ...this.#ring.slice(0, this.#ringPosition),
    ];
  }

  begin(name: string, attrs: TraceSpan['attrs'] = {}) {
    const start = performance.now();
    const startedAt = Date.now();
    let finished = false;
    return (status: TraceSpan['status'] = 'ok') => {
      if (finished) return;
      finished = true;
      this.#record({
        name,
        attrs,
        startedAt,
        status,
        endedAt: Date.now(),
        durationMs: performance.now() - start,
      });
    };
  }

  span<T>(name: string, attrs: TraceSpan['attrs'], fn: () => T): T {
    const end = this.begin(name, attrs);
    try {
      const value = fn();
      if (value instanceof Promise) {
        return value.then(
          (result: unknown) => {
            end();
            return result;
          },
          (error: unknown) => {
            end('error');
            throw error;
          },
        ) as T;
      }
      end();
      return value;
    } catch (error) {
      end('error');
      throw error;
    }
  }

  #record(span: TraceSpan) {
    const size = this.#options.ringSize ?? 0;
    if (size > 0) {
      this.#ring[this.#ringPosition] = span;
      this.#ringPosition = (this.#ringPosition + 1) % size;
    }
    this.#pending.push(span);
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        void this.flush().catch((error: unknown) => {
          if (this.#options.onError) this.#options.onError(error);
          else
            console.error(
              JSON.stringify({ level: 'error', event: 'trace.flush_failed' }),
            );
        });
      }, this.#options.flushDelayMs ?? 20);
      this.#timer.unref();
    }
  }

  async flush() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#flushing) await this.#flushing;
    if (!this.#pending.length) return;
    this.#flushing = this.#writePending();
    try {
      await this.#flushing;
    } finally {
      this.#flushing = undefined;
    }
  }

  async #writePending() {
    while (this.#pending.length) {
      const batch = this.#pending.splice(0, batchSize);
      try {
        await this.#store.writeTraceSpans(batch);
      } catch (error) {
        this.#pending = [...batch, ...this.#pending];
        throw error;
      }
    }
  }
}
