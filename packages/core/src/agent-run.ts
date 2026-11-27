import type {
  AgentCompactionEvent,
  AgentConnector,
  AgentEvent,
  AgentIO,
  AgentRequest,
  AgentTool,
  ChatRef,
  ToolCallStatus,
  ToolContext,
  ToolDefinition,
} from '@tsugimori/plugin-sdk';
import type { ApprovalContinuation, TraceSpan } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { Ajv } from 'ajv';
import { createHash } from 'node:crypto';

import type { HookRunner, Logger } from './hooks.ts';
import type { TaskRecorder } from './task-recorder.ts';
import type { ToolDetail, ToolDetails } from './tool-details.ts';

import { untilAborted } from './abort.ts';
import { describeStickerError, describeTaskError } from './errors.ts';

interface AgentRunDependencies {
  approvalPending?: AbortSignal;
  log: Logger;
  onSession?(sessionId: string): void;
  privateConversation?: boolean;
  recorder?: TaskRecorder;
  scopeChatId?: string | null;
  scopeModel?: string;
  task: ToolContext;
  toolDetails?: ToolDetails;
  trace: Tracer;
  waitForClose?(): boolean;
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

function isPendingApproval(result: unknown) {
  return (
    result &&
    typeof result === 'object' &&
    'pending' in result &&
    result.pending === true
  );
}

export async function runAgent(
  {
    approvalPending,
    privateConversation,
    trace,
    log,
    onSession,
    recorder,
    task,
    scopeChatId,
    scopeModel,
    toolDetails,
    waitForClose,
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
    sessionScope(
      scopeChatId && id === request.resumeSessionId
        ? { ...task.chat, chatId: scopeChatId }
        : task.chat,
      agent.id,
      id === request.resumeSessionId
        ? (scopeModel ?? request.model)
        : request.model,
      id,
    );
  const ephemeral = request.ephemeral || request.forkSessionId !== undefined;
  let activeScope =
    !ephemeral && request.resumeSessionId
      ? scope(request.resumeSessionId)
      : null;
  const reportCompaction = (event: AgentCompactionEvent) => {
    trace.record(
      'agent.compaction',
      {
        ...attrs,
        sessionScope:
          request.purpose || event.status === 'error' ? null : activeScope,
        trigger: event.trigger,
        contextTokens: event.tokensAfter ?? null,
        tokensBefore: event.tokensBefore ?? null,
        tokensAfter: event.tokensAfter ?? null,
      },
      event.durationMs,
      event.status,
    );
    const { trigger, tokensBefore, tokensAfter, status } = event;
    recorder?.event({
      kind: 'compaction',
      data: { trigger, tokensBefore, tokensAfter, status },
    });
    io.reportCompaction?.(event);
  };
  const runAttrs: TraceSpan['attrs'] = {
    ...attrs,
    sessionMode: request.forkSessionId
      ? 'fork'
      : ephemeral
        ? 'ephemeral'
        : request.resumeSessionId
          ? 'resume'
          : 'new',
    ...(privateConversation && { private: true }),
    contextBlocks: request.context.length,
    contextChars: request.context.reduce(
      (chars, { content }) => chars + content.length,
      0,
    ),
    toolDefinitions: request.tools.length,
    toolDefinitionChars: request.tools.reduce(
      (chars, { description, schema }) =>
        chars + description.length + JSON.stringify(schema).length,
      0,
    ),
  };
  return trace.span('agent.run', runAttrs, async () => {
    const tools = new Map<
      string,
      {
        detail?: ToolDetail;
        end: ReturnType<Tracer['begin']>;
        timed?: () => void;
      }
    >();
    const denying = new Set<string>();
    const approvals = new Map<string, { id: string; waiting: boolean }>();
    let toolCalls = 0;
    let toolErrors = 0;
    let usage: Record<
      'contextTokens' | 'inputTokens' | 'outputTokens',
      number | null
    > = { contextTokens: null, inputTokens: null, outputTokens: null };
    let resolvedModel: string | undefined;
    let complete = false;
    let failure: unknown;
    let deltas = '';
    let final: string | undefined;
    let sessionId: string | undefined;
    let iterator: AsyncIterator<AgentEvent> | undefined;
    let outcome: 'ok' | 'error' | 'aborted' | 'pending-approval' = 'ok';
    const firstTextAttrs: TraceSpan['attrs'] = { ...attrs };
    const startTool = (callId: string, name: string, args: unknown) => {
      toolCalls++;
      const detail = toolDetails?.begin(taskId, name, args, callId);
      const approval = approvals.get(callId);
      if (approval) {
        detail?.pending(approval.id);
        if (!approval.waiting) detail?.resume();
      }
      recorder?.toolStarted(detail?.seq);
      const tool = {
        detail,
        timed: recorder?.timing('toolsMs'),
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
      if (status !== 'ok') toolErrors++;
      const tool = tools.get(callId);
      tool?.timed?.();
      tool?.detail?.finish(status, result);
      tool?.end(
        status === 'ok' || status === 'pending-approval' ? 'ok' : 'error',
      );
      tools.delete(callId);
      approvals.delete(callId);
      denying.delete(callId);
    };
    try {
      signal.throwIfAborted();
      request.signal.throwIfAborted();
      const events = agent.run(
        {
          ...request,
          tools: request.tools.map((tool) => ({
            ...tool,
            async run(...args) {
              toolCalls++;
              try {
                const result = await tool.run(...args);
                if (isPendingApproval(result)) toolErrors++;
                return result;
              } catch (error) {
                toolErrors++;
                throw error;
              }
            },
          })),
        },
        {
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
        },
      );
      const stream = (iterator = events[Symbol.asyncIterator]());
      const firstText = trace.begin('agent.first_text', firstTextAttrs);
      let seenText = false;
      const recordFirstText = (text: string) => {
        if (!text || seenText) return;
        seenText = true;
        if (resolvedModel !== undefined)
          firstTextAttrs.resolvedModel = resolvedModel;
        firstText();
      };
      for (;;) {
        const next = await untilAborted(request.signal, () => stream.next());
        signal.throwIfAborted();
        if (next.done) {
          complete = true;
          return { text: final ?? deltas, sessionId, resolvedModel };
        }
        if (approvalPending?.aborted) continue;
        const event = next.value;
        switch (event.type) {
          case 'reasoning':
            recorder?.text('reasoning', event.text);
            break;
          case 'model':
            resolvedModel = event.model;
            runAttrs.resolvedModel = resolvedModel;
            if (event.reasoning !== undefined)
              runAttrs.reasoning = event.reasoning;
            else delete runAttrs.reasoning;
            recorder?.model(event.model, event.reasoning);
            break;
          case 'text.delta':
            recorder?.text('text', event.text);
            recordFirstText(event.text);
            deltas += event.text;
            break;
          case 'text.final':
            if (!deltas.endsWith(event.text))
              recorder?.text('text', event.text);
            recordFirstText(event.text);
            final = event.text;
            break;
          case 'sessionId': {
            sessionId = event.sessionId;
            const nextScope = ephemeral ? null : scope(sessionId);
            if (!request.purpose && nextScope !== activeScope)
              trace.record('agent.session.created', {
                ...attrs,
                sessionScope: nextScope,
              });
            activeScope = nextScope;
            recorder?.sessionId(sessionId);
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
            usage = {
              contextTokens,
              inputTokens: event.inputTokens ?? null,
              outputTokens: event.outputTokens ?? null,
            };
            trace.record('agent.usage', {
              ...attrs,
              sessionScope:
                request.purpose ||
                (contextTokens === null &&
                  event.inputTokens === undefined &&
                  contextWindow === undefined)
                  ? null
                  : activeScope,
              ...usage,
              ...(contextWindow === undefined ? {} : { contextWindow }),
              ...(request.purpose === 'sticker-index' && {
                costUsd: event.costUsd ?? null,
              }),
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
      if (signal.aborted || !approvalPending?.aborted) {
        outcome =
          signal.aborted || request.signal.aborted ? 'aborted' : 'error';
        if (outcome === 'error' && recorder)
          runAttrs.error = recorder.errorMessage(error);
        else if (outcome === 'error') {
          const redactSecrets = toolDetails?.redactor();
          const redact = (text: string) => {
            for (const id of [
              sessionId,
              request.resumeSessionId,
              request.forkSessionId,
            ])
              if (id) text = text.replaceAll(id, '[redacted session]');
            return redactSecrets?.(text) ?? text;
          };
          runAttrs.error =
            request.purpose === 'sticker-index'
              ? describeStickerError(error, redact)
              : describeTaskError(error, redact);
        }
        throw error;
      }
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
      Object.assign(runAttrs, usage, {
        sessionScope: activeScope,
        toolCalls,
        toolErrors,
        outputChars: outcome === 'ok' ? (final ?? deltas).length : 0,
        outcome:
          outcome === 'ok' && approvalPending?.aborted
            ? 'pending-approval'
            : outcome,
      });
      if (!complete && iterator) {
        const closed = Promise.resolve()
          .then(() => iterator?.return?.())
          .catch(() => {
            log({
              level: 'error',
              event: 'agent.iterator_close_failed',
              taskId,
            });
          });
        if (waitForClose?.()) {
          await untilAborted(AbortSignal.timeout(5_000), () => closed).catch(
            () =>
              log({
                level: 'warn',
                event: 'agent.iterator_close_timeout',
                taskId,
              }),
          );
        }
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
    recorder,
    toolDetails,
    task,
    requestApproval,
  }: {
    hooks: HookRunner;
    onResult?(result: unknown): void;
    recorder?: TaskRecorder;
    requestApproval(
      request: Parameters<AgentIO['requestApproval']>[0],
      tool: Extract<ApprovalContinuation, { kind: 'tool' }>,
      onPending?: (approvalId: string) => void,
    ): Promise<
      boolean | { pending: true; summary: string } | { result: unknown }
    >;
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
        recorder?.toolStarted(detail?.seq);
        const timed = recorder?.timing('toolsMs');
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
                description: await permission.describe?.(args, task),
                resource: permission.resource(args, task),
              },
              { kind: 'tool', name, args },
              detail?.pending,
            );
            if (!approval) {
              status = 'denied';
              throw new Error('Tool permission denied');
            }
            if (typeof approval === 'object' && 'pending' in approval) {
              result = approval;
            } else {
              detail?.resume();
              if (typeof approval === 'object') result = approval.result;
            }
          }
          if (result === undefined) {
            signal.throwIfAborted();
            const invocation =
              detail && toolDetails
                ? toolDetails.associate(task, detail)
                : task;
            result = await tool.run(args, invocation);
          }
          status = isPendingApproval(result) ? 'pending-approval' : 'ok';
        } catch (error) {
          result = error;
          throw error;
        } finally {
          timed?.();
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
