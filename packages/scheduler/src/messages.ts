import type { ChatRef, ScheduleApprovalRequest } from '@tsugimori/plugin-sdk';
import type {
  ScheduleRecord,
  ScheduleTrigger,
  Store,
} from '@tsugimori/storage';

import type { ScheduleLocale } from './cadence.ts';

import { cronCadence, intervalCadence } from './cadence.ts';
import {
  prepareReminder,
  reminderEntities,
  unlinkedText,
} from './reminders.ts';

export type ScheduleStatus =
  'scheduled' | 'pending_approval' | 'paused' | 'cancelled' | 'done' | 'failed';
type ScheduleRepeat = NonNullable<ScheduleApprovalRequest['repeat']>;

const messages = {
  en: {
    privateChat: 'Private chat',
    unnamedChat: 'Unnamed chat',
    unknownUser: 'the recipient',
    owner: 'the owner',
    everyone: 'everyone',
    noSchedules: 'There are no schedules to manage in this chat.',
    paused: 'Paused',
    cancelled: 'Cancelled',
    done: 'Completed',
    failed: 'Failed',
    pending_approval: 'Awaiting approval',
    today: 'Today',
    tomorrow: 'Tomorrow',
    once: 'once',
    from: (time: string, cadence: string) => `from ${time}, ${cadence}`,
    until: (time: string) => `, until ${time}`,
    next: (time: string) => ` · next due ${time}`,
    relative: (minutes: number, clock: string) =>
      `In ${minutes} min (${clock})`,
    scheduled: (time: string, chat: string, target: string, content: string) =>
      `${time} in ${chat}, remind ${target}: ${content}`,
    task: (time: string, chat: string, content: string) =>
      `${time} in ${chat}, run: ${content}`,
    pending: (approver: string) =>
      `Request sent. Awaiting approval from ${approver}`,
  },
  'zh-TW': {
    privateChat: '私人對話',
    unnamedChat: '未命名的聊天室',
    unknownUser: '收件人',
    owner: '主人',
    everyone: '大家',
    noSchedules: '這個聊天室目前沒有可管理的排程。',
    paused: '已暫停',
    cancelled: '已取消',
    done: '已完成',
    failed: '失敗',
    pending_approval: '等待同意',
    today: '今天',
    tomorrow: '明天',
    once: '一次',
    from: (time: string, cadence: string) => `${time} 起，${cadence}`,
    until: (time: string) => `，到${time} 為止`,
    next: (time: string) => ` · 下次執行 ${time}`,
    relative: (minutes: number, clock: string) =>
      `${minutes} 分鐘後（${clock}）`,
    scheduled: (time: string, chat: string, target: string, content: string) =>
      `${time}在 ${chat} 提醒 ${target}：${content}`,
    task: (time: string, chat: string, content: string) =>
      `${time}在 ${chat} 執行：${content}`,
    pending: (approver: string) => `已送出，等待${approver}同意`,
  },
};

export const scheduleReplyStyle =
  'Confirm completed schedule changes in one sentence with when, where, and what. Use the human-readable summary. The framework handles pending approval feedback. Omit internal IDs, field names, and JSON. Mention a short reference only when the user asks to manage a schedule.';

export function scheduleChatName(
  store: Store,
  chat: ChatRef,
  locale: ScheduleLocale,
  userId?: string,
) {
  const record = store.getChat(chat);
  const m = messages[locale];
  if (record?.title) return record.title;
  if (record?.kind !== 'dm') return m.unnamedChat;
  const recipient = userId ?? store.deliveryAddress(chat)?.userId;
  return (
    (recipient && store.getUserDisplay({ ...chat, userId: recipient })) ||
    m.privateChat
  );
}

export function scheduleTime(
  timestamp: number,
  timezone: string,
  locale: ScheduleLocale,
  now: number,
  relative = false,
) {
  const m = messages[locale];
  const clock = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  }).format(timestamp);
  const day = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  });
  const dueDay = day.format(timestamp);
  const today = day.format(now);
  const minutes = Math.ceil((timestamp - now) / 60_000);
  if (dueDay === today && relative && minutes >= 1 && minutes <= 60)
    return m.relative(minutes, clock);
  const tomorrow = new Date(today + 'T00:00:00Z');
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const label =
    dueDay === today
      ? m.today
      : dueDay === tomorrow.toISOString().slice(0, 10)
        ? m.tomorrow
        : new Intl.DateTimeFormat(locale, {
            dateStyle: 'medium',
            timeZone: timezone,
          }).format(timestamp);
  return `${label} ${clock}`;
}

function cadence(repeat: ScheduleRepeat, locale: ScheduleLocale) {
  return 'cron' in repeat
    ? cronCadence(repeat.cron, locale)
    : intervalCadence(repeat.minutes, locale);
}

export function scheduleCadence(
  repeat: ScheduleRepeat | undefined,
  locale: ScheduleLocale,
) {
  const label = repeat ? cadence(repeat, locale) : messages[locale].once;
  return locale === 'zh-TW' ? `（${label}）` : ` (${label})`;
}

export function scheduleRepeat(
  trigger: Exclude<ScheduleTrigger, { kind: 'once' }>,
): ScheduleRepeat {
  return trigger.kind === 'cron'
    ? { cron: trigger.expr }
    : { minutes: trigger.minutes };
}

