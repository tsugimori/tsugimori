import type { Auth } from '@tsugimori/auth';
import type { ContextAssembler } from '@tsugimori/context';
import type {
  AgentIO,
  ApprovalRequest,
  ChatRef,
  ExecBackend,
  ExecScope,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  ToolContext,
  ToolDefinition,
} from '@tsugimori/plugin-sdk';
import type { Store, TaskRecord } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { approvalCallbackId } from '@tsugimori/auth';
import { containsMention } from '@tsugimori/scheduler';
import { randomUUID } from 'node:crypto';

import type { HookRunner, Logger } from './hooks.ts';
import type { Runtime } from './runtime.ts';
import type { BackgroundSummaries } from './summary.ts';
import type { TaskInput } from './supplements.ts';

import { untilAborted } from './abort.ts';
import { protectTools, runAgent } from './agent-run.ts';
import { describeError } from './errors.ts';
import { conversationId, DeliveryError, Outbound } from './outbound.ts';
import { Supplements } from './supplements.ts';
import { shouldTrigger } from './trigger.ts';
import { prepareWorkspace, recordWorkspace } from './workspace-files.ts';

interface TaskDependencies {
  auth: Auth;
  backend(): ExecBackend | undefined;
  context: ContextAssembler;
  hooks: HookRunner;
  log: Logger;
  outbound: Outbound;
  runtime: Runtime;
  scope(workdir: string): ExecScope;
  store: Store;
  summarize: BackgroundSummaries['enqueue'];
  tools: readonly ToolDefinition[];
  trace: Tracer;
}

type Work = {
  abort: AbortController;
  acceptsSupplements: boolean;
  adapter: PlatformAdapter;
  chat: ChatRef;
  execution?: Promise<void>;
  id: string;
  input: TaskInput;
  messageIds: Set<string>;
  route?: { agentId: string; model: string };
  sessionValid: boolean;
  supplements: Supplements;
  workdir?: string;
};

function chatKey({ adapterId, chatId }: ChatRef) {
  return JSON.stringify([adapterId, chatId]);
}

export class Tasks {
  readonly #deps: TaskDependencies;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #running = new Map<string, Work>();
  readonly #work = new Set<Work>();
  readonly #approvals = new Map<
    string,
    (result?: { approved: boolean; decidedBy: string }) => void
  >();

  constructor(deps: TaskDependencies) {
    this.#deps = deps;
  }

