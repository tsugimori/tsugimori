import type { AdminChat, AdminToolCall, ChatRef } from '@tsugimori/plugin-sdk';

import type { ViewContext } from '../format.ts';
import type { Locale } from '../i18n.ts';

import {
  codeBlock,
  escapeHtml,
  number,
  time,
  wasTruncated,
} from '../format.ts';
import { i18n } from '../i18n.ts';

export function chatHref(chat: ChatRef, before?: number) {
  const query = new URLSearchParams({
    adapter: chat.adapterId,
    id: chat.chatId,
  });
  if (before !== undefined) query.set('before', String(before));
  return escapeHtml('/chat?' + query);
}

export function traceHref(taskId: string) {
  return escapeHtml('/trace?' + new URLSearchParams({ task: taskId }));
}

export function tag(kind: string) {
  return `<span class="tag">${escapeHtml(kind === 'telegram' ? 'Telegram' : kind === 'line' ? 'LINE' : kind)}</span>`;
}

export function chatTitle(chat: AdminChat) {
  return chat.title || chat.chatId;
}

export function linkedChat(ref: ChatRef, chat?: AdminChat) {
  return `${tag(chat?.platform ?? ref.adapterId)} <a href="${chatHref(ref)}">${escapeHtml(chat ? chatTitle(chat) : ref.chatId)}</a>`;
}

export function kv(rows: readonly (readonly [string, string])[]) {
  return `<dl class="kv">${rows.map(([key, val]) => `<dt>${escapeHtml(key)}</dt><dd>${val}</dd>`).join('')}</dl>`;
}

export function empty(text: string) {
  return `<p class="card empty">${escapeHtml(text)}</p>`;
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
      .map(escapeHtml)
      .join(' · ') || '—'
  );
}

export function summaryProgress(chat: AdminChat, ctx: ViewContext) {
  const { summary, latestSeq } = chat;
  if (!summary) return i18n(ctx.locale).noSummary;
  const progress = `#${number(summary.throughSeq)} / #${number(latestSeq)}`;
  return summary.updatedAt === null
    ? progress
    : `${progress} · ${time(summary.updatedAt, ctx)}`;
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
} as const;

export function statusStyle(status: string | null) {
  return status && Object.hasOwn(statuses, status)
    ? statuses[status as keyof typeof statuses]
    : (['idle', 'unknown'] as const);
}

export function badge(
  status: string | null,
  locale: Locale,
  denialIsError = false,
) {
  const [style, label] =
    status === null ? (['run', 'running'] as const) : statusStyle(status);
  return `<span class="badge ${denialIsError && status === 'denied' ? 'err' : style}">${i18n(locale)[label]}</span>`;
}

export function toolBody(tool: AdminToolCall | undefined, locale: Locale) {
  const m = i18n(locale);
  const rows: [string, string][] = [];
  if (tool?.args != null) rows.push([m.args, codeBlock(tool.args, locale)]);
  if (tool?.result != null)
    rows.push([
      m.result,
      codeBlock(tool.result, locale, tool.status === 'error'),
    ]);
  return `<div class="tool-body">${rows.length ? kv(rows) : `<p class="meta">${m.noDetails}</p>`}
${tool?.callId ? `<p class="meta">${m.callId} · ${escapeHtml(tool.callId)}</p>` : ''}
${tool && (wasTruncated(tool.args) || wasTruncated(tool.result)) ? `<p class="meta">${m.truncated}</p>` : ''}</div>`;
}
