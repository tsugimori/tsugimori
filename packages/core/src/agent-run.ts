import type {
  AgentCompactionEvent,
  AgentConnector,
  AgentIO,
  AgentRequest,
  AgentTool,
  ChatRef,
  ToolContext,
  ToolDefinition,
} from '@tsugimori/plugin-sdk';
import type { ApprovalContinuation } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { Ajv } from 'ajv';
import { createHash } from 'node:crypto';

import type { HookRunner, Logger } from './hooks.ts';

import { untilAborted } from './abort.ts';

interface AgentRunDependencies {
  approvalPending?: AbortSignal;
  log: Logger;
  onSession?(sessionId: string): void;
  scopeChatId?: string | null;
  scopeModel?: string;
  task: ToolContext;
  trace: Tracer;
}

export function sessionScope(
  { adapterId, chatId }: ChatRef,
  agentId: string,
  model: string,
  sessionId: string,
) {
  return createHash('sha256')
    .update(JSON.stringify([adapterId, chatId, agentId, model, sessionId]))
    .digest('hex');
}

export async function runAgent(
  {
    approvalPending,
    trace,
    log,
    onSession,
    task,
    scopeChatId,
    scopeModel,
  }: AgentRunDependencies,
  agent: AgentConnector,
  request: AgentRequest,
  io: AgentIO,
) {
  const { signal, taskId } = task;
  const attrs = { taskId, agentId: agent.id, model: request.model };
  const scope = (id: string) =>
    request.purpose
      ? null
      : sessionScope(
          scopeChatId && id === request.resumeSessionId
            ? { ...task.chat, chatId: scopeChatId }
            : task.chat,
          agent.id,
          id === request.resumeSessionId
            ? (scopeModel ?? request.model)
            : request.model,
          id,
        );
  let activeScope = request.resumeSessionId
    ? scope(request.resumeSessionId)
    : null;
  const reportCompaction = (event: AgentCompactionEvent) => {
    trace.record(
      'agent.compaction',
      {
        ...attrs,
        sessionScope: event.status === 'error' ? null : activeScope,
        trigger: event.trigger,
        contextTokens: event.tokensAfter ?? null,
        tokensBefore: event.tokensBefore ?? null,
        tokensAfter: event.tokensAfter ?? null,
      },
      event.durationMs,
      event.status,
    );
    io.reportCompaction?.(event);
  };
  return trace.span('agent.run', attrs, async () => {
    signal.throwIfAborted();
    const events = agent.run(request, { ...io, reportCompaction });
    const iterator = events[Symbol.asyncIterator]();
    const firstText = trace.begin('agent.first_text', attrs);
    const tools = new Map<string, ReturnType<Tracer['begin']>>();
    let complete = false;
    let deltas = '';
    let final: string | undefined;
    let sessionId: string | undefined;
    try {
      for (;;) {
        const next = await untilAborted(request.signal, () => iterator.next());
        signal.throwIfAborted();
        if (next.done) {
          complete = true;
          return { text: final ?? deltas, sessionId };
        }
        if (approvalPending?.aborted) continue;
        const event = next.value;
        switch (event.type) {
          case 'text.delta':
            if (event.text) firstText();
            deltas += event.text;
            break;
          case 'text.final':
            if (event.text) firstText();
            final = event.text;
            break;
          case 'sessionId': {
            sessionId = event.sessionId;
            const nextScope = scope(sessionId);
            if (nextScope && nextScope !== activeScope)
              trace.record('agent.session.created', {
                ...attrs,
                sessionScope: nextScope,
              });
            activeScope = nextScope;
            onSession?.(sessionId);
            break;
          }
          case 'tool.started':
            tools.get(event.callId)?.('error');
            tools.set(
              event.callId,
              trace.begin('agent.tool', { ...attrs, name: event.name }),
            );
            break;
          case 'tool.finished':
            tools.get(event.callId)?.(event.status);
            tools.delete(event.callId);
            break;
          case 'approval.requested':
            trace.begin('agent.approval_requested', attrs)();
            break;
          case 'usage': {
            const tokens =
              event.contextTokens === undefined &&
              (event.inputTokens !== undefined ||
                event.outputTokens !== undefined)
                ? (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
                : event.contextTokens;
            const contextTokens =
              typeof tokens === 'number' &&
              Number.isSafeInteger(tokens) &&
              tokens >= 0
                ? tokens
                : null;
            const contextWindow = event.contextWindow;
            trace.record('agent.usage', {
              ...attrs,
              sessionScope:
                contextTokens === null && contextWindow === undefined
                  ? null
                  : activeScope,
              contextTokens,
              ...(contextWindow === undefined ? {} : { contextWindow }),
              inputTokens: event.inputTokens ?? null,
              outputTokens: event.outputTokens ?? null,
            });
            break;
          }
          case 'compaction':
            reportCompaction(event);
            break;
          case 'error':
            throw event.error;
        }
      }
    } catch (error) {
      if (signal.aborted || !approvalPending?.aborted) throw error;
    } finally {
      for (const end of tools.values()) end('error');
      if (!complete) {
        void Promise.resolve()
          .then(() => iterator.return?.())
          .catch(() => {
            log({
              level: 'error',
              event: 'agent.iterator_close_failed',
              taskId,
            });
          });
      }
    }
    return { text: final ?? deltas };
  });
}

const validator = new Ajv();

export function protectTools(
  {
    trace,
    hooks,
    onResult,
    task,
    requestApproval,
  }: {
    hooks: HookRunner;
    onResult?(result: unknown): void;
    requestApproval(
      request: Parameters<AgentIO['requestApproval']>[0],
      tool: Extract<ApprovalContinuation, { kind: 'tool' }>,
    ): Promise<boolean | { pending: true; summary: string }>;
    task: ToolContext;
    trace: Tracer;
  },
  tools: readonly ToolDefinition[],
): readonly AgentTool[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    if (names.has(tool.name)) throw new Error('Duplicate tool name');
    names.add(tool.name);
    const validate = validator.compile(tool.schema);
    return {
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      async run(args) {
        const { signal, taskId } = task;
        signal.throwIfAborted();
        if (!validate(args)) throw new Error('Invalid tool arguments');
        const name = tool.name;
        await hooks.emit('tool.before', { task, name });
        let status: 'ok' | 'error' = 'error';
        let result: unknown;
        try {
          result = await trace.span('tool.run', { taskId, name }, async () => {
            const permission = tool.permission;
            if (permission) {
              const approval = await requestApproval(
                {
                  action: permission.action,
                  description: permission.describe?.(args, task),
                  resource: permission.resource(args, task),
                },
                { kind: 'tool', name, args },
              );
              if (typeof approval === 'object') return approval;
              if (!approval) throw new Error('Tool permission denied');
            }
            signal.throwIfAborted();
            return tool.run(args, task);
          });
          status = 'ok';
        } finally {
          await hooks.emit('tool.after', { task, name, status });
        }
        onResult?.(result);
        return result;
      },
    };
  });
}
