import type { WorkspaceConfig } from '@tsugimori/config';
import type { ToolCallStatus, ToolContext } from '@tsugimori/plugin-sdk';
import type { Store, ToolCallRecord } from '@tsugimori/storage';

import type { Logger } from './hooks.ts';

const redacted = '[redacted]';
const sensitive = /token|secret|password|api[_-]?key|authorization/i;
const secretEnv =
  /credential|private[_-]?key|access[_-]?key|auth|(?:^|_)pass(?:wd)?(?:_|$)/i;
const references = /env$/i;
const formatOmitted = new Intl.NumberFormat('en-US');

function envReferences(value: unknown, names: Set<string>) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (references.test(key) && typeof child === 'string') names.add(child);
    else envReferences(child, names);
  }
}

function redactText(text: string) {
  return text
    .replace(/\bbot\d+:[\w-]+/g, redacted)
    .replace(/\bBearer[ \t]+[a-z0-9._~+/=-]+/gi, 'Bearer ' + redacted)
    .replace(
      /\b(?:sk-[\w-]+|gh[pousr]_[\w-]+|github_pat_[\w-]+|xox[\w]*-[\w-]+)/gi,
      redacted,
    )
    .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, redacted)
    .replace(
      /(\b(?:[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*|authorization)["']?\s*[:=]\s*)(?:\[redacted\]|Bearer[ \t]+\[redacted\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}&]+)/gi,
      '$1' + redacted,
    )
    .replace(
      /(\bkey["']?\s*[:=]\s*)["']?[a-z0-9_+/=-]{32,}["']?/gi,
      '$1' + redacted,
    );
}

function imageToolArguments(args: unknown) {
  if (!args || typeof args !== 'object') return args;
  const clean = { ...args } as Record<string, unknown>;
  for (const key of ['url', 'path']) {
    const value = clean[key];
    if (
      typeof value !== 'string' ||
      (key === 'path' && !/^https?:\/\//i.test(value))
    )
      continue;
    const url = URL.parse(value);
    clean[key] =
      url?.protocol === 'http:' || url?.protocol === 'https:'
        ? url.origin + url.pathname
        : redacted;
  }
  return clean;
}

export function capToolDetail(text: string, limit: number) {
  if (text.length <= limit) return text;
  const marker = (omitted: number) =>
    `…[omitted ${formatOmitted.format(omitted)} chars]…`;
  const available = limit - marker(text.length).length;
  const headLength = Math.ceil((available * 2) / 3);
  const head = text.slice(0, headLength).replace(/[\uD800-\uDBFF]$/u, '');
  const tail = text
    .slice(-(available - headLength))
    .replace(/^[\uDC00-\uDFFF]/u, '');
  return head + marker(text.length - head.length - tail.length) + tail;
}

function capBytes(text: string, limit: number) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  const marker = (omitted: number) => `…[truncated ${omitted} bytes]`;
  let length = limit - Buffer.byteLength(marker(bytes.length));
  while ((bytes[length]! & 0xc0) === 0x80) length--;
  return bytes.subarray(0, length).toString() + marker(bytes.length - length);
}

function serializer({ config, env }: WorkspaceConfig) {
  const names = new Set<string>();
  envReferences(config, names);
  const values = new Set(
    [...env]
      .filter(
        ([name]) =>
          sensitive.test(name) || secretEnv.test(name) || names.has(name),
      )
      .map(([, value]) => value),
  );
  for (const name of names) {
    const value = process.env[name];
    if (value) values.add(value);
  }
  const ordered = [...values]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const pattern = ordered.length
    ? new RegExp(
        ordered
          .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|'),
        'g',
      )
    : undefined;
  const redact = (text: string) =>
    redactText(pattern ? text.replace(pattern, redacted) : text);
  const field = (value: unknown) => {
    if (value === undefined) return null;
    if (typeof value === 'string') return capBytes(redact(value), 64 * 1024);
    try {
      const objects = new WeakMap<object, object>();
      const text = JSON.stringify(
        value,
        (key, child: unknown) => {
          if (key && sensitive.test(key)) return redacted;
          if (typeof child === 'string' || typeof child === 'bigint')
            return redact(String(child));
          if (typeof child === 'number' || typeof child === 'boolean') {
            const cleaned = redact(String(child));
            return cleaned === String(child) ? child : cleaned;
          }
          if (child instanceof Error) return { message: child.message };
          if (child && typeof child === 'object' && !Array.isArray(child)) {
            const existing = objects.get(child);
            if (existing) return existing;
            const cleaned = Object.fromEntries(
              Object.entries(child).map(([name, val]) => [
                redact(name),
                sensitive.test(name) ? redacted : val,
              ]),
            );
            objects.set(child, cleaned);
            return cleaned;
          }
          return child;
        },
        2,
      );
      return text === undefined ? null : capBytes(text, 64 * 1024);
    } catch {
      return '[unserializable tool data]';
    }
  };
  return { field, redact };
}

export interface ToolDetail {
  deny(): void;
  finish(status: ToolCallStatus, result?: unknown): void;
  input(args: unknown): void;
  pending(approvalId: string): void;
  resume(): void;
  seq: number;
}

interface Dependencies {
  log: Logger;
  snapshot(): WorkspaceConfig;
  store: Store;
}

export class ToolDetails {
  readonly #deps: Dependencies;
  readonly #invocations = new WeakMap<ToolContext, ToolDetail>();

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  associate(task: ToolContext, detail: ToolDetail) {
    const invocation = { ...task };
    this.#invocations.set(invocation, detail);
    return invocation;
  }

  invocation(task: ToolContext) {
    return this.#invocations.get(task);
  }

  redactor() {
    return serializer(this.#deps.snapshot()).redact;
  }

  begin(
    taskId: string,
    name: string,
    args?: unknown,
    callId?: string,
  ): ToolDetail | undefined {
    const { log, snapshot, store } = this.#deps;
    const current = snapshot();
    const options = current.config.web?.toolDetails;
    if (options?.enabled === false) return;
    const save = <T>(operation: () => T): T | undefined => {
      try {
        return operation();
      } catch {
        log({ level: 'error', event: 'tool.details_write_failed', taskId });
      }
    };
    const format = save(() => serializer(current));
    if (!format) return;
    const input = (args: unknown) =>
      format.field(name === 'send.image' ? imageToolArguments(args) : args);
    const seq = save(() =>
      store.createToolCall({
        taskId,
        approvalId: null,
        name: capToolDetail(format.redact(name), 400),
        callId:
          callId === undefined
            ? null
            : capToolDetail(format.redact(callId), 400),
        startedAt: Date.now(),
        endedAt: null,
        status: null,
        args: input(args),
        result: null,
      }),
    );
    if (seq === undefined) return;
    const update = (
      patch: Partial<
        Pick<
          ToolCallRecord,
          'approvalId' | 'args' | 'endedAt' | 'result' | 'status'
        >
      >,
    ) => save(() => store.updateToolCall(seq, patch));
    let denied = false;
    return {
      deny: () => {
        denied = true;
      },
      resume: () => update({ status: null }),
      finish: (status, result) =>
        update({
          status: denied && status === 'error' ? 'denied' : status,
          endedAt: Date.now(),
          result: format.field(result),
        }),
      input: (args) => update({ args: input(args) }),
      pending: (approvalId) =>
        update({ approvalId, status: 'pending-approval' }),
      seq,
    };
  }
}
