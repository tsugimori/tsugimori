import type {
  Options,
  query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentCompactRequest,
  AgentCompactResult,
  AgentConnector,
  AgentEvent,
  AgentIO,
  AgentRequest,
  ContextBlock,
} from '@tsugimori/plugin-sdk';

import {
  defaultCompactAt,
  definePlugin,
  nativeCompactionLimit,
} from '@tsugimori/plugin-sdk';
import { realpath } from 'node:fs/promises';

import {
  askThroughHost,
  protectedDirectories,
  toolPermission,
} from './permissions.ts';
import {
  apiKeyName,
  claudeChecks,
  claudeEnvironment,
  claudeOptions,
  claudeSetup,
  oauthTokenName,
} from './setup.ts';
import { gatewayTools } from './tools.ts';

type Query = (args: Parameters<typeof query>[0]) => AsyncIterable<SDKMessage>;

interface ClaudeDependencies {
  query?: Query;
}

interface SessionSlot {
  ready: Promise<void>;
  release(): void;
}

const effortLevels = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function render(blocks: ContextBlock[]) {
  return blocks
    .map(({ content, source, trust }) =>
      JSON.stringify({ source, trust, content }),
    )
    .join('\n');
}

function trustedInstructions(block: ContextBlock) {
  return (
    block.trust === 'trusted' &&
    (block.source === 'system' || block.source === 'rule')
  );
}

export class ClaudeAgent implements AgentConnector {
  readonly id: string;
  readonly kind = 'claude-sdk';
  readonly loop = 'external';
  readonly #query?: Query;
  readonly #apiKey?: string;
  readonly #compactAt: number;
  readonly #home?: string;
  readonly #token?: string;
  readonly #active = new Set<AbortController>();
  readonly #lifecycle = new AbortController();
  readonly #sessionTails = new Map<string, Promise<void>>();
  readonly #compactions = new Map<string, Promise<AgentCompactResult>>();
  readonly #contextWindows = new Map<string, number>();

  constructor(
    { query }: ClaudeDependencies,
    id: string,
    apiKey: string | null = process.env.ANTHROPIC_API_KEY ?? null,
    options?: { compactAt?: number; home?: string; token?: string },
  ) {
    this.id = id;
    this.#query = query;
    this.#apiKey = apiKey ?? undefined;
    this.#compactAt = options?.compactAt ?? defaultCompactAt;
    this.#home = options?.home;
    this.#token = options?.token;
  }

