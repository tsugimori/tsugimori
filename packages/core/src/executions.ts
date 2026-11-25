import type {
  AgentInstanceConfig,
  ChatRef,
  ExecBackend,
  ExecScope,
  ExecSession,
  ToolContext,
  ToolDefinition,
} from '@tsugimori/plugin-sdk';
import type { Store, WorkspaceSettings } from '@tsugimori/storage';

import { agentHome, ToolFailure } from '@tsugimori/plugin-sdk';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { writeWorkspaceSettings } from './workspace-files.ts';

const string = { type: 'string', minLength: 1 };
const setting = { ...string, maxLength: 128 };
const file = { ...string, maxLength: 1024 };
const port = { type: 'integer', minimum: 1, maximum: 65_535 };
function object(properties: Record<string, unknown>, required: string[]) {
  return { type: 'object', additionalProperties: false, properties, required };
}

export function sandboxScope(
  workspace: string,
  workdir: string,
  denyRead: string[] = [],
  agents: readonly AgentInstanceConfig[] = [],
): ExecScope {
  const home = homedir();
  return {
    workdir,
    writable: [workdir],
    network: 'none',
    denyRead: [
      ...['.ssh', '.cloudflared', '.codex', '.claude', '.aws'].map((name) =>
        join(home, name),
      ),
      join(workspace, '.env'),
      join(workspace, 'agents'),
      ...agents.map(({ id }) => agentHome(workspace, id)),
      ...agents.flatMap((agent) =>
        ['codexHome', 'claudeHome'].flatMap((key) => {
          const value = agent.options?.[key];
          return typeof value === 'string'
            ? [agentHome(workspace, agent.id, value)]
            : [];
        }),
      ),
      ...['.git', '.env', 'agents.json', '.codex', '.claude'].map((name) =>
        join(workdir, name),
      ),
      ...denyRead.map((path) =>
        path.startsWith('~/')
          ? resolve(home, path.slice(2))
          : resolve(workspace, path),
      ),
    ],
  };
}

interface Dependencies {
  backend(): ExecBackend | undefined;
  invalidateSession(chat: ChatRef): void;
  recordWorkspace(): boolean;
  scope(workdir: string): ExecScope;
  store: Store;
  workdir(chat: ChatRef): Promise<string>;
}

type SessionEntry = {
  adapterId: string;
  scope: ExecScope;
  session: Promise<ExecSession>;
};

export class Executions {
  readonly #deps: Dependencies;
  readonly #sessions = new Map<string, SessionEntry>();
  #closed = false;

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  async #get(chat: ChatRef, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#closed) throw new ToolFailure('Execution is stopping');
    const backend = this.#deps.backend();
    if (!backend) throw new ToolFailure('No execution backend is configured');
    const workdir = await this.#deps.workdir(chat);
    signal.throwIfAborted();
    if (this.#closed) throw new ToolFailure('Execution is stopping');
    const scope = this.#deps.scope(workdir);
    const key = JSON.stringify([chat.adapterId, chat.chatId]);
    const current = this.#sessions.get(key);
    if (current) {
      if (JSON.stringify(current.scope) !== JSON.stringify(scope))
        throw new ToolFailure(
          'Sandbox permissions changed. Stop this chat execution session first.',
        );
      return current.session;
    }
    const session = backend.start(scope);
    this.#sessions.set(key, { adapterId: chat.adapterId, scope, session });
    try {
      return await session;
    } catch (error) {
      if (this.#sessions.get(key)?.session === session)
        this.#sessions.delete(key);
      throw error;
    }
  }

  async endpoint(chat: ChatRef, port: number) {
    const found = this.#sessions.get(
      JSON.stringify([chat.adapterId, chat.chatId]),
    );
    if (!found)
      throw new ToolFailure('No running execution session in this chat');
    return (await found.session).exposePort(port);
  }

