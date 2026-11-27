import type {
  Options,
  query,
  SDKMessage,
  SDKRateLimitInfo,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentCompactRequest,
  AgentCompactResult,
  AgentConnector,
  AgentEvent,
  AgentInstanceConfig,
  AgentIO,
  AgentQuota,
  AgentQuotaWindow,
  AgentRequest,
  AgentSessionInfo,
  AgentSettings,
  ImageLimits,
  PluginFactoryContext,
} from '@tsugimori/plugin-sdk';

import {
  agentWebPolicy,
  defaultCompactAt,
  definePlugin,
  imageLimits,
  isStableInstruction,
  nativeCompactionLimit,
  renderStableInstructions,
  renderTurnContext,
  toolWireName,
  webFetchToolName,
  webSearchTraceName,
} from '@tsugimori/plugin-sdk';
import { mkdir, realpath } from 'node:fs/promises';

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
import { searchArgs, searchResult } from './web-search.ts';

type Query = (args: Parameters<typeof query>[0]) => AsyncIterable<SDKMessage>;

interface ClaudeDependencies {
  query?: Query;
}

interface ClaudeOptions {
  compactAt?: number;
  effort?: string;
  home?: string;
  images?: ImageLimits;
  model?: string;
  token?: string;
}

interface SessionSlot {
  ready: Promise<void>;
  release(): void;
}

const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const defaultImageLimits: ImageLimits = {
  sourceMaxBytes: 32 * 1024 * 1024,
  maxEdge: 1568,
  maxBytes: 7_500_000,
  maxPixels: 1568 * 28 ** 2,
};

async function* imagePrompt(
  text: string,
  images: NonNullable<AgentRequest['images']>,
): AsyncIterable<SDKUserMessage> {
  const content = [
    { type: 'text' as const, text },
    ...images.flatMap(({ data, mime, source }) => [
      ...(source
        ? [{ type: 'text' as const, text: JSON.stringify(source) }]
        : []),
      {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: mime, data },
      },
    ]),
  ];
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
  };
}

const implementation = 'Claude Agent SDK';
const quotaWindows = { five_hour: 300, seven_day: 10_080 };
type QuotaWindow = keyof typeof quotaWindows;

export class ClaudeAgent implements AgentConnector {
  readonly capabilities = { webSearch: 'native' } as const;
  readonly id: string;
  readonly imageLimits: ImageLimits;
  readonly implementation = implementation;
  readonly kind = 'claude-sdk';
  readonly loop = 'external';
  readonly settings: AgentSettings = {
    perTurn: ['model', 'thinking', 'serviceTier'],
    serviceTiers: ['fast', 'default'],
    thinking: effortLevels,
  };
  readonly #query?: Query;
  readonly #apiKey?: string;
  readonly #compactAt: number;
  readonly #effort?: string;
  readonly #home?: string;
  readonly #model?: string;
  readonly #token?: string;
  readonly #active = new Set<AbortController>();
  #lifecycle = new AbortController();
  readonly #sessionTails = new Map<string, Promise<void>>();
  readonly #compactions = new Map<string, Promise<AgentCompactResult>>();
  readonly #contextWindows = new Map<string, number>();
  readonly #sessions = new Map<
    string,
    {
      info: AgentSessionInfo;
      settings: Pick<AgentRequest, 'model' | 'serviceTier' | 'thinking'>;
    }
  >();
  readonly #quota = new Map<QuotaWindow, AgentQuotaWindow>();
  readonly #reached = new Set<QuotaWindow>();
  #defaultModel?: string;
  #defaultEffort?: string;

  constructor(
    { query }: ClaudeDependencies,
    id: string,
    apiKey: string | null = process.env.ANTHROPIC_API_KEY ?? null,
    options?: ClaudeOptions,
  ) {
    this.id = id;
    this.imageLimits = options?.images ?? defaultImageLimits;
    this.#query = query;
    this.#apiKey = apiKey ?? undefined;
    this.#compactAt = options?.compactAt ?? defaultCompactAt;
    this.#effort = options?.effort;
    this.#home = options?.home;
    this.#model = options?.model === 'default' ? undefined : options?.model;
    this.#token = options?.token;
  }

