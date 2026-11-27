import type {
  SessionHistory,
  SessionMetric,
  Store,
  TraceSpan,
} from '@tsugimori/storage';

const batchSize = 100;

type TraceStore = Pick<Store, 'writeTraceSpans'> &
  Partial<Pick<Store, 'latestSessionSpan' | 'sessionHistory'>>;

interface TraceOptions {
  flushDelayMs?: number;
  onError?(error: unknown): void;
  ringSize?: number;
}

export class Tracer {
  readonly #store: TraceStore;
  readonly #options: TraceOptions;
  readonly #ring: TraceSpan[] = [];
  #ringPosition = 0;
  #pending: TraceSpan[] = [];
  #writing?: TraceSpan[];
  #timer?: NodeJS.Timeout;
  #flushing?: Promise<void>;

  constructor(store: TraceStore, options: TraceOptions = {}) {
    this.#store = store;
    this.#options = options;
  }

  get recent(): readonly TraceSpan[] {
    return [
      ...this.#ring.slice(this.#ringPosition),
      ...this.#ring.slice(0, this.#ringPosition),
    ];
  }

  latestSessionSpan(scope: string, metric: SessionMetric) {
    const matches = ({ attrs, name, status }: TraceSpan) => {
      if (attrs.sessionScope !== scope) return false;
      switch (metric) {
        case 'compaction':
          return name === 'agent.compaction' && status === 'ok';
        case 'context':
          return (
            name !== 'agent.run' && typeof attrs.contextTokens === 'number'
          );
        case 'contextWindow':
          return typeof attrs.contextWindow === 'number';
        case 'run':
          return name === 'agent.run';
        case 'usage':
          return name === 'agent.usage';
      }
    };
    return (
      this.#pending.findLast(matches) ??
      this.#writing?.findLast(matches) ??
      this.#store.latestSessionSpan?.(scope, metric)
    );
  }

  sessionHistory(scope: string): SessionHistory {
    const history = this.#store.sessionHistory?.(scope);
    let compactions = history?.compactions ?? 0;
    let createdAt = history?.createdAt ?? Infinity;
    let firstActivityAt = history?.firstActivityAt ?? Infinity;
    for (const spans of [this.#writing ?? [], this.#pending]) {
      for (const { attrs, name, startedAt, status } of spans) {
        if (attrs.sessionScope !== scope) continue;
        firstActivityAt = Math.min(firstActivityAt, startedAt);
        if (name === 'agent.session.created')
          createdAt = Math.min(createdAt, startedAt);
        if (name === 'agent.compaction' && status === 'ok') compactions++;
      }
    }
    return {
      compactions,
      createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
      firstActivityAt: Number.isFinite(firstActivityAt)
        ? firstActivityAt
        : undefined,
      tasks: history?.tasks ?? 0,
    };
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

  record(
    name: string,
    attrs: TraceSpan['attrs'],
    durationMs = 0,
    status: TraceSpan['status'] = 'ok',
  ) {
    const endedAt = Date.now();
    this.#record({
      name,
      attrs,
      startedAt: endedAt - Math.round(durationMs),
      endedAt,
      durationMs,
      status,
    });
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
      this.#writing = batch;
      try {
        const write = this.#store.writeTraceSpans(batch);
        if (!write) this.#writing = undefined;
        await write;
      } catch (error) {
        this.#pending = [...batch, ...this.#pending];
        throw error;
      } finally {
        this.#writing = undefined;
      }
    }
  }
}
