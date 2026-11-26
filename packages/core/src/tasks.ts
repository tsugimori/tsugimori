import type { Auth } from '@tsugimori/auth';
import type { ContextAssembler } from '@tsugimori/context';
import type {
  AgentConnector,
  AgentRequest,
  ApprovalRequest,
  ChatRef,
  ExecBackend,
  ExecScope,
  PlatformAdapter,
  ScheduleApproval,
  ScheduleApprovalRequest,
  ToolContext,
  ToolDefinition,
} from '@tsugimori/plugin-sdk';
import type {
  ApprovalContinuation,
  ApprovalRecord,
  ChatRecord,
  ScheduleChange,
  Store,
  TaskRecord,
} from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { approvalCallbackId } from '@tsugimori/auth';
import { pendingApprovalResult } from '@tsugimori/plugin-sdk';
import { containsMention, scheduleReplyStyle } from '@tsugimori/scheduler';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { HookRunner, Logger } from './hooks.ts';
import type { Runtime } from './runtime.ts';
import type { BackgroundSummaries } from './summary.ts';
import type { TaskInput } from './supplements.ts';

import { untilAborted } from './abort.ts';
import { protectTools, runAgent, sessionScope } from './agent-run.ts';
import { acceptsServiceTier, resolveAgentSetting } from './agent-settings.ts';
import { approvalMessages, approvalPrompt } from './approval-messages.ts';
import { describeError } from './errors.ts';
import { conversationId, DeliveryError, Outbound } from './outbound.ts';
import { Supplements } from './supplements.ts';
import { systemMessages } from './system-messages.ts';
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
  endForApproval: AbortController;
  execution?: Promise<void>;
  id: string;
  input: TaskInput;
  messageIds: Set<string>;
  pendingApprovalFallback?: string;
  progress: { stage: TaskStage; startedAt: number };
  route?: { agentId: string; model: string };
  sessionId?: string;
  sessionScopeChatId?: string | null;
  sessionScopeModel?: string;
  sessionValid: boolean;
  supplements: Supplements;
  workdir?: string;
};

export type TaskStage =
  | 'preparing'
  | 'context'
  | 'agent'
  | 'approval'
  | 'compaction'
  | 'delivery'
  | 'recording';

