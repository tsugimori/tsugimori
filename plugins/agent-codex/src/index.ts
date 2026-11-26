import type {
  AgentCompactRequest,
  AgentCompactResult,
  AgentConnector,
  AgentEvent,
  AgentInstanceConfig,
  AgentIO,
  AgentQuota,
  AgentRequest,
  AgentSessionInfo,
  AgentSettings,
  AgentTool,
  ImageLimits,
  PluginFactoryContext,
} from '@tsugimori/plugin-sdk';

import {
  defaultCompactAt,
  definePlugin,
  imageLimits,
  ToolFailure,
  toolWireName,
} from '@tsugimori/plugin-sdk';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { debuglog, promisify } from 'node:util';

import type { ServerFrame, SpawnServer } from './app-server.ts';

import { AppServer, asRecord, RpcError } from './app-server.ts';
import {
  bundledContextWindows,
  codexCompactionConfig,
  codexCompactionSupport,
  contextWindow,
} from './compaction.ts';
import { readCodexDefaults } from './defaults.ts';
import { installCodex, packageDirectory, pinnedVersion } from './install.ts';
import { mergeQuota } from './quota.ts';
import {
  codexChecks,
  codexEnvironment,
  codexLocation,
  codexSetup,
} from './setup.ts';
import {
  approvalPolicy,
  approvalsReviewer,
  approve,
  lastUsage,
  renderContext,
  replyToApproval,
  TurnCompactions,
  TurnFrames,
  TurnOutput,
} from './turn.ts';

interface CodexOptions {
  asyncCompaction?: boolean;
  codexHome?: string;
  command?: string;
  compactAt?: number;
  images?: ImageLimits;
}

interface CodexDependencies {
  inspect?(args: string[]): Promise<string | undefined>;
  spawn?: SpawnServer;
}

interface ThreadContext extends AgentSessionInfo {
  requestedModel?: string;
  requestedServiceTier?: string;
  requestedThinking?: string;
  tokens?: number;
  window?: number;
}

const execFileAsync = promisify(execFile);
const debug = debuglog('tsugimori:codex');
const defaultImageLimits: ImageLimits = {
  sourceMaxBytes: 32 * 1024 * 1024,
  maxEdge: 2048,
  maxBytes: 10_000_000,
  maxPixels: 2500 * 32 ** 2,
};
const implementation = 'Codex App Server';

export class CodexAgent implements AgentConnector {
  readonly id: string;
  readonly imageLimits: ImageLimits;
  readonly implementation = implementation;
  readonly kind = 'codex';
  readonly loop = 'external';
  readonly settings: AgentSettings = {
    perTurn: ['model', 'thinking', 'serviceTier'],
    serviceTiers: true,
    thinking: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  };
  readonly #deps: CodexDependencies;
  readonly #options: CodexOptions;
  readonly #threadContexts = new WeakMap<
    AppServer,
    Map<string, ThreadContext>
  >();
  readonly #modelCatalogs = new WeakMap<
    AppServer,
    Promise<ReturnType<typeof asRecord>[]>
  >();
  #inspection?: ReturnType<CodexAgent['inspect']>;
  #lifecycle?: AbortController;
  #connection?: Promise<AppServer>;
  #quota?: AgentQuota;
  #server?: AppServer;
  #restartAt = 0;
  #backoff = 250;

  constructor(deps: CodexDependencies, id: string, options: CodexOptions = {}) {
    this.id = id;
    this.imageLimits = options.images ?? defaultImageLimits;
    this.#deps = deps;
    this.#options = options;
  }

