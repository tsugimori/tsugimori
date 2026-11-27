import type { AssembledEntry } from '@tsugimori/context';
import type {
  ContextBlock,
  TaskAgent,
  TaskEvent,
  TaskExecution,
  TaskOutcome,
  TaskRefs,
  TaskSupplement,
  TaskTiming,
} from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';

import type { Logger } from './hooks.ts';

import { describeError, describeTaskError } from './errors.ts';
import { ruleReferences } from './record-context.ts';
import { buildInfo } from './version.ts';

type EventEntry<T = TaskEvent> = T extends TaskEvent
  ? Omit<T, 'seq' | 'at'>
  : never;
type TextKind = 'text' | 'reasoning';
type Stage = 'contextMs' | 'agentMs' | 'toolsMs' | 'deliveryMs';
type OutcomeError = NonNullable<TaskOutcome['error']>;
type Delivery = NonNullable<TaskOutcome['delivery']>;

interface Dependencies {
  log: Logger;
  redact(text: string): string;
  store: Store;
  taskId: string;
  workspace: string;
}

const chunkBytes = 4096;
const batchDelay = 100;

function chunks(text: string) {
  const bytes = Buffer.from(text);
  const parts: string[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + chunkBytes, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString());
    start = end;
  }
  return parts;
}

export function silentReason(
  output: string,
  redact = (text: string) => text,
): string | undefined {
  const text = output.trim();
  if (/[\r\n\u2028\u2029]/u.test(text)) return;
  const match = /^NO_REPLY(?::\s*(.*))?$/su.exec(text);
  if (match)
    return Array.from(redact(match[1]?.trim() ?? ''))
      .slice(0, 500)
      .join('');
}