  async stop(adapters?: ReadonlySet<string>) {
    if (!adapters) this.#closed = true;
    await Promise.allSettled(
      [...this.#sessions.entries()]
        .filter(([, entry]) => !adapters || adapters.has(entry.adapterId))
        .map(([key, entry]) => this.#stopEntry(key, entry)),
    );
  }

  async #stopEntry(key: string, entry: SessionEntry) {
    if (this.#sessions.get(key) !== entry) return;
    this.#sessions.delete(key);
    const [session] = await Promise.allSettled([entry.session]);
    if (session.status === 'fulfilled') await session.value.stop();
  }

  workspaceTools(): ToolDefinition[] {
    return [
      {
        name: 'workspace.configure',
        description:
          'Set this chat’s default agent, model or thinking after linked owner approval; omit fields to clear previous defaults.',
        schema: object(
          { agentId: setting, model: setting, thinking: setting },
          [],
        ),
        permission: {
          action: 'workspace.configure',
          describe: (args) =>
            `Requested chat settings: ${JSON.stringify(args)}`,
          resource: (args, { chat }) => ({
            type: 'project',
            id: createHash('sha256')
              .update(JSON.stringify([chat, args]))
              .digest('hex'),
          }),
        },
        run: async (args, task) => {
          task.signal.throwIfAborted();
          const settings = args as WorkspaceSettings;
          const workdir = await this.#deps.workdir(task.chat);
          await writeWorkspaceSettings(
            workdir,
            JSON.stringify(settings, null, 2) + '\n',
            task.principal.userId,
            this.#deps.recordWorkspace(),
          );
          this.#deps.store.setWorkspaceSettings(task.chat, settings);
          this.#deps.store.clearSession(task.chat);
          this.#deps.invalidateSession(task.chat);
          return settings;
        },
      },
    ];
  }

  tools(): ToolDefinition[] {
    const session = (task: ToolContext) => this.#get(task.chat, task.signal);
    return [
      {
        name: 'exec.run',
        description:
          'Run a command in the chat sandbox. Supply backgroundPort to start a persistent HTTP service listening on that port inside the sandbox. Use argv instead of a shell command string.',
        schema: object(
          {
            cmd: {
              type: 'array',
              minItems: 1,
              maxItems: 128,
              items: { type: 'string', maxLength: 4096 },
            },
            timeoutMs: { type: 'integer', minimum: 1, maximum: 300_000 },
            backgroundPort: port,
          },
          ['cmd'],
        ),
        run: async (args, task) => {
          const { cmd, timeoutMs, backgroundPort } = args as {
            backgroundPort?: number;
            cmd: string[];
            timeoutMs?: number;
          };
          return (await session(task)).run(cmd, {
            timeoutMs,
            backgroundPort,
            signal: task.signal,
          });
        },
      },
      {
        name: 'exec.read',
        description:
          'Read a UTF-8 file in the conversation workspace, including skill files.',
        schema: object({ path: file }, ['path']),
        run: async (args, task) =>
          Buffer.from(
            await (
              await session(task)
            ).readFile((args as { path: string }).path),
          ).toString('utf8'),
      },
      {
        name: 'exec.write',
        description:
          'Write a UTF-8 file inside the conversation workspace. Use workspace.configure for agent settings.',
        schema: object(
          { path: file, text: { type: 'string', maxLength: 1_000_000 } },
          ['path', 'text'],
        ),
        run: async (args, task) => {
          const { path, text } = args as { path: string; text: string };
          await (await session(task)).writeFile(path, Buffer.from(text));
          return { path };
        },
      },
      {
        name: 'exec.stop',
        description:
          'Stop this chat’s execution session and its background services.',
        schema: object({}, []),
        run: async (_args, task) => {
          const key = JSON.stringify([task.chat.adapterId, task.chat.chatId]);
          const entry = this.#sessions.get(key);
          if (entry) await this.#stopEntry(key, entry);
          return { stopped: !!entry };
        },
      },
    ];
  }
}
