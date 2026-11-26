import type {
  AgentCompactionEvent,
  AgentConnector,
  AgentIO,
  AgentRequest,
  AgentTool,
  ChatRef,
  ToolCallStatus,
  ToolContext,
  ToolDefinition,
} from '@tsugimori/plugin-sdk';
import type { ApprovalContinuation } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { Ajv } from 'ajv';
import { createHash } from 'node:crypto';

import type { HookRunner, Logger } from './hooks.ts';
import type { ToolDetail, ToolDetails } from './tool-details.ts';

import { untilAborted } from './abort.ts';

interface AgentRunDependencies {
  approvalPending?: AbortSignal;
  log: Logger;
  onSession?(sessionId: string): void;
  scopeChatId?: string | null;
  scopeModel?: string;
  task: ToolContext;
  toolDetails?: ToolDetails;
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
    toolDetails,
  }: AgentRunDependencies,
  agent: AgentConnector,
  request: AgentRequest,
  io: AgentIO,
) {
  const { signal, taskId } = task;
  const attrs = {
    taskId,
    agentId: agent.id,
    model: request.model,
    ...(request.purpose && { purpose: request.purpose }),
  };
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
    const tools = new Map<
      string,
      {
        detail?: ToolDetail;
        end: ReturnType<Tracer['begin']>;
      }
    >();
    const denying = new Set<string>();
    const approvals = new Map<string, { id: string; waiting: boolean }>();
    const events = agent.run(request, {
      ...io,
      reportCompaction,
      reportToolDenial: (callId) => denying.add(callId),
      requestApproval: async (approval, callId) => {
        if (callId === undefined) return io.requestApproval(approval);
        const allowed = await io.requestApproval(approval, callId, (id) => {
          approvals.set(callId, { id, waiting: true });
          tools.get(callId)?.detail?.pending(id);
        });
        const tracked = approvals.get(callId);
        if (tracked && !approvalPending?.aborted) {
          tracked.waiting = false;
          if (allowed) tools.get(callId)?.detail?.resume();
        }
        return allowed;
      },
    });
    const iterator = events[Symbol.asyncIterator]();
    const firstText = trace.begin('agent.first_text', attrs);
    const startTool = (callId: string, name: string, args: unknown) => {
      const detail = toolDetails?.begin(taskId, name, args, callId);
      const approval = approvals.get(callId);
      if (approval) {
        detail?.pending(approval.id);
        if (!approval.waiting) detail?.resume();
      }
      const tool = {
        detail,
        end: trace.begin('agent.tool', {
          ...attrs,
          name,
          ...(detail && { toolCallSeq: detail.seq }),
        }),
      };
      tools.set(callId, tool);
      return tool;
    };
    const finishTool = (
      callId: string,
      status: ToolCallStatus,
      result?: unknown,
    ) => {
      const tool = tools.get(callId);
      tool?.detail?.finish(status, result);
      tool?.end(
        status === 'ok' || status === 'pending-approval' ? 'ok' : 'error',
      );
      tools.delete(callId);
      approvals.delete(callId);
      denying.delete(callId);
    };
    let complete = false;
    let failure: unknown;
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
            if (tools.has(event.callId)) finishTool(event.callId, 'error');
            startTool(event.callId, event.name, event.args);
            break;
          case 'tool.input':
            tools.get(event.callId)?.detail?.input(event.args);
            break;
          case 'tool.finished': {
            const existing = tools.get(event.callId);
            if (!existing) startTool(event.callId, event.name, event.args);
            else if (event.args !== undefined)
              existing.detail?.input(event.args);
            finishTool(
              event.callId,
              denying.has(event.callId) ? 'denied' : event.status,
              event.result,
            );
            break;
          }
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
      failure = error;
      if (signal.aborted || !approvalPending?.aborted) throw error;
    } finally {
      for (const [id] of tools) {
        const status =
          approvalPending?.aborted && approvals.get(id)?.waiting
            ? 'pending-approval'
            : denying.has(id)
              ? 'denied'
              : 'error';
        finishTool(id, status, status === 'error' ? failure : undefined);
      }
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
    toolDetails,
    task,
    requestApproval,
  }: {
    hooks: HookRunner;
    onResult?(result: unknown): void;
    requestApproval(
      request: Parameters<AgentIO['requestApproval']>[0],
      tool: Extract<ApprovalContinuation, { kind: 'tool' }>,
      onPending?: (approvalId: string) => void,
    ): Promise<boolean | { pending: true; summary: string }>;
    task: ToolContext;
    toolDetails?: ToolDetails;
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
      async run(args, _context, callId) {
        const { signal, taskId } = task;
        const { name } = tool;
        const detail = toolDetails?.begin(taskId, name, args, callId);
        const end = trace.begin('tool.run', {
          taskId,
          name,
          ...(detail && { toolCallSeq: detail.seq }),
        });
        let status: ToolCallStatus = 'error';
        let result: unknown;
        let before = false;
        try {
          signal.throwIfAborted();
          if (!validate(args)) throw new Error('Invalid tool arguments');
          await hooks.emit('tool.before', { task, name });
          before = true;
          const permission = tool.permission;
          if (permission) {
            const approval = await requestApproval(
              {
                action: permission.action,
                description: permission.describe?.(args, task),
                resource: permission.resource(args, task),
              },
              { kind: 'tool', name, args },
              detail?.pending,
            );
            if (!approval) {
              status = 'denied';
              throw new Error('Tool permission denied');
            }
            if (typeof approval === 'object') result = approval;
            else detail?.resume();
          }
          if (result === undefined) {
            signal.throwIfAborted();
            const invocation =
              detail && toolDetails
                ? toolDetails.associate(task, detail)
                : task;
            result = await tool.run(args, invocation);
          }
          status =
            result &&
            typeof result === 'object' &&
            'pending' in result &&
            result.pending === true
              ? 'pending-approval'
              : 'ok';
        } catch (error) {
          result = error;
          throw error;
        } finally {
          detail?.finish(status, result);
          const traceStatus =
            status === 'ok' || status === 'pending-approval' ? 'ok' : 'error';
          end(traceStatus);
          if (before)
            await hooks.emit('tool.after', { task, name, status: traceStatus });
        }
        onResult?.(result);
        return result;
      },
    };
  });
}
