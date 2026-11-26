import type {
  AgentCompactRequest,
  AgentCompactResult,
  AgentConnector,
  AgentEvent,
  AgentIO,
  AgentRequest,
  AgentTool,
} from '@tsugimori/plugin-sdk';

import {
  defaultCompactAt,
  definePlugin,
  ToolFailure,
  toolWireName,
} from '@tsugimori/plugin-sdk';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { ServerFrame, SpawnServer } from './app-server.ts';

import { AppServer, asRecord, RpcError } from './app-server.ts';
import {
  bundledContextWindows,
  codexCompactionConfig,
  codexCompactionSupport,
  contextWindow,
} from './compaction.ts';
import { readCodexDefaults } from './defaults.ts';
import { installCodex } from './install.ts';
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
}

interface CodexDependencies {
  inspect?(args: string[]): Promise<string | undefined>;
  spawn?: SpawnServer;
}

interface ThreadContext {
  tokens?: number;
  window?: number;
}

const execFileAsync = promisify(execFile);

export class CodexAgent implements AgentConnector {
  readonly id: string;
  readonly kind = 'codex';
  readonly loop = 'external';
  readonly #deps: CodexDependencies;
  readonly #options: CodexOptions;
  readonly #threadContexts = new WeakMap<
    AppServer,
    Map<string, ThreadContext>
  >();
  readonly #defaultModels = new WeakMap<
    AppServer,
    Promise<string | undefined>
  >();
  #inspection?: ReturnType<CodexAgent['inspect']>;
  #lifecycle?: AbortController;
  #connection?: Promise<AppServer>;
  #server?: AppServer;
  #restartAt = 0;
  #backoff = 250;

  constructor(deps: CodexDependencies, id: string, options: CodexOptions = {}) {
    this.id = id;
    this.#deps = deps;
    this.#options = options;
  }

  describeDefaults() {
    return readCodexDefaults(this.#options.codexHome);
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
    const stop = () => server.fail('Codex agent stopped');
    signal.addEventListener('abort', stop, { once: true });
    server.signal.addEventListener(
      'abort',
      () => signal.removeEventListener('abort', stop),
      { once: true },
    );
    // Route server requests centrally so inactive threads never leave a prompt hanging.
    const listeners = new Map<string, (frame: ServerFrame) => void>();
    const contexts = new Map<string, ThreadContext>();
    this.#listeners.set(server, listeners);
    this.#threadContexts.set(server, contexts);
    server.on('frame', (frame) => {
      const { threadId } = frame.params;
      if (
        typeof threadId === 'string' &&
        frame.method === 'thread/tokenUsage/updated'
      ) {
        const { totalTokens } = lastUsage(frame.params);
        const window = contextWindow(
          asRecord(frame.params.tokenUsage).modelContextWindow,
        );
        if (typeof totalTokens === 'number' || window !== undefined) {
          const previous = contexts.get(threadId);
          contexts.delete(threadId);
          contexts.set(threadId, {
            tokens:
              typeof totalTokens === 'number' ? totalTokens : previous?.tokens,
            window: window ?? previous?.window,
          });
          if (contexts.size > 256)
            contexts.delete(contexts.keys().next().value!);
        }
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
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
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
    const observed = threadId
      ? this.#threadContexts.get(server)?.get(threadId)?.window
      : undefined;
    if (model) return windows.get(model) ?? observed;
    if (observed !== undefined) return observed;
    if (!windows.size) return;

    try {
      const result = await server.request('config/read', {
        cwd: workdir,
        includeLayers: false,
      });
      const config = asRecord(result.config);
      const configured = contextWindow(config.model_context_window);
      if (configured !== undefined) return configured;
      if (typeof config.model === 'string') return windows.get(config.model);
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
    }

    let defaultModel = this.#defaultModels.get(server);
    if (!defaultModel) {
      defaultModel = server
        .request('model/list', {})
        .then(({ data }) => {
          if (!Array.isArray(data)) return;
          const entry = data
            .map(asRecord)
            .find(({ isDefault }) => isDefault === true);
          const name = entry?.model ?? entry?.id;
          if (typeof name === 'string') return name;
        })
        .catch((error: unknown) => {
          if (!(error instanceof RpcError)) throw error;
          return undefined;
        });
      this.#defaultModels.set(server, defaultModel);
    }
    const name = await defaultModel;
    return name === undefined ? undefined : windows.get(name);
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
      'model' | 'purpose' | 'sandbox' | 'signal' | 'workdir'
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
    const model = request.model === 'default' ? undefined : request.model;
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
      approvalPolicy: scope ? 'never' : approvalPolicy,
      approvalsReviewer,
      ...(scoped ?? { sandbox: summarize ? 'read-only' : 'workspace-write' }),
      config: {
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
    return { server, signal, threadId, model, summarize, compaction, window };
  }

  async compact(request: AgentCompactRequest): Promise<AgentCompactResult> {
    const nativeId = request.sessionId.replace(/^tools:[a-f0-9]{64}:/, '');
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
    const { server, signal, threadId, model, summarize, compaction, window } =
      await this.#thread(request, resumeSessionId, dynamicTools);
    const listeners = this.#listeners.get(server)!;
    if (listeners.has(threadId))
      throw new Error('Codex thread already has an active turn');

    const frames = new TurnFrames();
    const output = new TurnOutput();
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
        effort: request.thinking,
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
        ],
      });
      const id = asRecord(started.turn).id;
      if (typeof id !== 'string')
        throw new Error('Codex returned an invalid turn ID');
      turnId = id;
      signal.throwIfAborted();
      yield { type: 'sessionId', sessionId: stamp + threadId };
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
                JSON.stringify(await tool.run(frame.params.arguments)) ??
                'null';
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
            allowed = !scope && (await approve(io, approval, signal));
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

export default definePlugin({
  name: 'agent-codex',
  agents: {
    codex(config, { workspace }) {
      return new CodexAgent({}, config.id, {
        ...codexLocation(config, workspace),
        asyncCompaction: config.options?.asyncCompaction === true,
        compactAt: config.compactAt,
      });
    },
  },
  checks: codexChecks,
  credentialNames: () => [],
  install: installCodex,
  setupSteps: codexSetup,
});