type ApprovalAnswer =
  | {
      approved: boolean;
      failureReason?: string;
      reaction?: Promise<boolean>;
      scheduleApplied?: boolean;
    }
  | 'expired'
  | 'timeout';

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
    {
      resolve(result?: ApprovalAnswer): void;
      signal: AbortSignal;
      work: Work;
    }
  >();

  constructor(deps: TaskDependencies) {
    this.#deps = deps;
  }

  status(chat: ChatRef) {
    const { store } = this.#deps;
    const key = chatKey(chat);
    const running = this.#running.get(key);
    const route = this.route(chat);
    const { agentId, selected } = route;
    const model = route.model.value ?? 'default';
    const perTurnModel = selected?.agent.settings?.perTurn?.includes('model');
    const activeSession =
      running?.sessionValid &&
      running.route?.agentId === agentId &&
      (perTurnModel || running.route?.model === model)
        ? running.sessionId
        : undefined;
    const storedSession =
      selected && agentId
        ? store.getSession(chat, agentId, perTurnModel ? undefined : model)
        : undefined;
    const sessionId = activeSession ?? storedSession?.sessionId;
    const scopeChatId = activeSession
      ? running?.sessionScopeChatId
      : storedSession?.scopeChatId;
    const scopeModel = activeSession
      ? running?.sessionScopeModel
      : storedSession?.model;
    let queued = running?.supplements.pendingCount ?? 0;
    for (const work of this.#work) {
      if (
        work !== running &&
        work.chat.adapterId === chat.adapterId &&
        work.chat.chatId === chat.chatId
      )
        queued++;
    }
    const progress = running?.progress;
    const waiting =
      running &&
      [...this.#approvals.values()].some(
        (approval) => approval.work === running && !approval.signal.aborted,
      );
    const sessionInfo = sessionId
      ? selected?.agent.describeSession?.(sessionId, {
          model,
          thinking: route.thinking.value,
          serviceTier: route.serviceTier.value,
        })
      : undefined;
    return {
      agentId,
      model,
      thinking: route.thinking.value,
      defaults: sessionInfo
        ? {
            ...selected?.defaults,
            ...(sessionInfo.model && { model: sessionInfo.model }),
            ...(sessionInfo.effort && { effort: sessionInfo.effort }),
          }
        : selected?.defaults,
      compactAt: selected?.config.compactAt,
      quota: selected?.agent.describeQuota?.(),
      serviceTier: route.serviceTier.value ?? sessionInfo?.serviceTier,
      sessionScope:
        sessionId && agentId && scopeModel
          ? sessionScope(
              { ...chat, chatId: scopeChatId ?? chat.chatId },
              agentId,
              scopeModel,
              sessionId,
            )
          : undefined,
      running:
        waiting && progress
          ? { ...progress, stage: 'approval' as const }
          : progress,
      queued,
    };
  }

  route(
    chat: ChatRef,
    current: ChatRecord | undefined = this.#deps.store.getChat(chat),
  ) {
    const { store, runtime } = this.#deps;
    const settings = store.getWorkspaceSettings(chat);
    const agentId = current?.agentId ?? settings?.agentId;
    const configuredId = agentId ?? runtime.config.defaultAgent;
    const unavailable = runtime.unavailable(configuredId);
    const selected =
      unavailable && configuredId
        ? undefined
        : (agentId && runtime.getAgent(agentId)) || runtime.defaultAgent();
    const bound =
      selected?.config ??
      runtime.config.agents.find(({ id }) => id === configuredId);
    const serviceTier = (tier: string | null | undefined) =>
      tier != null && (!selected || acceptsServiceTier(selected.agent, tier))
        ? tier
        : undefined;
    return {
      agentId: selected?.agent.id ?? agentId ?? bound?.id,
      model: resolveAgentSetting(current?.model, settings?.model, bound?.model),
      thinking: resolveAgentSetting(
        current?.thinking &&
          (!selected ||
            selected.agent.settings?.thinking?.includes(current.thinking))
          ? current.thinking
          : undefined,
        settings?.thinking,
        bound?.thinking,
      ),
      serviceTier: resolveAgentSetting(
        serviceTier(current?.serviceTier),
        undefined,
        serviceTier(bound?.serviceTier),
      ),
      selected,
      unavailable,
    };
  }

  dispatch(adapter: PlatformAdapter, chat: ChatRef, input: TaskInput) {
    const { store, trace, log } = this.#deps;
    chat = store.resolveChat(chat);
    const key = chatKey(chat);
    const running = this.#running.get(key);
    const { replyTo, messageId } = input.message;
    if (
      !input.compact &&
      !input.scheduled &&
      !input.message.migratedFromChatId &&
      running?.acceptsSupplements &&
      !running.input.message.migratedFromChatId &&
      !running.abort.signal.aborted &&
      replyTo &&
      running.messageIds.has(replyTo)
    ) {
      running.messageIds.add(messageId);
      running.supplements.push(input);
      return;
    }
    const createdAt = Date.now();
    const work: Work = {
      adapter,
      chat,
      input,
      id: randomUUID(),
      abort: new AbortController(),
      endForApproval: new AbortController(),
      messageIds: new Set([messageId]),
      supplements: new Supplements(),
      acceptsSupplements: false,
      progress: { stage: 'preparing', startedAt: createdAt },
      sessionValid: true,
    };
    store.createTask({
      ...chat,
      id: work.id,
      sourceChatId: input.message.migratedFromChatId,
      sourceMessageId: messageId,
      status: 'queued',
      agentId: null,
      model: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
    });
    this.#work.add(work);
    const dequeued = trace.begin('task.queue', { ...chat, taskId: work.id });
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const tail = previous
      .then(async () => {
        dequeued();
        work.progress.startedAt = Date.now();
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

  migrateChat(adapterId: string, chatId: string, newChatId: string) {
    const previous = this.#queues.get(chatKey({ adapterId, chatId }));
    if (!previous) return;
    const key = chatKey({ adapterId, chatId: newChatId });
    const tail = Promise.all([previous, this.#queues.get(key)]).then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    this.#queues.set(key, tail);
  }

  cancelSource(chat: ChatRef, messageId: string, sourceChatId?: string) {
    const { store } = this.#deps;
    this.cancelApprovals(chat, messageId, sourceChatId);
    const key = chatKey(chat);
    for (const work of this.#work) {
      if (
        chatKey(store.resolveChat(work.chat)) === key &&
        store.getTask(work.id)?.sourceChatId === (sourceChatId ?? null) &&
        work.messageIds.has(messageId)
      ) {
        work.abort.abort();
      }
    }
  }

  cancelApprovals(chat: ChatRef, messageId?: string, sourceChatId?: string) {
    const { store } = this.#deps;
    store.cancelChatApprovals(chat, Date.now(), messageId, sourceChatId);
    for (const approval of this.#approvals.values()) {
      if (
        chatKey(store.resolveChat(approval.work.chat)) === chatKey(chat) &&
        (messageId === undefined ||
          (approval.work.input.message.messageId === messageId &&
            store.getTask(approval.work.id)?.sourceChatId ===
              (sourceChatId ?? null)))
      )
        approval.resolve();
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
  }

  invalidateSession(chat: ChatRef) {
    const running = this.#running.get(chatKey(chat));
    if (running) running.sessionValid = false;
  }

  resolveApproval(id: string, result: ApprovalAnswer) {
    const approval = this.#approvals.get(id);
    if (!approval || approval.signal.aborted) return false;
    approval.resolve(result);
    return true;
  }

  async runApprovedTool(
    adapter: PlatformAdapter,
    approval: ApprovalRecord,
    source: TaskRecord,
  ) {
    const call = approval.continuation;
    if (call?.kind !== 'tool') return false;
    const tool = this.#toolDefinitions(adapter).find(
      ({ name, permission }) =>
        name === call.name && permission?.action === approval.action,
    );
    if (!tool) return false;
    const { adapterId, chatId } = source;
    const task: ToolContext = {
      chat: { adapterId, chatId },
      principal: { adapterId, userId: approval.requester },
      signal: AbortSignal.timeout(120_000),
      taskId: source.id,
    };
    const [guarded] = protectTools(
      {
        ...this.#deps,
        task,
        requestApproval: async ({ resource }) =>
          isDeepStrictEqual(resource, approval.resource),
      },
      [tool],
    );
    await guarded!.run(call.args);
    return true;
  }

  async #execute(work: Work) {
    const { store, auth, runtime, outbound, log } = this.#deps;
    const { adapter, input, abort, id } = work;
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
      const chat = store.resolveChat(work.chat);
      const sourceChatId = store.getTask(id)?.sourceChatId ?? '';
      work.chat = chat;
      if (store.getMessage(chat, message.messageId, sourceChatId)?.deleted) {
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
        input.compact
          ? !owner
          : input.scheduled
            ? !owner && !allowlisted
            : !shouldTrigger(message, owner, allowlisted)
      ) {
        finish('cancelled');
        return;
      }
      const route = this.route(chat, current);
      const { selected } = route;
      const model = selected
        ? (input.scheduled?.model ?? route.model.value ?? 'default')
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
        else if (owner) {
          work.progress.stage = 'delivery';
          await outbound.send(
            adapter,
            reply(
              message,
              route.unavailable ||
                systemMessages(runtime.config.locale).noAgent,
            ),
            {
              taskId: id,
              signal: abort.signal,
            },
          );
        } else finish('completed');
        return;
      }
      const settings = {
        model,
        serviceTier: route.serviceTier.value,
        thinking: route.thinking.value,
      };

      if (input.compact) {
        work.progress.stage = 'compaction';
        const text = await this.#compact(work, selected.agent, settings);
        abort.signal.throwIfAborted();
        work.progress.stage = 'delivery';
        await outbound.send(adapter, reply(message, text), {
          taskId: id,
          signal: abort.signal,
        });
        return;
      }

      ranAgent = true;
      work.progress.stage = 'context';
      const result = await this.#run(work, selected.agent, settings);
      work.acceptsSupplements = false;
      abort.signal.throwIfAborted();
      const fallback = work.pendingApprovalFallback;
      const text = [result.text, fallback].filter(Boolean).join('\n\n');
      if (text) {
        work.progress.stage = 'delivery';
        const scheduled = input.scheduled;
        const output = scheduled
          ? {
              ...scheduled.target,
              allowTextMentions: scheduled.allowTextMentions,
              text: scheduled.delayNote + text,
            }
          : reply(message, text);
        if (
          scheduled &&
          !scheduled.allowTextMentions &&
          containsMention(result.text)
        )
          throw new Error('Scheduled response contains an unapproved mention');
        await outbound.send(
          adapter,
          {
            ...output,
            format: result.text ? 'markdown' : undefined,
            parseTextMentions: result.text ? undefined : false,
          },
          {
            taskId: id,
            scheduled: scheduled !== undefined,
            signal: abort.signal,
          },
        );
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
          model: result.scopeModel ?? model,
          sessionId: result.sessionId,
          scopeChatId: result.scopeChatId,
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
      if (ranAgent) store.clearSession(work.chat);
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
        work.progress.stage = 'recording';
        try {
          await this.#deps.trace.span(
            'workspace.record',
            { ...work.chat, taskId: id },
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
    }
  }

  #toolDefinitions(adapter: PlatformAdapter) {
    return [
      ...this.#deps.tools.filter(
        ({ name }) =>
          !name.startsWith('exec.') || Boolean(this.#deps.backend()),
      ),
      ...(adapter.tools?.() ?? []),
    ];
  }

  async #compact(
    { abort, adapter, chat, id }: Work,
    agent: AgentConnector,
    settings: Pick<AgentRequest, 'model' | 'serviceTier' | 'thinking'>,
  ) {
    const { context, log, runtime, store, trace } = this.#deps;
    const { model } = settings;
    const m = systemMessages(runtime.config.locale);
    if (!agent.compact) return m.compactUnsupported;
    const session = store.getSession(
      chat,
      agent.id,
      agent.settings?.perTurn?.includes('model') ? undefined : model,
    );
    if (
      !session ||
      agent.acceptsSession?.(
        session.sessionId,
        this.#toolDefinitions(adapter),
      ) === false
    )
      return m.compactNoSession;

    const attrs = {
      ...chat,
      taskId: id,
      agentId: agent.id,
      model,
      sessionScope: null as string | null,
      trigger: 'manual',
      contextTokens: null as number | null,
      tokensBefore: null as number | null,
      tokensAfter: null as number | null,
    };
    const end = trace.begin('agent.compaction', attrs);
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(120_000),
    ]);
    try {
      const workdir = await context.workdir(chat);
      signal.throwIfAborted();
      const result = await agent.compact({
        ...settings,
        sessionId: session.sessionId,
        signal,
        workdir,
        sandbox: this.#deps.scope(workdir),
      });
      signal.throwIfAborted();
      if (result.status !== 'compacted') {
        end('error');
        return result.status === 'unsupported'
          ? m.compactUnsupported
          : m.compactSkipped;
      }
      if (result.shared) return m.compactSuccess;
      attrs.sessionScope = sessionScope(
        { ...chat, chatId: session.scopeChatId ?? chat.chatId },
        agent.id,
        session.model,
        session.sessionId,
      );
      attrs.tokensBefore = result.tokensBefore ?? null;
      attrs.tokensAfter = result.tokensAfter ?? null;
      attrs.contextTokens = attrs.tokensAfter;
      end();
      return m.compactSuccess;
    } catch {
      end('error');
      abort.signal.throwIfAborted();
      log({
        level: 'error',
        event: 'agent.compaction_failed',
        taskId: id,
        target: `agent/${agent.id}`,
      });
      return m.compactFailed;
    }
  }

  async #run(
    work: Work,
    agent: AgentConnector,
    settings: Pick<AgentRequest, 'model' | 'serviceTier' | 'thinking'>,
  ) {
    const { store, auth, context, runtime, trace, hooks } = this.#deps;
    const { chat, input, id, abort, supplements, adapter } = work;
    const { signal } = abort;
    const approvalPending = work.endForApproval.signal;
    const { model } = settings;
    const task: ToolContext = {
      chat,
      signal,
      taskId: id,
      principal: { adapterId: chat.adapterId, userId: input.message.userId },
    };
    const attrs = { ...chat, taskId: id };
    const definitions = this.#toolDefinitions(adapter);
    const storedSession = input.scheduled
      ? undefined
      : store.getSession(
          chat,
          agent.id,
          agent.settings?.perTurn?.includes('model') ? undefined : model,
        );
    const session =
      storedSession &&
      agent.acceptsSession?.(storedSession.sessionId, definitions) !== false
        ? storedSession
        : undefined;
    if (!session && !input.scheduled) store.clearSession(chat);
    work.sessionId = session?.sessionId;
    work.sessionScopeChatId = session?.scopeChatId;
    work.sessionScopeModel = session?.model;
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
      if (definitions.some(({ name }) => name === 'schedule.create'))
        blocks.unshift({
          source: 'system',
          trust: 'trusted',
          content: scheduleReplyStyle,
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
      const toolSignal = AbortSignal.any([passSignal, approvalPending]);
      const stopForApproval = () => {
        // Let the tool result settle before interrupting the connector.
        setImmediate(() => pass.abort());
      };
      const requestApproval = (
        request: ApprovalRequest,
        continuation?: ApprovalContinuation,
      ) => {
        const approval = this.#requestApproval(
          work,
          request,
          toolSignal,
          continuation,
        );
        pending.add(approval);
        void approval.then(
          () => pending.delete(approval),
          () => pending.delete(approval),
        );
        return approval;
      };
      const pending = new Set<ReturnType<typeof requestApproval>>();
      const tools = protectTools(
        {
          trace,
          hooks,
          onResult(result) {
            if (
              approvalPending.aborted &&
              result &&
              typeof result === 'object' &&
              'pending' in result &&
              result.pending === true
            )
              stopForApproval();
          },
          task: { ...task, signal: toolSignal },
          requestApproval,
        },
        definitions,
      );
      try {
        work.progress.stage = 'agent';
        const result = await runAgent(
          {
            ...this.#deps,
            task,
            approvalPending,
            scopeChatId:
              sessionId === session?.sessionId
                ? session?.scopeChatId
                : undefined,
            scopeModel:
              sessionId === session?.sessionId ? session?.model : undefined,
            onSession: input.scheduled
              ? undefined
              : (sessionId) => {
                  work.sessionId = sessionId;
                  work.sessionScopeChatId =
                    sessionId === session?.sessionId
                      ? session?.scopeChatId
                      : undefined;
                  work.sessionScopeModel =
                    sessionId === session?.sessionId ? session?.model : model;
                },
          },
          agent,
          {
            ...settings,
            exec: this.#deps.backend(),
            toolsDisabled: runtime.disabled('exec'),
            sandbox: this.#deps.scope(assembled.workdir),
            context: blocks,
            resumeSessionId: sessionId,
            signal: passSignal,
            workdir: assembled.workdir,
            tools,
          },
          {
            requestApproval: async (request) => {
              const result = await requestApproval(request);
              if (typeof result === 'object') stopForApproval();
              return result === true;
            },
            supplements: supplements.stream(passSignal),
          },
        );
        if (result.text.trim()) answers.push(result.text);
        sessionId = result.sessionId ?? sessionId;
      } finally {
        pass.abort();
        await Promise.allSettled(pending);
      }
      if (approvalPending.aborted) {
        sessionId = undefined;
        break;
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
      scopeChatId:
        sessionId === session?.sessionId ? session?.scopeChatId : undefined,
      scopeModel: sessionId === session?.sessionId ? session?.model : undefined,
      seenAfter,
      workdir: assembled.workdir,
    };
  }

  async #requestApproval(
    work: Work,
    request: ApprovalRequest,
    signal: AbortSignal,
    continuation?: ApprovalContinuation,
  ) {
    const approval = await this.#openApproval(
      work,
      request,
      signal,
      continuation,
    );
    if (!approval) return false;
    if ('approvedBy' in approval) return true;
    const result = await approval.decision;
    if (result === 'timeout') {
      return {
        ...pendingApprovalResult,
        summary: this.#markApprovalPending(work),
      };
    }
    if (!result || result === 'expired') return false;
    await result.reaction;
    return result.approved;
  }

  async approveSchedule(
    task: ToolContext,
    schedule: ScheduleApprovalRequest,
    change: ScheduleChange,
  ): Promise<ScheduleApproval | undefined> {
    const work = [...this.#running.values()].find(
      ({ id }) => id === task.taskId,
    );
    if (work?.id !== task.taskId) return;
    const request: ApprovalRequest = {
      action: 'schedule.' + schedule.operation,
      resource: {
        type: 'schedule',
        id: schedule.id,
        deliveryKey: schedule.deliveryKey,
      },
    };
    const approval = await this.#openApproval(
      work,
      request,
      task.signal,
      { kind: 'schedule', change },
      schedule,
    );
    if (!approval || 'approvedBy' in approval) return approval;
    const result = await approval.decision;
    if (result === 'timeout') {
      this.#markApprovalPending(work);
      return { pending: true };
    }
    if (result === 'expired') throw new Error('Schedule approval expired');
    await result?.reaction;
    if (result?.approved)
      return {
        failureReason: result.failureReason,
        scheduleApplied: result.scheduleApplied === true,
      };
  }

  #markApprovalPending(work: Work) {
    const summary = approvalMessages(this.#deps.runtime.config.locale).pending;
    const push = work.adapter.capabilities.outboundPush ?? 'free';
    if (!work.endForApproval.signal.aborted) {
      if (
        (!work.input.scheduled || push === 'free') &&
        (!work.adapter.setApprovalReaction ||
          work.input.scheduled ||
          this.#deps.store.getTask(work.id)?.sourceChatId)
      )
        work.pendingApprovalFallback = summary;
      work.endForApproval.abort();
    }
    return summary;
  }

  async #openApproval(
    work: Work,
    request: ApprovalRequest,
    signal: AbortSignal,
    continuation?: ApprovalContinuation,
    schedule?: ScheduleApprovalRequest,
  ): Promise<
    | { approvedBy: string }
    | { decision: Promise<ApprovalAnswer | undefined> }
    | undefined
  > {
    const { auth, store, trace, outbound, runtime } = this.#deps;
    const { adapter, chat, input, id } = work;
    return trace.span('approval.request', { ...chat, taskId: id }, async () => {
      signal.throwIfAborted();
      const owner = auth.owner(chat.adapterId);
      if (!owner && !schedule?.approverId) return;
      const approvalChat = schedule
        ? {
            adapterId: chat.adapterId,
            chatId: conversationId(schedule.address),
          }
        : chat;
      const reuseGrant = schedule
        ? schedule.reuseGrant
        : request.resource.type !== 'schedule';
      if (reuseGrant) {
        const requester = input.message.userId;
        for (const approver of new Set([schedule?.approverId, owner])) {
          if (
            approver &&
            auth.hasGrant(approvalChat, requester, request, approver)
          )
            return { approvedBy: approver };
        }
      }
      const approval = auth.createApproval(
        approvalChat,
        id,
        input.message.userId,
        request,
        {
          approverId: schedule?.approverId,
          continuation,
        },
      );
      const answer = Promise.withResolvers<ApprovalAnswer | undefined>();
      const wait = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      const cleanup = () => {
        wait.removeEventListener('abort', cancel);
        this.#approvals.delete(approval.id);
      };
      const cancel = () => {
        cleanup();
        answer.resolve(signal.aborted ? undefined : 'timeout');
      };
      this.#approvals.set(approval.id, {
        resolve: answer.resolve,
        signal: wait,
        work,
      });
      wait.addEventListener('abort', cancel, { once: true });
      let linked = false;
      try {
        const { locale } = runtime.config;
        const { buttons } = approvalMessages(locale);
        const useButtons = adapter.capabilities.inlineButtons === true;
        const { text, pre, entities } = approvalPrompt({
          chat,
          locale,
          request,
          schedule,
          store,
          useButtons,
          requester:
            input.message.userDisplay ??
            store.getUserDisplay({ ...chat, userId: input.message.userId }),
        });
        const format: NonNullable<ApprovalRecord['promptFormat']> = { pre };
        await outbound.send(
          adapter,
          {
            ...(schedule
              ? { ...schedule.address, text }
              : reply(input.message, text)),
            approval: true,
            parseTextMentions: false,
            entities: entities.length ? entities : undefined,
            buttons: useButtons
              ? [
                  {
                    id: approvalCallbackId(approval.id, 'approve'),
                    label: buttons.approve,
                  },
                  {
                    id: approvalCallbackId(approval.id, 'deny'),
                    label: buttons.deny,
                  },
                ]
              : undefined,
          },
          {
            signal,
            onReceipt: ({ messageId, parts, approvalEntities }) => {
              if (approvalEntities) {
                format.entities = approvalEntities;
                const rendered = approvalEntities.find(
                  ({ type }) => type === 'pre',
                );
                format.pre = rendered && {
                  offset: rendered.offset,
                  length: rendered.length,
                };
              } else if (pre && parts) {
                let start = 0;
                for (const part of parts) {
                  const end = start + part.text.length;
                  if (part.messageId === messageId) {
                    const from = Math.max(start, pre.offset);
                    const to = Math.min(end, pre.offset + pre.length);
                    format.pre =
                      to > from
                        ? { offset: from - start, length: to - from }
                        : undefined;
                    break;
                  }
                  start = end;
                }
              }
              store.linkApproval(approval.id, messageId, format);
              linked = true;
              if (
                adapter.setApprovalReaction &&
                !input.scheduled &&
                store.getApproval(approval.id)?.status === 'pending'
              )
                void outbound.reactToApproval(
                  adapter,
                  { ...chat, id, sourceMessageId: input.message.messageId },
                  'pending',
                );
            },
          },
        );
        return { decision: answer.promise.finally(cleanup) };
      } catch (error) {
        cleanup();
        if (!linked) store.cancelApproval(approval.id, Date.now());
        throw error;
      }
    });
  }
}

export function reply(message: TaskInput['message'], text: string) {
  return {
    chatId: message.chatId,
    replyTo:
      message.migratedFromChatId === undefined ? message.messageId : undefined,
    threadId: message.threadId,
    text,
  };
}
