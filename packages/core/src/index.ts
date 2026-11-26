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
import type { ScheduleRecord, ScheduleRun, Store } from '@tsugimori/storage';

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

import type { Logger } from './hooks.ts';
import type { PreviewProviders } from './previews.ts';

import { approvalDecisionText } from './approval-messages.ts';
import { ChatSetup } from './chat-setup.ts';
import { EnvironmentChecks, failureText } from './checks.ts';
import { Executions, sandboxScope } from './executions.ts';
import { HookRunner, logToStderr } from './hooks.ts';
import { conversationId, Outbound } from './outbound.ts';
import { Previews } from './previews.ts';
import { PluginRegistry } from './registry.ts';
import { Runtime } from './runtime.ts';
import { GuidedSetup } from './setup.ts';
import { BackgroundSummaries } from './summary.ts';
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
  #reportedFailures = false;
  readonly #inbound = new Set<Promise<void>>();
  #closeWatch?: ReturnType<typeof watch>;
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
        approvals: store.listApprovals(),
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
      measure: (target, run) =>
        this.#trace.span('environment.check', { target }, run),
      store,
      log,
      receive: (adapter, event) => this.#receive(adapter, event),
      interrupt: async (adapters, agents) => {
        await this.#tasks.interrupt(adapters, agents);
        await this.#previews?.detach(adapters);
        await this.#execution.stop(adapters);
      },
    });
    this.#hooks = new HookRunner({ registry, trace: this.#trace, log });
    this.#outbound = new Outbound({
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
      approve: async (task, request, signal) =>
        task.approveSchedule?.(request, signal),
      canSchedule: (chat, userId) =>
        this.#auth.isOwner({ ...chat, userId }) ||
        this.#auth.isAllowlisted(chat),
      deliver: (schedule, run, delayed) =>
        this.#fireSchedule(schedule, run, delayed),
      attachedAdapters: () =>
        this.#isStopping() || this.#runtime.transition
          ? []
          : this.#runtime.adapterIds,
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
    store.interruptTasks(Date.now());
    await this.#apply(snapshot);
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
    await this.#reportFailures();
  }

  async #apply(snapshot: WorkspaceConfig) {
    await this.#runtime.apply(snapshot);
    if (this.#deps.namedPreview) {
      const provider = this.#deps.namedPreview(
        this.#runtime.disabled('preview.named') ? undefined : snapshot,
      );
      await this.#previews?.configureNamed(provider);
    }
  }

  async #reportFailures() {
    if (this.#reportedFailures) return;
    const failures = failureText(this.#runtime.reports);
    if (!failures) return;
    for (const id of this.#runtime.adapterIds) {
      const owner = this.#auth.owner(id);
      const adapter = this.#runtime.getAdapter(id);
      if (!owner || !adapter) continue;
      this.#reportedFailures = true;
      try {
        await this.#outbound.send(adapter, {
          chatId: owner,
          text: `Environment checks failed:
${failures}`,
        });
      } catch {
        this.#deps.log({
          level: 'warn',
          event: 'environment.owner_notification_failed',
          adapterId: id,
        });
      }
      return;
    }
  }

  async idle() {
    while (this.#inbound.size) await Promise.allSettled(this.#inbound);
    await this.#tasks.idle();
  }

  stop() {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop() {
    this.#state = 'stopping';
    this.#scheduler.stop();
    try {
      await this.#closeWatch?.();
    } finally {
      try {
        await this.#chatSetup.stop();
        await this.#summaries.stop();
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

  async #process(adapter: PlatformAdapter, event: PlatformInboundEvent) {
    const { store } = this.#deps;
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
      const result = this.#resolveApproval({
        ...chat,
        callbackId: event.callbackId,
        messageId: event.messageId,
        userId: event.userId,
      });
      await this.#approvalFeedback(adapter, chat, {
        chatId: event.chatId,
        messageId: event.messageId,
        queryId: event.queryId,
        decision: result?.decision,
        pre: result?.pre,
      });
      return;
    }
    if (await this.#chatSetup.receive(adapter, chat, event)) return;
    const command = parseCommand(event.text);
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
        {
          adapterId: chat.adapterId,
          userId: event.userId,
          display: event.userDisplay ?? null,
        },
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
    if (!stored || event.edited) return;
    const message = privateCommand
      ? { ...event, raw: undefined, text: stored.text }
      : event;
    await this.#hooks.emit('inbound.received', { chat, message });
    if (this.#isStopping()) return;

    if (event.replyTo) {
      const result = this.#resolveApproval({
        ...chat,
        userId: event.userId,
        replyTo: event.replyTo,
        text: event.text,
      });
      if (result) {
        await this.#approvalFeedback(adapter, chat, {
          chatId: event.chatId,
          messageId: event.replyTo,
          decision: result.decision,
          pre: result.pre,
        });
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
        () => this.#command(adapter, chat, message, owner, command),
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
            text: reminder.text,
            entities: reminderEntities(reminder.mentions),
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
      const delayNote = delayed
        ? `[Delayed schedule, originally due ${new Date(run.dueAt).toISOString()}]\n\n`
        : '';
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

  #resolveApproval(input: Parameters<Auth['resolveApproval']>[0]) {
    const result = this.#trace.span(
      'approval.resolve',
      {
        adapterId: input.adapterId,
        chatId: input.chatId,
      },
      () => this.#auth.resolveApproval(input),
    );
    if (result)
      return {
        ...result,
        pre: this.#tasks.resolveApproval({
          ...result,
          decidedBy: input.userId,
        }),
      };
  }

  async #approvalFeedback(
    adapter: PlatformAdapter,
    chat: ChatRef,
    feedback: Omit<ApprovalFeedback, 'decisionText' | 'notice' | 'prompt'>,
  ) {
    if (!adapter.respondToApproval) return;
    const prompt = feedback.decision
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
    owner: boolean,
    { name, args }: Command,
  ) {
    const { store } = this.#deps;
    const send = (text: string) =>
      this.#outbound.send(adapter, reply(message, text));
    if (name === 'pair') {
      if (message.chatKind !== 'dm' || this.#auth.owner(adapter.id)) return;
      const paired = this.#auth.claimPairing(adapter.id, message.userId, args);
      await send(
        paired ? 'Owner paired.' : 'Pairing code is invalid or expired.',
      );
      if (paired) await this.#reportFailures();
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
          await send('Usage: /add <agent|platform> <kind> [--id <id>]');
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
        if (!args) await send('Usage: /login <agentId>');
        else
          await this.#chatSetup.start(adapter, message, {
            mode: 'login',
            id: args,
          });
        break;
      case 'allow':
      case 'deny':
        store.setAllowlisted(chat, name === 'allow');
        await send(
          name === 'allow'
            ? 'Chat allowlisted.'
            : 'Chat removed from the allowlist.',
        );
        break;
      case 'agent':
        if (!this.#runtime.getAgent(args)) {
          await send(
            this.#runtime.unavailable(args) || 'That agent is not attached.',
          );
          break;
        }
        if (store.getChat(chat)?.agentId !== args) {
          this.#tasks.invalidateSession(chat);
          store.setChatRoute(chat, { agentId: args });
        }
        await send(`Agent set to ${args}.`);
        break;
      case 'model':
        if (!args) {
          await send('Usage: /model <name>');
          break;
        }
        if (store.getChat(chat)?.model !== args) {
          this.#tasks.invalidateSession(chat);
          store.setChatRoute(chat, { model: args });
        }
        await send(`Model set to ${args}.`);
        break;
      case 'previews': {
        const open = this.#previews?.list(chat.adapterId) ?? [];
        await send(
          open.length
            ? open
                .map(
                  (item) =>
                    `${item.id} · ${item.url} · port ${item.port} · expires ${new Date(item.expiresAt).toISOString()}`,
                )
                .join('\n')
            : 'No open previews.',
        );
        break;
      }
      case 'preview': {
        const match = /^close\s+(\S+)$/.exec(args);
        if (!match?.[1]) {
          await send('Usage: /preview close <id>');
          break;
        }
        const closed = await this.#previews?.ownerClose(
          chat.adapterId,
          match[1],
        );
        await send(
          closed ? 'Preview closed.' : 'No open preview with that ID.',
        );
        break;
      }
      case 'status':
        await send(
          [
            `Gateway running with ${this.#runtime.adapterCount} platform(s) and ${this.#runtime.agentCount} agent(s).`,
            failureText(this.#runtime.reports),
          ]
            .filter(Boolean)
            .join('\n'),
        );
        break;
    }
  }
}

type Command = {
  args: string;
  name:
    | 'add'
    | 'login'
    | 'pair'
    | 'allow'
    | 'deny'
    | 'agent'
    | 'model'
    | 'status'
    | 'preview'
    | 'previews';
};

function parseCommand(text: string): Command | undefined {
  const match =
    /^\/(add|login|pair|allow|deny|agent|model|status|preview|previews)(?:\s+([\s\S]*))?$/.exec(
      text.trim(),
    );
  if (!match) return;
  return { name: match[1] as Command['name'], args: match[2]?.trim() ?? '' };
}

export { GuidedSetup } from './setup.ts';
export type { SetupIO, SetupRequest } from './setup.ts';

export { systemInstallPlan } from './system-setup.ts';

export { SetupError } from '@tsugimori/plugin-sdk';
export type { SetupDependencies } from '@tsugimori/plugin-sdk';