export class TaskRecorder {
  readonly #deps: Dependencies;
  readonly #start = performance.now();
  readonly #timing: TaskTiming;
  readonly #input: ContextBlock[] = [];
  readonly #supplements: TaskSupplement[] = [];
  readonly #refs: TaskRefs = {
    tsugimori: { commit: buildInfo.commit, dirty: buildInfo.dirty },
    history: {},
    session: { mode: 'new' },
    order: [],
  };
  #seq = 0;
  #run?: {
    at: number;
    bytes: number;
    checkpoint: string[];
    checkpointBytes: number;
    firstSeq: number;
    kind: TextKind;
    text: string;
  };
  #replaceAfterSeq?: number;
  #events: TaskEvent[] = [];
  #timer?: NodeJS.Timeout;
  #closed = false;
  #agent: TaskAgent | null = null;
  #output: string | null = null;
  #delivery?: Delivery;
  #agentStarted?: number;
  #ephemeralSessionId?: string;

  constructor(deps: Dependencies, queuedMs: number) {
    this.#deps = deps;
    this.#timing = {
      queuedMs,
      contextMs: 0,
      agentMs: 0,
      toolsMs: 0,
      deliveryMs: 0,
      totalMs: 0,
    };
  }

  #save(action: () => void) {
    try {
      action();
    } catch (error) {
      this.#warn(error);
    }
  }

  #warn(error: unknown) {
    const { log, redact, taskId } = this.#deps;
    log({
      level: 'warn',
      event: 'task.record_failed',
      taskId,
      error: describeError(error, redact),
    });
  }

  get references() {
    const { summary, workspace } = this.#refs;
    return { summary, workspace };
  }

  async context(
    entries: readonly AssembledEntry[],
    privateConversation = false,
  ) {
    const { store, workspace } = this.#deps;
    const history: number[] = [];
    let index = 0;
    for (const entry of entries) {
      switch (entry.kind) {
        case 'system':
          this.#refs.order.push({ kind: 'system', name: entry.name });
          break;
        case 'rule':
          this.#refs.order.push({ kind: 'rule', index: index++ });
          break;
        case 'summary':
          if (entry.revision !== undefined)
            this.#refs.summary = {
              revision: entry.revision,
              chatId: entry.chatId,
            };
          this.#refs.order.push({ kind: 'summary' });
          break;
        case 'history':
          if (entry.seq !== undefined) {
            const { seq, revision, block } = entry;
            history.push(seq);
            this.#refs.order.push({
              kind: 'history',
              seq,
              trust: block.trust,
              revision,
              // Album membership and cached descriptions can change independently
              // of this message's revision.
              ...(block.message &&
                (privateConversation ||
                  block.message.albumId ||
                  block.message.replyTo?.albumId ||
                  block.message.attachments.some(
                    ({ description }) => description,
                  ) ||
                  block.message.replyTo?.attachments.some(
                    ({ description }) => description,
                  )) && {
                  message: block.message,
                }),
            });
          }
          break;
        case 'new':
          this.newBlock(entry.block);
          break;
      }
    }
    if (history.length)
      this.#refs.history = {
        fromSeq: history[0],
        throughSeq: history.at(-1),
        seqs: history,
      };
    try {
      this.#refs.workspace = await ruleReferences(workspace, entries, store);
    } catch (error) {
      this.#warn(error);
    }
  }

  newBlock(block: ContextBlock) {
    this.#refs.order.push({
      kind: 'new',
      index: this.#input.push({ ...block }) - 1,
    });
  }

  session(session: TaskRefs['session']) {
    this.#refs.session = session;
  }

  sessionId(id: string) {
    const previous = this.#refs.session;
    if (previous.mode === 'ephemeral' || previous.mode === 'fork') {
      this.#ephemeralSessionId = id;
      return;
    }
    this.#refs.session =
      previous.mode === 'resumed' && previous.sessionId !== id
        ? {
            mode: 'new',
            previousSessionId: previous.sessionId,
            sessionId: id,
            reason: 'backend-started-new-session',
          }
        : { ...previous, sessionId: id };
  }

  agent(agent: TaskAgent) {
    this.#agent = agent;
  }

  model(model: string, reasoning?: string) {
    if (!this.#agent || this.#closed) return;
    this.#agent = {
      ...this.#agent,
      model,
      reasoning: reasoning ?? this.#agent.reasoning,
    };
    this.#save(() => this.#deps.store.updateTask(this.#deps.taskId, { model }));
  }

  timing(stage: Stage) {
    const start = performance.now();
    if (stage === 'agentMs') this.#agentStarted ??= start;
    return () => {
      this.#timing[stage] += performance.now() - start;
    };
  }

  output(text: string) {
    this.#output = this.#deps.redact(text);
  }

  text(kind: TextKind, text: string) {
    if (!text || this.#closed) return;
    if (this.#agentStarted !== undefined)
      this.#timing.firstTokenMs ??= performance.now() - this.#agentStarted;
    if (this.#run?.kind !== kind) {
      this.#seal();
      this.#run = {
        kind,
        text: '',
        at: Date.now(),
        firstSeq: this.#seq + 1,
        bytes: 0,
        checkpointBytes: 0,
        checkpoint: [],
      };
    }
    this.#run.text += text;
    this.#run.bytes += Buffer.byteLength(text);
    if (this.#run.bytes - this.#run.checkpointBytes >= chunkBytes)
      this.#flush();
    else this.#schedule();
  }

  #checkpoint() {
    const run = this.#run;
    if (!run || run.bytes === run.checkpointBytes) return;
    // Redact the full run before chunking so a credential can span deltas or a checkpoint.
    const parts = chunks(this.#deps.redact(run.text));
    if (parts.length < run.checkpoint.length)
      this.#replaceAfterSeq = run.firstSeq + parts.length - 1;
    for (const [index, text] of parts.entries())
      if (index >= run.checkpoint.length || text !== run.checkpoint[index])
        this.#events.push({
          kind: run.kind,
          seq: run.firstSeq + index,
          at: run.at,
          data: { text },
        });
    run.checkpoint = parts;
    run.checkpointBytes = run.bytes;
  }

  #seal() {
    if (!this.#run) return;
    this.#checkpoint();
    this.#seq += this.#run.checkpoint.length;
    this.#run = undefined;
  }

  event(entry: EventEntry) {
    if (this.#closed) {
      // Some connectors report background compaction after the reply is complete.
      if (entry.kind === 'compaction') {
        const { store, taskId } = this.#deps;
        this.#save(() =>
          store.appendTaskEvents(taskId, [
            { ...entry, seq: ++this.#seq, at: Date.now() },
          ]),
        );
      }
      return;
    }
    this.#seal();
    const event = { ...entry, seq: ++this.#seq, at: Date.now() };
    this.#events.push(event);
    if (this.#events.length >= 16) this.#flush();
    else this.#schedule();
    return event;
  }

  toolStarted(toolSeq?: number) {
    if (this.#closed) return;
    if (toolSeq !== undefined) this.event({ kind: 'tool', data: { toolSeq } });
    else {
      this.#seal();
      this.#schedule();
    }
  }

  supplement(messageId: string, block: ContextBlock) {
    this.newBlock(block);
    const event = this.event({ kind: 'supplement', data: { messageId } });
    if (event)
      this.#supplements.push({
        messageId,
        at: event.at,
        afterEventSeq: event.seq - 1,
      });
  }

  #schedule() {
    this.#timer ??= setTimeout(() => this.#flush(), batchDelay).unref();
  }

  #flush() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#checkpoint();
    const events = this.#events.splice(0);
    const replaceAfterSeq = this.#replaceAfterSeq;
    this.#replaceAfterSeq = undefined;
    if (events.length || replaceAfterSeq !== undefined)
      this.#save(() =>
        this.#deps.store.appendTaskEvents(
          this.#deps.taskId,
          events,
          replaceAfterSeq,
        ),
      );
  }

  errorMessage(error: unknown) {
    const { sessionId, previousSessionId } = this.#refs.session;
    return describeTaskError(error, (text) => {
      for (const id of [sessionId, previousSessionId, this.#ephemeralSessionId])
        if (id) text = text.replaceAll(id, '[redacted session]');
      return this.#deps.redact(text);
    });
  }

  error(error: unknown, stage: OutcomeError['stage']): OutcomeError {
    const code =
      error instanceof Error
        ? 'code' in error && typeof error.code === 'string'
          ? error.code
          : error.name
        : 'Error';
    const data = {
      code: this.#deps.redact(code).slice(0, 100),
      message: this.errorMessage(error),
      stage,
    };
    this.event({ kind: 'error', data });
    return data;
  }

  delivery(adapterId: string, messageIds: readonly string[], error?: unknown) {
    const delivery = (this.#delivery ??= { adapterId, parts: [] });
    delivery.parts.push(
      ...messageIds.map((messageId) => ({ messageId, ok: true })),
    );
    if (error !== undefined)
      delivery.parts.push({
        ok: false,
        error: describeError(error, this.#deps.redact),
      });
  }

  finish(outcome: TaskOutcome) {
    this.#seal();
    this.#flush();
    this.#closed = true;
    this.#timing.totalMs =
      this.#timing.queuedMs + performance.now() - this.#start;
    const record: TaskExecution = {
      agent: this.#agent,
      refs: this.#refs,
      input: this.#input,
      output: this.#output,
      outcome: { ...outcome, delivery: this.#delivery },
      timing: this.#timing,
      supplements: this.#supplements,
    };
    this.#save(() =>
      this.#deps.store.saveTaskExecution(this.#deps.taskId, record),
    );
  }
}