  dispatch(adapter: PlatformAdapter, chat: ChatRef, input: TaskInput) {
    const key = chatKey(chat);
    const running = this.#running.get(key);
    const { replyTo, messageId } = input.message;
    if (
      !input.scheduled &&
      running?.acceptsSupplements &&
      !running.abort.signal.aborted &&
      replyTo &&
      running.messageIds.has(replyTo)
    ) {
      running.messageIds.add(messageId);
      running.supplements.push(input);
      return;
    }
    const work: Work = {
      adapter,
      chat,
      input,
      id: randomUUID(),
      abort: new AbortController(),
      messageIds: new Set([messageId]),
      supplements: new Supplements(),
      acceptsSupplements: false,
      sessionValid: true,
    };
    const { store, trace, log } = this.#deps;
    store.createTask({
      ...chat,
      id: work.id,
      sourceMessageId: messageId,
      status: 'queued',
      agentId: null,
      model: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    });
    this.#work.add(work);
    const dequeued = trace.begin('task.queue', { ...chat, taskId: work.id });
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const tail = previous
      .then(async () => {
        dequeued();
        this.#running.set(key, work);
        work.execution = this.#execute(work);
        await work.execution;
      })
      .catch((error: unknown) => {
        log({
          level: 'error',
          event: 'task.dispatch_failed',
          taskId: work.id,
          error: describeError(error),
        });
      })
      .finally(() => {
        this.#running.delete(key);
        this.#work.delete(work);
        if (this.#queues.get(key) === tail) this.#queues.delete(key);
      });
    this.#queues.set(key, tail);
    if (input.scheduled) return tail.then(() => store.getTask(work.id)?.status);
  }

  async idle() {
    while (this.#queues.size) await Promise.all(this.#queues.values());
  }

  cancelSource(chat: ChatRef, messageId: string) {
    const key = chatKey(chat);
    for (const work of this.#work) {
      if (chatKey(work.chat) === key && work.messageIds.has(messageId)) {
        work.abort.abort();
      }
    }
  }

  async interrupt(adapters: ReadonlySet<string>, agents: ReadonlySet<string>) {
    const active: Promise<void>[] = [];
    for (const work of this.#work) {
      if (
        adapters.has(work.chat.adapterId) ||
        (work.route && agents.has(work.route.agentId))
      ) {
        work.abort.abort();
        if (work.execution) active.push(work.execution);
      }
    }
    await Promise.allSettled(active);
    for (const id of agents) this.#deps.store.clearAgentSessions(id);
  }

  invalidateSession(chat: ChatRef) {
    const running = this.#running.get(chatKey(chat));
    if (running) running.sessionValid = false;
  }

  resolveApproval(
    result: { approved: boolean; decidedBy: string; id: string } | undefined,
  ) {
    if (result) this.#approvals.get(result.id)?.(result);
  }

  async #execute(work: Work) {
    const { store, auth, runtime, outbound, log } = this.#deps;
    const { chat, adapter, input, abort, id } = work;
    const { message } = input;
    const activity = new AbortController();
    const finish = (status: TaskRecord['status']) =>
      store.updateTask(id, { status, finishedAt: Date.now() });
    let ranAgent = false;
    let delivered = false;
    try {
      abort.signal.throwIfAborted();
      const transition = runtime.transition;
      if (transition) await untilAborted(abort.signal, () => transition);
      if (store.getMessage(chat, message.messageId)?.deleted) {
        finish('cancelled');
        return;
      }
      const owner = auth.isOwner({
        adapterId: chat.adapterId,
        userId: message.userId,
      });
      const current = store.getChat(chat);
      const allowlisted = current?.allowlisted ?? false;
      if (
        input.scheduled
          ? !owner && !allowlisted
          : !shouldTrigger(message, owner, allowlisted)
      ) {
        finish('cancelled');
        return;
      }
      const settings = store.getWorkspaceSettings(chat);
      const agentId = current?.agentId ?? settings?.agentId;
      const explicitUnavailable = runtime.unavailable(
        agentId ?? runtime.config.defaultAgent,
      );
      const selected =
        explicitUnavailable && (agentId || runtime.config.defaultAgent)
          ? undefined
          : (agentId && runtime.getAgent(agentId)) || runtime.defaultAgent();
      const model = selected
        ? (input.scheduled?.model ??
          current?.model ??
          settings?.model ??
          selected.config.model ??
          'default')
        : null;
      work.route =
        selected && model !== null
          ? { agentId: selected.agent.id, model }
          : undefined;
      store.updateTask(id, {
        agentId: work.route?.agentId ?? null,
        model,
        status: 'running',
        startedAt: Date.now(),
      });
      if (adapter.typing) {
        this.#deps.trace.span('outbound.typing', { ...chat, taskId: id }, () =>
          adapter.typing?.(
            message,
            AbortSignal.any([abort.signal, activity.signal]),
          ),
        );
      }
      if (!selected || model === null) {
        if (input.scheduled) finish('failed');
        else if (owner)
          await outbound.send(
            adapter,
            reply(message, explicitUnavailable || 'No agent is attached.'),
            {
              taskId: id,
              signal: abort.signal,
            },
          );
        else finish('completed');
        return;
      }

      ranAgent = true;
      const result = await this.#run(work, selected, model);
      work.acceptsSupplements = false;
      abort.signal.throwIfAborted();
      if (result.text) {
        const scheduled = input.scheduled;
        const output = scheduled
          ? { ...scheduled.target, text: scheduled.delayNote + result.text }
          : reply(message, result.text);
        if (
          scheduled &&
          !scheduled.allowTextMentions &&
          containsMention(result.text)
        )
          throw new Error('Scheduled response contains an unapproved mention');
        await outbound.send(adapter, output, {
          taskId: id,
          signal: abort.signal,
        });
        delivered = true;
      } else {
        finish('completed');
      }

      if (input.scheduled) {
        store.clearSession(chat);
      } else if (
        !abort.signal.aborted &&
        work.sessionValid &&
        result.sessionId
      ) {
        store.setSession({
          ...chat,
          agentId: selected.agent.id,
          model,
          sessionId: result.sessionId,
          throughSeq: input.seq,
          seenAfter: result.seenAfter,
        });
      } else {
        store.clearSession(chat);
      }
      if (!abort.signal.aborted)
        this.#deps.summarize({
          agentId: selected.agent.id,
          chat,
          model,
          taskId: id,
          throughSeq: Math.max(input.seq, ...result.seenAfter),
          workdir: result.workdir,
        });
    } catch (error) {
      if (ranAgent) store.clearSession(chat);
      if (!delivered && !(error instanceof DeliveryError))
        finish(abort.signal.aborted ? 'cancelled' : 'failed');
      if (!abort.signal.aborted || error instanceof DeliveryError) {
        log({
          level: 'error',
          event: 'task.failed',
          taskId: id,
          error: describeError(error),
        });
      }
    } finally {
      activity.abort();
      if (work.workdir && !runtime.disabled('workspace.record')) {
        try {
          await this.#deps.trace.span(
            'workspace.record',
            { ...chat, taskId: id },
            () => recordWorkspace(work.workdir!, message.userId),
          );
        } catch (error) {
          log({
            level: 'error',
            event: 'workspace.record_failed',
            taskId: id,
            error: describeError(error),
          });
        }
      }
      work.acceptsSupplements = false;
      store.cancelApprovals(id, Date.now());
    }
  }

  async #run(
    work: Work,
    selected: NonNullable<ReturnType<Runtime['getAgent']>>,
    model: string,
  ) {
    const { store, auth, context, runtime, trace, hooks } = this.#deps;
    const { chat, input, id, abort, supplements, adapter } = work;
    const { signal } = abort;
    const { agent, config } = selected;
    const task: ToolContext = {
      chat,
      signal,
      taskId: id,
      principal: { adapterId: chat.adapterId, userId: input.message.userId },
    };
    const attrs = { ...chat, taskId: id };
    const definitions = [
      ...this.#deps.tools.filter(
        ({ name }) =>
          !name.startsWith('exec.') || Boolean(this.#deps.backend()),
      ),
      ...(adapter.tools?.() ?? []),
    ];
    const storedSession = input.scheduled
      ? undefined
      : store.getSession(chat, agent.id, model);
    const session =
      storedSession &&
      agent.acceptsSession?.(storedSession.sessionId, definitions) !== false
        ? storedSession
        : undefined;
    if (!session && !input.scheduled) store.clearSession(chat);
    work.acceptsSupplements = true;
    const assembled = await trace.span('context.assembled', attrs, async () => {
      const blocks = await context.assemble({
        ...chat,
        kind: adapter.kind,
        ownerId: auth.owner(chat.adapterId),
        recentMessages: runtime.config.context.recentMessages,
        throughSeq: input.seq,
        afterSeq: session?.throughSeq,
        skipSeq: session?.seenAfter,
      });
      if (input.scheduled && !input.scheduled.allowTextMentions)
        blocks.push({
          source: 'system',
          trust: 'trusted',
          content:
            'Return the scheduled response without textual mentions. The platform adds any approved recipients separately.',
        });
      const workdir = await context.workdir(chat);
      await prepareWorkspace(workdir, !runtime.disabled('workspace.record'));
      work.workdir = workdir;
      return { blocks, workdir };
    });

    let blocks = assembled.blocks;
    let sessionId = session?.sessionId;
    const answers: string[] = [];
    for (;;) {
      signal.throwIfAborted();
      await hooks.emit('context.assembled', { task, context: blocks });
      await hooks.emit('agent.before', { task, agentId: agent.id, model });
      const pass = new AbortController();
      const passSignal = AbortSignal.any([signal, pass.signal]);
      const pending = new Set<Promise<boolean>>();
      const requestApproval: AgentIO['requestApproval'] = (request) => {
        const approval = this.#requestApproval(work, request, passSignal).then(
          Boolean,
        );
        pending.add(approval);
        void approval.then(
          () => pending.delete(approval),
          () => pending.delete(approval),
        );
        return approval;
      };
      const tools = protectTools(
        {
          trace,
          hooks,
          task: {
            ...task,
            signal: passSignal,
            approveSchedule: ({ address, approverId, description, id }) =>
              this.#requestApproval(
                work,
                {
                  action: 'schedule.create',
                  resource: { type: 'project', id },
                  description,
                },
                AbortSignal.any([passSignal, AbortSignal.timeout(120_000)]),
                { address, approverId },
              ),
          },
          requestApproval,
        },
        definitions,
      );
      try {
        const result = await runAgent(
          { ...this.#deps, task },
          agent,
          {
            model,
            thinking:
              store.getWorkspaceSettings(chat)?.thinking ?? config.thinking,
            exec: this.#deps.backend(),
            toolsDisabled: runtime.disabled('exec'),
            sandbox: this.#deps.scope(assembled.workdir),
            context: blocks,
            resumeSessionId: sessionId,
            signal,
            workdir: assembled.workdir,
            tools,
          },
          {
            requestApproval,
            supplements: supplements.stream(passSignal),
          },
        );
        if (result.text) answers.push(result.text);
        sessionId = result.sessionId ?? sessionId;
      } finally {
        pass.abort();
        await Promise.allSettled(pending);
      }
      const next = supplements.takePending();
      if (!next.length) {
        work.acceptsSupplements = false;
        break;
      }
      blocks = next.map(({ message }) => ({
        source: 'message',
        trust: auth.isOwner({
          adapterId: chat.adapterId,
          userId: message.userId,
        })
          ? 'owner'
          : 'member',
        content: message.text,
      }));
    }
    const seenAfter = [
      ...new Set([...(session?.seenAfter ?? []), ...supplements.delivered]),
    ].filter((seq) => seq > input.seq);
    return {
      text: answers.join('\n\n'),
      sessionId,
      seenAfter,
      workdir: assembled.workdir,
    };
  }

  async #requestApproval(
    work: Work,
    request: ApprovalRequest,
    signal: AbortSignal,
    schedule?: {
      address: Pick<OutboundMessage, 'chatId' | 'threadId'>;
      approverId?: string;
    },
  ) {
    const { auth, store, trace, outbound } = this.#deps;
    const { adapter, chat, input, id } = work;
    return trace.span('approval.request', { ...chat, taskId: id }, async () => {
      signal.throwIfAborted();
      const owner = auth.owner(chat.adapterId);
      if (
        !schedule &&
        owner &&
        auth.hasGrant(chat, input.message.userId, request)
      )
        return owner;
      if (!owner && !schedule?.approverId) return;
      const approvalChat = schedule
        ? {
            adapterId: chat.adapterId,
            chatId: conversationId(schedule.address),
          }
        : chat;
      const approval = auth.createApproval(
        approvalChat,
        id,
        input.message.userId,
        request,
        { approverId: schedule?.approverId, onceOnly: !!schedule },
      );
      const answer = Promise.withResolvers<
        { approved: boolean; decidedBy: string } | undefined
      >();
      this.#approvals.set(approval.id, answer.resolve);
      const cancel = () => answer.resolve(undefined);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const description = request.description
          ? `\n\n${request.description}`
          : '';
        const choices = schedule ? 'yes or no' : 'yes, always, or no';
        const text = `Approval requested for ${request.action} on ${JSON.stringify(request.resource)}. Reply directly to this message with ${choices}.${description}`;
        await outbound.send(
          adapter,
          {
            ...(schedule
              ? { ...schedule.address, text }
              : reply(input.message, text)),
            buttons: adapter.capabilities.inlineButtons
              ? [
                  {
                    id: approvalCallbackId(approval.id, 'once'),
                    label: 'Allow once',
                  },
                  ...(schedule
                    ? []
                    : [
                        {
                          id: approvalCallbackId(approval.id, 'always'),
                          label: 'Always',
                        },
                      ]),
                  {
                    id: approvalCallbackId(approval.id, 'deny'),
                    label: 'Deny',
                  },
                ]
              : undefined,
          },
          {
            signal,
            onReceipt: (messageId) =>
              store.linkApproval(approval.id, messageId),
          },
        );
        const result = await answer.promise;
        return result?.approved && !signal.aborted
          ? result.decidedBy
          : undefined;
      } finally {
        signal.removeEventListener('abort', cancel);
        this.#approvals.delete(approval.id);
        store.cancelApproval(approval.id, Date.now());
      }
    });
  }
}

export function reply(message: InboundMessage, text: string) {
  return {
    chatId: message.chatId,
    replyTo: message.messageId,
    threadId: message.threadId,
    text,
  };
}