function dateInSentence(
  timestamp: number,
  timezone: string,
  locale: ScheduleLocale,
  now: number,
) {
  return scheduleTime(timestamp, timezone, locale, now).replace(
    /^(Today|Tomorrow)\b/,
    (day) => day.toLowerCase(),
  );
}

export function recurringScheduleTime(
  {
    dueAt,
    repeat,
    timezone,
    until,
  }: {
    dueAt?: number;
    repeat: ScheduleRepeat;
    timezone: string;
    until?: number;
  },
  locale: ScheduleLocale,
  now: number,
) {
  const m = messages[locale];
  const date = (timestamp: number) =>
    dateInSentence(timestamp, timezone, locale, now);
  const label = cadence(repeat, locale);
  return (
    (dueAt === undefined ? label : m.from(date(dueAt), label)) +
    (until === undefined ? '' : m.until(date(until)))
  );
}

export function scheduleRecordTime(
  schedule: Pick<ScheduleRecord, 'nextDueAt' | 'timezone' | 'trigger'>,
  locale: ScheduleLocale,
  now: number,
  relative = false,
) {
  const { nextDueAt, trigger, timezone } = schedule;
  if (trigger.kind === 'once')
    return scheduleTime(
      nextDueAt ?? trigger.at,
      timezone,
      locale,
      now,
      relative,
    );
  const firstDueAt = trigger.kind === 'cron' ? trigger.firstDueAt : trigger.at;
  const timing = recurringScheduleTime(
    {
      dueAt: firstDueAt,
      repeat: scheduleRepeat(trigger),
      timezone,
      until: trigger.until,
    },
    locale,
    now,
  );
  return nextDueAt !== null && nextDueAt !== firstDueAt
    ? timing +
        messages[locale].next(dateInSentence(nextDueAt, timezone, locale, now))
    : timing;
}

export function scheduleRef(id: string) {
  return id.slice(0, 6);
}

export function scheduleResult(
  store: Store,
  schedule: ScheduleRecord,
  locale: ScheduleLocale,
  now: number,
  status: ScheduleStatus,
  approverName?: string,
) {
  const m = messages[locale];
  const ref = scheduleRef(schedule.id);
  const { action, adapterId, target } = schedule;
  const chat = {
    adapterId,
    chatId:
      target.threadId === undefined
        ? target.chatId
        : `${target.chatId}_${target.threadId}`,
  };
  const recipient = store.deliveryAddress(chat);
  const where = compact(
    scheduleChatName(store, chat, locale, recipient?.userId),
  );
  const display = (userId: string) =>
    store.getUserDisplay({ adapterId, userId });
  const reminder =
    action.kind === 'message'
      ? action.mentions
        ? { text: action.text, mentions: action.mentions }
        : prepareReminder(action.text, schedule.mentions, display)
      : undefined;
  const ids =
    recipient?.kind === 'dm'
      ? [recipient.userId, ...schedule.mentions]
      : schedule.mentions;
  const labels = reminder?.mentions ?? [];
  const names = new Map(ids.map((id) => [id, display(id)]));
  for (const { userId, displayName } of labels) names.set(userId, displayName);
  const ordinary = reminder ? unlinkedText(reminder.text, labels) : '';
  const handles = ordinary.match(/@[\p{L}\p{N}_]+/gu) ?? [];
  const targets =
    [
      ...new Set([
        ...[...names.values()].map((name) => compact(name || m.unknownUser)),
        ...handles,
      ]),
    ].join(locale === 'zh-TW' ? '、' : ', ') || m.everyone;
  let content = compact(
    reminder?.text ?? (action.kind === 'agent' ? action.prompt : action.text),
  );
  if (reminder) {
    const first = reminderEntities(labels)[0];
    if (first && !reminder.text.slice(0, first.offset).trim()) {
      const remainder = reminder.text.slice(first.offset + first.length);
      if (/^[\s:：,，、]+/u.test(remainder))
        content = compact(remainder.replace(/^[\s:：,，、]+/u, '')) || content;
    }
  }
  const listTime = scheduleRecordTime(schedule, locale, now);
  const time =
    schedule.trigger.kind === 'once'
      ? scheduleRecordTime(schedule, locale, now, true)
      : listTime;
  const description =
    action.kind === 'message'
      ? m.scheduled(time, where, targets, content)
      : m.task(time, where, content);
  let summary = description;
  if (status === 'pending_approval') {
    const approver = (approverName ?? m.owner) || m.unknownUser;
    summary =
      m.pending(compact(approver)) +
      (locale === 'zh-TW' ? '：' : ': ') +
      description;
  } else if (status !== 'scheduled') {
    summary = m[status] + (locale === 'zh-TW' ? '：' : ': ') + description;
  }
  const line = [
    `#${ref}`,
    listTime,
    targets,
    content,
    status === 'scheduled' ? '' : `(${m[status]})`,
    schedule.failureReason,
  ]
    .filter(Boolean)
    .join(' ');
  return { line, result: { ok: true, summary, status, ref } };
}

export function emptyScheduleList(locale: ScheduleLocale) {
  return messages[locale].noSchedules;
}

function compact(text: string) {
  const line = text.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(line);
  return characters.length > 100
    ? characters.slice(0, 100).join('') + '…'
    : line;
}
