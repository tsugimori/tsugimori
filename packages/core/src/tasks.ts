import type { Auth } from '@tsugimori/auth';
import type { ContextAssembler } from '@tsugimori/context';
import type {
  AgentConnector,
  AgentImage,
  AgentRequest,
  ApprovalRequest,
  AttachmentMetadata,
  ChatRef,
  ContextBlock,
  ExecBackend,
  ExecScope,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  QueuedMedia,
  ScheduleApproval,
  ScheduleApprovalRequest,
  SendPart,
  TaskOutcome,
  ToolContext,
  ToolDefinition,
} from '@tsugimori/plugin-sdk';
import type {
  ActiveTaskRefs,
  ApprovalContinuation,
  ApprovalRecord,
  ChatRecord,
  ScheduleChange,
  Store,
  TaskRecord,
} from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { approvalCallbackId } from '@tsugimori/auth';
import { messageContext } from '@tsugimori/context';
import { pendingApprovalResult } from '@tsugimori/plugin-sdk';
import { containsMention, scheduleReplyStyle } from '@tsugimori/scheduler';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import type { HookRunner, Logger } from './hooks.ts';
import type { MemoryResult } from './memory.ts';
import type { Runtime } from './runtime.ts';
import type { StickerIndex } from './stickers.ts';
import type { BackgroundSummaries } from './summary.ts';
import type { TaskInput } from './supplements.ts';
import type { ToolDetail, ToolDetails } from './tool-details.ts';

import { untilAborted } from './abort.ts';
import { protectTools, runAgent, sessionScope } from './agent-run.ts';
import {
  acceptsServiceTier,
  modelThinkingLevels,
  resolveAgentSetting,
} from './agent-settings.ts';
import { approvalMessages, approvalPrompt } from './approval-messages.ts';
import { attachmentTool, turnAttachments } from './attachments.ts';
import { describeError } from './errors.ts';
import { FfmpegMissing, findFfmpeg, prepareImage } from './media.ts';
import { memoryAction } from './memory.ts';
import { conversationId, DeliveryError, Outbound } from './outbound.ts';
import { sendTools } from './send-tools.ts';
import { Supplements } from './supplements.ts';
import { systemMessages } from './system-messages.ts';
import { silentReason, TaskRecorder } from './task-recorder.ts';
import { canTrigger } from './trigger.ts';
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
  stickers: StickerIndex;
  stopExec(chat: ChatRef, taskId: string): Promise<void>;
  store: Store;
  summarize: BackgroundSummaries['enqueue'];
  toolDetails: ToolDetails;
  tools: readonly ToolDefinition[];
  trace: Tracer;
  workspace: string;
}

