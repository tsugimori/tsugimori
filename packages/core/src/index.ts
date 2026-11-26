import type { WorkspaceConfig } from '@tsugimori/config';
import type { SummaryProvider } from '@tsugimori/context';
import type {
  AdminReader,
  ApprovalFeedback,
  ChatRef,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  PlatformInboundEvent,
  ScheduledInboundEvent,
  SetupDependencies,
  TunnelProvider,
} from '@tsugimori/plugin-sdk';
import type {
  ApprovalRecord,
  ScheduleRecord,
  ScheduleRun,
  Store,
  TaskRecord,
} from '@tsugimori/storage';

import { Auth } from '@tsugimori/auth';
import {
  ConfigError,
  configuredOwner,
  loadConfig,
  watch,
} from '@tsugimori/config';
import { ContextAssembler } from '@tsugimori/context';
import { SendFailure } from '@tsugimori/plugin-sdk';
import {
  prepareReminder,
  reminderEntities,
  Scheduler,
} from '@tsugimori/scheduler';
import { Tracer } from '@tsugimori/trace';

import type { Command } from './chat-commands.ts';
import type { Logger } from './hooks.ts';
import type { PreviewProviders } from './previews.ts';
import type { PlatformNotice } from './runtime.ts';

import { approvalDecisionText, approvalMessages } from './approval-messages.ts';
import { parseCommand } from './chat-commands.ts';
import { ChatSetup } from './chat-setup.ts';
import { EnvironmentChecks, failureText } from './checks.ts';
import { CommandMenus } from './command-menus.ts';
import { Executions, sandboxScope } from './executions.ts';
import { HookRunner, logToStderr } from './hooks.ts';
import { conversationId, Outbound } from './outbound.ts';
import { Previews } from './previews.ts';
import { PluginRegistry } from './registry.ts';
import { Runtime } from './runtime.ts';
import { GuidedSetup } from './setup.ts';
import { BackgroundSummaries } from './summary.ts';
import { systemMessages } from './system-messages.ts';
import { reply, Tasks } from './tasks.ts';
import { shouldTrigger } from './trigger.ts';

export { EnvironmentChecks, PluginRegistry, shouldTrigger };
export { runCommand } from './commands.ts';
export type { CheckReport } from './checks.ts';
export type { Logger };

interface GatewayDependencies {
  log?: Logger;
  namedPreview?(snapshot?: WorkspaceConfig): TunnelProvider | undefined;
  previews?: PreviewProviders;
  registry?: PluginRegistry;
  setup?: SetupDependencies;
  store: Store;
  summary?: SummaryProvider;
  trace?: Tracer;
  workspace: string;
}

type LinkedApproval = Exclude<
  NonNullable<ReturnType<Auth['resolveApproval']>>,
  { decision: 'expired' }
> & {
  live: boolean;
  reaction?: Promise<void>;
  record: ApprovalRecord;
};

export class Gateway {
  readonly #deps;
  readonly #registry: PluginRegistry;
  readonly #trace: Tracer;
  readonly #runtime: Runtime;
  readonly #hooks: HookRunner;
  readonly #auth: Auth;
  readonly #outbound: Outbound;
  readonly #tasks: Tasks;
  readonly #summaries: BackgroundSummaries;
  readonly #scheduler: Scheduler;
  readonly #previews?: Previews;
  readonly #execution: Executions;
  readonly #chatSetup: ChatSetup;
  readonly #commandMenus: CommandMenus;
  readonly #platformNotifications = new Map<string, Promise<void>>();
  readonly #inbound = new Set<Promise<void>>();
  #applyingConfig = false;
  #closeWatch?: ReturnType<typeof watch>;
  #environmentNotification?: Promise<void>;
  #expiry?: Promise<void>;
  #initialApply?: Promise<void>;
  #stopping?: Promise<void>;
  readonly admin: AdminReader;
  #state: 'new' | 'starting' | 'running' | 'stopping' = 'new';

