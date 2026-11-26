import type { Config, WorkspaceConfig } from '@tsugimori/config';
import type { SummaryProvider } from '@tsugimori/context';
import type {
  AdminReader,
  ApprovalFeedback,
  ChatRef,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
  PlatformInboundEvent,
  PromptChoice,
  ScheduledInboundEvent,
  SetupDependencies,
  TunnelProvider,
} from '@tsugimori/plugin-sdk';
import type {
  ApprovalRecord,
  ChatRoute,
  RemovalTarget,
  ScheduleRecord,
  ScheduleRun,
  Store,
  TaskRecord,
} from '@tsugimori/storage';

import { approvalCallbackId, Auth } from '@tsugimori/auth';
import {
  ConfigError,
  configuredOwner,
  loadConfig,
  watch,
} from '@tsugimori/config';
import { ContextAssembler } from '@tsugimori/context';
import { SendFailure, SetupError } from '@tsugimori/plugin-sdk';
import {
  prepareReminder,
  reminderEntities,
  Scheduler,
  scheduleRecordTime,
} from '@tsugimori/scheduler';
import { Tracer } from '@tsugimori/trace';
import { isDeepStrictEqual } from 'node:util';

import type { Command } from './chat-commands.ts';
import type { Logger } from './hooks.ts';
import type { PreviewProviders } from './previews.ts';
import type { RemovalPlan } from './removal.ts';
import type { PlatformNotice } from './runtime.ts';

import { untilAborted } from './abort.ts';
import { acceptsServiceTier, formatServiceTier } from './agent-settings.ts';
import { approvalDecisionText, approvalMessages } from './approval-messages.ts';
import { ChatChoices, supportsChoices } from './chat-choices.ts';
import { chatCommands, parseCommand } from './chat-commands.ts';
import { ChatRemoval } from './chat-removal.ts';
import { ChatSetup } from './chat-setup.ts';
import { EnvironmentChecks, failureText } from './checks.ts';
import { CommandMenus } from './command-menus.ts';
import { Executions, sandboxScope } from './executions.ts';
import { historyTools } from './history.ts';
import { HookRunner, logToStderr } from './hooks.ts';
import { conversationId, Outbound } from './outbound.ts';
import { Previews } from './previews.ts';
import { PluginRegistry } from './registry.ts';
import { removalMessages } from './removal-messages.ts';
import { Removal } from './removal.ts';
import { Runtime } from './runtime.ts';
import { GuidedSetup } from './setup.ts';
import { statusCard } from './status.ts';
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
  reaction?: Promise<boolean>;
  record: ApprovalRecord;
};

function commandChoices(values: Iterable<string>): PromptChoice[] {
  return [...new Set(values)].map((value) => ({ value, label: value }));
}