type Work = {
  abort: AbortController;
  acceptsSupplements: boolean;
  adapter: PlatformAdapter;
  chat: ChatRef;
  createdAt: number;
  endForApproval: AbortController;
  execution?: Promise<void>;
  id: string;
  incognitoId?: number;
  input: TaskInput;
  mediaDelivered?: boolean;
  mediaQueued?: { detail?: ToolDetail; handle: QueuedMedia }[];
  messageIds: Set<string>;
  pendingApprovalFallback?: string;
  progress: { stage: TaskStage; startedAt: number };
  recorder?: TaskRecorder;
  route?: { agentId: string; model: string };
  sessionId?: string;
  sessionScopeChatId?: string | null;
  sessionScopeModel?: string;
  sessionValid: boolean;
  sideQuestionFallback?: boolean;
  stickerCandidates?: InboundAttachment[];
  stopExec?: Promise<void>;
  supplements: Supplements;
  temporaryAttachments: Set<string>;
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
      memoryOutcome?: Promise<MemoryResult>;
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
    const resolveThinking = (levels?: readonly string[]) => {
      const accepts = (value: string | null | undefined) =>
        value != null && (!levels || levels.includes(value))
          ? value
          : undefined;
      return resolveAgentSetting(
        current?.thinking &&
          (!selected ||
            (levels ?? selected.agent.settings?.thinking)?.includes(
              current.thinking,
            ))
          ? current.thinking
          : undefined,
        accepts(settings?.thinking),
        accepts(bound?.thinking),
      );
    };
    return {
      agentId: selected?.agent.id ?? agentId ?? bound?.id,
      model: resolveAgentSetting(current?.model, settings?.model, bound?.model),
      thinking: resolveThinking(),
      resolveThinking,
      serviceTier: resolveAgentSetting(
        serviceTier(current?.serviceTier),
        undefined,
        serviceTier(bound?.serviceTier),
      ),
      selected,
      unavailable,
    };
  }

  thinkingLevels(
    route: ReturnType<Tasks['route']>,
    model = route.model.value,
    signal?: AbortSignal,
  ) {
    return modelThinkingLevels(
      route.selected?.agent,
      model === undefined || model === 'default'
        ? route.selected?.defaults?.model
        : model,
      this.#deps.log,
      signal,
    );
  }

  resetSession(chat: ChatRef, incognitoId: number | null) {
    const { store, trace } = this.#deps;
    chat = store.resolveChat(chat);
    const key = chatKey(chat);
    if (this.#queues.has(key)) return false;
    const agentId = store.getChat(chat)?.sessionAgentId;
    const session = agentId ? store.getSession(chat, agentId) : undefined;
    store.clearSession(chat, incognitoId);
    trace.record('session.reset', {
      sessionScope: session
        ? sessionScope(
            { ...chat, chatId: session.scopeChatId ?? chat.chatId },
            session.agentId,
            session.model,
            session.sessionId,
          )
        : null,
    });
    return true;
  }

  dispatch(
    adapter: PlatformAdapter,
    chat: ChatRef,
    input: TaskInput,
    onTask?: (id: string) => void,
  ) {
    const { store, trace, log } = this.#deps;
    chat = store.resolveChat(chat);
    const key = chatKey(chat);
    const running = this.#running.get(key);
    const { replyTo, messageId } = input.message;
    if (
      !input.compact &&
      !input.scheduled &&
      !input.sessionCommand &&
      !input.message.migratedFromChatId &&
      running?.acceptsSupplements &&
      store.messageVisible(chat, messageId, '') &&
      !running.input.message.migratedFromChatId &&
      !running.abort.signal.aborted &&
      replyTo &&
      running.messageIds.has(replyTo.id)
    ) {
      running.messageIds.add(messageId);
      running.supplements.push(input);
      onTask?.(running.id);
      return;
    }
    const createdAt = Date.now();
    const work: Work = {
      adapter,
      chat,
      input,
      createdAt,
      id: randomUUID(),
      abort: new AbortController(),
      endForApproval: new AbortController(),
      messageIds: new Set([messageId]),
      supplements: new Supplements(),
      temporaryAttachments: new Set(),
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
    onTask?.(work.id);
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
        if (!work.abort.signal.aborted && work.stickerCandidates?.length)
          this.#deps.stickers.observeSingles(adapter, work.stickerCandidates);
      });
    this.#queues.set(key, tail);
    if (input.scheduled) return tail.then(() => store.getTask(work.id)?.status);
  }

  activeRecordRefs(): readonly ActiveTaskRefs[] {
    const active: ActiveTaskRefs[] = [];
    for (const { chat, id, recorder } of this.#work)
      if (recorder)
        active.push({ ...chat, taskId: id, refs: recorder.references });
    return active;
  }

  async idle() {
    while (this.#queues.size) await Promise.all(this.#queues.values());
  }

  migrateChat(adapterId: string, chatId: string, newChatId: string) {
    const oldKey = chatKey({ adapterId, chatId });
    const destination = { adapterId, chatId: newChatId };
    const key = chatKey(destination);
    const incognitoId =
      this.#deps.store.getChat(destination)?.incognitoId ?? undefined;
    for (const running of [this.#running.get(oldKey), this.#running.get(key)])
      if (running && running.incognitoId !== incognitoId) running.abort.abort();
    const previous = this.#queues.get(oldKey);
    if (!previous) return;
    const tail = Promise.all([previous, this.#queues.get(key)]).then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    this.#queues.set(key, tail);
  }

  stop(chat: ChatRef, userId: string) {
    const { log, store, trace } = this.#deps;
    const key = chatKey(store.resolveChat(chat));
    const running =
      this.#running.get(key) ??
      [...this.#running.values()].find(
        (work) => chatKey(store.resolveChat(work.chat)) === key,
      );
    if (!running || running.abort.signal.aborted) return;
    const status = store.getTask(running.id)?.status;
    if (status !== 'queued' && status !== 'running') return;
    for (const [id, approval] of this.#approvals)
      if (approval.work === running) store.cancelApproval(id, Date.now());
    running.abort.abort();
    store.updateTask(running.id, {
      status: 'cancelled',
      finishedAt: Date.now(),
    });
    running.stopExec = this.#deps.stopExec(running.chat, running.id).catch(() =>
      log({
        level: 'error',
        event: 'task.exec_stop_failed',
        taskId: running.id,
      }),
    );
    trace.record('task.stopped', {
      taskId: running.id,
      userIdHash: createHash('sha256').update(userId).digest('hex'),
    });
    return [...this.#work].filter(
      (work) =>
        work !== running && chatKey(store.resolveChat(work.chat)) === key,
    ).length;
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

  async interrupt(
    adapters: ReadonlySet<string>,
    agents: ReadonlySet<string>,
    removeAgent?: string,
  ) {
    const active: Promise<void>[] = [];
    for (const work of this.#work) {
      if (
        adapters.has(work.chat.adapterId) ||
        (work.route && agents.has(work.route.agentId)) ||
        (removeAgent !== undefined &&
          !work.route &&
          this.route(work.chat).agentId === removeAgent)
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
    const { store } = this.#deps;
    const { adapterId, chatId } = source;
    const chat = store.resolveChat({ adapterId, chatId });
    if (
      !store.messageVisible(
        chat,
        source.sourceMessageId,
        source.sourceChatId ?? '',
      )
    )
      return false;
    const incognito = store.getChat(chat)?.incognitoId != null;
    const tool = this.#toolDefinitions(adapter, incognito).find(
      ({ name, permission }) =>
        name === call.name && permission?.action === approval.action,
    );
    if (!tool) return false;
    const task: ToolContext = {
      chat,
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
    const { store, auth, runtime, log, toolDetails, workspace } = this.#deps;
    const { adapter, input, abort, id } = work;
    const { message } = input;
    const ephemeral = input.sessionCommand !== undefined;
    const sameIncognitoWindow = () =>
      (store.getChat(store.resolveChat(work.chat))?.incognitoId ??
        undefined) === work.incognitoId;
    const activity = new AbortController();
    const finish = (status: TaskRecord['status']) =>
      store.updateTask(id, { status, finishedAt: Date.now() });
    const redactor = toolDetails.redactor();
    const recorder = new TaskRecorder(
      { store, log, redact: redactor, taskId: id, workspace },
      Math.max(0, work.progress.startedAt - work.createdAt),
    );
    work.recorder = recorder;
    let outcome: TaskOutcome = { kind: 'cancelled' };
    let ranAgent = false;
    let delivered = false;
    try {
      abort.signal.throwIfAborted();
      const transition = runtime.transition;
      if (transition) await untilAborted(abort.signal, () => transition);
      const chat = store.resolveChat(work.chat);
      const sourceChatId = store.getTask(id)?.sourceChatId ?? '';
      work.chat = chat;
      if (!store.messageVisible(chat, message.messageId, sourceChatId)) {
        finish('cancelled');
        return;
      }
      const owner = auth.isOwner({
        adapterId: chat.adapterId,
        userId: message.userId,
      });
      const current = store.getChat(chat);
      work.incognitoId = current?.incognitoId ?? undefined;
      const allowlisted = current?.allowlisted ?? false;
      if (
        input.compact
          ? !owner
          : input.scheduled || input.sessionCommand
            ? !owner && !allowlisted
            : !canTrigger(
                message,
                owner,
                allowlisted,
                adapter.capabilities.ownerReplyTriggers,
              )
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
        outcome = { kind: 'no-agent' };
        if (input.scheduled) finish('failed');
        else if (owner || input.sessionCommand) {
          await this.#deliver(
            work,
            reply(
              message,
              route.unavailable ||
                systemMessages(runtime.config.locale).noAgent,
            ),
          );
        } else finish('completed');
        return;
      }
      const levels =
        current?.thinking || route.thinking.value !== undefined
          ? await this.thinkingLevels(route, model, abort.signal)
          : undefined;
      abort.signal.throwIfAborted();
      const settings = {
        model,
        serviceTier: route.serviceTier.value,
        thinking: route.resolveThinking(levels).value,
      };

      recorder.agent({
        agentId: selected.agent.id,
        kind: selected.agent.kind,
        model,
        requestedModel: model,
        reasoning: settings.thinking,
        serviceTier: settings.serviceTier,
      });
      if (input.compact) {
        work.progress.stage = 'compaction';
        const timed = recorder.timing('agentMs');
        let text: string;
        try {
          text = await this.#compact(work, selected.agent, settings);
        } finally {
          timed();
        }
        abort.signal.throwIfAborted();
        await this.#deliver(work, reply(message, text));
        outcome = { kind: 'delivered' };
        return;
      }

      ranAgent = true;
      work.progress.stage = 'context';
      const result = await this.#run(work, selected.agent, settings, recorder);
      recorder.output(result.text);
      work.acceptsSupplements = false;
      abort.signal.throwIfAborted();
      const reason = silentReason(result.text, redactor);
      const silent = reason !== undefined;
      // The approval notice still matters after a sticker or other media.
      const fallback = work.pendingApprovalFallback;
      const text = [
        work.sideQuestionFallback
          ? systemMessages(runtime.config.locale).btwFresh
          : '',
        silent ? '' : result.text,
        fallback,
      ]
        .filter(Boolean)
        .join('\n\n');
      if (silent) outcome.silentReason = reason;
      if (text || work.mediaQueued?.length) {
        const scheduled = input.scheduled;
        const output = scheduled
          ? {
              ...scheduled.target,
              allowTextMentions: scheduled.allowTextMentions,
              text: text ? scheduled.delayNote + text : '',
            }
          : reply(message, text);
        if (scheduled && !scheduled.allowTextMentions && containsMention(text))
          throw new Error('Scheduled response contains an unapproved mention');
        await this.#deliver(
          work,
          {
            ...output,
            format: !silent && result.text ? 'markdown' : undefined,
            parseTextMentions: !silent && result.text ? undefined : false,
          },
          !silent && Boolean(result.text),
        );
        delivered = true;
        outcome.kind = 'delivered';
      } else if (work.mediaDelivered) {
        finish('sent');
        outcome.kind = 'delivered';
      } else {
        outcome.kind = 'silent';
        if (silent)
          this.#deps.trace.record('outbound.silent', {
            ...chat,
            taskId: id,
            reply: 'silent',
            silentReason: reason,
          });
        await this.#deps.trace.flush().catch(() => {
          log({ level: 'error', event: 'trace.flush_failed', taskId: id });
        });
        abort.signal.throwIfAborted();
        finish('completed');
      }

      if (!ephemeral && sameIncognitoWindow()) {
        if (
          !input.scheduled &&
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
      }
      if (!ephemeral && work.incognitoId === undefined && !abort.signal.aborted)
        this.#deps.summarize({
          agentId: selected.agent.id,
          chat,
          model,
          taskId: id,
          throughSeq: Math.max(input.seq, ...result.seenAfter),
          workdir: result.workdir,
        });
    } catch (error) {
      const stage = work.progress.stage;
      outcome.kind =
        abort.signal.aborted && !(error instanceof DeliveryError)
          ? 'cancelled'
          : 'failed';
      outcome.error = recorder.error(
        error,
        stage === 'preparing'
          ? 'queue'
          : stage === 'compaction'
            ? 'agent'
            : stage === 'recording'
              ? 'record'
              : stage === 'approval'
                ? 'other'
                : stage,
      );
      if (ranAgent && !ephemeral && !work.stopExec && sameIncognitoWindow())
        store.clearSession(work.chat);
      if (!delivered && !work.stopExec && !(error instanceof DeliveryError))
        finish(abort.signal.aborted ? 'cancelled' : 'failed');
      if (!abort.signal.aborted || error instanceof DeliveryError) {
        this.#deps.trace.record(
          'task.failed',
          {
            taskId: id,
            error:
              runtime.config.web?.toolDetails?.enabled === false
                ? null
                : outcome.error.message,
          },
          0,
          'error',
        );
        log({
          level: 'error',
          event: 'task.failed',
          taskId: id,
          error: describeError(error, redactor),
        });
      }
    } finally {
      activity.abort();
      if (work.stopExec) await work.stopExec;
      this.#settleMedia(
        work,
        [],
        new Error('Chat task ended before queued media was delivered'),
      );
      for (const path of work.temporaryAttachments) {
        try {
          await rm(path, { force: true });
        } catch (error) {
          log({
            level: 'error',
            event: 'media.cleanup_failed',
            taskId: id,
            error: describeError(error),
          });
        }
      }
      recorder.finish(outcome);
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

  #settleMedia(work: Work, parts: readonly SendPart[], error?: unknown) {
    for (const { detail, handle } of work.mediaQueued ?? []) {
      const part = parts.find(({ mediaId }) => mediaId === handle.id);
      if (part)
        detail?.finish('ok', {
          messageId: part.messageId,
          messageIds: [part.messageId],
        });
      else
        detail?.finish(
          'error',
          error ?? new Error('Adapter did not return a media receipt'),
        );
    }
    work.mediaQueued = undefined;
  }

  async #deliver(work: Work, message: OutboundMessage, finalReply = false) {
    work.progress.stage = 'delivery';
    const timed = work.recorder?.timing('deliveryMs');
    let recorded = false;
    try {
      const { outbound } = this.#deps;
      const send = finalReply ? outbound.sendFinal : outbound.send;
      return await send.call(outbound, work.adapter, message, {
        incognitoId: work.incognitoId,
        taskId: work.id,
        scheduled: work.input.scheduled !== undefined,
        sideQuestion: work.input.sessionCommand !== undefined,
        signal: work.abort.signal,
        media: work.mediaQueued?.map(({ handle }) => handle),
        onParts: (parts, error) => this.#settleMedia(work, parts, error),
        onDelivery: (ids, error) => {
          recorded = true;
          work.recorder?.delivery(work.adapter.id, ids, error);
        },
      });
    } catch (error) {
      if (!recorded) work.recorder?.delivery(work.adapter.id, [], error);
      throw error;
    } finally {
      timed?.();
    }
  }

  #toolDefinitions(adapter: PlatformAdapter, incognito: boolean, work?: Work) {
    const { store, context, toolDetails } = this.#deps;
    const scheduled = work?.input.scheduled;
    const message = work?.input.message;
    const sendAllowed =
      !scheduled ||
      (message?.chatId === scheduled.target.chatId &&
        message?.threadId === scheduled.target.threadId);
    return [
      ...this.#deps.tools.filter(
        ({ name }) =>
          (!incognito ||
            (!name.startsWith('history.') &&
              name !== memoryAction &&
              name !== 'schedule.create' &&
              name !== 'schedule.update')) &&
          (!name.startsWith('exec.') || Boolean(this.#deps.backend())),
      ),
      ...(adapter.tools?.() ?? []),
      ...this.#deps.stickers.tools(adapter),
      ...(sendAllowed
        ? sendTools(
            { ...this.#deps, workdir: (chat) => context.workdir(chat) },
            adapter,
            work && message
              ? {
                  address: scheduled?.target ?? reply(message, ''),
                  source: message.messageId,
                  incognitoId: work.incognitoId,
                  sideQuestion: work.input.sessionCommand !== undefined,
                  onDelivery: (ids, error) => {
                    work.recorder?.delivery(adapter.id, ids, error);
                    work.mediaDelivered ||= ids.length > 0;
                  },
                  onQueued: (handle, task) => {
                    (work.mediaQueued ??= []).push({
                      handle,
                      detail: toolDetails.invocation(task),
                    });
                  },
                }
              : undefined,
          )
        : []),
      ...(adapter.downloadAttachment
        ? [
            attachmentTool(
              { store, workdir: (chat) => context.workdir(chat) },
              adapter,
              work?.temporaryAttachments,
            ),
          ]
        : []),
    ];
  }

  async #compact(
    { abort, adapter, chat, id, incognitoId, recorder }: Work,
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
        this.#toolDefinitions(adapter, incognitoId !== undefined),
      ) === false
    )
      return m.compactNoSession;

    recorder?.session({ mode: 'resumed', sessionId: session.sessionId });
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
      recorder?.event({
        kind: 'compaction',
        data: {
          trigger: 'manual',
          status: result.status,
          ...(result.status === 'compacted' && {
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
          }),
        },
      });
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
    } catch (error) {
      recorder?.error(error, 'agent');
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
    recorder: TaskRecorder,
  ) {
    const { store, auth, context, runtime, trace, hooks, stickers } =
      this.#deps;
    const { chat, input, id, abort, supplements, adapter, incognitoId } = work;
    const ephemeral = input.sessionCommand !== undefined;
    const btw = input.sessionCommand?.mode === 'btw';
    const { signal } = abort;
    const approvalPending = work.endForApproval.signal;
    const { model } = settings;
    const visibleReply = (message: InboundMessage) => {
      const { replyTo } = message;
      if (
        replyTo &&
        !store.messageVisible(
          chat,
          replyTo.id,
          input.message.migratedFromChatId ?? '',
        )
      )
        return { id: replyTo.id };
      return replyTo;
    };
    const collectStickers = (message: InboundMessage) => {
      if (input.scheduled || !adapter.downloadAttachment) return;
      for (const attachments of [
        message.attachments,
        visibleReply(message)?.attachments,
      ])
        for (const attachment of attachments ?? [])
          if (attachment.kind === 'sticker')
            (work.stickerCandidates ??= []).push(attachment);
    };
    collectStickers(input.message);
    const describe = <T extends AttachmentMetadata>(
      attachments: readonly T[],
    ) => stickers.describe(adapter, attachments);
    const task: ToolContext = {
      chat,
      signal,
      taskId: id,
      principal: { adapterId: chat.adapterId, userId: input.message.userId },
    };
    const attrs = { ...chat, taskId: id };
    const definitions = this.#toolDefinitions(
      adapter,
      incognitoId !== undefined,
      work,
    );
    const previousSession = store.getSession(
      chat,
      store.getChat(chat)?.sessionAgentId ?? agent.id,
    );
    const storedSession =
      !input.scheduled &&
      previousSession?.agentId === agent.id &&
      (agent.settings?.perTurn?.includes('model') ||
        previousSession.model === model)
        ? previousSession
        : undefined;
    const compatibleSession =
      storedSession &&
      agent.acceptsSession?.(storedSession.sessionId, definitions) !== false
        ? storedSession
        : undefined;
    const forkSessionId =
      btw && agent.supportsSessionFork
        ? compatibleSession?.sessionId
        : undefined;
    const session = ephemeral ? undefined : compatibleSession;
    if (ephemeral) {
      recorder.session({ mode: forkSessionId ? 'fork' : 'ephemeral' });
      work.sideQuestionFallback = btw && !forkSessionId;
    } else
      recorder.session(
        session
          ? {
              mode: 'resumed',
              sessionId: session.sessionId,
              previousSessionId: session.sessionId,
            }
          : {
              mode: 'new',
              previousSessionId: previousSession?.sessionId,
              reason: input.scheduled
                ? 'scheduled'
                : storedSession
                  ? 'connector-rejected-session'
                  : previousSession
                    ? 'agent-or-model-changed'
                    : 'no-session',
            },
      );
    if (!session && !input.scheduled && !input.sessionCommand)
      store.clearSession(chat);
    work.sessionId = session?.sessionId;
    work.sessionScopeChatId = session?.scopeChatId;
    work.sessionScopeModel = session?.model;
    work.acceptsSupplements = !ephemeral;
    if (
      input.message.albumId &&
      agent.imageLimits &&
      adapter.downloadAttachment
    )
      await trace.span('media.album', attrs, () =>
        delay(175, undefined, { signal }),
      );
    const endContext = recorder.timing('contextMs');
    const assembled = await trace
      .span('context.assembled', attrs, async () => {
        const entries = await context.assembleWithRefs({
          ...chat,
          botIdentity: adapter.botIdentity,
          kind: adapter.kind,
          richText: adapter.capabilities.richText,
          ownerId: auth.owner(chat.adapterId),
          recentMessages: runtime.config.context.recentMessages,
          throughSeq: input.seq,
          ...(btw && { history: 'none' }),
          incognitoId,
          afterSeq: (forkSessionId ? compatibleSession : session)?.throughSeq,
          skipSeq: session?.seenAfter,
        });
        if (definitions.some(({ name }) => name === 'schedule.create'))
          entries.unshift({
            kind: 'system',
            name: 'schedule-style',
            block: {
              source: 'system',
              trust: 'trusted',
              content: scheduleReplyStyle,
            },
          });
        if (input.scheduled && !input.scheduled.allowTextMentions)
          entries.push({
            kind: 'new',
            block: {
              source: 'system',
              trust: 'trusted',
              content:
                'Return the scheduled response without textual mentions. The platform adds any approved recipients separately.',
            },
          });
        if (input.sessionCommand) {
          // The command prompt has no mention, so say who it is for.
          const at = entries.findIndex(
            (entry) => entry.kind === 'new' && entry.seq === input.seq,
          );
          entries.splice(at < 0 ? entries.length : at, 0, {
            kind: 'new',
            block: {
              source: 'system',
              trust: 'trusted',
              content: `The next message was sent to you with the /${input.sessionCommand.mode} command. Reply to it.`,
            },
          });
        }
        if (btw)
          entries.unshift({
            kind: 'new',
            block: {
              source: 'system',
              trust: 'trusted',
              content:
                'Answer only this side question. Earlier conversation is reference only. Do not continue or change earlier tasks.',
            },
          });
        for (const entry of entries) {
          const { block } = entry;
          if (
            entry.kind === 'new' &&
            entry.seq === input.seq &&
            input.sessionCommand
          )
            block.content = input.sessionCommand.prompt;
          const { message } = block;
          if (!message) continue;
          message.attachments = describe(message.attachments);
          if (message.replyTo)
            message.replyTo.attachments = describe(message.replyTo.attachments);
        }
        await recorder.context(entries, incognitoId !== undefined);
        const workdir = await context.workdir(chat);
        await prepareWorkspace(workdir, !runtime.disabled('workspace.record'));
        work.workdir = workdir;
        return {
          blocks: entries.map(({ block }) => block),
          media: entries
            .filter(
              (entry) =>
                entry.kind === 'new' || (session && entry.kind === 'history'),
            )
            .map(({ block }) => block),
          workdir,
        };
      })
      .finally(endContext);

    let blocks = assembled.blocks;
    let sessionId = session?.sessionId;
    const answers: string[] = [];
    const describeSupplement = (message: InboundMessage) => {
      collectStickers(message);
      const replyTo = visibleReply(message);
      return {
        ...message,
        ...((incognitoId !== undefined || replyTo !== message.replyTo) && {
          raw: undefined,
        }),
        attachments: message.attachments && describe(message.attachments),
        replyTo: replyTo && {
          ...replyTo,
          attachments: replyTo.attachments && describe(replyTo.attachments),
        },
      };
    };
    const supplementBlock = (message: InboundMessage): ContextBlock => ({
      source: 'message',
      trust: auth.isOwner({ adapterId: chat.adapterId, userId: message.userId })
        ? 'owner'
        : 'member',
      content: message.text,
      message: messageContext({
        albumId: message.albumId,
        messageId: message.messageId,
        metadata: message,
        migratedFromChatId: '',
        recordedAt: null,
        replyTo: message.replyTo?.id ?? null,
        userId: message.userId,
      }),
    });
    let media = assembled.media;
    const seenImages = new Set<string>();
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
        onPending?: (approvalId: string) => void,
      ) => {
        const approval = this.#requestApproval(
          work,
          request,
          toolSignal,
          continuation,
          onPending,
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
          toolDetails: this.#deps.toolDetails,
          recorder,
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
      const images = await this.#images(
        work,
        agent,
        media,
        session?.throughSeq,
        sessionId === undefined,
        seenImages,
      );
      const endAgent = recorder.timing('agentMs');
      try {
        work.progress.stage = 'agent';
        const result = await runAgent(
          {
            ...this.#deps,
            task,
            recorder,
            approvalPending,
            incognito: incognitoId !== undefined,
            waitForClose: () => work.stopExec !== undefined,
            scopeChatId:
              sessionId === session?.sessionId
                ? session?.scopeChatId
                : undefined,
            scopeModel:
              sessionId === session?.sessionId ? session?.model : undefined,
            onSession:
              input.scheduled || ephemeral
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
            ...(ephemeral && { ephemeral }),
            ...(forkSessionId && { forkSessionId }),
            ...(images.length && { images }),
            resumeSessionId: sessionId,
            signal: passSignal,
            workdir: assembled.workdir,
            tools,
          },
          {
            requestApproval: async (request, _callId, onPending) => {
              const result = await requestApproval(
                request,
                undefined,
                onPending,
              );
              if (typeof result === 'object' && 'pending' in result) {
                // The connector's approval call can be interrupted before it returns.
                stopForApproval();
              }
              return result === true;
            },
            supplements: supplements.stream(passSignal, (message) => {
              const described = describeSupplement(message);
              recorder.supplement(
                message.messageId,
                supplementBlock(described),
              );
              return described;
            }),
          },
        );
        if (result.text.trim()) answers.push(result.text);
        sessionId = result.sessionId ?? sessionId;
      } finally {
        pass.abort();
        await Promise.allSettled(pending);
        endAgent();
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
      blocks = next.map(({ message }) => {
        const block = supplementBlock(describeSupplement(message));
        recorder.supplement(message.messageId, block);
        return block;
      });
      media = blocks;
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

  async #images(
    { abort, adapter, chat, id, input }: Work,
    { imageLimits }: AgentConnector,
    blocks: readonly ContextBlock[],
    afterSeq: number | undefined,
    includeReplies: boolean,
    seen: Set<string>,
  ) {
    const { store, trace, log } = this.#deps;
    const download = adapter.downloadAttachment?.bind(adapter);
    if (!download || !imageLimits || input.scheduled) return [];
    const attachments = turnAttachments(
      store,
      chat,
      adapter.kind,
      blocks,
      input.message.migratedFromChatId ?? '',
      afterSeq,
      includeReplies,
    );
    if (!attachments.length) return [];
    const { signal } = abort;
    return trace.span(
      'media.prepare',
      { ...chat, taskId: id, images: attachments.length },
      async () => {
        const command = await findFfmpeg();
        if (!command) {
          log({ level: 'warn', event: 'media.ffmpeg_missing', taskId: id });
          return [];
        }
        const ready: AgentImage[] = [];
        for (const {
          albumFirstSeq,
          attachment,
          id: messageId,
        } of attachments) {
          const key = JSON.stringify([
            albumFirstSeq ?? messageId,
            attachment.index,
          ]);
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const { bytes } = await download(
              attachment,
              signal,
              imageLimits.sourceMaxBytes,
            );
            const image = await prepareImage(
              bytes,
              attachment,
              imageLimits,
              signal,
              command,
            );
            ready.push({
              ...image,
              source: { messageId, index: attachment.index },
            });
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof FfmpegMissing) {
              log({ level: 'warn', event: 'media.ffmpeg_missing', taskId: id });
              break;
            }
            log({ level: 'warn', event: 'media.prepare_failed', taskId: id });
          }
        }
        return ready;
      },
    );
  }

  async #requestApproval(
    work: Work,
    request: ApprovalRequest,
    signal: AbortSignal,
    continuation?: ApprovalContinuation,
    onPending?: (approvalId: string) => void,
  ) {
    const approval = await this.#openApproval(
      work,
      request,
      signal,
      continuation,
      undefined,
      onPending,
    );
    if (!approval) return false;
    if ('approvedBy' in approval) return true;
    const result = await approval.decision;
    if (result === 'timeout') {
      return {
        ...pendingApprovalResult,
        summary: this.#markApprovalPending(
          work,
          request.action === memoryAction,
        ),
      };
    }
    if (!result || result === 'expired') return false;
    await result.reaction;
    if (result.memoryOutcome) return { result: await result.memoryOutcome };
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
    const detail = this.#deps.toolDetails.invocation(task);
    const approval = await this.#openApproval(
      work,
      request,
      task.signal,
      { kind: 'schedule', change },
      schedule,
      detail?.pending,
    );
    if (!approval) {
      detail?.deny();
      return;
    }
    if ('approvedBy' in approval) return approval;
    const result = await approval.decision;
    if (result === 'timeout') {
      this.#markApprovalPending(work);
      return { pending: true };
    }
    if (result === 'expired') {
      detail?.deny();
      throw new Error('Schedule approval expired');
    }
    await result?.reaction;
    if (result?.approved) {
      detail?.resume();
      return {
        failureReason: result.failureReason,
        scheduleApplied: result.scheduleApplied === true,
      };
    }
    detail?.deny();
  }

  #markApprovalPending(work: Work, memory = false) {
    const messages = approvalMessages(this.#deps.runtime.config.locale);
    const summary = memory ? messages.memoryPending : messages.pending;
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
    onPending?: (approvalId: string) => void,
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
        : request.action !== memoryAction &&
          request.resource.type !== 'schedule';
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
      onPending?.(approval.id);
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
            incognitoId: work.incognitoId,
            signal,
            sideQuestion: input.sessionCommand !== undefined,
            onDelivery: (ids, error) =>
              work.recorder?.delivery(adapter.id, ids, error),
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