  async stop() {
    this.#lifecycle.abort();
    for (const controller of this.#active) controller.abort();
    await Promise.allSettled(this.#compactions.values());
  }

  #reserveSession(sessionId: string): SessionSlot {
    const ready = this.#sessionTails.get(sessionId) ?? Promise.resolve();
    const released = Promise.withResolvers<void>();
    const tail = ready.then(() => released.promise);
    this.#sessionTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.#sessionTails.get(sessionId) === tail)
        this.#sessionTails.delete(sessionId);
    });
    return { ready, release: released.resolve };
  }

  #startCompaction(request: AgentCompactRequest, slot: SessionSlot) {
    const compacting = slot.ready
      .then(() => this.#compact(request))
      .finally(() => {
        this.#compactions.delete(request.sessionId);
        slot.release();
      });
    this.#compactions.set(request.sessionId, compacting);
    return compacting;
  }

  compact(request: AgentCompactRequest): Promise<AgentCompactResult> {
    const active = this.#compactions.get(request.sessionId);
    if (active)
      return active.then((result) =>
        result.status === 'compacted' ? { ...result, shared: true } : result,
      );
    return this.#startCompaction(
      request,
      this.#reserveSession(request.sessionId),
    );
  }

  async #compact(request: AgentCompactRequest): Promise<AgentCompactResult> {
    let compacted: AgentCompactResult = { status: 'skipped' };
    const input: AgentRequest = {
      ...request,
      context: [],
      resumeSessionId: request.sessionId,
      tools: [],
      toolsDisabled: true,
    };
    for await (const event of this.#session(input, undefined, '/compact')) {
      if (event.session_id !== request.sessionId)
        throw new Error(
          'Claude returned a different session during compaction',
        );
      if (event.type === 'system') {
        if (
          event.subtype === 'init' &&
          !event.slash_commands.includes('compact')
        )
          return { status: 'unsupported' };
        if (
          event.subtype === 'compact_boundary' &&
          event.compact_metadata.trigger === 'manual'
        )
          compacted = { status: 'compacted', ...compactionDetails(event) };
      } else if (event.type === 'result') {
        assertSuccess(event);
        return compacted;
      }
    }
    throw new Error('Claude compaction ended before a result');
  }

  async *#session(request: AgentRequest, io?: AgentIO, command?: '/compact') {
    const requestSignal = AbortSignal.any([
      request.signal,
      this.#lifecycle.signal,
    ]);
    requestSignal.throwIfAborted();
    const abortController = new AbortController();
    const abort = () => abortController.abort(requestSignal.reason);
    requestSignal.addEventListener('abort', abort, { once: true });
    this.#active.add(abortController);
    const signal = abortController.signal;
    try {
      const workdir = await realpath(request.workdir);
      const query =
        this.#query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      signal.throwIfAborted();
      const instructions = request.context.filter(trustedInstructions);
      const context = request.resumeSessionId
        ? request.context.filter(({ source }) => source === 'message')
        : request.context.filter((block) => !trustedInstructions(block));
      const registered = request.tools.length
        ? gatewayTools(
            (await import('@anthropic-ai/claude-agent-sdk')).createSdkMcpServer,
            request.tools,
          )
        : undefined;
      const options: Options = {
        ...registered,
        abortController,
        cwd: workdir,
        model: request.model === 'default' ? undefined : request.model,
        maxTurns: command ? 1 : undefined,
        resume: request.resumeSessionId,
        effort:
          request.thinking && effortLevels.has(request.thinking)
            ? (request.thinking as Options['effort'])
            : undefined,
        systemPrompt: instructions.length ? render(instructions) : undefined,
        settingSources: [],
        skills: [],
        strictMcpConfig: true,
        tools:
          request.purpose === 'summary' || request.toolsDisabled
            ? []
            : request.sandbox
              ? ['Read', 'Glob', 'Grep']
              : [
                  'Read',
                  'Glob',
                  'Grep',
                  'Bash',
                  'Edit',
                  'Write',
                  'NotebookEdit',
                  'WebFetch',
                  'WebSearch',
                ],
        env: {
          ...claudeEnvironment(),
          CLAUDE_CONFIG_DIR: this.#home,
          [apiKeyName]: this.#apiKey,
          [oauthTokenName]: this.#token,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'tsugimori/0.0.0',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(
            nativeCompactionLimit(
              this.#compactAt,
              this.#contextWindows.get(request.model),
            ),
          ),
        },
        permissionMode: 'default',
        canUseTool: io
          ? toolPermission(
              workdir,
              io,
              signal,
              new Set(registered?.allowedTools),
              request.sandbox?.denyRead,
            )
          : async () => ({ behavior: 'deny', message: 'Permission denied.' }),
        includePartialMessages: true,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input, id, ctx) => {
                  if (
                    input.hook_event_name === 'PreToolUse' &&
                    registered?.allowedTools?.includes(input.tool_name)
                  )
                    return {};
                  return askThroughHost(input, id, ctx);
                },
              ],
            },
          ],
        },
        settings: {
          autoMemoryEnabled: false,
          permissions: {
            blockWritesOutsideWorkingDirectories: true,
            disableBypassPermissionsMode: 'disable',
            deny: [
              'Read(**/.env)',
              'Read(**/.env.*)',
              ...protectedDirectories.map(
                (directory) => `Read(/${directory}/**)`,
              ),
            ],
          },
        },
        sandbox: request.sandbox
          ? undefined
          : {
              enabled: true,
              failIfUnavailable: true,
              allowUnsandboxedCommands: false,
              autoAllowBashIfSandboxed: false,
              filesystem: {
                allowWrite: [workdir],
                denyRead: [...protectedDirectories, '**/.env', '**/.env.*'],
              },
              network: { allowedDomains: [] },
              credentials: {
                envVars: [
                  { name: apiKeyName, mode: 'deny' },
                  { name: oauthTokenName, mode: 'deny' },
                ],
              },
            },
      };
      for await (const event of query({
        prompt: command ?? render(context),
        options,
      })) {
        signal.throwIfAborted();
        yield event;
      }
      signal.throwIfAborted();
    } finally {
      abortController.abort();
      requestSignal.removeEventListener('abort', abort);
      this.#active.delete(abortController);
    }
  }

  async *run(request: AgentRequest, io: AgentIO): AsyncIterable<AgentEvent> {
    let slot = request.resumeSessionId
      ? this.#reserveSession(request.resumeSessionId)
      : undefined;
    try {
      await slot?.ready;
      yield* this.#runTurn(request, io, (sessionId, tokensBefore) => {
        if (!slot) slot = this.#reserveSession(sessionId);
        if (tokensBefore === undefined || this.#compactions.has(sessionId))
          return;
        const startedAt = performance.now();
        const compaction = this.#startCompaction(
          {
            sessionId,
            model: request.model,
            sandbox: request.sandbox,
            workdir: request.workdir,
            signal: AbortSignal.timeout(120_000),
          },
          slot,
        );
        slot = undefined;
        const report = (result?: AgentCompactResult) => {
          const compacted = result?.status === 'compacted' ? result : undefined;
          io.reportCompaction?.({
            type: 'compaction',
            trigger: 'post-turn',
            status: compacted ? 'ok' : 'error',
            tokensBefore: compacted?.tokensBefore ?? tokensBefore,
            tokensAfter: compacted?.tokensAfter,
            durationMs: compacted?.durationMs ?? performance.now() - startedAt,
          });
        };
        void compaction.then(report, () => report());
      });
    } finally {
      slot?.release();
    }
  }

  async *#runTurn(
    request: AgentRequest,
    io: AgentIO,
    session: (sessionId: string, tokensBefore?: number) => void,
  ): AsyncIterable<AgentEvent> {
    let sessionId: string | undefined;
    let lastText = '';
    let model: string | undefined;
    let lastContext: number | undefined;
    let streamedContext: number | undefined;
    let sawNativeCompaction = false;
    let result:
      Extract<SDKMessage, { subtype: 'success'; type: 'result' }> | undefined;
    const tools = new Map<string, string>();
    for await (const event of this.#session(request, io)) {
      if (event.session_id && sessionId !== event.session_id) {
        sessionId = event.session_id;
        session(sessionId);
        yield { type: 'sessionId', sessionId };
      }
      if (event.type === 'stream_event' && event.parent_tool_use_id === null) {
        const { event: part } = event;
        if (part.type === 'message_start') {
          model = part.message.model;
          streamedContext = contextTokens(part.message.usage, false);
          lastContext = contextTokens(part.message.usage);
        } else if (
          part.type === 'message_delta' &&
          streamedContext !== undefined
        ) {
          lastContext = streamedContext + part.usage.output_tokens;
        }
        if (
          part.type === 'content_block_delta' &&
          part.delta.type === 'text_delta'
        )
          yield { type: 'text.delta', text: part.delta.text };
        if (
          part.type === 'content_block_start' &&
          part.content_block.type === 'tool_use'
        ) {
          const { id: callId, name } = part.content_block;
          tools.set(callId, name);
          yield { type: 'tool.started', callId, name };
        }
      } else if (event.type === 'assistant') {
        if (event.error)
          throw new Error(`Claude assistant failed (${event.error})`);
        if (
          event.parent_tool_use_id === null &&
          streamedContext === undefined
        ) {
          model = event.message.model ?? model;
          lastContext = contextTokens(event.message.usage) ?? lastContext;
        }
        const text: string[] = [];
        for (const block of event.message.content) {
          if (block.type === 'text') text.push(block.text);
          if (block.type === 'tool_use' && !tools.has(block.id)) {
            tools.set(block.id, block.name);
            yield {
              type: 'tool.started',
              callId: block.id,
              name: block.name,
            };
          }
        }
        if (text.length && event.parent_tool_use_id === null)
          lastText = text.join('');
      } else if (
        event.type === 'user' &&
        Array.isArray(event.message.content)
      ) {
        for (const block of event.message.content) {
          if (block.type !== 'tool_result') continue;
          const callId = block.tool_use_id;
          const name = tools.get(callId);
          if (!name) continue;
          tools.delete(callId);
          yield {
            type: 'tool.finished',
            callId,
            name,
            status: block.is_error ? 'error' : 'ok',
          };
        }
      } else if (event.type === 'system' && event.subtype === 'init') {
        model = event.model;
      } else if (
        event.type === 'system' &&
        event.subtype === 'compact_boundary'
      ) {
        sawNativeCompaction = true;
        streamedContext = undefined;
        lastContext = event.compact_metadata.post_tokens;
        yield {
          type: 'compaction',
          trigger:
            event.compact_metadata.trigger === 'auto' ? 'native' : 'manual',
          ...compactionDetails(event),
        };
      } else if (event.type === 'result') {
        assertSuccess(event);
        result = event;
        break;
      }
    }
    if (!result) throw new Error('Claude query ended before a result');
    const usageByModel = result.modelUsage ?? {};
    const reportedModels = Object.values(usageByModel);
    const window = (
      usageByModel[model ?? request.model] ??
      (reportedModels.length === 1 ? reportedModels[0] : undefined)
    )?.contextWindow;
    if (
      typeof window === 'number' &&
      Number.isSafeInteger(window) &&
      window > 0
    )
      this.#contextWindows.set(request.model, window);

    // Aggregate turn usage may count the same context several times across tool calls.
    const tokens =
      lastContext ??
      (!sawNativeCompaction && (result.num_turns ?? 1) <= 1
        ? contextTokens(result.usage)
        : undefined);
    if (
      !request.purpose &&
      sessionId &&
      tokens !== undefined &&
      tokens > this.#compactAt
    )
      session(sessionId, tokens);
    yield {
      type: 'usage',
      contextTokens: tokens ?? null,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    };
    const text = result.result || lastText;
    if (text) yield { type: 'text.final', text };
  }
}