const choicesPerPage = 80;

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
  readonly #chatRemoval: ChatRemoval;
  readonly removal: Removal;
  readonly #chatChoices: ChatChoices;
  readonly #commandMenus: CommandMenus;
  readonly #platformNotifications = new Map<string, Promise<void>>();
  readonly #ownerDeliveries = new Map<Promise<void>, string>();
  readonly #migratedPrompts = new Map<string, Promise<void>>();
  readonly #inbound = new Map<Promise<void>, string>();
  #configUpdates = Promise.resolve();
  #reloadPending = false;
  #activeRemoval?: { plan: RemovalPlan; work: Promise<string> };
  #applyingConfig = false;
  #closeWatch?: ReturnType<typeof watch>;
  #environmentNotification?: Promise<void>;
  #expiry?: Promise<void>;
  #initialApply?: Promise<void>;
  #stopping?: Promise<void>;
  #startedAt = 0;
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
          failureReason: approval.failureReason,
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
          this.#restoreApprovalPrompts();
          this.#scheduler.tick();
          void this.#reportFailures();
        }
        this.#reportPlatformNotices();
      },
      receive: (adapter, event) => this.#receive(adapter, event),
      interrupt: async (adapters, agents) => {
        const target = this.#activeRemoval?.plan;
        await this.#tasks.interrupt(
          adapters,
          agents,
          target?.category === 'agent' ? target.id : undefined,
        );
        if (target) await this.#summaries.interrupt(target);
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
      onMigration: (adapter, chatId, newChatId) => {
        this.#tasks.migrateChat(adapter.id, chatId, newChatId);
        this.#restoreApprovalPrompts([adapter]);
      },
      owner: (id) => this.#auth.owner(id),
      runtime: this.#runtime,
      store,
      trace: this.#trace,
    });
    this.#chatChoices = new ChatChoices({
      isOwner: (adapter, userId) =>
        !this.#isStopping() &&
        this.#runtime.getAdapter(adapter.id) === adapter &&
        this.#auth.isOwner({ adapterId: adapter.id, userId }),
      locale: () => this.#runtime.config.locale,
      log,
      trace: this.#trace,
    });
    this.#chatSetup = new ChatSetup({
      choices: this.#chatChoices,
      setup: new GuidedSetup({ ...setup, store, workspace, registry }),
      isOwner: (adapterId, userId) => this.#auth.isOwner({ adapterId, userId }),
      runtime: this.#runtime,
      log,
      store,
      trace: this.#trace,
    });
    this.removal = new Removal({
      store,
      workspace,
      registry,
      trace: this.#trace,
    });
    this.#chatRemoval = new ChatRemoval({
      choices: this.#chatChoices,
      execute: (plan, actor, adapterId) =>
        this.removeInstance(plan, actor, adapterId),
      isOwner: (adapterId, userId) => this.#auth.isOwner({ adapterId, userId }),
      log,
      outbound: this.#outbound,
      removal: this.removal,
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
          : this.#runtime.adapterIds.filter(
              (id) => !this.#removingPlatform(id),
            ),
      canFire: (schedule) =>
        schedule.action.kind !== 'agent' || !this.#removingAgentRoute(schedule),
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
      pushFailure: (chat, attrs) => this.#schedulePushFailure(chat, attrs),
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
        ...historyTools({
          store,
          timezone: () => this.#runtime.config.timezone,
        }),
        ...(this.#previews?.tools() ?? []),
        ...this.#execution.workspaceTools(),
        ...(registry.execution('local-sandbox') ? this.#execution.tools() : []),
      ],
    });
  }

  async start(initial?: WorkspaceConfig) {
    if (this.#state !== 'new') throw new Error('Gateway can only start once');
    this.#state = 'starting';
    this.#startedAt = Date.now();
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
      onConfig: async () => {
        if (this.#state !== 'running') return;
        if (await this.#reload()) {
          log({ level: 'info', event: 'config.reloaded' });
          await this.#reportFailures();
        }
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

  #reload(removal?: { current: Config; next: Config; plan: RemovalPlan }) {
    const work = this.#configUpdates.then(() =>
      this.#trace.span('config.reload', {}, async () => {
        if (!removal && this.#activeRemoval) {
          this.#reloadPending = true;
          return false;
        }
        const snapshot = await loadConfig(this.#deps.workspace, this.#registry);
        if (removal && !isDeepStrictEqual(snapshot.config, removal.current))
          throw new SetupError(removalMessages(removal.plan.locale).changed);
        if (removal) {
          this.#reloadPending = true;
          await this.#apply(
            { ...snapshot, config: removal.next },
            removal.plan,
          );
        } else {
          await this.#apply(snapshot);
        }
        return true;
      }),
    );
    // Each caller handles its reload failure. Keep the queue available for the next configuration.
    this.#configUpdates = work.then(
      () => {},
      () => {},
    );
    return work;
  }

  async #apply(snapshot: WorkspaceConfig, removal?: RemovalTarget) {
    this.#applyingConfig = true;
    try {
      await this.#expiry;
      await this.#runtime.apply(snapshot, removal);
      this.#commandMenus.refresh();
      this.#restoreApprovalPrompts();
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

  removeInstance(plan: RemovalPlan, actor?: string, adapterId?: string) {
    if (this.#activeRemoval || this.#state !== 'running')
      throw new SetupError(removalMessages(plan.locale).busy);
    const work = this.removal
      .execute(plan, {
        actor,
        adapterId,
        detach: async (current, next) => {
          await this.#reload({ current, next, plan });
          if (plan.category === 'platform') {
            this.#chatRemoval.stop(plan.id);
            await this.#chatSetup.detach(plan.id);
            const inbound = [...this.#inbound]
              .filter(([, id]) => id === plan.id)
              .map(([job]) => job);
            await Promise.allSettled(inbound);
            await this.#commandMenus.detach(plan.id);
            await this.#scheduler.idle(plan.id);
            const deliveries = [...this.#ownerDeliveries]
              .filter(([, id]) => id === plan.id)
              .map(([job]) => job);
            await Promise.allSettled(deliveries);
            await this.#platformNotifications.get(plan.id);
            await this.#migratedPrompts.get(plan.id);
          }
        },
      })
      .finally(() => {
        this.#activeRemoval = undefined;
        this.#scheduler.tick();
        if (this.#reloadPending && this.#state === 'running') {
          this.#reloadPending = false;
          void this.#reload().catch(() =>
            this.#deps.log({ level: 'error', event: 'config.reload_failed' }),
          );
        }
      });
    this.#activeRemoval = { plan, work };
    return work;
  }

  #removingPlatform(id: string) {
    const target = this.#activeRemoval?.plan;
    return target?.category === 'platform' && target.id === id;
  }

  #removingAgentRoute(chat: ChatRef) {
    const agent = this.#activeRemoval?.plan;
    return (
      agent?.category === 'agent' &&
      (agent.rows.routes.some(
        (ref) => ref.adapterId === chat.adapterId && ref.chatId === chat.chatId,
      ) ||
        this.#tasks.route(chat).agentId === agent.id)
    );
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
      if (
        !owner ||
        !adapter ||
        (adapter.capabilities.outboundPush ?? 'free') !== 'free'
      )
        continue;
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
        if (
          !adapter ||
          (adapter.capabilities.outboundPush ?? 'free') !== 'free'
        )
          continue;
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

  #notifyOwner(
    adapter: PlatformAdapter,
    owner: string,
    text: string,
    target?: string,
  ) {
    if (this.#removingPlatform(adapter.id)) return Promise.resolve();
    const job = this.#outbound
      .send(adapter, { chatId: owner, text })
      .then(
        () => {},
        () =>
          this.#deps.log({
            level: 'warn',
            event: 'environment.owner_notification_failed',
            adapterId: adapter.id,
            target,
          }),
      )
      .finally(() => this.#ownerDeliveries.delete(job));
    this.#ownerDeliveries.set(job, adapter.id);
    return job;
  }

  async idle() {
    while (this.#inbound.size) await Promise.allSettled(this.#inbound.keys());
    await this.#tasks.idle();
    await this.#commandMenus.idle();
    while (this.#migratedPrompts.size)
      await Promise.allSettled(this.#migratedPrompts.values());
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
    await Promise.allSettled(
      this.#activeRemoval ? [this.#activeRemoval.work] : [],
    );
    this.#chatRemoval.stop();
    this.#runtime.cancelStarts();
    this.#commandMenus.stop();
    this.#scheduler.stop();
    try {
      await this.#closeWatch?.();
      await this.#initialApply;
      await this.#configUpdates;
    } finally {
      try {
        await this.#chatSetup.stop();
        await this.#chatChoices.stop();
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
    if (this.#isStopping() || this.#removingPlatform(adapter.id))
      return Promise.resolve();
    const work = this.#process(adapter, event);
    this.#inbound.set(work, adapter.id);
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

  #restoreApprovalPrompts(
    adapters = this.#runtime.adapterIds.flatMap((id) => {
      const adapter = this.#runtime.getAdapter(id);
      return adapter ? [adapter] : [];
    }),
  ) {
    if (this.#isStopping()) return;
    const { log, store } = this.#deps;
    const { buttons } = approvalMessages(this.#runtime.config.locale);
    for (const adapter of adapters) {
      for (const approval of store.listMigratedApprovalPrompts(
        adapter.id,
        Date.now(),
      )) {
        const { id, chatId, migratedPrompt, promptFormat } = approval;
        if (!migratedPrompt || this.#migratedPrompts.has(id)) continue;
        const work = this.#outbound
          .send(
            adapter,
            {
              chatId,
              text: migratedPrompt,
              approval: true,
              parseTextMentions: false,
              entities:
                promptFormat?.entities ??
                (promptFormat?.pre && [{ ...promptFormat.pre, type: 'pre' }]),
              buttons: adapter.capabilities.inlineButtons
                ? [
                    {
                      id: approvalCallbackId(id, 'approve'),
                      label: buttons.approve,
                    },
                    { id: approvalCallbackId(id, 'deny'), label: buttons.deny },
                  ]
                : undefined,
            },
            {
              onReceipt: ({ messageId }) =>
                store.linkApproval(id, messageId, promptFormat ?? undefined),
            },
          )
          .then(
            () => undefined,
            () =>
              log({
                level: 'error',
                event: 'approval.migration_prompt_failed',
                adapterId: adapter.id,
                taskId: approval.taskId,
              }),
          )
          .finally(() => this.#migratedPrompts.delete(id));
        this.#migratedPrompts.set(id, work);
      }
    }
  }

  async #process(adapter: PlatformAdapter, inbound: PlatformInboundEvent) {
    const { store } = this.#deps;
    if (inbound.type === 'chat-migrated')
      this.#commandMenus.migrateChat(adapter, inbound);
    const original =
      inbound.type === 'chat-migrated' ? inbound.message : inbound;
    if (!original) return;
    const { chatId } = store.resolveChat({
      adapterId: adapter.id,
      chatId: original.chatId,
    });
    const migratedFrom =
      chatId === original.chatId ? undefined : original.chatId;
    const event =
      migratedFrom === undefined
        ? original
        : original.type === 'message'
          ? {
              ...original,
              chatId,
              chatKind: 'supergroup' as const,
              chatTitle: undefined,
              migratedFromChatId: migratedFrom,
              threadId: undefined,
              replyTo: undefined,
            }
          : { ...original, chatId, threadId: undefined };
    const chat: ChatRef = {
      adapterId: adapter.id,
      chatId: conversationId(event),
    };
    if (event.type === 'delete') {
      this.#trace.span('inbound.deleted', { ...chat }, () => {
        store.markDeleted(chat, event.messageId, migratedFrom);
        this.#tasks.cancelSource(chat, event.messageId, migratedFrom);
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
      if (
        await this.#chatChoices.receive(
          adapter,
          event,
          migratedFrom !== undefined,
        )
      )
        return;
      const result =
        migratedFrom === undefined
          ? this.#resolveApproval(adapter, {
              ...chat,
              callbackId: event.callbackId,
              messageId: event.messageId,
              userId: event.userId,
            })
          : undefined;
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
      command?.name === 'cancel' &&
      (await this.#chatRemoval.receive(adapter, chat, event, true))
    )
      return;
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
    if (
      inbound.type !== 'chat-migrated' &&
      parsed !== 'other-bot' &&
      (await this.#chatRemoval.receive(adapter, chat, event, false))
    )
      return;
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
          migratedFromChatId: migratedFrom,
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
      const finish = owner
        ? this.#chatChoices.claimReply(adapter, message, command)
        : undefined;
      await this.#trace.span(
        'trigger.command',
        { ...chat, command: command.name },
        async () => {
          try {
            await this.#command(
              adapter,
              chat,
              message,
              stored.seq,
              owner,
              command,
              finish,
            );
          } catch (error) {
            await finish?.(
              systemMessages(this.#runtime.config.locale).choices.failed,
            );
            throw error;
          }
        },
      );
      return;
    }

    const triggered = this.#trace.span('trigger.decided', { ...chat }, () =>
      shouldTrigger(event, owner, this.#auth.isAllowlisted(chat)),
    );
    await this.#hooks.emit('trigger.decided', { chat, message, triggered });
    if (
      triggered &&
      !this.#isStopping() &&
      !this.#removingPlatform(adapter.id) &&
      !this.#removingAgentRoute(chat)
    ) {
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
    const metered =
      this.#runtime.getAdapter(adapterId)?.capabilities.outboundPush ===
      'metered';
    const attrs = {
      adapterId,
      chatId,
      scheduleId: id,
      dueAt: run.dueAt,
      ...(metered && { 'push.metered': true }),
    };
    const delayNote = delayed
      ? systemMessages(this.#runtime.config.locale).delayed(
          new Date(run.dueAt).toISOString(),
        ) + '\n\n'
      : '';
    return this.#trace.span('schedule.fire', attrs, async () => {
      await this.#hooks.emit('schedule.fired', { scheduleId: id });
      const chat = store.resolveChat({ adapterId, chatId });
      const adapter = this.#runtime.getAdapter(adapterId);
      const origin = store.getChat(chat);
      if (
        !adapter ||
        !origin ||
        !this.#canCompleteApproval(chat, createdBy) ||
        this.#removingPlatform(adapterId) ||
        (action.kind === 'agent' && this.#removingAgentRoute(chat))
      )
        return 'skipped';
      if (action.kind === 'message') {
        const reminder =
          action.mentions === undefined
            ? prepareReminder(action.text, schedule.mentions, (userId) =>
                store.getUserDisplay({ adapterId, userId }),
              )
            : { mentions: action.mentions, text: action.text };
        try {
          await this.#outbound.send(
            adapter,
            {
              ...schedule.target,
              text: delayNote + reminder.text,
              entities: reminderEntities(reminder.mentions).map((entity) => ({
                ...entity,
                offset: entity.offset + delayNote.length,
              })),
              parseTextMentions: false,
            },
            { scheduled: true },
          );
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
        chatId: store.resolveChat({
          adapterId,
          chatId: schedule.address.chatId,
        }).chatId,
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

  #schedulePushFailure(
    chat: ChatRef,
    attrs: {
      approvalId?: string;
      dueAt?: number;
      scheduleId?: string;
      taskId?: string;
    },
  ) {
    if (
      this.#runtime.getAdapter(chat.adapterId)?.capabilities.outboundPush !==
      'none'
    )
      return;
    const reason =
      'Scheduled delivery is unavailable on this platform. It only supports replies to incoming messages.';
    this.#trace.record(
      'schedule.push_unavailable',
      { ...chat, ...attrs, reason },
      0,
      'error',
    );
    return reason;
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
        this.#auth.resolveApproval(input, (approval, schedule) => {
          const failure = this.#schedulePushFailure(
            {
              adapterId: schedule.adapterId,
              chatId: conversationId(schedule.target),
            },
            {
              taskId: approval.taskId,
              approvalId: approval.id,
              scheduleId: schedule.id,
            },
          );
          if (failure) return failure;
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
    const reacted = await result.reaction;
    const { store, log } = this.#deps;
    const { record, approved, scheduleApplied } = result;
    const source = store.getTask(record.taskId);
    if (!source) return;
    if (result.live && (reacted || !source.sourceChatId)) return;
    const { locale } = this.#runtime.config;
    const m = approvalMessages(locale).outcomes;
    const continuation = record.continuation;
    let text = approved ? m.interrupted : m.denied;
    if (continuation?.kind === 'schedule') {
      const { schedule, previous } = continuation.change;
      const ref = schedule.id.slice(0, 6);
      if (!approved) text = m.scheduleDenied(ref);
      else if (!scheduleApplied) text = m.scheduleFailed(ref);
      else {
        const timing =
          schedule.trigger.kind === 'once'
            ? undefined
            : scheduleRecordTime(schedule, locale, Date.now());
        text = previous
          ? m.scheduleUpdated(ref, timing)
          : m.scheduleCreated(ref, timing);
      }
    } else if (result.live) {
      text = approvalDecisionText(locale, result.decision).decisionText ?? text;
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
    if ((adapter.capabilities.outboundPush ?? 'free') !== 'free') return;
    const { store, log } = this.#deps;
    const address = store.deliveryAddress(source);
    if (!address) return;
    const message = store.getMessage(
      store.resolveChat(source),
      source.sourceMessageId,
      source.sourceChatId ?? '',
    );
    try {
      await this.#outbound.send(adapter, {
        chatId: address.chatId,
        threadId: address.threadId,
        replyTo:
          message && !message.deleted && !source.sourceChatId
            ? source.sourceMessageId
            : undefined,
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
        ? this.#deps.store.getMessage(chat, feedback.messageId, '')?.text
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

  #chatAgentSetting(
    chat: ChatRef,
    name: 'fast' | 'model' | 'thinking',
    args: string,
  ) {
    const { store } = this.#deps;
    const m = systemMessages(this.#runtime.config.locale);
    const current = store.getChat(chat);
    const route = this.#tasks.route(chat, current);
    const agent = route.selected?.agent;
    const field = name === 'fast' ? 'serviceTier' : name;
    const label = m.settingLabels[field];
    const fastTier = args === 'on' ? 'fast' : 'default';
    if (
      name === 'fast' &&
      (!agent ||
        (!acceptsServiceTier(agent, fastTier) &&
          (args || !acceptsServiceTier(agent, 'fast'))))
    )
      return m.fastUnsupported;

    if (!args) {
      const { value, source } = route[field];
      const status = this.#tasks.status(chat);
      const effective =
        field === 'serviceTier'
          ? formatServiceTier(
              status.serviceTier === undefined
                ? status.defaults?.serviceTier
                : status.serviceTier,
              m,
            )
          : field === 'thinking'
            ? (value ?? status.defaults?.effort ?? m.unset)
            : ((value === 'default' ? undefined : value) ??
              status.defaults?.model ??
              m.unset);
      return m.settingCurrent(label, effective, m.settingSources[source]);
    }

    if (name === 'thinking' && args !== 'default') {
      const levels = agent?.settings?.thinking;
      if (!levels?.length) return m.thinkingUnsupported;
      if (!levels.includes(args)) return m.thinkingUsage(levels.join('|'));
    }
    if (name === 'fast' && !['on', 'off', 'default'].includes(args))
      return m.fastUsage;

    const value = args === 'default' ? null : name === 'fast' ? fastTier : args;
    if (current && current[field] !== value) {
      const update: ChatRoute = { [field]: value };
      const next = this.#tasks.route(chat, { ...current, ...update });
      const invalidate =
        route[field].value !== next[field].value &&
        !agent?.settings?.perTurn?.includes(field);
      if (invalidate) this.#tasks.invalidateSession(chat);
      store.setChatRoute(chat, update, invalidate);
    }
    return value === null
      ? m.settingCleared(label)
      : m.settingSet(
          label,
          field === 'serviceTier' ? formatServiceTier(value, m) : value,
        );
  }

  async #settingChoices(chat: ChatRef, name: 'fast' | 'model' | 'thinking') {
    const agent = this.#tasks.route(chat).selected?.agent;
    if (name === 'thinking')
      return commandChoices([...(agent?.settings?.thinking ?? []), 'default']);
    if (name === 'fast')
      return commandChoices([
        ...(agent && acceptsServiceTier(agent, 'fast') ? ['on'] : []),
        ...(agent && acceptsServiceTier(agent, 'default')
          ? ['off', 'default']
          : []),
      ]);
    if (!agent?.listModels) return [];
    try {
      const models = await untilAborted(
        AbortSignal.timeout(2_000),
        async () => agent.listModels?.() ?? [],
      );
      return models.length ? commandChoices([...models, 'default']) : [];
    } catch {
      this.#deps.log({
        level: 'warn',
        event: 'choice.models_unavailable',
        ...chat,
      });
      return [];
    }
  }

  async #command(
    adapter: PlatformAdapter,
    chat: ChatRef,
    message: InboundMessage,
    seq: number,
    owner: boolean,
    { name, args }: Command,
    finish?: (text: string) => Promise<void>,
  ) {
    const { store } = this.#deps;
    const { locale } = this.#runtime.config;
    const m = systemMessages(locale);
    const selectedCommand = m.choices.answer(`/${name} ${args}`);
    const send = async (
      text: string,
      choices: readonly PromptChoice[] = [],
    ) => {
      if (!choices.length) {
        if (finish) await finish(text);
        else await this.#outbound.send(adapter, reply(message, text));
        return;
      }
      if (!supportsChoices(adapter)) {
        await this.#outbound.send(
          adapter,
          reply(
            message,
            [
              text,
              m.choices.values(
                choices.map(({ value }) => `/${name} ${value}`).join(' · '),
              ),
            ].join('\n'),
          ),
        );
        return;
      }
      if (finish) await finish(selectedCommand);
      const pages = Math.ceil(choices.length / choicesPerPage);
      const showPage = async (index: number) => {
        if (this.#isStopping()) return;
        const offset = index * choicesPerPage;
        const page = choices.slice(offset, offset + choicesPerPage);
        const previous = { value: '', label: m.choices.previous };
        const next = { value: '', label: m.choices.next };
        if (index > 0) page.push(previous);
        if (index + 1 < pages) page.push(next);
        const prompt =
          pages > 1 ? `${text}\n${m.choices.page(index + 1, pages)}` : text;
        await this.#chatChoices.send(
          adapter,
          reply(message, prompt),
          message.userId,
          page,
          async (choice, edit) => {
            if (choice === previous || choice === next) {
              const target = index + (choice === previous ? -1 : 1);
              await edit(prompt);
              await showPage(target);
              return;
            }
            await this.#trace.span(
              'trigger.command',
              { ...chat, command: name },
              () =>
                this.#command(
                  adapter,
                  chat,
                  message,
                  seq,
                  this.#auth.isOwner({
                    adapterId: adapter.id,
                    userId: message.userId,
                  }),
                  { name, args: choice.value },
                  edit,
                ),
            );
          },
          {
            command: name,
            deliver: (outbound) => this.#outbound.send(adapter, outbound),
            expires: true,
          },
        );
      };
      await showPage(0);
    };
    const setup = async (request: Parameters<ChatSetup['start']>[2]) => {
      const started = await this.#chatSetup.start(adapter, message, request);
      if (!started) await send(m.setup.alreadyRunning);
      else if (finish) await finish(selectedCommand);
    };
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
      case 'help':
        await send(
          chatCommands(locale)
            .owner.map(({ name, description }) => `/${name} · ${description}`)
            .join('\n'),
        );
        break;
      case 'add': {
        if (!args) {
          await send(m.addUsage, [
            {
              value: 'agent',
              label: 'Agent',
              localized: { 'zh-TW': '代理程式' },
            },
            {
              value: 'platform',
              label: 'Platform',
              localized: { 'zh-TW': '平台' },
            },
          ]);
          break;
        }
        if (args === 'agent' || args === 'platform') {
          const kinds =
            args === 'agent'
              ? this.#registry.agentKinds
              : this.#registry.platformKinds;
          await send(
            kinds.size ? m.choices.addKind(args) : m.choices.noPlugins(args),
            [...kinds].map((kind) => ({
              value: `${args} ${kind}`,
              label: kind,
            })),
          );
          break;
        }
        const match =
          /^(agent|platform)\s+([A-Za-z0-9_.:-]+)(?:\s+--id\s+([A-Za-z0-9_.:-]+))?$/.exec(
            args,
          );
        if (!match?.[2]) {
          await send(m.addUsage);
          break;
        }
        await setup({
          mode: 'add',
          category: match[1] === 'agent' ? 'agent' : 'platform',
          kind: match[2],
          id: match[3],
        });
        break;
      }
      case 'login':
        if (!args)
          await send(
            m.loginUsage,
            commandChoices(this.#runtime.config.agents.map(({ id }) => id)),
          );
        else
          await setup({
            mode: 'login',
            id: args,
          });
        break;
      case 'remove': {
        if (message.edited) break;
        const match =
          /^(agent|platform)\s+([A-Za-z0-9_][A-Za-z0-9_.:-]*)$/.exec(args);
        if (!match?.[2]) await send(removalMessages(locale).usage);
        else
          await this.#chatRemoval.start(
            adapter,
            chat,
            message,
            {
              category: match[1] === 'agent' ? 'agent' : 'platform',
              id: match[2],
            },
            locale,
          );
        break;
      }
      case 'allow':
      case 'deny':
        store.setAllowlisted(chat, name === 'allow');
        if (name === 'deny') this.#tasks.cancelApprovals(chat);
        await send(name === 'allow' ? m.allowlisted : m.removedFromAllowlist);
        break;
      case 'agent': {
        if (!args) {
          const current = store.getChat(chat);
          const route = this.#tasks.route(chat, current);
          const chatAgent =
            current?.agentId ?? store.getWorkspaceSettings(chat)?.agentId;
          const source =
            chatAgent !== undefined && chatAgent === route.agentId
              ? m.settingSources.chat
              : m.settingSources.default;
          await send(
            m.settingCurrent(
              m.settingLabels.agent,
              route.agentId ?? m.unset,
              source,
            ),
            commandChoices(
              this.#runtime.config.agents.flatMap(({ id }) =>
                this.#runtime.getAgent(id) ? [id] : [],
              ),
            ),
          );
          break;
        }
        const next = this.#runtime.getAgent(args);
        if (!next) {
          await send(this.#runtime.unavailable(args) || m.agentUnavailable);
          break;
        }
        const current = store.getChat(chat);
        const switching = this.#tasks.route(chat, current).agentId !== args;
        const update: ChatRoute = { agentId: args };
        const cleared: string[] = [];
        if (switching) {
          if (
            current?.thinking &&
            !next.agent.settings?.thinking?.includes(current.thinking)
          ) {
            update.thinking = null;
            cleared.push(m.settingLabels.thinking);
          }
          if (
            current?.serviceTier &&
            !acceptsServiceTier(next.agent, current.serviceTier)
          ) {
            update.serviceTier = null;
            cleared.push(m.settingLabels.serviceTier);
          }
        }
        if (current?.agentId !== args) {
          if (switching) this.#tasks.invalidateSession(chat);
          store.setChatRoute(chat, update, switching);
        }
        await send(
          [
            m.agentSet(args),
            ...(cleared.length
              ? [m.agentOverridesCleared(cleared.join(', '))]
              : []),
          ].join('\n'),
        );
        break;
      }
      case 'model':
      case 'thinking':
      case 'fast':
        await send(
          this.#chatAgentSetting(chat, name, args),
          args ? [] : await this.#settingChoices(chat, name),
        );
        break;
      case 'compact':
        if (
          this.#removingPlatform(adapter.id) ||
          this.#removingAgentRoute(chat)
        )
          break;
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
        if (args === 'close') {
          const open = this.#previews?.list(chat.adapterId) ?? [];
          await send(
            open.length ? m.previewCloseUsage : m.noPreviews,
            open.map(({ id }) => ({ value: `close ${id}`, label: id })),
          );
          break;
        }
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
      case 'status': {
        const card = statusCard(
          {
            runtime: this.#runtime,
            showRecentApproval:
              (adapter.capabilities.outboundPush ?? 'free') !== 'free',
            sandboxEnabled: this.#execution.enabled,
            startedAt: this.#startedAt,
            store,
            tasks: this.#tasks,
            trace: this.#trace,
          },
          chat,
          message,
        );
        await this.#outbound.send(adapter, {
          ...reply(message, card.text),
          ...card,
        });
        break;
      }
    }
  }
}

export { GuidedSetup, SetupCancelled } from './setup.ts';
export { Removal } from './removal.ts';
export { formatRemovalPlan, removalMessages } from './removal-messages.ts';
export type { RemovalPlan } from './removal.ts';
export type { RemovalTarget } from '@tsugimori/storage';
export type { SetupIO, SetupRequest } from './setup.ts';

export { systemInstallPlan } from './system-setup.ts';

export { SetupError } from '@tsugimori/plugin-sdk';
export type { SetupDependencies } from '@tsugimori/plugin-sdk';
