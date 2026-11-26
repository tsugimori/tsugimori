import type { ChatRef } from '@tsugimori/plugin-sdk';
import type { ScheduleRecord, Store } from '@tsugimori/storage';

import {
  prepareReminder,
  reminderEntities,
  unlinkedText,
} from './reminders.ts';

export type ScheduleLocale = 'en' | 'zh-TW';
export type ScheduleStatus =
  'scheduled' | 'pending_approval' | 'paused' | 'cancelled' | 'done';

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
    pending_approval: 'Awaiting approval',
    today: 'Today',
    tomorrow: 'Tomorrow',
    once: 'once',
    cron: (expression: string) => 'cron ' + expression,
    interval: (minutes: number) => `every ${minutes} min`,
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
    pending_approval: '等待同意',
    today: '今天',
    tomorrow: '明天',
    once: '一次',
    cron: (expression: string) => 'Cron ' + expression,
    interval: (minutes: number) => `每 ${minutes} 分鐘`,
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
  'Confirm completed schedule changes in one sentence with when, where, and what. Use the human-readable summary. The framework reports the outcome of pending approvals. Omit internal IDs, field names, and JSON. Mention a short reference only when the user asks to manage a schedule.';

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

export function scheduleCadence(
  repeat: { cron: string } | { minutes: number } | undefined,
  locale: ScheduleLocale,
) {
  const m = messages[locale];
  const label = !repeat
    ? m.once
    : 'cron' in repeat
      ? m.cron(repeat.cron)
      : m.interval(repeat.minutes);
  return locale === 'zh-TW' ? `（${label}）` : ` (${label})`;
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
  const { action, adapterId, target, trigger } = schedule;
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
  const repeat =
    trigger.kind === 'interval'
      ? trigger
      : trigger.kind === 'cron'
        ? { cron: trigger.expr }
        : undefined;
  const due =
    schedule.nextDueAt ?? (trigger.kind === 'cron' ? undefined : trigger.at);
  const time =
    (due === undefined
      ? ''
      : scheduleTime(due, schedule.timezone, locale, now, true)) +
    (repeat ? scheduleCadence(repeat, locale) : '');
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
  const listTime =
    (due === undefined
      ? ''
      : scheduleTime(due, schedule.timezone, locale, now)) +
    (repeat ? scheduleCadence(repeat, locale) : '');
  const line = [
    `#${ref}`,
    listTime,
    targets,
    content,
    status === 'scheduled' ? '' : `(${m[status]})`,
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