function contextTokens(
  usage?: {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
  },
  includeOutput = true,
) {
  if (!usage || typeof usage.input_tokens !== 'number') return;
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (includeOutput ? (usage.output_tokens ?? 0) : 0)
  );
}

function assertSuccess(
  event: Extract<SDKMessage, { type: 'result' }>,
): asserts event is Extract<
  SDKMessage,
  { subtype: 'success'; type: 'result' }
> {
  if (event.subtype !== 'success' || event.is_error)
    throw new Error(`Claude query failed (${event.subtype})`);
}

function compactionDetails(
  event: Extract<SDKMessage, { subtype: 'compact_boundary' }>,
) {
  const { pre_tokens, post_tokens, duration_ms } = event.compact_metadata;
  return {
    tokensBefore: pre_tokens,
    tokensAfter: post_tokens,
    durationMs: duration_ms,
  };
}

export default definePlugin({
  name: 'agent-claude-sdk',
  checks: claudeChecks,
  credentialNames: (entry) =>
    [entry.options?.tokenEnv, entry.options?.apiKeyEnv ?? apiKeyName].filter(
      (value): value is string => typeof value === 'string',
    ),
  setupSteps: claudeSetup,
  agents: {
    'claude-sdk': (config, ctx) => {
      const auth = claudeOptions(config, ctx);
      return new ClaudeAgent({}, config.id, auth.apiKey ?? null, {
        ...auth,
        compactAt: config.compactAt,
      });
    },
  },
});