  describeDefaults() {
    return readCodexDefaults(this.#options.codexHome);
  }

  describeQuota() {
    return this.#quota;
  }

  async listModels() {
    if (!this.#server) return [];
    const models = await this.#models(this.#server);
    return models.flatMap(({ model, id, hidden }) => {
      const value = typeof model === 'string' ? model : id;
      return !hidden && typeof value === 'string' && value ? [value] : [];
    });
  }

  describeSession(
    sessionId: string,
    settings?: Pick<AgentRequest, 'model' | 'serviceTier' | 'thinking'>,
  ): AgentSessionInfo | undefined {
    if (!this.#server) return;
    const context = this.#threadContexts
      .get(this.#server)
      ?.get(nativeSessionId(sessionId));
    if (!context) return;
    if (!settings) return { serviceTier: context.serviceTier };
    const sameModel = settings.model === context.requestedModel;
    return {
      model: sameModel ? context.model : undefined,
      effort:
        sameModel && settings.thinking === context.requestedThinking
          ? context.effort
          : undefined,
      serviceTier:
        settings.serviceTier === context.requestedServiceTier
          ? context.serviceTier
          : undefined,
    };
  }

  async start() {
    this.#lifecycle ??= new AbortController();
    await this.#connect();
  }

  async stop() {
    const connection = this.#connection;
    const inspection = this.#inspection;
    const server = this.#server;
    this.#lifecycle?.abort();
    this.#lifecycle = undefined;
    this.#connection = undefined;
    this.#quota = undefined;
    this.#server = undefined;
    this.#inspection = undefined;
    this.#restartAt = 0;
    this.#backoff = 250;
    const closed = server?.close();
    await Promise.allSettled([connection, closed, inspection]);
  }

  #connect() {
    if (this.#connection) return this.#connection;
    const lifecycle = this.#lifecycle;
    if (!lifecycle) throw new Error('Codex agent is detached');
    const connection = this.#open(lifecycle.signal);
    this.#connection = connection;
    const restart = (startedAt?: number) => {
      if (this.#connection !== connection || lifecycle.signal.aborted) return;
      this.#connection = undefined;
      this.#server = undefined;
      if (startedAt !== undefined && Date.now() - startedAt >= 30_000)
        this.#backoff = 250;
      this.#restartAt = Date.now() + this.#backoff;
      this.#backoff = Math.min(this.#backoff * 2, 10_000);
      void this.#connect().catch(() => undefined); // Failed connections schedule another attempt.
    };
    void connection.then(
      (server) => {
        const startedAt = Date.now();
        if (server.signal.aborted) restart(startedAt);
        else
          server.signal.addEventListener('abort', () => restart(startedAt), {
            once: true,
          });
      },
      () => restart(),
    );
    return connection;
  }

  async #open(signal: AbortSignal) {
    const wait = this.#restartAt - Date.now();
    if (wait > 0) await delay(wait, undefined, { signal });
    signal.throwIfAborted();
    const { command = 'codex', codexHome } = this.#options;
    const env = codexEnvironment(codexHome);
    this.#inspection ??= this.inspect(command, env, signal);
    const server = new AppServer(this.#deps.spawn, command, env);
    this.#server = server;
    this.#quota = undefined;
    const stop = () => server.fail('Codex agent stopped');
    signal.addEventListener('abort', stop, { once: true });
    server.signal.addEventListener(
      'abort',
      () => signal.removeEventListener('abort', stop),
      { once: true },
    );
    // Route server requests centrally so inactive threads never leave a prompt hanging.
    const listeners = new Map<string, (frame: ServerFrame) => void>();
    this.#listeners.set(server, listeners);
    this.#threadContexts.set(server, new Map());
    server.on('frame', (frame) => {
      if (
        frame.method === 'account/rateLimits/updated' &&
        frame.id === undefined
      ) {
        this.#quota = mergeQuota(this.#quota, frame.params.rateLimits);
        return;
      }
      const { threadId } = frame.params;
      if (
        typeof threadId === 'string' &&
        frame.method === 'thread/tokenUsage/updated'
      ) {
        const { totalTokens } = lastUsage(frame.params);
        const window = contextWindow(
          asRecord(frame.params.tokenUsage).modelContextWindow,
        );
        if (typeof totalTokens === 'number' || window !== undefined)
          this.#updateThreadContext(server, threadId, {
            ...(typeof totalTokens === 'number' && { tokens: totalTokens }),
            ...(window !== undefined && { window }),
          });
      }
      const listener =
        typeof threadId === 'string' ? listeners.get(threadId) : undefined;
      if (listener) listener(frame);
      else if (frame.id !== undefined)
        void server
          .reject(frame.id)
          .catch(() =>
            server.fail('Codex could not reject an unsupported request'),
          );
    });
    try {
      await server.request(
        'initialize',
        {
          clientInfo: {
            name: 'tsugimori',
            title: 'Tsugimori',
            version: '0.0.0',
          },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
        15_000,
      );
      await server.notify('initialized');
      void server
        .request('account/rateLimits/read', {}, 5_000, { failOnTimeout: false })
        .then(({ rateLimits }) => {
          if (server.signal.aborted) return;
          // Notifications received while the initial read was pending are newer.
          this.#quota = mergeQuota(
            mergeQuota(undefined, rateLimits),
            this.#quota,
          );
        })
        .catch((error: unknown) => {
          debug('%j', {
            event: 'codex.quota_read_failed',
            code: error instanceof RpcError ? error.code : undefined,
          });
        });
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  #updateThreadContext(
    server: AppServer,
    threadId: string,
    update: ThreadContext,
  ) {
    const contexts = this.#threadContexts.get(server)!;
    const previous = contexts.get(threadId);
    contexts.delete(threadId);
    contexts.set(threadId, { ...previous, ...update });
    if (contexts.size > 256) contexts.delete(contexts.keys().next().value!);
  }

  private async inspect(
    command: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ) {
    const inspect =
      this.#deps.inspect ??
      (async (args: string[]) => {
        try {
          return (
            await execFileAsync(command, args, {
              env: { ...env, NO_COLOR: '1' },
              signal,
              timeout: 5000,
              maxBuffer: 8 * 1024 * 1024,
            })
          ).stdout;
        } catch {
          // Unavailable CLI inspection leaves the native safety net in place.
        }
      });
    const [support, windows] = await Promise.all([
      codexCompactionSupport(inspect),
      bundledContextWindows(inspect),
    ]);
    return { support, windows };
  }

  async #window(
    server: AppServer,
    windows: ReadonlyMap<string, number>,
    model: string | undefined,
    workdir: string,
    threadId?: string,
  ) {
    const previous = threadId
      ? this.#threadContexts.get(server)?.get(threadId)
      : undefined;
    const observed =
      !model || model === previous?.model ? previous?.window : undefined;
    if (model) return windows.get(model) ?? observed;
    if (observed !== undefined) return observed;
    if (!windows.size) return;

    const config = await this.#readConfig(server, workdir);
    if (config) {
      const configured = contextWindow(config.model_context_window);
      if (configured !== undefined) return configured;
      if (typeof config.model === 'string') return windows.get(config.model);
    }
    const entry = (await this.#models(server)).find(
      ({ isDefault }) => isDefault === true,
    );
    const name = entry?.model ?? entry?.id;
    if (typeof name === 'string') return windows.get(name);
  }

  async #readConfig(server: AppServer, workdir: string) {
    try {
      const result = await server.request('config/read', {
        cwd: workdir,
        includeLayers: false,
      });
      return asRecord(result.config);
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      return undefined;
    }
  }

  #models(server: AppServer) {
    let catalog = this.#modelCatalogs.get(server);
    if (!catalog) {
      catalog = this.#loadModels(server).catch((error: unknown) => {
        this.#modelCatalogs.delete(server);
        if (!(error instanceof RpcError)) throw error;
        return [];
      });
      this.#modelCatalogs.set(server, catalog);
    }
    return catalog;
  }

  async #loadModels(server: AppServer) {
    const models: ReturnType<typeof asRecord>[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const { data, nextCursor } = await server.request(
        'model/list',
        { cursor },
        30_000,
        { failOnTimeout: false },
      );
      if (Array.isArray(data)) models.push(...data.map(asRecord));
      cursor =
        typeof nextCursor === 'string' && nextCursor ? nextCursor : undefined;
      if (cursor) {
        if (seen.has(cursor))
          throw new Error('Codex repeated a model catalog cursor');
        seen.add(cursor);
      }
    } while (cursor);
    return models;
  }

  async #turnSettings(
    server: AppServer,
    request: Pick<
      AgentRequest,
      'model' | 'serviceTier' | 'thinking' | 'workdir'
    >,
    resumeSessionId?: string,
  ) {
    let model = request.model === 'default' ? undefined : request.model;
    let effort = request.thinking;
    let serviceTier: string | null | undefined = request.serviceTier;
    if (resumeSessionId) {
      const previous = this.#threadContexts.get(server)?.get(resumeSessionId);
      const modelChanged = previous?.requestedModel !== request.model;
      const restoreModel = model === undefined && modelChanged;
      const restoreEffort =
        effort === undefined &&
        (modelChanged || previous?.requestedThinking !== undefined);
      const restoreTier =
        serviceTier === undefined &&
        (!previous || previous.requestedServiceTier !== undefined);
      if (!restoreModel && !restoreEffort && !restoreTier)
        return { model, effort, serviceTier };
      // Omitted turn settings inherit the thread's previous overrides. Resolve the
      // native defaults explicitly when resuming a thread with cleared settings.
      const config = await this.#readConfig(server, request.workdir);
      if (restoreModel && typeof config?.model === 'string')
        model = config.model;
      if (restoreEffort && typeof config?.model_reasoning_effort === 'string')
        effort = config.model_reasoning_effort;
      if (
        restoreTier &&
        (typeof config?.service_tier === 'string' ||
          config?.service_tier === null)
      )
        serviceTier = config.service_tier;
      if (
        (restoreModel && model === undefined) ||
        (restoreEffort && effort === undefined)
      ) {
        const lookupModel =
          model ?? (modelChanged ? undefined : previous?.model);
        const entry = (await this.#models(server)).find((entry) =>
          lookupModel === undefined
            ? entry.isDefault === true
            : (entry.model ?? entry.id) === lookupModel,
        );
        const name = entry?.model ?? entry?.id;
        if (restoreModel && typeof name === 'string') model ??= name;
        if (restoreEffort && typeof entry?.defaultReasoningEffort === 'string')
          effort ??= entry.defaultReasoningEffort;
      }
    }
    return { model, effort, serviceTier };
  }

  readonly #listeners = new WeakMap<
    AppServer,
    Map<string, (frame: ServerFrame) => void>
  >();

  acceptsSession(id: string, tools: readonly AgentTool[]) {
    const prefix = sessionPrefix(describeTools(tools));
    return prefix ? id.startsWith(prefix) : !id.startsWith('tools:');
  }

  async #thread(
    request: Pick<
      AgentRequest,
      | 'model'
      | 'purpose'
      | 'sandbox'
      | 'serviceTier'
      | 'signal'
      | 'thinking'
      | 'workdir'
    >,
    resumeSessionId?: string,
    dynamicTools?: ReturnType<typeof describeTools>,
  ) {
    request.signal.throwIfAborted();
    if (!this.#lifecycle) await this.start();
    const server = await this.#connect();
    const signal = AbortSignal.any([request.signal, server.signal]);
    signal.throwIfAborted();
    const { workdir } = request;
    const { model, effort, serviceTier } = await this.#turnSettings(
      server,
      request,
      resumeSessionId,
    );
    const summarize = request.purpose === 'summary';
    const scope = request.sandbox;
    const { support, windows } = await this.#inspection!;
    const window = await this.#window(
      server,
      windows,
      model,
      workdir,
      resumeSessionId,
    );
    signal.throwIfAborted();
    const compaction = codexCompactionConfig(
      support,
      this.#options.asyncCompaction === true,
      this.#options.compactAt ?? defaultCompactAt,
      window,
    );
    // With a gateway execution scope, Codex gets no native execution environment:
    // commands run only through gateway tools inside the scope's sandbox.
    const scoped = scope
      ? {
          sandbox: 'read-only',
          runtimeWorkspaceRoots: [workdir],
          environments: [],
        }
      : undefined;
    const threadOptions = {
      cwd: workdir,
      model,
      serviceTier,
      approvalPolicy: scope ? 'never' : approvalPolicy,
      approvalsReviewer,
      ...(scoped ?? { sandbox: summarize ? 'read-only' : 'workspace-write' }),
      config: {
        model_reasoning_effort: effort,
        ...compaction.config,
        ...(scope
          ? { project_doc_max_bytes: 0 }
          : {
              sandbox_workspace_write: {
                writable_roots: [],
                network_access: false,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
              },
            }),
        shell_environment_policy: {
          inherit: scope ? 'none' : 'core',
          set: scope
            ? { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }
            : undefined,
          ignore_default_excludes: false,
        },
      },
    };
    const result = resumeSessionId
      ? await server.request('thread/resume', {
          ...threadOptions,
          threadId: resumeSessionId,
          excludeTurns: true,
        })
      : await server.request('thread/start', {
          ...threadOptions,
          ephemeral: summarize || undefined,
          dynamicTools: dynamicTools?.length ? dynamicTools : undefined,
        });
    signal.throwIfAborted();
    const threadId = asRecord(result.thread).id;
    if (
      typeof threadId !== 'string' ||
      (resumeSessionId && threadId !== resumeSessionId)
    )
      throw new Error('Codex returned an invalid thread ID');
    const reportedTier = result.serviceTier;
    const resolvedModel =
      typeof result.model === 'string' ? result.model : model;
    const resolvedEffort =
      typeof result.reasoningEffort === 'string'
        ? result.reasoningEffort
        : effort;
    this.#updateThreadContext(server, threadId, {
      model: resolvedModel,
      effort: resolvedEffort,
      requestedModel: request.model,
      requestedServiceTier: request.serviceTier,
      requestedThinking: request.thinking,
      serviceTier:
        serviceTier !== undefined
          ? serviceTier
          : typeof reportedTier === 'string' || reportedTier === null
            ? reportedTier
            : undefined,
      window,
    });
    return {
      server,
      signal,
      threadId,
      model,
      effort,
      serviceTier,
      resolvedModel,
      resolvedEffort,
      summarize,
      compaction,
      window,
    };
  }

  async compact(request: AgentCompactRequest): Promise<AgentCompactResult> {
    const nativeId = nativeSessionId(request.sessionId);
    const { server, signal, threadId } = await this.#thread(request, nativeId);
    const listeners = this.#listeners.get(server)!;
    if (listeners.has(threadId))
      throw new Error('Codex thread already has an active turn');

    const compactions = new TurnCompactions(
      this.#threadContexts.get(server)?.get(threadId)?.tokens,
    );
    const frames = new TurnFrames();
    listeners.set(threadId, frames.push);
    let started = false;
    let complete = false;
    let turnId: string | undefined;
    let result: AgentCompactResult = { status: 'skipped' };
    try {
      signal.throwIfAborted();
      try {
        await server.request('thread/compact/start', { threadId });
        started = true;
      } catch (error) {
        if (error instanceof RpcError && error.code === -32601)
          return { status: 'unsupported' };
        throw error;
      }
      for (;;) {
        const frame = await frames.next(signal);
        if (frame.id !== undefined) {
          await server.reject(frame.id);
          continue;
        }
        const turn = asRecord(frame.params.turn);
        if (frame.method === 'turn/started' && typeof turn.id === 'string')
          turnId ??= turn.id;
        if (frame.method === 'turn/completed' && turnId && turn.id === turnId) {
          complete = true;
          if (turn.status !== 'completed')
            throw new Error('Codex compaction turn failed');
          return result;
        }
        if (turnId && frame.params.turnId === turnId) {
          const details = compactions.observe(frame);
          if (details) result = { ...details, status: 'compacted' };
        }
      }
    } finally {
      listeners.delete(threadId);
      if (started && !complete && !server.signal.aborted) {
        if (turnId) {
          await server
            .request('turn/interrupt', { threadId, turnId }, 5_000)
            .catch(() => server.fail('Codex could not interrupt compaction'));
        } else
          server.fail('Codex compaction stopped before receiving a turn ID');
      }
    }
  }

  async *run(request: AgentRequest, io: AgentIO): AsyncIterable<AgentEvent> {
    const { workdir, sandbox: scope } = request;
    const dynamicTools = describeTools(request.tools);
    const stamp = sessionPrefix(dynamicTools);
    const resumeSessionId =
      request.resumeSessionId &&
      this.acceptsSession(request.resumeSessionId, request.tools)
        ? request.resumeSessionId.slice(stamp.length)
        : undefined;
    const {
      server,
      signal,
      threadId,
      model,
      effort,
      serviceTier,
      resolvedModel,
      resolvedEffort,
      summarize,
      compaction,
      window,
    } = await this.#thread(request, resumeSessionId, dynamicTools);
    const listeners = this.#listeners.get(server)!;
    if (listeners.has(threadId))
      throw new Error('Codex thread already has an active turn');

    const frames = new TurnFrames();
    const output = new TurnOutput(
      new Set(request.tools.map(({ name }) => toolWireName(name))),
    );
    const compactions = new TurnCompactions(
      this.#threadContexts.get(server)?.get(threadId)?.tokens,
    );
    listeners.set(threadId, frames.push);
    let turnId: string | undefined;
    let complete = false;
    let interruption: Promise<unknown> | undefined;
    const interrupt = () => {
      if (turnId && !complete && !server.signal.aborted) {
        interruption ??= server
          .request('turn/interrupt', { threadId, turnId }, 5_000)
          .catch(() => server.fail('Codex could not interrupt an active turn'));
      }
    };
    request.signal.addEventListener('abort', interrupt, { once: true });
    try {
      const started = await server.request('turn/start', {
        threadId,
        cwd: workdir,
        model,
        effort,
        serviceTier,
        approvalPolicy: scope ? 'never' : approvalPolicy,
        approvalsReviewer,
        ...(scope
          ? {
              runtimeWorkspaceRoots: [workdir],
              environments: [],
              sandboxPolicy: { type: 'readOnly', networkAccess: false },
            }
          : {
              sandboxPolicy: summarize
                ? { type: 'readOnly', networkAccess: false }
                : {
                    type: 'workspaceWrite',
                    writableRoots: [workdir],
                    networkAccess: false,
                    excludeTmpdirEnvVar: true,
                    excludeSlashTmp: true,
                  },
            }),
        input: [
          {
            type: 'text',
            text: renderContext(request.context, resumeSessionId !== undefined),
            text_elements: [],
          },
          ...(request.images ?? []).flatMap(({ data, mime, source }) => [
            ...(source
              ? [
                  {
                    type: 'text',
                    text: JSON.stringify(source),
                    text_elements: [],
                  },
                ]
              : []),
            { type: 'image', url: `data:${mime};base64,${data}` },
          ]),
        ],
      });
      const id = asRecord(started.turn).id;
      if (typeof id !== 'string')
        throw new Error('Codex returned an invalid turn ID');
      turnId = id;
      signal.throwIfAborted();
      yield { type: 'sessionId', sessionId: stamp + threadId };
      const turn = asRecord(started.turn);
      const activeModel =
        typeof turn.model === 'string'
          ? turn.model
          : typeof started.model === 'string'
            ? started.model
            : resolvedModel;
      const activeEffort =
        typeof turn.reasoningEffort === 'string'
          ? turn.reasoningEffort
          : typeof started.reasoningEffort === 'string'
            ? started.reasoningEffort
            : resolvedEffort;
      signal.throwIfAborted();
      if (activeModel)
        yield { type: 'model', model: activeModel, reasoning: activeEffort };
      for (;;) {
        const frame = await frames.next(signal);
        if (frame.method === 'turn/completed') {
          const turn = asRecord(frame.params.turn);
          if (turn.id !== turnId) continue;
          complete = true;
          if (turn.status !== 'completed') {
            const info = asRecord(turn.error).codexErrorInfo;
            const tag =
              typeof info === 'string' ? info : Object.keys(asRecord(info))[0];
            throw new Error(
              `Codex turn ${turn.status === 'interrupted' ? 'interrupted' : 'failed'}${tag && /^[a-zA-Z]+$/.test(tag) ? ` (${tag})` : ''}`,
            );
          }
          const final = output.final(turn);
          if (final !== undefined) yield { type: 'text.final', text: final };
          return;
        }
        if (frame.id !== undefined) {
          if (
            frame.method === 'item/tool/call' &&
            frame.params.turnId === turnId
          ) {
            const name = frame.params.tool;
            const tool = request.tools.find(
              (tool) => toolWireName(tool.name) === name,
            );
            let result: string;
            let success = false;
            try {
              if (!tool) throw new Error('Tool is unavailable');
              result =
                JSON.stringify(
                  await tool.run(
                    frame.params.arguments,
                    undefined,
                    typeof frame.params.callId === 'string'
                      ? frame.params.callId
                      : undefined,
                  ),
                ) ?? 'null';
              success = true;
            } catch (error) {
              result =
                error instanceof ToolFailure
                  ? error.message
                  : 'The framework rejected or could not complete this tool call.';
            }
            await server.answer(frame.id, {
              success,
              contentItems: [{ type: 'inputText', text: result }],
            });
            continue;
          }
          const approval =
            frame.params.turnId === turnId && output.approval(frame, workdir);
          if (!approval) {
            await server.reject(frame.id);
            continue;
          }
          yield { type: 'approval.requested', request: approval };
          let allowed = false;
          try {
            const callId =
              typeof frame.params.itemId === 'string'
                ? frame.params.itemId
                : undefined;
            allowed = !scope && (await approve(io, approval, signal, callId));
            if (!allowed && callId) io.reportToolDenial?.(callId);
          } finally {
            if (!server.signal.aborted)
              await replyToApproval(server, frame, allowed);
          }
        } else if (frame.params.turnId === turnId) {
          const details = compactions.observe(frame);
          if (details) {
            // Item notifications carry no trigger. Codex also bounds the native limit
            // at 90% of the model window, even when the configured limit is higher.
            const nativeLimit = Math.min(
              compaction.config.model_auto_compact_token_limit,
              (window ?? Infinity) * 0.9,
              this.#threadContexts.get(server)?.get(threadId)?.window ??
                Infinity,
            );
            const trigger =
              compaction.mode === 'async' &&
              (details.tokensBefore ?? Infinity) < nativeLimit
                ? 'async'
                : compaction.mode === 'post-turn' && output.hasFinalMessage
                  ? 'post-turn'
                  : 'native';
            yield { ...details, trigger, type: 'compaction' };
          }
          yield* output.events(frame);
        }
      }
    } finally {
      request.signal.removeEventListener('abort', interrupt);
      interrupt();
      listeners.delete(threadId);
      await interruption;
    }
  }
}

