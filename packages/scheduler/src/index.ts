import type {
  ChatRef,
  ScheduleApproval,
  ScheduleApprovalReason,
  ScheduleApprovalRequest,
  ToolContext,
  ToolDefinition,
} from '@tsugimori/plugin-sdk';
import type {
  ScheduleAction,
  ScheduleRecord,
  ScheduleRun,
  ScheduleTrigger,
  Store,
} from '@tsugimori/storage';

import { createHash, randomUUID } from 'node:crypto';

import { Cron, minuteMs } from './cron.ts';
import {
  emptyScheduleList,
  scheduleRef,
  scheduleReplyStyle,
  scheduleResult,
} from './messages.ts';
import { prepareReminder, unlinkedText } from './reminders.ts';

export {
  scheduleCadence,
  scheduleChatName,
  scheduleReplyStyle,
  scheduleTime,
} from './messages.ts';
export { prepareReminder, reminderEntities } from './reminders.ts';

type Settings = {
  highCostModels?: readonly string[];
  maxActivePerUser?: number;
  minIntervalMinutes?: number;
};

type ScheduleInput = {
  action: ScheduleAction;
  mentions?: string[];
  missed?: ScheduleRecord['missed'];
  needsApproval?: boolean;
  reason?: string;
  targetChatId?: string;
  targets?: string[];
  timezone?: string;
  trigger: ScheduleTrigger;
};

interface SchedulerDependencies {
  approve(
    task: ToolContext,
    request: ScheduleApprovalRequest,
    signal: AbortSignal,
  ): Promise<ScheduleApproval | undefined>;
  attachedAdapters(): readonly string[];
  canSchedule(chat: ChatRef, userId: string): boolean;
  deliver(
    schedule: ScheduleRecord,
    run: ScheduleRun,
    delayed: boolean,
  ): Promise<ScheduleRun['status']>;
  logError(event: string, id?: string): void;
  model(chat: ChatRef): string;
  now?(): number;
  owner(adapterId: string): string | undefined;
  settings(): Settings & { locale?: 'en' | 'zh-TW'; timezone: string };
  store: Store;
}

interface PendingSchedule {
  approverName?: string;
  controller: AbortController;
  schedule: ScheduleRecord;
}

const text = { type: 'string', minLength: 1, maxLength: 10_000 };
const timestamp = { type: 'integer', minimum: 0, maximum: 8_000_000_000_000 };
function object(properties: Record<string, unknown>, required: string[]) {
  return { type: 'object', additionalProperties: false, properties, required };
}
const at = timestamp;
const until = timestamp;
const nativeUserIds = {
  type: 'array',
  maxItems: 20,
  uniqueItems: true,
  items: { ...text, maxLength: 128 },
};
const fields = {
  action: {
    oneOf: [
      object({ kind: { const: 'message' }, text }, ['kind', 'text']),
      object({ kind: { const: 'agent' }, prompt: text, model: text }, [
        'kind',
        'prompt',
      ]),
    ],
  },
  trigger: {
    oneOf: [
      object({ kind: { const: 'once' }, at }, ['kind', 'at']),
      object(
        { kind: { const: 'cron' }, expr: { ...text, maxLength: 128 }, until },
        ['kind', 'expr'],
      ),
      object(
        {
          kind: { const: 'interval' },
          at,
          minutes: { type: 'integer', minimum: 1, maximum: 525_600 },
          until,
        },
        ['kind', 'at', 'minutes'],
      ),
    ],
  },
  targetChatId: { ...text, maxLength: 256 },
  mentions: {
    ...nativeUserIds,
    description: 'Native platform user IDs to mention.',
  },
  targets: nativeUserIds,
  timezone: { ...text, maxLength: 128 },
  missed: { enum: ['latest', 'skip'] },
  needsApproval: { type: 'boolean' },
  reason: { ...text, maxLength: 300 },
};
const id = { type: 'string', pattern: '^(#?[a-fA-F0-9]{6}|[a-f0-9-]{36})$' };
const empty = object({}, []);

export function containsMention(text: string) {
  return /@[\p{L}\p{N}_]|tg:\/\/user\?id=|(?:https?:\/\/)?t\.me\//iu.test(text);
}

