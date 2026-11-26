import type {
  AgentConnector,
  AgentIO,
  AgentRequest,
  AgentTool,
  ToolContext,
  ToolDefinition,
} from '@tsugimori/plugin-sdk';
import type { Tracer } from '@tsugimori/trace';

import { Ajv } from 'ajv';

import type { HookRunner, Logger } from './hooks.ts';

import { untilAborted } from './abort.ts';

interface AgentRunDependencies {
  log: Logger;
  task: ToolContext;
  trace: Tracer;
}

export async function runAgent(
  { trace, log, task }: AgentRunDependencies,
  agent: AgentConnector,
  request: AgentRequest,
  io: AgentIO,
) {
  const { signal, taskId } = task;
  const attrs = { taskId, agentId: agent.id, model: request.model };
  return trace.span('agent.run', attrs, async () => {
    signal.throwIfAborted();
    const iterator = agent.run(request, io)[Symbol.asyncIterator]();
    const firstText = trace.begin('agent.first_text', attrs);
    const tools = new Map<string, ReturnType<Tracer['begin']>>();
    let complete = false;
    let deltas = '';
    let final: string | undefined;
    let sessionId: string | undefined;
    try {
      for (;;) {
        const next = await untilAborted(signal, () => iterator.next());
        if (next.done) {
          complete = true;
          return { text: final ?? deltas, sessionId };
        }
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
          case 'sessionId':
            sessionId = event.sessionId;
            break;
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
          case 'usage':
            trace.begin('agent.usage', {
              ...attrs,
              inputTokens: event.inputTokens ?? null,
              outputTokens: event.outputTokens ?? null,
            })();
            break;
          case 'compaction':
            trace.record(
              'agent.compaction',
              {
                ...attrs,
                trigger: event.trigger,
                tokensBefore: event.tokensBefore ?? null,
                tokensAfter: event.tokensAfter ?? null,
              },
              event.durationMs,
            );
            break;
          case 'error':
            throw event.error;
        }
      }
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
  });
}

const validator = new Ajv();

export function protectTools(
  {
    trace,
    hooks,
    task,
    requestApproval,
  }: {
    hooks: HookRunner;
    requestApproval: AgentIO['requestApproval'];
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
        try {
          const result = await trace.span(
            'tool.run',
            { taskId, name },
            async () => {
              const permission = tool.permission;
              if (
                permission &&
                !(await requestApproval({
                  action: permission.action,
                  description: permission.describe?.(args, task),
                  resource: permission.resource(args, task),
                }))
              )
                throw new Error('Tool permission denied');
              signal.throwIfAborted();
              return tool.run(args, task);
            },
          );
          status = 'ok';
          return result;
        } finally {
          await hooks.emit('tool.after', { task, name, status });
        }
      },
    };
  });
}
