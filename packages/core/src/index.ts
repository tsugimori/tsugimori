import type { Config, WorkspaceConfig } from '@tsugimori/config';
import type { SummaryProvider } from '@tsugimori/context';
import type {
  AdminEvent,
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
  TriggerDecision,
  TunnelProvider,
  WebhookStatus,
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
  defaultRecordsMaxBytes,
  loadConfig,
  watch,
} from '@tsugimori/config';
import { ContextAssembler } from '@tsugimori/context';
import { SendFailure, SetupError, ToolFailure } from '@tsugimori/plugin-sdk';
import {
  prepareReminder,
  reminderEntities,
  Scheduler,
  scheduleRecordTime,
} from '@tsugimori/scheduler';
import { Tracer } from '@tsugimori/trace';
import { isDeepStrictEqual } from 'node:util';

import type { ChoiceHandler } from './chat-choices.ts';
import type { Command } from './chat-commands.ts';
import type { Logger } from './hooks.ts';
import type { MemoryResult } from './memory.ts';
import type { PreviewProviders } from './previews.ts';
import type { RemovalPlan } from './removal.ts';
import type { PlatformNotice } from './runtime.ts';
import type { TaskInput } from './supplements.ts';
import type { WebImageNetwork } from './web-image.ts';

import { untilAborted } from './abort.ts';
import { adminReader } from './admin.ts';
import { acceptsServiceTier, formatServiceTier } from './agent-settings.ts';
import { approvalDecisionText, approvalMessages } from './approval-messages.ts';
import { ChatChoices, supportsChoices } from './chat-choices.ts';
import { canRunCommand, chatCommands, parseCommand } from './chat-commands.ts';
import { ChatRemoval } from './chat-removal.ts';
import { ChatSetup } from './chat-setup.ts';
import { EnvironmentChecks, failureText } from './checks.ts';
import { CommandMenus } from './command-menus.ts';
import { Executions, sandboxScope } from './executions.ts';
import { guideTools } from './guides.ts';
import { historyTools } from './history.ts';
import { HookRunner, logToStderr } from './hooks.ts';
import {
  hasPrivateArguments,
  redactPairingCodes,
  resolveReplyTarget,
} from './inbound-message.ts';
import { Memory, memoryAction } from './memory.ts';
import { conversationId, Outbound } from './outbound.ts';
import { pairingContact } from './pairing.ts';
import { Previews } from './previews.ts';
import { PluginRegistry } from './registry.ts';
import { removalMessages } from './removal-messages.ts';
import { defaultAgent, Removal } from './removal.ts';
import { Runtime } from './runtime.ts';
import { GuidedSetup } from './setup.ts';
import { contextCard, statusCard } from './status.ts';
import { StickerIndex } from './stickers.ts';
import { BackgroundSummaries } from './summary.ts';
import { systemMessages } from './system-messages.ts';
import { reply, Tasks } from './tasks.ts';
import { ToolDetails } from './tool-details.ts';
import {
  shouldTrigger as decideTrigger,
  canTrigger as shouldTrigger,
} from './trigger.ts';
import { Webhooks } from './webhooks.ts';

export { decideTrigger, EnvironmentChecks, PluginRegistry, shouldTrigger };
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
  webImageNetwork?: WebImageNetwork;
  workspace: string;
}

type LinkedApproval = Exclude<
  NonNullable<ReturnType<Auth['resolveApproval']>>,
  { decision: 'expired' }
> & {
  live: boolean;
  memoryOutcome?: Promise<MemoryResult>;
  reaction?: Promise<boolean>;
  record: ApprovalRecord;
};

type CommandSend = (
  text: string,
  choices?: readonly PromptChoice[],
  fallback?: string,
  options?: {
    canChoose?(): boolean;
    command?: Command['name'];
    describePage?(page: readonly PromptChoice[]): string;
    select?: ChoiceHandler;
  },
) => Promise<void>;

function commandChoices(values: Iterable<string>): PromptChoice[] {
  return [...new Set(values)].map((value) => ({ value, label: value }));
}

function webhookStatusLine(status: WebhookStatus, locale: Config['locale']) {
  const m = systemMessages(locale).webhook;
  const age = status.checkedAt
    ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
        -Math.max(
          0,
          Math.round((Date.now() - Date.parse(status.checkedAt)) / 60_000),
        ),
        'minute',
      )
    : undefined;
  return [
    m.heading + (locale === 'zh-TW' ? '：' : ': ') + m.states[status.state],
    status.provider,
    status.baseUrl,
    age && m.checked(age),
    status.reason,
  ]
    .filter(Boolean)
    .join(' · ');
}

const defaultChoicesPerPage = 80;

export class Gateway {
  readonly #deps;
  readonly #registry: PluginRegistry;
  readonly #trace: Tracer;
  readonly #runtime: Runtime;
  readonly #webhooks: Webhooks;
  #configWarnings: readonly string[] = [];
  readonly #hooks: HookRunner;
  readonly #auth: Auth;
  readonly #outbound: Outbound;
  readonly #tasks: Tasks;
  readonly #stickers: StickerIndex;
  readonly #summaries: BackgroundSummaries;
  readonly #scheduler: Scheduler;
  readonly #previews?: Previews;
  readonly #execution: Executions;
  readonly #memory: Memory;
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
  #recordsTimer?: NodeJS.Timeout;
  #closeWatch?: ReturnType<typeof watch>;
  #environmentNotification?: Promise<void>;
  #expiry?: Promise<void>;
  #initialApply?: Promise<void>;
  #stopping?: Promise<void>;
  #startedAt = 0;
  readonly admin: AdminReader;
  readonly #adminReload = new Set<(event: AdminEvent) => void>();
  #state: 'new' | 'starting' | 'running' | 'stopping' = 'new';