function occurrence(
  schedule: Pick<ScheduleRecord, 'trigger' | 'timezone'>,
  from: number,
  backwards = false,
) {
  const { trigger, timezone } = schedule;
  if (trigger.kind === 'once') return trigger.at;
  const at = backwards ? Math.min(from, trigger.until ?? Infinity) : from;
  const due =
    trigger.kind === 'cron'
      ? backwards
        ? new Cron(trigger.expr, timezone).latest(at)
        : new Cron(trigger.expr, timezone).next(at)
      : trigger.at +
        Math.max(
          0,
          backwards
            ? Math.floor((at - trigger.at) / (trigger.minutes * minuteMs))
            : Math.floor((at - trigger.at) / (trigger.minutes * minuteMs)) + 1,
        ) *
          trigger.minutes *
          minuteMs;
  return due !== undefined &&
    (trigger.until === undefined || due <= trigger.until)
    ? due
    : undefined;
}

export class Scheduler {
  readonly #deps: SchedulerDependencies;
  readonly #now: () => number;
  readonly #active = new Set<Promise<void>>();
  readonly #pending = new Map<string, PendingSchedule>();
  readonly #wake = new AbortController();
  #timer?: NodeJS.Timeout;
  #startedAt = Number.NEGATIVE_INFINITY;

  constructor(deps: SchedulerDependencies) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  start() {
    this.#startedAt = this.#now();
    this.#deps.store.interruptScheduleRuns(this.#startedAt);
    this.#timer = setInterval(() => this.tick(), 1_000);
    this.#timer.unref();
    this.tick();
  }

