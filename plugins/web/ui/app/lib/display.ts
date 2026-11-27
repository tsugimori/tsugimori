import type { AdminChat, ChatRef } from '@tsugimori/plugin-sdk';

import type { Locale } from './i18n.ts';

import { number } from './format.ts';
import { i18n } from './i18n.ts';

export function chatHref({
  adapterId,
  chatId,
  threadId,
}: ChatRef & { threadId?: string | null }) {
  return [
    '/chat',
    encodeURIComponent(adapterId),
    encodeURIComponent(chatId),
    ...(threadId ? [encodeURIComponent(threadId)] : []),
  ].join('/');
}

export function taskHref(taskId: string) {
  return '/task/' + encodeURIComponent(taskId);
}

export function platformLabel(kind: string) {
  return kind === 'telegram' ? 'Telegram' : kind === 'line' ? 'LINE' : kind;
}

export function chatTitle(chat: AdminChat) {
  return chat.title || chat.chatId;
}
export function routeLabel(route: AdminChat['route'], locale: Locale) {
  const m = i18n(locale);
  const thinking: Record<string, string> = {
    high: m.high,
    low: m.low,
    medium: m.medium,
    minimal: m.minimal,
    xhigh: m.xhigh,
    max: m.max,
    none: m.off,
  };
  const tier = route.serviceTier;
  return (
    [
      route.agentId &&
        (route.isDefault ? `${route.agentId} ${m.default}` : route.agentId),
      route.model,
      route.thinking &&
        (Object.hasOwn(thinking, route.thinking)
          ? thinking[route.thinking]
          : route.thinking),
      tier === 'fast' || tier === 'priority'
        ? m.fast
        : tier === 'default'
          ? m.off
          : tier,
    ]
      .filter(Boolean)
      .join(' · ') || '—'
  );
}

export function summaryProgress(chat: AdminChat) {
  return chat.summary
    ? `#${number(chat.summary.throughSeq)} / #${number(chat.latestSeq)}`
    : '';
}

const statuses = {
  ok: ['ok', 'done'],
  completed: ['ok', 'done'],
  sent: ['ok', 'done'],
  done: ['ok', 'done'],
  running: ['run', 'running'],
  sending: ['run', 'running'],
  queued: ['run', 'queued'],
  pending: ['warn', 'pending'],
  'pending-approval': ['warn', 'pending'],
  denied: ['warn', 'denied'],
  approved: ['ok', 'approved'],
  error: ['err', 'failed'],
  failed: ['err', 'failed'],
  'delivery-unknown': ['err', 'failed'],
  cancelled: ['idle', 'cancelled'],
  expired: ['idle', 'expired'],
  active: ['ok', 'active'],
  paused: ['idle', 'paused'],
  idle: ['idle', 'idle'],
  disabled: ['idle', 'disabled'],
  unavailable: ['err', 'error'],
} as const;

export function statusStyle(status: string | null) {
  return status && Object.hasOwn(statuses, status)
    ? statuses[status as keyof typeof statuses]
    : (['idle', 'unknown'] as const);
}

export function chatKey({ adapterId, chatId }: ChatRef) {
  return JSON.stringify([adapterId, chatId]);
}

export function taskDuration(
  task: {
    createdAt: number;
    finishedAt: number | null;
    startedAt: number | null;
  },
  now: number,
) {
  return task.startedAt === null && task.finishedAt === null
    ? null
    : Math.max(
        0,
        (task.finishedAt ?? now) - (task.startedAt ?? task.createdAt),
      );
}

export function tokenPair(input?: number | null, output?: number | null) {
  if (input == null && output == null) return '—';
  const abbreviated = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  return [input, output]
    .map((value) => (value == null ? '—' : abbreviated.format(value)))
    .join(' / ');
}

export function cacheHitRatio(
  input: number | null | undefined,
  cached: number | null | undefined,
  locale: Locale,
) {
  if (input == null || input <= 0 || cached == null) return;
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(cached / input);
}

export function taskTokenLabel(
  task: {
    cachedInputTokens?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  },
  locale: Locale,
) {
  const pair = tokenPair(task.inputTokens, task.outputTokens);
  const hit = cacheHitRatio(task.inputTokens, task.cachedInputTokens, locale);
  return hit === undefined ? pair : `${pair} · ${i18n(locale).cacheHit} ${hit}`;
}