  constructor({
    store,
    workspace,
    registry = new PluginRegistry(),
    trace,
    summary,
    previews,
    namedPreview,
    setup = {},
    log = logToStderr,
  }: GatewayDependencies) {
    this.#deps = { store, workspace, log, namedPreview };
    this.admin = {
      chats: () => store.listChats(),
      chat: (chat, before) => {
        const record = store.getChat(chat);
        if (record)
          return {
            chat: record,
            messages: store.listChatMessages(chat, before),
            tasks: store.listChatTasks(chat),
          };
      },
      approvals: () => ({
        approvals: store.listApprovals().map((approval) => ({
          action: approval.action,
          adapterId: approval.adapterId,
          approverId: approval.approverId,
          chatId: approval.chatId,
          decidedAt: approval.decidedAt,
          decidedBy: approval.decidedBy,
          expiresAt: approval.expiresAt,
          id: approval.id,
          promptMessageId: approval.promptMessageId,
          requester: approval.requester,
          resource: approval.resource,
          status: approval.status,
          taskId: approval.taskId,
        })),
        grants: store.listGrants(),
      }),
      trace: (taskId) => {
        const task = store.getTask(taskId);
        if (task) return { task, spans: store.taskTrace(taskId) };
      },
    };
    this.#registry = registry;
    this.#trace =
      trace ??
      new Tracer(store, {
        onError: () => log({ level: 'error', event: 'trace.flush_failed' }),
      });
    this.#runtime = new Runtime({
      workspace,
      registry,
      checks: new EnvironmentChecks(setup, workspace),
      trace: this.#trace,
      store,
      log,
      platformChanged: (ready) => {
        if (this.#state !== 'running' || this.#applyingConfig) return;
        if (ready) {
          this.#commandMenus.refresh();
          this.#scheduler.tick();
          void this.#reportFailures();
        }
        this.#reportPlatformNotices();
      },
      receive: (adapter, event) => this.#receive(adapter, event),
      interrupt: async (adapters, agents) => {
        await this.#tasks.interrupt(adapters, agents);
        await this.#previews?.detach(adapters);
        await this.#execution.stop(adapters);
      },
    });
    this.#hooks = new HookRunner({ registry, trace: this.#trace, log });
    this.#outbound = new Outbound({
      log,
      store,
      trace: this.#trace,
      hooks: this.#hooks,
    });
    this.#auth = new Auth({
      store,
      configuredOwner: (id) =>
        configuredOwner(
          this.#runtime.config,
          id,
          this.#runtime.adapterKind(id),
        ),
    });
    this.#commandMenus = new CommandMenus({
      log,
      owner: (id) => this.#auth.owner(id),
      runtime: this.#runtime,
      store,
      trace: this.#trace,
    });
    this.#chatSetup = new ChatSetup({
      setup: new GuidedSetup({ ...setup, store, workspace, registry }),
      isOwner: (adapterId, userId) => this.#auth.isOwner({ adapterId, userId }),
      runtime: this.#runtime,
      log,
      store,
      trace: this.#trace,
    });
    const context = new ContextAssembler({
      workspace,
      store,
      summary: summary ?? { get: (chat) => this.#summaries.get(chat) },
    });
    const backend = () =>
      this.#runtime.config.exec && !this.#runtime.disabled('exec')
        ? registry.execution(this.#runtime.config.exec.kind ?? 'local-sandbox')
        : undefined;
    const scope = (workdir: string) =>
      sandboxScope(
        workspace,
        workdir,
        this.#runtime.config.exec?.denyRead,
        this.#runtime.config.agents,
      );
    this.#execution = new Executions({
      backend,
      scope,
      store,
      invalidateSession: (chat) => this.#tasks.invalidateSession(chat),
      recordWorkspace: () => !this.#runtime.disabled('workspace.record'),
      workdir: (chat) => context.workdir(chat),
    });
    this.#summaries = new BackgroundSummaries({
      scope,
      log,
      runtime: this.#runtime,
      store,
      trace: this.#trace,
    });
    this.#scheduler = new Scheduler({
      store,
      approve: (task, request, change) =>
        this.#tasks.approveSchedule(task, request, change),
      canSchedule: (chat, userId) =>
        this.#auth.isOwner({ ...chat, userId }) ||
        this.#auth.isAllowlisted(chat),
      deliver: (schedule, run, delayed) =>
        this.#fireSchedule(schedule, run, delayed),
      expireApprovals: (now, adapterIds) => {
        if (!this.#applyingConfig && !this.#expiry && adapterIds.length)
          this.#expiry = this.#expireApprovals(now, adapterIds)
            .catch(() =>
              log({ level: 'error', event: 'approval.expiry_failed' }),
            )
            .finally(() => {
              this.#expiry = undefined;
            });
      },
      attachedAdapters: () =>
        this.#isStopping() || this.#runtime.transition
          ? []
          : this.#runtime.adapterIds,
      adapterAvailableSince: (id) => this.#runtime.availableSince(id),
      logError: (event, scheduleId) =>
        log({ level: 'error', event, scheduleId }),
      model: (chat) => {
        const current = store.getChat(chat);
        const settings = store.getWorkspaceSettings(chat);
        const agentId = current?.agentId ?? settings?.agentId;
        const selected =
          (agentId && this.#runtime.getAgent(agentId)) ||
          this.#runtime.defaultAgent();
        return (
          current?.model ??
          settings?.model ??
          selected?.config.model ??
          'default'
        );
      },
      owner: (id) => this.#auth.owner(id),
      settings: () => ({
        ...this.#runtime.config.scheduler,
        locale: this.#runtime.config.locale,
        timezone: this.#runtime.config.timezone,
      }),
    });
    if (previews)
      this.#previews = new Previews({
        auth: this.#auth,
        hooks: this.#hooks,
        log,
        store,
        trace: this.#trace,
        providers: previews,
        available: (kind) =>
          (!registry.forFeature('preview', 'tunnel-cloudflare') ||
            Boolean(this.#runtime.config.preview)) &&
          !this.#runtime.disabled(`preview.${kind}`),
        namedConfigured: () =>
          Boolean(previews.named || this.#runtime.config.preview?.named),
        endpoint: (chat, port) => this.#execution.endpoint(chat, port),
        maxTtlMinutes: () => this.#runtime.config.preview?.maxTtlMinutes ?? 60,
      });
    this.#tasks = new Tasks({
      store,
      auth: this.#auth,
      trace: this.#trace,
      hooks: this.#hooks,
      context,
      backend,
      scope,
      summarize: (job) => {
        if (!summary) this.#summaries.enqueue(job);
      },
      outbound: this.#outbound,
      runtime: this.#runtime,
      log,
      tools: [
        ...registry.plugins.flatMap((plugin) => [...(plugin.tools ?? [])]),
        ...this.#scheduler.tools(),
        ...(this.#previews?.tools() ?? []),
        ...this.#execution.workspaceTools(),
        ...(registry.execution('local-sandbox') ? this.#execution.tools() : []),
      ],
    });
  }

  async start(initial?: WorkspaceConfig) {
    if (this.#state !== 'new') throw new Error('Gateway can only start once');
    this.#state = 'starting';
    const { store, workspace, log } = this.#deps;
    const snapshot = initial ?? (await loadConfig(workspace, this.#registry));
    if (this.#isStopping()) return;
    store.interruptTasks(Date.now());
    this.#initialApply = this.#apply(snapshot);
    try {
      await this.#initialApply;
    } finally {
      this.#initialApply = undefined;
    }
    if (this.#isStopping()) return;
    this.#closeWatch = watch(workspace, this.#registry, {
      onConfig: async (next) => {
        if (this.#state !== 'running') return;
        await this.#trace.span('config.reload', {}, () => this.#apply(next));
        log({ level: 'info', event: 'config.reloaded' });
        await this.#reportFailures();
      },
      onError: (error) =>
        log({
          level: 'error',
          event: 'config.reload_failed',
          reason: error instanceof ConfigError ? error.message : undefined,
        }),
    });
    this.#state = 'running';
    this.#scheduler.start();
    if (this.#previews) this.#previews.start();
    else store.closePreviewsOnRestart(Date.now());
    log({ level: 'info', event: 'gateway.started' });
    this.#reportPlatformNotices();
    await this.#reportFailures();
  }

  async #apply(snapshot: WorkspaceConfig) {
    this.#applyingConfig = true;
    try {
      await this.#expiry;
      await this.#runtime.apply(snapshot);
      this.#commandMenus.refresh();
      if (this.#deps.namedPreview) {
        const provider = this.#deps.namedPreview(
          this.#runtime.disabled('preview.named') ? undefined : snapshot,
        );
        await this.#previews?.configureNamed(provider);
      }
    } finally {
      this.#applyingConfig = false;
    }
    if (this.#state === 'running') {
      this.#scheduler.tick();
      this.#reportPlatformNotices();
    }
  }

  #reportFailures() {
    if (this.#environmentNotification || this.#isStopping())
      return this.#environmentNotification;
    const { locale } = this.#runtime.config;
    const failures = failureText(this.#runtime.environmentReports, locale);
    if (!failures) return;
    for (const id of this.#runtime.adapterIds) {
      const owner = this.#auth.owner(id);
      const adapter = this.#runtime.getAdapter(id);
      if (!owner || !adapter) continue;
      this.#environmentNotification = this.#notifyOwner(
        adapter,
        owner,
        `${systemMessages(locale).environment}\n${failures}`,
      );
      return this.#environmentNotification;
    }
  }

  #reportPlatformNotices() {
    if (this.#isStopping() || this.#applyingConfig) return;
    const active = this.#runtime.adapterIds;
    for (const id of this.#runtime.pendingPlatformNotices) {
      if (this.#platformNotifications.has(id)) continue;
      for (const route of [id, ...active.filter((item) => item !== id)]) {
        const adapter = this.#runtime.getAdapter(route);
        if (!adapter) continue;
        const owner = this.#auth.owner(route);
        if (!owner) continue;
        const batch = this.#runtime.takePlatformNotices(id);
        const job = this.#sendPlatformNotices(
          adapter,
          owner,
          id,
          batch,
        ).finally(() => {
          this.#platformNotifications.delete(id);
          this.#reportPlatformNotices();
        });
        this.#platformNotifications.set(id, job);
        break;
      }
    }
  }

  #sendPlatformNotices(
    adapter: PlatformAdapter,
    owner: string,
    id: string,
    notices: PlatformNotice[],
  ) {
    const { locale } = this.#runtime.config;
    const m = systemMessages(locale);
    const text = notices
      .map((notice) => {
        if (notice.kind === 'environment')
          return `${m.environment}\n${failureText([notice.report], locale)}`;
        return notice.kind === 'unavailable'
          ? m.platformUnavailable(id)
          : m.platformRecovered(id);
      })
      .join('\n');
    return this.#notifyOwner(adapter, owner, text, `platform/${id}`);
  }

  async #notifyOwner(
    adapter: PlatformAdapter,
    owner: string,
    text: string,
    target?: string,
  ) {
    try {
      await this.#outbound.send(adapter, { chatId: owner, text });
    } catch {
      this.#deps.log({
        level: 'warn',
        event: 'environment.owner_notification_failed',
        adapterId: adapter.id,
        target,
      });
    }
  }

  async idle() {
    while (this.#inbound.size) await Promise.allSettled(this.#inbound);
    await this.#tasks.idle();
    await this.#commandMenus.idle();
    await this.#environmentNotification;
    while (this.#platformNotifications.size)
      await Promise.allSettled(this.#platformNotifications.values());
  }

  stop() {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop() {
    this.#state = 'stopping';
    this.#runtime.cancelStarts();
    this.#commandMenus.stop();
    this.#scheduler.stop();
    try {
      await this.#closeWatch?.();
      await this.#initialApply;
    } finally {
      try {
        await this.#chatSetup.stop();
        await this.#summaries.stop();
        await this.#expiry;
        await this.#runtime.stop();
        await this.idle();
        await this.#scheduler.idle();
        await this.#previews?.stop();
        await this.#execution.stop();
      } finally {
        await this.#hooks.stop();
        await this.#trace.flush();
      }
    }
    this.#deps.log({ level: 'info', event: 'gateway.stopped' });
  }

  #isStopping() {
    return this.#state === 'stopping';
  }

  #receive(adapter: PlatformAdapter, event: PlatformInboundEvent) {
    if (this.#isStopping()) return Promise.resolve();
    const work = this.#process(adapter, event);
    this.#inbound.add(work);
    void work.then(
      () => this.#inbound.delete(work),
      () => {
        this.#inbound.delete(work);
        this.#deps.log({
          level: 'error',
          event: 'inbound.failed',
          adapterId: adapter.id,
        });
      },
    );
    return work;
  }

  async #process(adapter: PlatformAdapter, inbound: PlatformInboundEvent) {
    const { store } = this.#deps;
    if (inbound.type === 'chat-migrated')
      this.#commandMenus.migrateChat(adapter, inbound);
    const event = inbound.type === 'chat-migrated' ? inbound.message : inbound;
    if (!event) return;
    const chat: ChatRef = {
      adapterId: adapter.id,
      chatId: conversationId(event),
    };
    if (event.type === 'delete') {
      this.#trace.span('inbound.deleted', { ...chat }, () => {
        store.markDeleted(chat, event.messageId);
        this.#tasks.cancelSource(chat, event.messageId);
      });
      return;
    }
    if (event.type === 'callback') {
      store.recordUser({
        adapterId: chat.adapterId,
        userId: event.userId,
        display: event.userDisplay ?? null,
        username: event.userUsername,
      });
      const result = this.#resolveApproval(adapter, {
        ...chat,
        callbackId: event.callbackId,
        messageId: event.messageId,
        userId: event.userId,
      });
      await this.#approvalFeedback(
        adapter,
        chat,
        {
          chatId: event.chatId,
          messageId: event.messageId,
          queryId: event.queryId,
          decision: result?.decision,
          ...(result && 'record' in result
            ? result.record.promptFormat
            : undefined),
        },
        result?.decision !== 'expired',
      );
      if (result && 'record' in result)
        await this.#approvalOutcome(adapter, result);
      return;
    }
    const user = {
      adapterId: chat.adapterId,
      userId: event.userId,
      display: event.userDisplay ?? null,
      username: event.userUsername,
    };
    const parsed = parseCommand(event.text, adapter.botIdentity?.username);
    const command = parsed === 'other-bot' ? undefined : parsed;
    if (
      inbound.type !== 'chat-migrated' &&
      (await this.#chatSetup.receive(
        adapter,
        chat,
        event,
        parsed === 'other-bot' ? parsed : parsed?.name,
      ))
    ) {
      store.recordUser(user);
      return;
    }
    const privateCommand =
      command?.name === 'pair' ||
      command?.name === 'login' ||
      command?.name === 'add';
    const stored = this.#trace.span('inbound.received', { ...chat }, () =>
      store.recordInbound(
        {
          ...chat,
          kind: event.chatKind,
          title: event.chatTitle ?? null,
        },
        user,
        {
          ...chat,
          messageId: event.messageId,
          direction: 'inbound',
          userId: event.userId,
          replyTo: event.replyTo ?? null,
          threadId: event.threadId ?? null,
          text:
            privateCommand && command?.args
              ? `/${command.name} [redacted]`
              : event.text,
          raw: privateCommand ? null : (event.raw ?? null),
        },
        event.edited,
      ),
    );
    if (!stored || inbound.type === 'chat-migrated') return;
    this.#commandMenus.observeChat(adapter, event);
    if (event.edited) return;
    const message = privateCommand
      ? { ...event, raw: undefined, text: stored.text }
      : event;
    await this.#hooks.emit('inbound.received', { chat, message });
    if (this.#isStopping() || parsed === 'other-bot') return;

    if (event.replyTo) {
      const result = this.#resolveApproval(adapter, {
        ...chat,
        userId: event.userId,
        replyTo: event.replyTo,
        text: event.text,
      });
      if (result) {
        if ('record' in result) {
          await this.#approvalFeedback(adapter, chat, {
            chatId: event.chatId,
            messageId: event.replyTo,
            decision: result.decision,
            ...result.record.promptFormat,
          });
          await this.#approvalOutcome(adapter, result);
        }
        return;
      }
    }

    const owner = this.#auth.isOwner({
      adapterId: adapter.id,
      userId: event.userId,
    });
    if (command) {
      await this.#trace.span(
        'trigger.command',
        { ...chat, command: command.name },
        () => this.#command(adapter, chat, message, stored.seq, owner, command),
      );
      return;
    }

    const triggered = this.#trace.span('trigger.decided', { ...chat }, () =>
      shouldTrigger(event, owner, this.#auth.isAllowlisted(chat)),
    );
    await this.#hooks.emit('trigger.decided', { chat, message, triggered });
    if (triggered && !this.#isStopping()) {
      this.#trace.span('task.dispatch', { ...chat }, () =>
        this.#tasks.dispatch(adapter, chat, { message, seq: stored.seq }),
      );
    }
  }

  async #fireSchedule(
    schedule: ScheduleRecord,
    run: ScheduleRun,
    delayed: boolean,
  ): Promise<ScheduleRun['status']> {
    const { store } = this.#deps;
    const { id, adapterId, chatId, createdBy, action } = schedule;
    const adapter = this.#runtime.getAdapter(adapterId);
    const chat = { adapterId, chatId };
    const origin = store.getChat(chat);
    if (!adapter || !origin) return 'skipped';
    const attrs = { ...chat, scheduleId: id, dueAt: run.dueAt };
    const delayNote = delayed
      ? systemMessages(this.#runtime.config.locale).delayed(
          new Date(run.dueAt).toISOString(),
        ) + '\n\n'
      : '';
    return this.#trace.span('schedule.fire', attrs, async () => {
      await this.#hooks.emit('schedule.fired', { scheduleId: id });
      if (action.kind === 'message') {
        const reminder =
          action.mentions === undefined
            ? prepareReminder(action.text, schedule.mentions, (userId) =>
                store.getUserDisplay({ adapterId, userId }),
              )
            : { mentions: action.mentions, text: action.text };
        try {
          await this.#outbound.send(adapter, {
            ...schedule.target,
            text: delayNote + reminder.text,
            entities: reminderEntities(reminder.mentions).map((entity) => ({
              ...entity,
              offset: entity.offset + delayNote.length,
            })),
            parseTextMentions: false,
          });
          return 'sent';
        } catch (error) {
          this.#deps.log({
            level: 'error',
            event: 'schedule.delivery_failed',
            scheduleId: id,
          });
          return error instanceof SendFailure && !error.deliveryUnknown
            ? 'failed'
            : 'delivery-unknown';
        }
      }
      const target: Omit<OutboundMessage, 'text'> = {
        ...schedule.target,
        mentions: schedule.mentions,
      };
      const event: ScheduledInboundEvent = {
        type: 'schedule',
        scheduleId: id,
        ...schedule.address,
        chatKind: origin.kind,
        userId: createdBy,
        messageId: `schedule:${id}:${run.dueAt}`,
        text: `[Scheduled task] ${action.prompt}`,
      };
      const message: InboundMessage = { ...event, type: 'message' };
      const stored = this.#trace.span('inbound.scheduled', attrs, () =>
        store.recordInbound(
          { ...chat, kind: origin.kind, title: origin.title },
          { adapterId, userId: createdBy, display: null },
          {
            ...chat,
            messageId: event.messageId,
            direction: 'inbound',
            userId: createdBy,
            replyTo: null,
            threadId: event.threadId ?? null,
            text: event.text,
            raw: { scheduleId: event.scheduleId, dueAt: run.dueAt },
          },
        ),
      );
      if (!stored) return 'skipped';
      const status = await this.#tasks.dispatch(adapter, chat, {
        message,
        seq: stored.seq,
        scheduled: {
          model: action.model,
          target,
          delayNote,
          allowTextMentions:
            schedule.deliveryApprovedBy !== null &&
            schedule.deliveryApprovedBy === this.#auth.owner(adapterId),
        },
      });
      if (
        status === 'sent' ||
        status === 'completed' ||
        status === 'delivery-unknown'
      )
        return status;
      return status === 'cancelled' ? 'skipped' : 'failed';
    });
  }

  #resolveApproval(
    adapter: PlatformAdapter,
    input: Parameters<Auth['resolveApproval']>[0],
  ): LinkedApproval | { decision: 'expired' } | undefined {
    const { store } = this.#deps;
    const result = this.#trace.span(
      'approval.resolve',
      {
        adapterId: input.adapterId,
        chatId: input.chatId,
      },
      () =>
        this.#auth.resolveApproval(input, (approval) => {
          const source = store.getTask(approval.taskId);
          if (source && this.#canCompleteApproval(source, approval.requester))
            return this.#runtime.config.scheduler?.maxActivePerUser ?? 20;
        }),
    );
    if (!result) return;
    if (result.decision === 'expired') return result;
    const record = store.getApproval(result.id);
    if (!record) return;
    const source = store.getTask(record.taskId);
    const reaction =
      source &&
      this.#outbound.reactToApproval(
        adapter,
        source,
        result.approved ? 'approved' : 'denied',
      );
    const live = this.#tasks.resolveApproval(result.id, {
      ...result,
      reaction,
    });
    return { ...result, live, reaction, record };
  }

  async #expireApprovals(now: number, adapterIds: readonly string[]) {
    const { store } = this.#deps;
    const expired = store.expireApprovals(now, adapterIds);
    for (const { id } of expired) this.#tasks.resolveApproval(id, 'expired');
    for (const record of expired) {
      const { adapterId, chatId, id, taskId, promptMessageId, promptFormat } =
        record;
      const chat = { adapterId, chatId };
      await this.#trace.span(
        'approval.expired',
        { ...chat, taskId, approvalId: id },
        async () => {
          const adapter = this.#runtime.getAdapter(adapterId);
          if (!adapter) return;
          const address = store.deliveryAddress(chat);
          if (address && promptMessageId)
            await this.#approvalFeedback(adapter, chat, {
              ...promptFormat,
              chatId: address.chatId,
              messageId: promptMessageId,
              decision: 'expired',
            });
          const source = store.getTask(taskId);
          if (!source) return;
          await this.#outbound.reactToApproval(adapter, source, 'expired');
          const m = approvalMessages(this.#runtime.config.locale).outcomes;
          const continuation = record.continuation;
          const text =
            continuation?.kind === 'schedule'
              ? m.scheduleExpired(continuation.change.schedule.id.slice(0, 6))
              : m.expired;
          await this.#notifyApproval(adapter, source, text);
        },
      );
    }
  }

  #canCompleteApproval(chat: ChatRef, requester: string) {
    return (
      Boolean(this.#deps.store.getChat(chat)) &&
      (this.#auth.isAllowlisted(chat) ||
        this.#auth.isOwner({ ...chat, userId: requester }))
    );
  }

  async #approvalOutcome(adapter: PlatformAdapter, result: LinkedApproval) {
    if (result.live) return;
    await result.reaction;
    const { store, log } = this.#deps;
    const { record, approved, scheduleApplied } = result;
    const source = store.getTask(record.taskId);
    if (!source) return;
    const m = approvalMessages(this.#runtime.config.locale).outcomes;
    const continuation = record.continuation;
    let text = approved ? m.interrupted : m.denied;
    if (continuation?.kind === 'schedule') {
      const { schedule, previous } = continuation.change;
      const ref = schedule.id.slice(0, 6);
      text = !approved
        ? m.scheduleDenied(ref)
        : !scheduleApplied
          ? m.scheduleFailed(ref)
          : previous
            ? m.scheduleUpdated(ref)
            : m.scheduleCreated(ref);
    } else if (approved && continuation?.kind === 'tool') {
      text = m.failed;
      try {
        if (
          this.#canCompleteApproval(source, record.requester) &&
          (await this.#tasks.runApprovedTool(adapter, record, source))
        )
          text = m.completed;
      } catch {
        log({
          level: 'error',
          event: 'approval.action_failed',
          taskId: source.id,
        });
      }
    }
    await this.#notifyApproval(adapter, source, text);
  }

  async #notifyApproval(
    adapter: PlatformAdapter,
    source: TaskRecord,
    text: string,
  ) {
    const { store, log } = this.#deps;
    const address = store.deliveryAddress(source);
    if (!address) return;
    const message = store.getMessage(source, source.sourceMessageId);
    try {
      await this.#outbound.send(adapter, {
        chatId: address.chatId,
        threadId: address.threadId,
        replyTo:
          message && !message.deleted ? source.sourceMessageId : undefined,
        text,
      });
    } catch {
      log({
        level: 'error',
        event: 'approval.outcome_failed',
        taskId: source.id,
      });
    }
  }

  async #approvalFeedback(
    adapter: PlatformAdapter,
    chat: ChatRef,
    feedback: Omit<ApprovalFeedback, 'decisionText' | 'notice' | 'prompt'>,
    edit = true,
  ) {
    if (!adapter.respondToApproval) return;
    const prompt =
      edit && feedback.decision
        ? this.#deps.store.getMessage(chat, feedback.messageId)?.text
        : undefined;
    try {
      await this.#trace.span('approval.feedback', { ...chat }, () =>
        adapter.respondToApproval?.({
          ...feedback,
          ...approvalDecisionText(
            this.#runtime.config.locale,
            feedback.decision,
          ),
          ...(!edit ? { decisionText: undefined } : undefined),
          prompt,
        }),
      );
    } catch {
      this.#deps.log({
        level: 'error',
        event: 'approval.feedback_failed',
        adapterId: adapter.id,
      });
    }
  }

  async #command(
    adapter: PlatformAdapter,
    chat: ChatRef,
    message: InboundMessage,
    seq: number,
    owner: boolean,
    { name, args }: Command,
  ) {
    const { store } = this.#deps;
    const { locale } = this.#runtime.config;
    const m = systemMessages(locale);
    const send = (text: string) =>
      this.#outbound.send(adapter, reply(message, text));
    if (name === 'pair') {
      if (message.chatKind !== 'dm' || this.#auth.owner(adapter.id)) return;
      const paired = this.#auth.claimPairing(adapter.id, message.userId, args);
      if (paired) this.#commandMenus.sync(adapter);
      await send(paired ? m.pairing.success : m.pairing.invalid);
      if (paired) {
        this.#reportPlatformNotices();
        await this.#reportFailures();
      }
      return;
    }
    if (!owner) return;
    switch (name) {
      case 'add': {
        const match =
          /^(agent|platform)\s+([A-Za-z0-9_.:-]+)(?:\s+--id\s+([A-Za-z0-9_.:-]+))?$/.exec(
            args,
          );
        if (!match?.[2]) {
          await send(m.addUsage);
          break;
        }
        await this.#chatSetup.start(adapter, message, {
          mode: 'add',
          category: match[1] === 'agent' ? 'agent' : 'platform',
          kind: match[2],
          id: match[3] ?? match[2],
        });
        break;
      }
      case 'login':
        if (!args) await send(m.loginUsage);
        else
          await this.#chatSetup.start(adapter, message, {
            mode: 'login',
            id: args,
          });
        break;
      case 'allow':
      case 'deny':
        store.setAllowlisted(chat, name === 'allow');
        if (name === 'deny') this.#tasks.cancelApprovals(chat);
        await send(name === 'allow' ? m.allowlisted : m.removedFromAllowlist);
        break;
      case 'agent':
        if (!this.#runtime.getAgent(args)) {
          await send(this.#runtime.unavailable(args) || m.agentUnavailable);
          break;
        }
        if (store.getChat(chat)?.agentId !== args) {
          this.#tasks.invalidateSession(chat);
          store.setChatRoute(chat, { agentId: args });
        }
        await send(m.agentSet(args));
        break;
      case 'model':
        if (!args) {
          await send(m.modelUsage);
          break;
        }
        if (store.getChat(chat)?.model !== args) {
          this.#tasks.invalidateSession(chat);
          store.setChatRoute(chat, { model: args });
        }
        await send(m.modelSet(args));
        break;
      case 'compact':
        if (args) await send(m.compactUsage);
        else
          this.#tasks.dispatch(adapter, chat, { message, seq, compact: true });
        break;
      case 'previews': {
        const open = this.#previews?.list(chat.adapterId) ?? [];
        await send(
          open.length
            ? open
                .map((item) =>
                  m.preview(
                    item.id,
                    item.url,
                    item.port,
                    new Date(item.expiresAt).toISOString(),
                  ),
                )
                .join('\n')
            : m.noPreviews,
        );
        break;
      }
      case 'preview': {
        const match = /^close\s+(\S+)$/.exec(args);
        if (!match?.[1]) {
          await send(m.previewCloseUsage);
          break;
        }
        const closed = await this.#previews?.ownerClose(
          chat.adapterId,
          match[1],
        );
        await send(closed ? m.previewClosed : m.previewMissing);
        break;
      }
      case 'status':
        await send(
          [
            m.status(this.#runtime.adapterCount, this.#runtime.agentCount),
            failureText(this.#runtime.reports, locale),
          ]
            .filter(Boolean)
            .join('\n'),
        );
        break;
    }
  }
}

export { GuidedSetup } from './setup.ts';
export type { SetupIO, SetupRequest } from './setup.ts';

export { systemInstallPlan } from './system-setup.ts';

export { SetupError } from '@tsugimori/plugin-sdk';
export type { SetupDependencies } from '@tsugimori/plugin-sdk';
