import type {
  AgentConnector,
  AgentEvent,
  AgentIO,
  AgentRequest,
  AgentTool,
} from '@tsugimori/plugin-sdk';

import { definePlugin, ToolFailure, toolWireName } from '@tsugimori/plugin-sdk';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { ServerFrame, SpawnServer } from './app-server.ts';

import { AppServer, asRecord } from './app-server.ts';
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
  renderContext,
  replyToApproval,
  TurnFrames,
  TurnOutput,
} from './turn.ts';

interface CodexOptions {
  codexHome?: string;
  command?: string;
}

interface CodexDependencies {
  spawn?: SpawnServer;
}

export class CodexAgent implements AgentConnector {
  readonly id: string;
  readonly kind = 'codex';
  readonly loop = 'external';
  readonly #deps: CodexDependencies;
  readonly #options: CodexOptions;
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

  async start() {
    this.#lifecycle ??= new AbortController();
    await this.#connect();
  }

  async stop() {
    const connection = this.#connection;
    const server = this.#server;
    this.#lifecycle?.abort();
    this.#lifecycle = undefined;
    this.#connection = undefined;
    this.#server = undefined;
    this.#restartAt = 0;
    this.#backoff = 250;
    const closed = server?.close();
    await Promise.allSettled([connection, closed]);
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
    this.#listeners.set(server, listeners);
    server.on('frame', (frame) => {
      const { threadId } = frame.params;
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

  readonly #listeners = new WeakMap<
    AppServer,
    Map<string, (frame: ServerFrame) => void>
  >();

  acceptsSession(id: string, tools: readonly AgentTool[]) {
    const prefix = sessionPrefix(describeTools(tools));
    return prefix ? id.startsWith(prefix) : !id.startsWith('tools:');
  }

  async *run(request: AgentRequest, io: AgentIO): AsyncIterable<AgentEvent> {
    request.signal.throwIfAborted();
    if (!this.#lifecycle) await this.start();
    const server = await this.#connect();
    const signal = AbortSignal.any([request.signal, server.signal]);
    signal.throwIfAborted();
    const { workdir } = request;
    const dynamicTools = describeTools(request.tools);
    const stamp = sessionPrefix(dynamicTools);
    const resumeSessionId =
      request.resumeSessionId &&
      this.acceptsSession(request.resumeSessionId, request.tools)
        ? request.resumeSessionId.slice(stamp.length)
        : undefined;
    const model = request.model === 'default' ? undefined : request.model;
    const summarize = request.purpose === 'summary';
    const scope = request.sandbox;
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
          dynamicTools: dynamicTools.length ? dynamicTools : undefined,
        });
    signal.throwIfAborted();
    const threadId = asRecord(result.thread).id;
    if (
      typeof threadId !== 'string' ||
      (resumeSessionId && threadId !== resumeSessionId)
    )
      throw new Error('Codex returned an invalid thread ID');
    const listeners = this.#listeners.get(server)!;
    if (listeners.has(threadId))
      throw new Error('Codex thread already has an active turn');

    const frames = new TurnFrames();
    const output = new TurnOutput();
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
      return new CodexAgent({}, config.id, codexLocation(config, workspace));
    },
  },
  checks: codexChecks,
  credentialNames: () => [],
  install: installCodex,
  setupSteps: codexSetup,
});