function describeTools(tools: readonly AgentTool[]) {
  const specs = tools.map((tool) => ({
    type: 'function',
    name: toolWireName(tool.name),
    description: tool.description,
    inputSchema: tool.schema,
  }));
  if (new Set(specs.map(({ name }) => name)).size !== specs.length)
    throw new Error('Conflicting Codex tool names');
  return specs;
}

function sessionPrefix(tools: ReturnType<typeof describeTools>) {
  return tools.length
    ? `tools:${createHash('sha256').update(JSON.stringify(tools)).digest('hex')}:`
    : '';
}

function nativeSessionId(sessionId: string) {
  return sessionId.replace(/^tools:[a-f0-9]{64}:/, '');
}

export default definePlugin({
  name: 'agent-codex',
  agents: {
    codex: Object.assign(
      (config: AgentInstanceConfig, { workspace }: PluginFactoryContext) =>
        new CodexAgent({}, config.id, {
          ...codexLocation(config, workspace),
          asyncCompaction: config.options?.asyncCompaction === true,
          compactAt: config.compactAt,
          images: imageLimits(defaultImageLimits, config.options),
        }),
      { implementation },
    ),
  },
  checks: codexChecks,
  credentialNames: () => [],
  managedRuntimePaths: (workspace, entry) => {
    const version = pinnedVersion(entry);
    return version ? [packageDirectory(workspace, version)] : [];
  },
  install: installCodex,
  setupSteps: codexSetup,
});