  constructor({
    store,
    workspace,
    registry = new PluginRegistry(),
    trace,
    summary,
    previews,
    namedPreview,
    webImageNetwork,
    setup = {},
    log = logToStderr,
  }: GatewayDependencies) {
    this.#deps = { store, workspace, log, namedPreview };
    this.#memory = new Memory(workspace);
    this.admin = adminReader({
      store,
      workspace,
      config: () => this.#runtime.config,
      agentInfo: (id) => this.#runtime.adminAgentInfo(id),
      reloadListeners: this.#adminReload,
      webhook: () => this.#webhooks.status(),
      route: (chat, current) => this.#tasks.route(chat, current),
    });
    this.#registry = registry;
    this.#trace =
      trace ??
      new Tracer(store, {
        onError: () => log({ level: 'error', event: 'trace.flush_failed' }),
      });
    this.#webhooks = new Webhooks({
      ...setup,
      registry,
      workspace,
      log,
      trace: this.#trace,
      onStatus: () => this.#notifyAdminReload(),
    });
    this.#runtime = new Runtime({
      workspace,
      registry,
      checks: new EnvironmentChecks(setup, workspace, this.#webhooks),
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
        await this.#stickers.interrupt(adapters, agents);
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
      webImageNetwork,
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
        const destination = { adapterId: adapter.id, chatId: newChatId };
        if (store.getChat(destination)?.incognitoId != null)
          this.#summaries.cancelChat(destination);
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
    const toolDetails = new ToolDetails({
      log,
      snapshot: () => this.#runtime.snapshot,
      store,
    });
    this.#chatSetup = new ChatSetup({
      auth: this.#auth,
      redact: (text) => toolDetails.redactor()(text),
      choices: this.#chatChoices,
      setup: new GuidedSetup({
        ...setup,
        store,
        workspace,
        registry,
        webhooks: this.#webhooks,
      }),
      runtime: this.#runtime,
      outbound: this.#outbound,
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
    this.#stickers = new StickerIndex({
      scope,
      log,
      runtime: this.#runtime,
      store,
      toolDetails,
      trace: this.#trace,
    });
    this.#summaries = new BackgroundSummaries({
      toolDetails,
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
      workspace,
      toolDetails,
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
      stickers: this.#stickers,
      stopExec: (chat, taskId) => this.#execution.stopTask(chat, taskId),
      log,
      tools: [
        ...registry.plugins.flatMap((plugin) => [...(plugin.tools ?? [])]),
        ...this.#scheduler.tools(),
        ...historyTools({
          store,
          timezone: () => this.#runtime.config.timezone,
        }),
        ...guideTools({ log, workspace }),
        ...this.#memory.tools(() => {
          const { reason, separator } = approvalMessages(
            this.#runtime.config.locale,
          );
          return reason + separator;
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
    this.#scheduleRecordPrune(60_000);
    this.#scheduler.start();
    this.#webhooks.start();
    if (this.#previews) this.#previews.start();
    else store.closePreviewsOnRestart(Date.now());
    log({ level: 'info', event: 'gateway.started' });
    this.#reportPlatformNotices();
    await this.#reportFailures();
  }

  #scheduleRecordPrune(delay: number) {
    this.#recordsTimer = setTimeout(() => {
      const { log, store } = this.#deps;
      try {
        const result = store.pruneRecords(
          this.#runtime.config.records?.maxBytes ?? defaultRecordsMaxBytes,
          this.#tasks.activeRecordRefs(),
        );
        if (result.bytes > 0) {
          log({ level: 'info', event: 'records.pruned', ...result });
          this.#notifyAdminReload();
        }
      } catch {
        log({ level: 'warn', event: 'records.prune_failed' });
      } finally {
        if (this.#state === 'running') this.#scheduleRecordPrune(60 * 60_000);
      }
    }, delay).unref();
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
      await this.#runtime.apply(snapshot, removal, () =>
        this.#webhooks.configure(snapshot, this.#state === 'running'),
      );
      const { config } = this.#runtime;
      const owned = new Set(Object.keys(config.owner));
      for (const { id, kind } of config.platforms)
        if (configuredOwner(config, id, kind)) owned.add(id);
      for (const id of owned) this.#deps.store.deletePairingCode(id);
      const warnings = snapshot.warnings ?? [];
      if (!isDeepStrictEqual(warnings, this.#configWarnings)) {
        for (const reason of warnings)
          this.#deps.log({ level: 'warn', event: 'config.warning', reason });
        this.#configWarnings = warnings;
      }
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
      this.#notifyAdminReload();
      this.#scheduler.tick();
      this.#reportPlatformNotices();
    }
  }

  webhookInfo(platformId?: string) {
    return {
      status: this.#webhooks.status(),
      paths: this.#webhooks.paths(),
      attached:
        platformId !== undefined && !!this.#runtime.getAdapter(platformId),
    };
  }

  #notifyAdminReload() {
    if (this.#state !== 'running') return;
    for (const listener of this.#adminReload) {
      try {
        listener({ kind: 'reload' });
      } catch {
        this.#deps.log({ level: 'error', event: 'admin.listener_failed' });
      }
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

  #removingAgent(id: string) {
    const target = this.#activeRemoval?.plan;
    return target?.category === 'agent' && target.id === id;
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
    clearTimeout(this.#recordsTimer);
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
        await this.#stickers.stop();
        await this.#summaries.stop();
        await this.#expiry;
        await this.#runtime.stop();
        await this.#webhooks.stop();
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

  #recordTrigger(decision: TriggerDecision, seq?: number) {
    const { store, log } = this.#deps;
    const { adapterId, chatId, messageId, triggered, reason, taskId } =
      decision;
    this.#trace.record('trigger.decided', {
      adapterId,
      chatId,
      messageId,
      triggered,
      reason,
      taskId: taskId ?? null,
    });
    try {
      store.saveTrigger(decision, seq);
    } catch {
      log({
        level: 'warn',
        event: 'task.record_failed',
        adapterId,
        chatId,
        taskId: taskId ?? undefined,
      });
    }
  }

  async #process(
    adapter: PlatformAdapter,
    inbound: PlatformInboundEvent,
    finishChoice?: (text: string) => Promise<void>,
  ) {
    const at = Date.now();
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
    const recordDecision = (
      reason: TriggerDecision['reason'],
      triggered: boolean,
      seq?: number,
      taskId?: string,
    ) =>
      this.#recordTrigger(
        { ...chat, messageId: event.messageId, at, triggered, reason, taskId },
        seq,
      );
    if (event.type === 'delete') {
      this.#trace.span('inbound.deleted', { ...chat }, () => {
        store.markDeleted(chat, event.messageId, migratedFrom);
        recordDecision(
          'deleted',
          false,
          store.getMessage(chat, event.messageId, migratedFrom ?? '')?.seq,
        );
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
    const finishSelected = async (allowed = true) => {
      if (!finishChoice || !command) return;
      const { choices } = systemMessages(this.#runtime.config.locale);
      await finishChoice(
        allowed ? choices.answer(`/${command.name}`) : choices.unavailable,
      );
    };
    if (
      inbound.type !== 'chat-migrated' &&
      command?.name === 'cancel' &&
      (await this.#chatRemoval.receive(adapter, chat, event, true))
    ) {
      recordDecision('command', true);
      if (finishChoice) await finishSelected();
      return;
    }
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
      recordDecision('command', true);
      if (finishChoice) await finishSelected(this.#auth.isOwner(user));
      return;
    }
    if (
      inbound.type !== 'chat-migrated' &&
      parsed !== 'other-bot' &&
      (await this.#chatRemoval.receive(adapter, chat, event, false))
    ) {
      if (this.#runtime.getAdapter(adapter.id)) recordDecision('command', true);
      return;
    }
    const privateCommand = command && hasPrivateArguments(command.name);
    const redactedText = redactPairingCodes(event.text);
    const sideQuestion = command?.name === 'btw' || command?.name === 'ask';
    const reset = command?.name === 'new' || command?.name === 'incognito';
    const incognitoSetting =
      command?.name === 'incognito' && ['on', 'off'].includes(command.args)
        ? ` ${command.args}`
        : '';
    const privateReply = privateCommand || redactedText !== event.text;
    const privateRaw = privateReply || reset;
    const replyId = event.replyTo?.id;
    const { replyTo, sensitiveReply } = resolveReplyTarget(
      { store, bot: adapter.botIdentity },
      chat,
      event.replyTo,
      migratedFrom,
    );
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
          replyTo: replyId ?? null,
          albumId: event.albumId,
          metadata: {
            at: event.at,
            attachments: event.attachments,
            replyTo,
            sender: event.sender,
            userDisplay: event.userDisplay,
            ...(event.mentionsBot === true && { mentionsBot: true }),
            ...(event.repliesToBot === true && { repliesToBot: true }),
            ...(privateReply && { privateReply }),
            ...(sideQuestion && { sideQuestion }),
          },
          threadId: event.threadId ?? null,
          text: reset
            ? `/${command.name}${incognitoSetting}`
            : privateCommand && command?.args
              ? `/${command.name} [redacted]`
              : redactedText ||
                (event.attachments?.length
                  ? `[${event.attachments[0]!.kind}]`
                  : ''),
          raw: privateRaw || sensitiveReply ? null : (event.raw ?? null),
        },
        event.edited,
      ),
    );
    if (!stored) {
      recordDecision('duplicate', false);
      return;
    }
    this.#stickers.observe(adapter, chat, event.attachments);
    this.#stickers.observe(adapter, chat, replyTo?.attachments);
    if (inbound.type === 'chat-migrated') {
      recordDecision('not-addressed', false, stored.seq);
      return;
    }
    this.#commandMenus.observeChat(adapter, event);
    if (event.edited) {
      recordDecision('duplicate', false, stored.seq);
      return;
    }
    const message = {
      ...event,
      replyTo,
      raw: privateRaw || sensitiveReply ? undefined : event.raw,
      text: stored.text,
    };
    const received = this.#hooks.emit('inbound.received', { chat, message });
    if (reset && !this.#isStopping()) {
      await this.#trace.span(
        'trigger.command',
        { ...chat, command: command.name },
        async () => {
          try {
            // Apply the transition at the command's position in the message log.
            const response = this.#resetConversation(
              adapter,
              chat,
              message,
              stored.seq,
              command,
            );
            await received;
            if (finishChoice) await finishSelected(Boolean(response));
            if (response)
              await this.#outbound.send(
                adapter,
                reply(message, response.text),
                response,
              );
          } finally {
            recordDecision('command', true, stored.seq);
          }
        },
      );
      return;
    }
    await received;
    if (this.#isStopping() || parsed === 'other-bot') {
      recordDecision(
        parsed === 'other-bot' ? 'addressed-to-other' : 'not-addressed',
        false,
        stored.seq,
      );
      return;
    }

    if (replyId) {
      const result = this.#resolveApproval(adapter, {
        ...chat,
        userId: event.userId,
        replyTo: replyId,
        text: event.text,
      });
      if (result) {
        recordDecision('command', true, stored.seq);
        if ('record' in result) {
          await this.#approvalFeedback(adapter, chat, {
            chatId: event.chatId,
            messageId: replyId,
            decision: result.decision,
            ...result.record.promptFormat,
          });
          await this.#approvalOutcome(adapter, result, message);
        }
        return;
      }
    }

    const owner = this.#auth.isOwner({
      adapterId: adapter.id,
      userId: event.userId,
    });
    if (command) {
      const finish =
        finishChoice ??
        (owner
          ? this.#chatChoices.claimReply(adapter, message, command)
          : undefined);
      let recorded = false;
      const commandDecision = (taskId?: string) => {
        if (recorded) return;
        recorded = true;
        recordDecision('command', true, stored.seq, taskId);
      };
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
              commandDecision,
            );
          } catch (error) {
            await finish?.(
              systemMessages(this.#runtime.config.locale).choices.failed,
            );
            throw error;
          } finally {
            commandDecision();
          }
        },
      );
      return;
    }

    let priorAlbumItem = false;
    if (event.albumId && event.chatKind === 'dm') {
      priorAlbumItem =
        store.messageAlbum(chat, event.albumId, migratedFrom ?? '')[0]?.seq !==
        stored.seq;
    }
    const { triggered, reason } = priorAlbumItem
      ? { triggered: false, reason: 'not-addressed' as const }
      : decideTrigger(
          event,
          owner,
          this.#auth.isAllowlisted(chat),
          adapter.capabilities.ownerReplyTriggers,
        );
    await this.#hooks.emit('trigger.decided', {
      chat,
      message,
      triggered,
      reason,
    });
    if (
      triggered &&
      !this.#isStopping() &&
      !this.#removingPlatform(adapter.id) &&
      !this.#removingAgentRoute(chat)
    ) {
      this.#trace.span('task.dispatch', { ...chat }, () =>
        this.#tasks.dispatch(
          adapter,
          chat,
          { message, seq: stored.seq },
          (taskId) => recordDecision(reason, triggered, stored.seq, taskId),
        ),
      );
    } else recordDecision(reason, triggered, stored.seq);
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
      if (!stored) {
        this.#recordTrigger({
          ...chat,
          messageId: message.messageId,
          at: Date.now(),
          triggered: false,
          reason: 'duplicate',
        });
        return 'skipped';
      }
      const status = await this.#tasks.dispatch(
        adapter,
        chat,
        {
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
        },
        (taskId) =>
          this.#recordTrigger(
            {
              ...chat,
              messageId: message.messageId,
              at: Date.now(),
              triggered: true,
              reason: 'scheduled',
              taskId,
            },
            stored.seq,
          ),
      );
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
          if (
            source &&
            this.#canCompleteApproval(source, approval.requester) &&
            this.#canWriteChatKnowledge(source)
          )
            return this.#runtime.config.scheduler?.maxActivePerUser ?? 20;
        }),
    );
    if (!result) return;
    if (result.decision === 'expired') return result;
    const record = store.getApproval(result.id);
    if (!record) return;
    const source = store.getTask(record.taskId);
    const call = record.continuation;
    const memoryOutcome =
      result.approved &&
      record.action === memoryAction &&
      call?.kind === 'tool' &&
      call.name === memoryAction
        ? this.#applyMemoryApproval(source, record, call.args)
        : undefined;
    const reaction =
      source &&
      this.#outbound.reactToApproval(
        adapter,
        source,
        result.approved ? 'approved' : 'denied',
      );
    const live = this.#tasks.resolveApproval(result.id, {
      ...result,
      memoryOutcome,
      reaction,
    });
    return { ...result, live, memoryOutcome, reaction, record };
  }

  async #applyMemoryApproval(
    source: TaskRecord | undefined,
    { decidedBy, id, requester }: ApprovalRecord,
    args: unknown,
  ): Promise<MemoryResult> {
    if (
      !source ||
      decidedBy === null ||
      !this.#canCompleteApproval(source, requester) ||
      !this.#canWriteChatKnowledge(source)
    )
      return { error: 'The requesting conversation is no longer authorized' };
    try {
      const result = await this.#trace.span(
        'approval.apply',
        { action: memoryAction, approvalId: id, taskId: source.id },
        () => this.#memory.apply(args, decidedBy),
      );
      if ('warning' in result && result.warning)
        this.#deps.log({
          level: 'error',
          event: 'memory.git_failed',
          taskId: source.id,
          reason: result.warning,
        });
      return result;
    } catch (error) {
      this.#deps.log({
        level: 'error',
        event: 'approval.action_failed',
        taskId: source.id,
      });
      return {
        error:
          error instanceof ToolFailure
            ? error.message
            : 'Could not write MEMORY.md',
      };
    }
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

  #canWriteChatKnowledge(source: TaskRecord) {
    const { store } = this.#deps;
    const chat = store.resolveChat(source);
    return (
      store.getMessage(
        chat,
        source.sourceMessageId,
        source.sourceChatId ?? '',
        false,
      )?.incognitoId == null
    );
  }

  async #approvalOutcome(
    adapter: PlatformAdapter,
    result: LinkedApproval,
    message?: InboundMessage,
  ) {
    const reacted = await result.reaction;
    const { store, log } = this.#deps;
    const { record, approved, scheduleApplied } = result;
    const source = store.getTask(record.taskId);
    if (!source) return;
    const { locale } = this.#runtime.config;
    const m = approvalMessages(locale).outcomes;
    if (result.memoryOutcome) {
      const outcome = await result.memoryOutcome;
      const text =
        'error' in outcome
          ? m.failed
          : outcome.warning
            ? m.memoryWarning(outcome.warning)
            : m.memoryWritten;
      await this.#notifyApproval(adapter, source, text, message);
      return;
    }
    if (result.live && (reacted || !source.sourceChatId)) return;
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
    responseTo?: InboundMessage,
  ) {
    if (!responseTo && (adapter.capabilities.outboundPush ?? 'free') !== 'free')
      return;
    const { store, log } = this.#deps;
    const message = responseTo
      ? undefined
      : store.getMessage(
          store.resolveChat(source),
          source.sourceMessageId,
          source.sourceChatId ?? '',
        );
    const address = responseTo ?? store.deliveryAddress(source);
    if (!address) return;
    try {
      await this.#outbound.send(
        adapter,
        responseTo
          ? reply(responseTo, text)
          : {
              chatId: address.chatId,
              threadId: address.threadId,
              replyTo:
                message && !message.deleted && !source.sourceChatId
                  ? source.sourceMessageId
                  : undefined,
              text,
            },
      );
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

  async #chatAgentSetting(
    chat: ChatRef,
    name: 'fast' | 'thinking',
    args: string,
    send: (text: string, choices?: readonly PromptChoice[]) => Promise<void>,
    isCurrentOwner: () => boolean,
  ): Promise<void> {
    const { store } = this.#deps;
    const m = systemMessages(this.#runtime.config.locale);
    let current = store.getChat(chat);
    let route = this.#tasks.route(chat, current);
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
      return send(m.fastUnsupported);

    let catalogLevels: readonly string[] | undefined;
    if (name === 'thinking') {
      catalogLevels = await this.#tasks.thinkingLevels(route);
      if (!isCurrentOwner()) return;
      current = store.getChat(chat);
      const latest = this.#tasks.route(chat, current);
      if (
        latest.selected !== route.selected ||
        latest.model.value !== route.model.value
      )
        return this.#chatAgentSetting(chat, name, args, send, isCurrentOwner);
      route = latest;
    }
    const levels = catalogLevels ?? agent?.settings?.thinking;
    const setting =
      name === 'thinking' ? route.resolveThinking(catalogLevels) : route[field];

    if (!args) {
      const { value, source } = setting;
      const status = this.#tasks.status(chat);
      const effective =
        field === 'serviceTier'
          ? formatServiceTier(
              status.serviceTier === undefined
                ? status.defaults?.serviceTier
                : status.serviceTier,
              m,
            )
          : (value ?? status.defaults?.effort ?? m.unset);
      return send(
        m.settingCurrent(label, effective, m.settingSources[source]),
        name === 'thinking'
          ? commandChoices([...(levels ?? []), 'default'])
          : commandChoices([
              ...(agent && acceptsServiceTier(agent, 'fast') ? ['on'] : []),
              ...(agent && acceptsServiceTier(agent, 'default')
                ? ['off', 'default']
                : []),
            ]),
      );
    }

    if (name === 'thinking' && args !== 'default') {
      if (!levels?.length) return send(m.thinkingUnsupported);
      if (!levels.includes(args))
        return send(m.thinkingUsage(levels.join('|')));
    }
    if (name === 'fast' && !['on', 'off', 'default'].includes(args))
      return send(m.fastUsage);

    const value = args === 'default' ? null : name === 'fast' ? fastTier : args;
    if (current && current[field] !== value) {
      const update: ChatRoute = { [field]: value };
      const next = this.#tasks.route(chat, { ...current, ...update });
      const nextSetting =
        name === 'thinking' ? next.resolveThinking(catalogLevels) : next[field];
      const invalidate =
        setting.value !== nextSetting.value &&
        !agent?.settings?.perTurn?.includes(field);
      if (invalidate) this.#tasks.invalidateSession(chat);
      store.setChatRoute(chat, update, invalidate);
    }
    return send(
      value === null
        ? m.settingCleared(label)
        : m.settingSet(
            label,
            field === 'serviceTier' ? formatServiceTier(value, m) : value,
          ),
    );
  }

  async #showProviderModels(
    chat: ChatRef,
    id: string,
    send: CommandSend,
    canChoose: () => boolean,
  ) {
    const m = systemMessages(this.#runtime.config.locale);
    const agent = this.#runtime.getAgent(id)?.agent;
    if (!canChoose()) return;
    if (!agent || this.#removingAgent(id))
      return send(this.#runtime.unavailable(id) || m.agentUnavailable);
    const available = () =>
      this.#runtime.getAgent(id)?.agent === agent && !this.#removingAgent(id);
    let models: readonly string[];
    try {
      models = agent.listModels
        ? await untilAborted(
            AbortSignal.timeout(2_000),
            async () => agent.listModels?.() ?? [],
          )
        : [];
    } catch {
      this.#deps.log({
        level: 'warn',
        event: 'choice.models_unavailable',
        ...chat,
      });
      if (canChoose()) await send(m.choices.unavailable);
      return;
    }
    if (!canChoose()) return;
    if (!available())
      return send(this.#runtime.unavailable(id) || m.agentUnavailable);
    const choices = commandChoices([...models, 'default']).map(({ label }) => ({
      label,
      value: `${id} ${label}`,
    }));
    return send(m.providerModels(id), choices, undefined, {
      canChoose: () => canChoose() && available(),
      describePage: (page) =>
        m.choices.values(page.map(({ label }) => label).join(' · ')),
    });
  }

  async #setChatModel(
    chat: ChatRef,
    provider: string | null | undefined,
    model: string | null,
    send: CommandSend,
    canChoose: () => boolean,
  ) {
    const { store } = this.#deps;
    const m = systemMessages(this.#runtime.config.locale);
    const target = provider ? this.#runtime.getAgent(provider) : undefined;
    let catalog:
      | {
          agent: NonNullable<typeof target>['agent'];
          levels: readonly string[] | undefined;
          model: string | undefined;
        }
      | undefined;

    while (canChoose()) {
      if (
        provider &&
        (!target ||
          this.#runtime.getAgent(provider) !== target ||
          this.#removingAgent(provider))
      )
        return send(this.#runtime.unavailable(provider) || m.agentUnavailable);
      const current = store.getChat(chat);
      const route = this.#tasks.route(chat, current);
      const update: ChatRoute = { model };
      // An explicit provider default takes precedence over a workspace model.
      if (target && model === null && store.getWorkspaceSettings(chat)?.model)
        update.model = target.config.model ?? 'default';
      if (
        provider === null ||
        (provider !== undefined && route.agentId !== provider)
      )
        update.agentId = provider;
      const next = this.#tasks.route(
        chat,
        current && { ...current, ...update },
      );
      const switching = route.agentId !== next.agentId;
      const agent = next.selected?.agent;
      if (next.agentId && this.#removingAgent(next.agentId))
        return send(m.choices.unavailable);

      const cleared: string[] = [];
      if (switching && agent) {
        if (current?.thinking) {
          const nextModel = next.model.value;
          if (
            !catalog ||
            catalog.agent !== agent ||
            catalog.model !== nextModel
          ) {
            catalog = {
              agent,
              model: nextModel,
              levels: await this.#tasks.thinkingLevels(next),
            };
            // Reload the chat route and recheck permission after the catalog call.
            continue;
          }
          if (
            !(catalog.levels ?? agent.settings?.thinking)?.includes(
              current.thinking,
            )
          ) {
            update.thinking = null;
            cleared.push(m.settingLabels.thinking);
          }
        }
        if (
          current?.serviceTier &&
          !acceptsServiceTier(agent, current.serviceTier)
        ) {
          update.serviceTier = null;
          cleared.push(m.settingLabels.serviceTier);
        }
      }
      if (
        current &&
        (current.model !== update.model ||
          (update.agentId !== undefined &&
            current.agentId !== update.agentId) ||
          cleared.length)
      ) {
        const invalidate =
          switching ||
          (route.model.value !== next.model.value &&
            !agent?.settings?.perTurn?.includes('model'));
        if (invalidate) this.#tasks.invalidateSession(chat);
        store.setChatRoute(chat, update, invalidate);
      }
      const text =
        provider === null
          ? m.modelRouteCleared
          : model === null
            ? m.providerModelDefault
            : m.settingSet(m.settingLabels.model, model);
      const result =
        switching && next.agentId
          ? [m.settingSet(m.settingLabels.provider, next.agentId), text]
          : [text];
      if (cleared.length)
        result.push(m.agentOverridesCleared(cleared.join(', ')));
      return send(result.join('\n'));
    }
  }

  async #newPairingCode(
    adapter: PlatformAdapter,
    message: InboundMessage,
    args: string,
  ) {
    const { config } = this.#runtime;
    const { pairing } = systemMessages(config.locale);
    const send = (text: string) =>
      this.#outbound.send(adapter, reply(message, text));
    if (message.chatKind !== 'dm') {
      await send(pairing.directOnly);
      return;
    }
    const id = /^new\s+([A-Za-z0-9_][A-Za-z0-9_.:-]*)$/i.exec(args)?.[1];
    if (!id) {
      await send(pairing.useNew);
      return;
    }
    const target = this.#runtime.getAdapter(id);
    const link = await pairingContact(this.#trace, target);
    if (
      this.#isStopping() ||
      this.#runtime.getAdapter(adapter.id) !== adapter ||
      !this.#auth.isOwner({ adapterId: adapter.id, userId: message.userId })
    )
      return;
    const current = this.#runtime.config;
    if (!current.platforms.some((entry) => entry.id === id)) {
      await send(
        current.agents.some((entry) => entry.id === id)
          ? pairing.platformOnly(id)
          : pairing.unknown(id),
      );
      return;
    }
    if (this.#auth.owner(id)) {
      await send(pairing.owned(id));
      return;
    }
    const code = this.#auth.createPairingCode(id);
    const text = pairing.code(
      id,
      code,
      this.#runtime.getAdapter(id) === target ? link : undefined,
    );
    if (
      !(await this.#outbound.sendSecret(adapter, {
        ...reply(message, text),
        format: 'markdown',
      }))
    )
      await send(pairing.sendFailed(id));
  }

  #resetConversation(
    adapter: PlatformAdapter,
    chat: ChatRef,
    message: InboundMessage,
    seq: number,
    { name, args }: Command,
  ) {
    const { store } = this.#deps;
    chat = store.resolveChat(chat);
    if (
      this.#removingPlatform(adapter.id) ||
      this.#removingAgentRoute(chat) ||
      !canRunCommand(
        name,
        this.#auth.isOwner({ adapterId: adapter.id, userId: message.userId }),
        this.#auth.isAllowlisted(chat),
      )
    )
      return;
    const m = systemMessages(this.#runtime.config.locale);
    const incognitoId = store.getChat(chat)?.incognitoId ?? undefined;
    const active = incognitoId !== undefined;
    const state = active ? m.incognitoEnabled : m.incognitoOff;
    const desired =
      name === 'incognito' && (args === 'on' || (args !== 'off' && !active));
    if (name === 'incognito' && active === desired)
      return { incognitoId, text: state };
    if (!this.#tasks.resetSession(chat, desired ? seq : null)) {
      const busy = m.newBusy(name);
      return {
        incognitoId,
        text: name === 'incognito' || active ? `${state} ${busy}` : busy,
      };
    }
    if (active || desired) this.#summaries.cancelChat(chat);
    return desired
      ? { incognitoId: seq, sessionBoundary: true, text: m.incognitoOn }
      : { text: active ? m.incognitoOff : m.newSuccess };
  }

  async #command(
    adapter: PlatformAdapter,
    chat: ChatRef,
    message: InboundMessage,
    seq: number,
    owner: boolean,
    { name, args }: Command,
    finish?: (text: string) => Promise<void>,
    onTask?: (taskId: string) => void,
  ) {
    const { store } = this.#deps;
    const { locale } = this.#runtime.config;
    const m = systemMessages(locale);
    const selectedCommand = m.choices.answer(
      args ? `/${name} ${args}` : `/${name}`,
    );
    const respond =
      (
        finish?: (text: string) => Promise<void>,
        selection = selectedCommand,
      ): CommandSend =>
      async (
        text,
        choices = [],
        fallback,
        { canChoose, command: choiceCommand = name, describePage, select } = {},
      ) => {
        const limit = adapter.capabilities.maxInlineButtons ?? Infinity;
        if (
          !choices.length ||
          !supportsChoices(adapter) ||
          (limit < 3 && choices.length > limit)
        ) {
          const body = choices.length
            ? [
                text,
                fallback ??
                  m.choices.values(
                    choices
                      .map(({ value }) => `/${choiceCommand} ${value}`)
                      .join(' · '),
                  ),
              ].join('\n')
            : text;
          if (finish) await finish(body);
          else await this.#outbound.send(adapter, reply(message, body));
          return;
        }
        if (finish) await finish(selection);
        const choicesPerPage =
          choices.length <= Math.min(defaultChoicesPerPage, limit)
            ? choices.length
            : Math.min(defaultChoicesPerPage, limit - 2);
        const pages = Math.ceil(choices.length / choicesPerPage);
        const showPage = async (index: number) => {
          if (this.#isStopping() || canChoose?.() === false) return;
          const offset = index * choicesPerPage;
          const page = choices.slice(offset, offset + choicesPerPage);
          const prompt = [
            text,
            pages > 1 ? m.choices.page(index + 1, pages) : undefined,
            describePage?.(page),
          ]
            .filter(Boolean)
            .join('\n');
          const previous = { value: '', label: m.choices.previous };
          const next = { value: '', label: m.choices.next };
          if (index > 0) page.push(previous);
          if (index + 1 < pages) page.push(next);
          await this.#chatChoices.send(
            adapter,
            reply(message, prompt),
            message.userId,
            page,
            async (choice, edit, event) => {
              if (choice === previous || choice === next) {
                const target = index + (choice === previous ? -1 : 1);
                await edit(prompt);
                await showPage(target);
                return;
              }
              if (select) {
                await select(choice, edit, event);
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
                    { name: choiceCommand, args: choice.value },
                    edit,
                  ),
              );
            },
            {
              canChoose,
              command: select ? undefined : choiceCommand,
              deliver: (outbound) => this.#outbound.send(adapter, outbound),
              expires: true,
            },
          );
        };
        await showPage(0);
      };
    const send = respond(finish);
    const setup = async (request: Parameters<ChatSetup['start']>[2]) => {
      const started = await this.#chatSetup.start(adapter, message, request);
      if (!started) await send(m.setup.alreadyRunning);
      else if (finish) await finish(selectedCommand);
    };
    if (name === 'pair') {
      if (/^new(?:\s|$)/i.test(args)) {
        if (owner) await this.#newPairingCode(adapter, message, args);
        return;
      }
      if (owner && !args && message.chatKind === 'dm') {
        await send(m.pairing.useNew);
        return;
      }
      if (message.chatKind !== 'dm' || this.#auth.owner(adapter.id)) {
        if (finish) await finish(m.choices.unavailable);
        return;
      }
      const paired = this.#auth.claimPairing(adapter.id, message.userId, args);
      if (paired) this.#commandMenus.sync(adapter);
      await send(paired ? m.pairing.success : m.pairing.invalid);
      if (paired) {
        this.#reportPlatformNotices();
        await this.#reportFailures();
      }
      return;
    }
    if (!canRunCommand(name, owner, this.#auth.isAllowlisted(chat))) {
      if (finish) await finish(m.choices.unavailable);
      return;
    }
    const isCurrentOwner = () =>
      !this.#isStopping() &&
      this.#runtime.getAdapter(adapter.id) === adapter &&
      this.#auth.isOwner({ adapterId: adapter.id, userId: message.userId });
    switch (name) {
      case 'sticker':
        await send(
          this.#stickers.command(args, locale, message.chatKind === 'dm'),
        );
        break;
      case 'help': {
        const commands = chatCommands(locale)[
          owner ? 'owner' : 'member'
        ].filter(
          ({ name }) =>
            message.chatKind === 'dm' ||
            (name !== 'pair' && name !== 'sticker'),
        );
        const descriptions = new Map(
          commands.map(({ name, description }) => [`/${name}`, description]),
        );
        const choices = [...descriptions.keys()].map((label) => ({
          label,
          value: label,
        }));
        const describePage = (page: readonly PromptChoice[]) =>
          page
            .map(({ label }) => `${label} · ${descriptions.get(label)}`)
            .join('\n');
        await send(m.choices.help, choices, describePage(choices), {
          canChoose: () =>
            !this.#isStopping() &&
            !this.#removingPlatform(adapter.id) &&
            this.#runtime.getAdapter(adapter.id) === adapter &&
            canRunCommand(
              'help',
              this.#auth.isOwner({
                adapterId: adapter.id,
                userId: message.userId,
              }),
              this.#auth.isAllowlisted(chat),
            ),
          describePage,
          select: ({ value }, edit, event) => {
            // Give the tap its own log position while replying to a platform message.
            const selected: TaskInput['message'] = {
              type: 'message',
              chatId: event.chatId,
              chatKind: message.chatKind,
              chatTitle: message.chatTitle,
              messageId: event.callbackId,
              replyToMessageId: event.messageId,
              text: value,
              threadId: event.threadId,
              userDisplay: event.userDisplay,
              userId: event.userId,
              userUsername: event.userUsername,
            };
            return this.#process(adapter, selected, edit);
          },
        });
        break;
      }
      case 'webhook': {
        const w = m.webhook;
        if (args === 'setup') {
          await send(w.providers, [
            ...(this.#webhooks.provider('cloudflare')
              ? [{ value: 'setup cloudflare', label: 'Cloudflare Tunnel' }]
              : []),
            { value: 'setup manual', label: w.manual },
          ]);
        } else if (args === 'setup manual' || args === 'setup cloudflare') {
          const kind = args.slice('setup '.length);
          if (!this.#webhooks.provider(kind))
            await send(w.missingProvider(kind));
          else await setup({ mode: 'add', category: 'webhook', kind });
        } else if (args === 'check') {
          await send(
            webhookStatusLine(await this.#webhooks.check(true), locale),
          );
        } else if (!args) {
          await send(webhookStatusLine(this.#webhooks.status(), locale), [
            { value: 'setup', label: w.setup },
            { value: 'check', label: w.check },
          ]);
        } else await send(w.use);
        break;
      }
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
          const choices = [...kinds].map((kind) => ({
            value: `${args} ${kind}`,
            label:
              kind +
              (args === 'platform' &&
              this.#registry.requiresWebhook(kind) &&
              this.#webhooks.status().state !== 'ok'
                ? m.webhook.suffix
                : ''),
          }));
          await send(
            kinds.size ? m.choices.addKind(args) : m.choices.noPlugins(args),
            choices,
            m.choices.values(
              choices
                .map(
                  ({ label, value }) => `/add ${value.split(' ')[0]} ${label}`,
                )
                .join(' · '),
            ),
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
        if (
          match[1] === 'platform' &&
          this.#registry.requiresWebhook(match[2])
        ) {
          const status = this.#webhooks.status();
          if (status.state !== 'ok') {
            const w = m.webhook;
            const state = status.reason
              ? w.failed(status.reason)
              : w.states[status.state];
            await send(
              w.blocked(match[2] === 'line' ? 'LINE' : match[2], state),
              [
                { value: 'setup', label: w.setupWebhook },
                { value: 'check', label: w.check },
              ],
              undefined,
              { command: 'webhook' },
            );
            break;
          }
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
        const removal = removalMessages(locale);
        if (!args) {
          await send(
            removal.usage,
            [
              {
                value: 'platform',
                label: 'Platform',
                localized: { 'zh-TW': '平台' },
              },
              {
                value: 'agent',
                label: 'Agent',
                localized: { 'zh-TW': '代理' },
              },
            ],
            removal.categories,
          );
          break;
        }
        if (args === 'agent' || args === 'platform') {
          const config = this.#runtime.config;
          const configured =
            args === 'agent' ? config.agents : config.platforms;
          const blocked = args === 'agent' ? defaultAgent(config) : adapter.id;
          const choices: PromptChoice[] = [];
          const lines = [removal.choose(args)];
          for (const { id, kind } of configured) {
            const label =
              locale === 'zh-TW' ? `${id}（${kind}）` : `${id} (${kind})`;
            const reason =
              id !== blocked
                ? undefined
                : args === 'platform'
                  ? removal.ownPlatform
                  : removal.defaultAgent(
                      id,
                      config.agents
                        .filter(
                          (agent) => agent.id !== id && agent.enabled !== false,
                        )
                        .map((agent) => agent.id),
                    );
            lines.push(reason ? `- ${label} · ${reason}` : `- ${label}`);
            if (!reason) choices.push({ value: `${args} ${id}`, label: id });
          }
          if (!choices.length) lines.push(removal.noRemovable);
          await send(lines.join('\n'), choices, removal.removeHint(args));
          break;
        }
        const match =
          /^(agent|platform)\s+([A-Za-z0-9_][A-Za-z0-9_.:-]*)$/.exec(args);
        if (!match?.[2]) await send(removal.usage);
        else {
          if (finish) await finish(selectedCommand);
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
        }
        break;
      }
      case 'allow':
      case 'deny':
        store.setAllowlisted(chat, name === 'allow');
        this.#commandMenus.sync(adapter);
        if (name === 'deny') this.#tasks.cancelApprovals(chat);
        await send(name === 'allow' ? m.allowlisted : m.removedFromAllowlist);
        break;
      case 'model': {
        const canChoose = () =>
          isCurrentOwner() &&
          !this.#removingPlatform(adapter.id) &&
          !this.#removingAgentRoute(chat);
        if (!canChoose()) {
          if (finish) await finish(m.choices.unavailable);
          break;
        }
        if (!args) {
          const route = this.#tasks.route(chat);
          const provider = route.agentId ?? m.unset;
          const status = this.#tasks.status(chat);
          const model =
            (route.model.value === 'default' ? undefined : route.model.value) ??
            status.defaults?.model ??
            m.unset;
          const current = [
            locale === 'zh-TW'
              ? `${m.settingLabels.provider}：${provider}`
              : `${m.settingLabels.provider}: ${provider}`,
            m.settingCurrent(
              m.settingLabels.model,
              model,
              m.settingSources[route.model.source],
            ),
          ].join(' · ');
          const reset = { label: 'default', value: 'default' };
          const agents = this.#runtime.config.agents.flatMap(({ id }) => {
            const agent = this.#runtime.getAgent(id)?.agent;
            return agent && !this.#removingAgent(id) ? [agent] : [];
          });
          const choices = agents.map(({ id, implementation }) => {
            const label =
              implementation &&
              !agents.some(
                (other) =>
                  other.id !== id &&
                  (other.id === implementation ||
                    other.implementation === implementation),
              )
                ? implementation
                : id;
            return {
              label:
                label === reset.label
                  ? `${label} (${m.settingLabels.provider})`
                  : label,
              value: id,
            };
          });
          choices.push(reset);
          const describePage = (page: readonly PromptChoice[]) =>
            m.modelProviders(
              page
                .map(({ label, value }) =>
                  label === value ? label : `${label} (${value})`,
                )
                .join(' · '),
            );
          await send(current, choices, describePage(choices), {
            canChoose,
            describePage,
            select: (choice, edit) =>
              this.#trace.span(
                'trigger.command',
                { ...chat, command: name },
                () => {
                  const send = respond(
                    edit,
                    m.choices.answer(`/model ${choice.value}`),
                  );
                  return choice === reset
                    ? this.#setChatModel(chat, null, null, send, canChoose)
                    : this.#showProviderModels(
                        chat,
                        choice.value,
                        send,
                        canChoose,
                      );
                },
              ),
          });
          break;
        }
        if (args === 'default') {
          await this.#setChatModel(chat, null, null, send, canChoose);
          break;
        }
        const [provider = args, model] = args.split(/\s+([\s\S]+)/, 2);
        if (model !== undefined)
          await this.#setChatModel(
            chat,
            provider,
            model === 'default' ? null : model,
            send,
            canChoose,
          );
        else if (this.#runtime.config.agents.some(({ id }) => id === provider))
          await this.#showProviderModels(chat, provider, send, canChoose);
        else
          await this.#setChatModel(chat, undefined, provider, send, canChoose);
        break;
      }
      case 'thinking':
      case 'fast':
        await this.#chatAgentSetting(chat, name, args, send, isCurrentOwner);
        break;
      case 'compact':
        if (
          this.#removingPlatform(adapter.id) ||
          this.#removingAgentRoute(chat)
        )
          break;
        if (args) await send(m.compactUsage);
        else {
          this.#tasks.dispatch(
            adapter,
            chat,
            { message, seq, compact: true },
            onTask,
          );
          if (finish) await finish(selectedCommand);
        }
        break;
      case 'stop':
      case 'context':
        if (
          this.#removingPlatform(adapter.id) ||
          this.#removingAgentRoute(chat)
        )
          break;
        if (name === 'stop') {
          if (args) await send(m.stopUsage);
          else {
            const queued = this.#tasks.stop(chat, message.userId);
            await send(queued === undefined ? m.stopIdle : m.stopped(queued));
          }
        } else if (args) await send(m.contextUsage);
        else {
          await this.#trace.flush();
          await send(
            contextCard(
              { store, trace: this.#trace },
              this.#tasks.status(chat).sessionScope,
              locale,
              store.getChat(store.resolveChat(chat))?.incognitoId ?? null,
            ),
          );
        }
        break;
      case 'ask':
      case 'btw': {
        if (
          this.#removingPlatform(adapter.id) ||
          this.#removingAgentRoute(chat)
        )
          break;
        if (!args) await send(name === 'ask' ? m.askUsage : m.btwUsage);
        else
          this.#tasks.dispatch(
            adapter,
            chat,
            {
              message,
              seq,
              sessionCommand: {
                mode: name,
                prompt: redactPairingCodes(args),
              },
            },
            onTask,
          );
        break;
      }
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
        if (!args || args === 'close') {
          const open = this.#previews?.list(chat.adapterId) ?? [];
          await send(
            open.length || !args ? m.previewCloseUsage : m.noPreviews,
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
            webhook: this.#webhooks.status(),
            store,
            tasks: this.#tasks,
            trace: this.#trace,
          },
          chat,
          message,
        );
        if (finish) await finish(selectedCommand);
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

export { Webhooks } from './webhooks.ts';