  stop() {
    clearInterval(this.#timer);
    this.#wake.abort();
    for (const { controller } of this.#pending.values()) controller.abort();
  }

  async idle() {
    await Promise.allSettled(this.#active);
  }

  tick() {
    if (this.#wake.signal.aborted) return;
    try {
      const now = this.#now();
      for (const schedule of this.#deps.store.dueSchedules(
        now,
        this.#deps.attachedAdapters(),
      )) {
        if (this.#active.size >= 2) break;
        const execution = this.#fire(schedule, now).catch(() =>
          this.#deps.logError('schedule.run_failed', schedule.id),
        );
        this.#active.add(execution);
        void execution.finally(() => this.#active.delete(execution));
      }
    } catch {
      this.#deps.logError('schedule.tick_failed');
    }
  }

  tools(): ToolDefinition[] {
    return [
      {
        name: 'schedule.create',
        description:
          'Create a reminder or agent task. Pass recipients in mentions as native platform user IDs (strings). Include the display name in the reminder text or write it as [Name](tg://user?id=ID) to place a mention. at and until are Unix milliseconds. targetChatId is a known chat on this adapter, including its topic suffix if applicable. ' +
          scheduleReplyStyle,
        schema: object(fields, ['action', 'trigger']),
        run: (args, task) => this.#save(args as ScheduleInput, task),
      },
      {
        name: 'schedule.list',
        description:
          'List schedules created in this conversation that you can manage. Relay the readable list and use its six-character references for management. ' +
          scheduleReplyStyle,
        schema: empty,
        run: async (_args, task) => this.#list(task),
      },
      {
        name: 'schedule.update',
        description:
          'Replace the timing and action of a schedule in this chat using its six-character reference as id. Pass recipients in mentions as native platform user IDs (strings). The new settings are checked again for approval. ' +
          scheduleReplyStyle,
        schema: object({ ...fields, id }, ['id', 'action', 'trigger']),
        run: (args, task) => {
          const input = args as ScheduleInput & { id: string };
          const schedule = this.#get(task, input.id);
          if (this.#pending.has(schedule.id))
            throw new Error('Schedule is awaiting approval');
          return this.#save(input, task, schedule);
        },
      },
      {
        name: 'schedule.pause',
        description:
          'Pause or resume a schedule in this chat using its six-character reference as id. Pass paused=false to resume. ' +
          scheduleReplyStyle,
        schema: object({ id, paused: { type: 'boolean' } }, ['id']),
        run: (args, task) => {
          const input = args as { id: string; paused?: boolean };
          return this.#change(
            task,
            input.id,
            input.paused === false ? 'active' : 'paused',
          );
        },
      },
      {
        name: 'schedule.cancel',
        description:
          'Cancel a schedule in this chat using its six-character reference as id. ' +
          scheduleReplyStyle,
        schema: object({ id }, ['id']),
        run: (args, task) =>
          this.#change(task, (args as { id: string }).id, 'cancelled'),
      },
    ];
  }

  #canManage({ principal, chat }: ToolContext, schedule: ScheduleRecord) {
    return (
      schedule.adapterId === chat.adapterId &&
      schedule.chatId === chat.chatId &&
      (principal.userId === schedule.createdBy ||
        principal.userId === this.#deps.owner(chat.adapterId))
    );
  }

  #inChat(chat: ChatRef) {
    return [
      ...this.#deps.store.listSchedules(chat),
      ...[...this.#pending.values()]
        .map(({ schedule }) => schedule)
        .filter(
          (schedule) =>
            schedule.adapterId === chat.adapterId &&
            schedule.chatId === chat.chatId,
        ),
    ];
  }

  #list(task: ToolContext) {
    const locale = this.#deps.settings().locale ?? 'en';
    const now = this.#now();
    const schedules = this.#inChat(task.chat)
      .filter((schedule) => this.#canManage(task, schedule))
      .sort((a, b) => (a.nextDueAt ?? Infinity) - (b.nextDueAt ?? Infinity));
    const entries = schedules.map((schedule) => {
      const pending = this.#pending.get(schedule.id);
      return scheduleResult(
        this.#deps.store,
        schedule,
        locale,
        now,
        pending
          ? 'pending_approval'
          : schedule.status === 'active'
            ? 'scheduled'
            : schedule.status,
        pending?.approverName,
      ).line;
    });
    return {
      ok: true,
      summary: entries.join('\n') || emptyScheduleList(locale),
    };
  }

  #get(task: ToolContext, id: string) {
    const ref = id.replace(/^#/, '').toLowerCase();
    let schedule: ScheduleRecord | undefined;
    if (ref.length === 6) {
      const matches = this.#inChat(task.chat).filter(({ id }) =>
        id.startsWith(ref),
      );
      if (matches.length > 1)
        throw new Error('Schedule reference is ambiguous in this conversation');
      schedule = matches[0];
    } else {
      schedule =
        this.#pending.get(ref)?.schedule ?? this.#deps.store.getSchedule(ref);
    }
    if (!schedule || !this.#canManage(task, schedule))
      throw new Error('Schedule is unavailable in this conversation');
    if (schedule.status === 'cancelled' || schedule.status === 'done')
      throw new Error('Schedule is already closed');
    return schedule;
  }

  async #change(
    task: ToolContext,
    id: string,
    status: ScheduleRecord['status'],
  ) {
    const existing = this.#get(task, id);
    const next = { ...existing, status };
    const pending = this.#pending.get(existing.id);
    if (pending) {
      if (status !== 'cancelled')
        throw new Error('Schedule is awaiting approval');
      this.#pending.delete(existing.id);
      pending.controller.abort();
    } else if (!this.#deps.store.updateSchedule(next, existing, Infinity)) {
      throw new Error('Schedule changed while the request was running');
    }
    return this.#result(next);
  }

  #result(schedule: ScheduleRecord, pending?: PendingSchedule) {
    return scheduleResult(
      this.#deps.store,
      schedule,
      this.#deps.settings().locale ?? 'en',
      this.#now(),
      pending
        ? 'pending_approval'
        : schedule.status === 'active'
          ? 'scheduled'
          : schedule.status,
      pending?.approverName,
    ).result;
  }

  #newId(chat: ChatRef) {
    const used = new Set(this.#inChat(chat).map(({ id }) => scheduleRef(id)));
    let id = randomUUID();
    while (used.has(scheduleRef(id))) id = randomUUID();
    return id;
  }

  async #save(
    input: ScheduleInput,
    task: ToolContext,
    previous?: ScheduleRecord,
  ) {
    const { store } = this.#deps;
    const { chat, principal, signal } = task;
    const time = this.#now();
    const settings = this.#deps.settings();
    const timezone = input.timezone ?? settings.timezone;
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    const address = store.deliveryAddress(chat);
    const targetScope = { ...chat, chatId: input.targetChatId ?? chat.chatId };
    const target = store.deliveryAddress(targetScope);
    if (!address || !target)
      throw new Error('Schedule destination is unavailable');
    const { action, trigger } = input;
    const due = occurrence({ trigger, timezone }, time);
    if (
      due === undefined ||
      due <= time ||
      (trigger.kind === 'interval' && trigger.at <= time)
    )
      throw new Error('Schedule must have a future occurrence');
    const userId = principal.userId;
    const ids = [
      ...new Set([...(input.mentions ?? []), ...(input.targets ?? [])]),
    ];
    const reminder =
      action.kind === 'message'
        ? prepareReminder(action.text, ids, (userId) =>
            store.getUserDisplay({ adapterId: chat.adapterId, userId }),
          )
        : undefined;
    const mentions = reminder
      ? reminder.mentions.map(({ userId }) => userId)
      : ids;
    if (mentions.length > nativeUserIds.maxItems)
      throw new Error('Too many schedule mentions');
    const content =
      reminder?.text ?? (action.kind === 'agent' ? action.prompt : action.text);
    const ordinary = reminder
      ? unlinkedText(content, reminder.mentions)
      : content;
    const explicitMention = containsMention(ordinary);
    const self =
      target.kind === 'dm' &&
      target.userId === userId &&
      mentions.every((id) => id === userId) &&
      !explicitMention;
    const untargetedGroup =
      target.kind !== 'dm' &&
      trigger.kind === 'once' &&
      !mentions.length &&
      !explicitMention;
    const restricted = !self && !untargetedGroup;
    const reasons: ScheduleApprovalReason[] = [];
    const minInterval = settings.minIntervalMinutes ?? 15;
    if (trigger.kind !== 'once') {
      if (
        trigger.kind === 'interval'
          ? trigger.minutes < minInterval
          : new Cron(trigger.expr, timezone).tooFrequent(
              due - 1,
              minInterval,
              trigger.until,
            )
      )
        reasons.push('frequency');
    }
    const model =
      action.kind === 'agent'
        ? (action.model ?? this.#deps.model(chat))
        : undefined;
    if (model && settings.highCostModels?.includes(model))
      reasons.push('model');
    if (input.needsApproval) reasons.push('agent');
    if (action.kind === 'agent' && targetScope.chatId !== chat.chatId)
      reasons.push('crossChat');
    const id = previous?.id ?? this.#newId(chat);
    const schedule: ScheduleRecord = {
      ...chat,
      id,
      action: reminder
        ? { kind: 'message', text: reminder.text, mentions: reminder.mentions }
        : action.kind === 'agent' && model
          ? { ...action, model }
          : action,
      trigger,
      timezone,
      mentions,
      deliveryApprovedBy: null,
      address: { chatId: address.chatId, threadId: address.threadId },
      target: { chatId: target.chatId, threadId: target.threadId },
      createdBy: previous?.createdBy ?? userId,
      missed: input.missed ?? 'latest',
      status: previous?.status === 'paused' ? 'paused' : 'active',
      nextDueAt: due,
    };
    const limit = settings.maxActivePerUser ?? 20;
    const save = (approvedBy: string | null) => {
      const next = { ...schedule, deliveryApprovedBy: approvedBy };
      const saved = previous
        ? store.updateSchedule(next, previous, limit)
        : store.createSchedule(next, limit);
      if (!saved) throw new Error('Schedule limit reached or schedule changed');
      return this.#result(next);
    };
    if (restricted || reasons.length) {
      const ownerOnly = reasons.length > 0;
      if (restricted) reasons.push('delivery');
      const approverId =
        ownerOnly || explicitMention
          ? undefined
          : target.kind === 'dm' && mentions.every((id) => id === target.userId)
            ? target.userId
            : mentions.length === 1 && target.kind !== 'dm'
              ? mentions[0]
              : undefined;
      const ownerId = this.#deps.owner(chat.adapterId);
      const ownerAddress =
        ownerId && store.deliveryAddress({ ...chat, chatId: ownerId });
      const promptAddress = approverId
        ? target
        : ownerAddress &&
            ownerAddress.kind === 'dm' &&
            ownerAddress.userId === ownerId
          ? ownerAddress
          : address;
      const repeat =
        trigger.kind === 'once'
          ? undefined
          : trigger.kind === 'cron'
            ? { cron: trigger.expr }
            : { minutes: trigger.minutes };
      const until = trigger.kind === 'once' ? undefined : trigger.until;
      const agentReason = input.needsApproval ? input.reason : undefined;
      // An always grant covers the same conversation, destination, content and
      // cadence. Its scope cannot be widened by supplying a new tool argument.
      const scope = createHash('sha256')
        .update(
          JSON.stringify([
            chat.chatId,
            targetScope.chatId,
            target.kind === 'dm' ? target.userId : null,
            action.kind,
            action.kind === 'message' ? action.text : action.prompt,
            [...mentions].sort(),
            model,
            timezone,
            trigger.kind,
            repeat,
            until,
            schedule.missed,
            reasons,
            agentReason,
          ]),
        )
        .digest('hex');
      const request: ScheduleApprovalRequest = {
        id,
        address: promptAddress,
        agentReason,
        approverId,
        content,
        dueAt: due,
        kind: action.kind,
        recipients: [
          ...new Set([
            ...mentions.map(
              (id) =>
                reminder?.mentions.find(({ userId }) => userId === id)
                  ?.displayName ??
                store.getUserDisplay({
                  adapterId: chat.adapterId,
                  userId: id,
                }) ??
                '',
            ),
            ...(target.kind === 'dm'
              ? [
                  store.getUserDisplay({
                    adapterId: chat.adapterId,
                    userId: target.userId,
                  }) ?? '',
                ]
              : []),
            ...(ordinary.match(/@[\p{L}\p{N}_]+/gu) ?? []),
          ]),
        ],
        model,
        operation: previous ? 'update' : 'create',
        reasons,
        repeat,
        scope,
        target: targetScope,
        targetUserId: target.kind === 'dm' ? target.userId : undefined,
        timezone,
        until,
      };
      if (previous) {
        const approval = await this.#deps.approve(task, request, signal);
        const approvedBy =
          approval &&
          ('approvedBy' in approval
            ? approval.approvedBy
            : await approval.decision);
        if (!approvedBy) throw new Error('Schedule approval denied');
        signal.throwIfAborted();
        return save(approvedBy);
      }
      const controller = new AbortController();
      const designated = approverId ?? ownerId;
      const pending = {
        controller,
        schedule,
        approverName: designated
          ? (store.getUserDisplay({
              adapterId: chat.adapterId,
              userId: designated,
            }) ??
            reminder?.mentions.find(({ userId }) => userId === designated)
              ?.displayName ??
            (approverId ? '' : undefined))
          : undefined,
      };
      this.#pending.set(id, pending);
      let waiting = false;
      try {
        const approval = await this.#deps.approve(
          task,
          request,
          controller.signal,
        );
        signal.throwIfAborted();
        controller.signal.throwIfAborted();
        if (!approval)
          throw new Error('Schedule approval denied or unavailable');
        if ('approvedBy' in approval) return save(approval.approvedBy);
        waiting = true;
        void approval.decision
          .then((approvedBy) => {
            if (
              approvedBy &&
              !controller.signal.aborted &&
              this.#deps.canSchedule(chat, userId)
            )
              save(approvedBy);
          })
          .catch(() => this.#deps.logError('schedule.approval_failed', id))
          .finally(() => this.#pending.delete(id));
        return this.#result(schedule, pending);
      } finally {
        if (!waiting) {
          this.#pending.delete(id);
          controller.abort();
        }
      }
    }
    signal.throwIfAborted();
    return save(null);
  }

  async #fire(schedule: ScheduleRecord, now: number) {
    const { store } = this.#deps;
    const latest = occurrence(schedule, now, true);
    if (
      latest === undefined ||
      schedule.nextDueAt === null ||
      latest < schedule.nextDueAt
    )
      return;
    const next =
      schedule.trigger.kind === 'once'
        ? null
        : (occurrence(schedule, now) ?? null);
    const delayed =
      latest < this.#startedAt ||
      latest > schedule.nextDueAt ||
      now - latest >= 2_000;
    const record: ScheduleRun = {
      scheduleId: schedule.id,
      dueAt: latest,
      startedAt: now,
      finishedAt: null,
      status: 'claimed',
    };
    if (!store.claimScheduleRun(schedule, record, next)) return;
    let status: ScheduleRun['status'] = 'failed';
    try {
      status =
        (delayed && schedule.missed === 'skip') ||
        !this.#deps.canSchedule(schedule, schedule.createdBy)
          ? 'skipped'
          : await this.#deps.deliver(schedule, record, delayed);
    } finally {
      store.finishScheduleRun({ ...record, status, finishedAt: this.#now() });
    }
  }
}
