import type {
  Options,
  query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentConnector,
  AgentEvent,
  AgentIO,
  AgentRequest,
  ContextBlock,
} from '@tsugimori/plugin-sdk';

import { definePlugin } from '@tsugimori/plugin-sdk';
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
  readonly #home?: string;
  readonly #token?: string;
  readonly #active = new Set<AbortController>();

  constructor(
    { query }: ClaudeDependencies,
    id: string,
    apiKey: string | null = process.env.ANTHROPIC_API_KEY ?? null,
    auth?: { home: string; token?: string },
  ) {
    this.id = id;
    this.#query = query;
    this.#apiKey = apiKey ?? undefined;
    this.#home = auth?.home;
    this.#token = auth?.token;
  }

  stop() {
    for (const controller of this.#active) controller.abort();
    return Promise.resolve();
  }

  async *run(request: AgentRequest, io: AgentIO): AsyncIterable<AgentEvent> {
    request.signal.throwIfAborted();
    const abortController = new AbortController();
    const abort = () => abortController.abort(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
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
        },
        permissionMode: 'default',
        canUseTool: toolPermission(
          workdir,
          io,
          signal,
          new Set(registered?.allowedTools),
          request.sandbox?.denyRead,
        ),
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
      let sessionId: string | undefined;
      let lastText = '';
      const tools = new Map<string, string>();
      for await (const event of query({ prompt: render(context), options })) {
        signal.throwIfAborted();
        if (event.session_id && sessionId !== event.session_id) {
          sessionId = event.session_id;
          yield { type: 'sessionId', sessionId };
        }
        if (
          event.type === 'stream_event' &&
          event.parent_tool_use_id === null
        ) {
          const { event: part } = event;
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
        } else if (event.type === 'result') {
          yield {
            type: 'usage',
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
          };
          if (event.subtype !== 'success' || event.is_error)
            throw new Error(`Claude query failed (${event.subtype})`);
          const text = event.result || lastText;
          if (text) yield { type: 'text.final', text };
          return;
        }
      }
      signal.throwIfAborted();
      throw new Error('Claude query ended before a result');
    } finally {
      abortController.abort();
      request.signal.removeEventListener('abort', abort);
      this.#active.delete(abortController);
    }
  }
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
      return new ClaudeAgent({}, config.id, auth.apiKey ?? null, auth);
    },
  },
});
