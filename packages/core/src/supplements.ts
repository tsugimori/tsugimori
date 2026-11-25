import type { InboundMessage, OutboundMessage } from '@tsugimori/plugin-sdk';

export interface TaskInput {
  message: InboundMessage;
  scheduled?: {
    allowTextMentions: boolean;
    delayNote: string;
    model?: string;
    target: Omit<OutboundMessage, 'text'>;
  };
  seq: number;
}

export class Supplements {
  readonly #queue: TaskInput[] = [];
  readonly delivered = new Set<number>();
  #available = Promise.withResolvers<void>();

  push(input: TaskInput) {
    this.#queue.push(input);
    this.#wake();
  }

  takePending() {
    const batch = this.#queue.splice(0);
    for (const input of batch) this.delivered.add(input.seq);
    return batch;
  }

  async *stream(signal: AbortSignal): AsyncIterable<InboundMessage> {
    const wake = () => this.#wake();
    signal.addEventListener('abort', wake);
    try {
      while (!signal.aborted) {
        const input = this.#queue.shift();
        if (input) {
          this.delivered.add(input.seq);
          yield input.message;
        } else {
          await this.#available.promise;
        }
      }
    } finally {
      signal.removeEventListener('abort', wake);
    }
  }

  #wake() {
    this.#available.resolve();
    this.#available = Promise.withResolvers<void>();
  }
}