  describeDefaults() {
    const model = this.#model ?? this.#defaultModel;
    const effort = this.#effort ?? this.#defaultEffort;
    return { ...(model && { model }), ...(effort && { effort }) };
  }

  economyModel() {
    return 'haiku';
  }

  listModels() {
    return ['sonnet', 'opus', 'haiku'];
  }

  describeSession(
    sessionId: string,
    settings?: Pick<AgentRequest, 'model' | 'serviceTier' | 'thinking'>,
  ) {
    const session = this.#sessions.get(sessionId);
    if (!settings || !session) return session?.info;
    const sameModel = session.settings.model === settings.model;
    return {
      model: sameModel ? session.info.model : undefined,
      effort:
        sameModel && session.settings.thinking === settings.thinking
          ? session.info.effort
          : undefined,
      serviceTier:
        sameModel && session.settings.serviceTier === settings.serviceTier
          ? session.info.serviceTier
          : undefined,
    };
  }

  describeQuota(): AgentQuota | undefined {
    if (!this.#quota.size) return;
    const primary = this.#quota.get('five_hour');
    const secondary = this.#quota.get('seven_day');
    const [rateLimitReachedType] = this.#reached;
    return {
      ...(primary && { primary }),
      ...(secondary && { secondary }),
      ...(rateLimitReachedType && { rateLimitReachedType }),
    };
  }

  #updateQuota({
    rateLimitType,
    resetsAt,
    status,
    utilization,
  }: SDKRateLimitInfo) {
    if (rateLimitType !== 'five_hour' && rateLimitType !== 'seven_day') return;
    const previous = this.#quota.get(rateLimitType);
    this.#quota.set(rateLimitType, {
      ...previous,
      windowDurationMins: quotaWindows[rateLimitType],
      ...(typeof resetsAt === 'number' &&
        Number.isFinite(resetsAt) && { resetsAt }),
      ...(typeof utilization === 'number' &&
        Number.isFinite(utilization) && {
          usedPercent: utilization <= 1 ? utilization * 100 : utilization,
        }),
    });
    if (status === 'rejected') this.#reached.add(rateLimitType);
    if (status === 'allowed' || status === 'allowed_warning')
      this.#reached.delete(rateLimitType);
  }

  async start() {
    if (this.#lifecycle.signal.aborted) this.#lifecycle = new AbortController();
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
    let hasResult = false;
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
        hasResult = true;
      }
    }
    if (!hasResult) throw new Error('Claude compaction ended before a result');
    return compacted;
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
      if (this.#home) await mkdir(this.#home, { recursive: true, mode: 0o700 });
      const query =
        this.#query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      signal.throwIfAborted();
      const instructions = renderStableInstructions(request.context);
      const context = renderTurnContext(
        request.context,
        request.resumeSessionId
          ? ({ source }) => source === 'message'
          : (block) => !isStableInstruction(block),
      );
      const web = agentWebPolicy(request);
      const tools = web.fetch
        ? request.tools
        : request.tools.filter(({ name }) => name !== webFetchToolName);
      const registered = tools.length
        ? gatewayTools(
            (await import('@anthropic-ai/claude-agent-sdk')).createSdkMcpServer,
            tools,
          )
        : undefined;
      const options: Options = {
        ...registered,
        abortController,
        cwd: workdir,
        model: request.model === 'default' ? undefined : request.model,
        maxTurns: command ? 1 : undefined,
        persistSession:
          request.ephemeral || request.purpose ? false : undefined,
        resume: request.resumeSessionId,
        effort: effortLevels.find((level) => level === request.thinking),
        systemPrompt: instructions || undefined,
        settingSources: [],
        skills: [],
        strictMcpConfig: true,
        tools:
          request.purpose !== undefined || request.toolsDisabled
            ? []
            : [
                'Read',
                'Glob',
                'Grep',
                ...(request.sandbox
                  ? []
                  : ['Bash', 'Edit', 'Write', 'NotebookEdit']),
                ...(web.fetch && !request.sandbox ? ['WebFetch'] : []),
                ...(web.search ? ['WebSearch'] : []),
              ],
        env: {
          ...claudeEnvironment(),
          CLAUDE_CONFIG_DIR: this.#home,
          [apiKeyName]: this.#apiKey,
          [oauthTokenName]: this.#token,
          DISABLE_AUTOUPDATER: '1',
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
              {
                search: !web.search
                  ? 'deny'
                  : request.sandbox
                    ? 'allow'
                    : 'ask',
                fetch: web.fetch && !request.sandbox,
              },
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
          ...(request.serviceTier === 'fast' ||
          request.serviceTier === 'default'
            ? { fastMode: request.serviceTier === 'fast' }
            : {}),
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
        prompt:
          command ??
          (request.images?.length
            ? imagePrompt(context, request.images)
            : context),
        options,
      })) {
        signal.throwIfAborted();
        if (event.type === 'rate_limit_event')
          this.#updateQuota(event.rate_limit_info);
        if (
          !command &&
          !request.purpose &&
          !request.ephemeral &&
          event.type === 'system' &&
          event.subtype === 'init'
        ) {
          const { effort, fast_mode_state: fast, model } = event;
          this.#sessions.set(event.session_id, {
            info: {
              ...(model && { model }),
              ...(effort && { effort }),
              ...(fast && { serviceTier: fast === 'off' ? 'default' : 'fast' }),
            },
            settings: {
              model: request.model,
              serviceTier: request.serviceTier,
              thinking: request.thinking,
            },
          });
          if (request.model === 'default') this.#defaultModel = model;
          if (!request.thinking && request.model === (this.#model ?? 'default'))
            this.#defaultEffort = effort ?? undefined;
        }
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
        if (request.ephemeral) return;
        if (!slot) slot = this.#reserveSession(sessionId);
        if (tokensBefore === undefined || this.#compactions.has(sessionId))
          return;
        const startedAt = performance.now();
        const compaction = this.#startCompaction(
          {
            sessionId,
            model: request.model,
            serviceTier: request.serviceTier,
            thinking: request.thinking,
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
    let reportedModel = false;
    let streamedText = false;
    const thinkingBlocks = new Set<number>();
    let model: string | undefined;
    let lastContext: number | undefined;
    let streamedContext: number | undefined;
    let sawNativeCompaction = false;
    let result:
      Extract<SDKMessage, { subtype: 'success'; type: 'result' }> | undefined;
    const tools = new Map<string, { name: string; searchStarted?: number }>();
    const frameworkTools = new Set(
      request.tools.map(({ name }) => `mcp__tsugimori__${toolWireName(name)}`),
    );
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
          streamedText = false;
          thinkingBlocks.clear();
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
        ) {
          streamedText = true;
          yield { type: 'text.delta', text: part.delta.text };
        }
        if (
          part.type === 'content_block_start' &&
          part.content_block.type === 'thinking' &&
          part.content_block.thinking
        ) {
          thinkingBlocks.add(part.index);
          yield { type: 'reasoning', text: part.content_block.thinking };
        }
        if (
          part.type === 'content_block_delta' &&
          part.delta.type === 'thinking_delta'
        ) {
          thinkingBlocks.add(part.index);
          yield { type: 'reasoning', text: part.delta.thinking };
        }
        if (
          part.type === 'content_block_start' &&
          part.content_block.type === 'tool_use'
        ) {
          const { id: callId, name, input } = part.content_block;
          if (!frameworkTools.has(name)) {
            const search = name === 'WebSearch';
            tools.set(callId, {
              name,
              searchStarted: search ? performance.now() : undefined,
            });
            yield {
              type: 'tool.started',
              callId,
              name: search ? webSearchTraceName : name,
              args: search ? searchArgs(input) : input,
            };
          }
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
        for (const [index, block] of event.message.content.entries()) {
          if (block.type === 'text') {
            text.push(block.text);
            if (event.parent_tool_use_id === null && !streamedText)
              yield { type: 'text.delta', text: block.text };
          }
          if (
            block.type === 'thinking' &&
            event.parent_tool_use_id === null &&
            !thinkingBlocks.has(index)
          )
            yield { type: 'reasoning', text: block.thinking };
          if (block.type !== 'tool_use' || frameworkTools.has(block.name))
            continue;
          const search = block.name === 'WebSearch';
          const args = search ? searchArgs(block.input) : block.input;
          if (tools.has(block.id)) {
            if (args !== undefined)
              yield { type: 'tool.input', callId: block.id, args };
          } else {
            tools.set(block.id, {
              name: block.name,
              searchStarted: search ? performance.now() : undefined,
            });
            yield {
              type: 'tool.started',
              callId: block.id,
              name: search ? webSearchTraceName : block.name,
              args,
            };
          }
        }
        if (event.parent_tool_use_id === null) {
          if (text.length) lastText = text.join('');
          streamedText = false;
          thinkingBlocks.clear();
        }
      } else if (
        event.type === 'user' &&
        Array.isArray(event.message.content)
      ) {
        for (const block of event.message.content) {
          if (block.type !== 'tool_result') continue;
          const callId = block.tool_use_id;
          const tool = tools.get(callId);
          if (!tool) continue;
          tools.delete(callId);
          const search = tool.searchStarted !== undefined;
          const status = block.is_error ? 'error' : 'ok';
          const output = event.tool_use_result;
          const args = search ? searchArgs(output) : undefined;
          yield {
            type: 'tool.finished',
            callId,
            name: search ? webSearchTraceName : tool.name,
            status,
            ...(args?.query !== undefined && { args }),
            result:
              tool.searchStarted === undefined
                ? block.content
                : searchResult(output, tool.searchStarted, status),
          };
        }
      } else if (event.type === 'system' && event.subtype === 'init') {
        model = event.model;
        if (model && !reportedModel) {
          reportedModel = true;
          yield { type: 'model', model, reasoning: event.effort ?? undefined };
        }
      } else if (
        event.type === 'system' &&
        event.subtype === 'compact_boundary'
      ) {
        sawNativeCompaction = true;
        streamedContext = undefined;
        lastContext = event.compact_metadata.post_tokens;
        yield {
          type: 'compaction',
          status: 'ok',
          trigger:
            event.compact_metadata.trigger === 'auto' ? 'native' : 'manual',
          ...compactionDetails(event),
        };
      } else if (event.type === 'result') {
        assertSuccess(event);
        result = event;
      }
    }
    if (!result) throw new Error('Claude query ended before a result');
    const usageByModel = result.modelUsage ?? {};
    const reportedModels = Object.values(usageByModel);
    const reportedWindow = (
      usageByModel[model ?? request.model] ??
      usageByModel[request.model] ??
      (reportedModels.length === 1 ? reportedModels[0] : undefined)
    )?.contextWindow;
    const window =
      typeof reportedWindow === 'number' &&
      Number.isSafeInteger(reportedWindow) &&
      reportedWindow > 0
        ? reportedWindow
        : undefined;
    if (window !== undefined) this.#contextWindows.set(request.model, window);

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
    const { cache_read_input_tokens, cache_creation_input_tokens } =
      result.usage;
    yield {
      type: 'usage',
      contextTokens: tokens ?? null,
      ...(window === undefined ? {} : { contextWindow: window }),
      ...(request.purpose === 'sticker-index' &&
        typeof result.total_cost_usd === 'number' && {
          costUsd: result.total_cost_usd,
        }),
      ...(cache_read_input_tokens != null && {
        cachedInputTokens: cache_read_input_tokens,
      }),
      ...(cache_creation_input_tokens != null && {
        cacheWriteTokens: cache_creation_input_tokens,
      }),
      inputTokens: contextTokens(result.usage, false),
      outputTokens: result.usage.output_tokens ?? undefined,
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
  credentialNames: ({ options }) => {
    const { apiKeyEnv, tokenEnv } = options ?? {};
    return apiKeyEnv === undefined && tokenEnv === undefined
      ? [apiKeyName]
      : [apiKeyEnv, tokenEnv].filter(
          (name): name is string => typeof name === 'string',
        );
  },
  setupSteps: claudeSetup,
  agents: {
    'claude-sdk': Object.assign(
      (config: AgentInstanceConfig, ctx: PluginFactoryContext) => {
        const auth = claudeOptions(config, ctx);
        return new ClaudeAgent({}, config.id, auth.apiKey ?? null, {
          ...auth,
          compactAt: config.compactAt,
          images: imageLimits(defaultImageLimits, config.options),
          model: typeof config.model === 'string' ? config.model : undefined,
          effort:
            typeof config.thinking === 'string' ? config.thinking : undefined,
        });
      },
      { implementation },
    ),
  },
});
