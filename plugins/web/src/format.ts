import type { AdminWorkspace } from '@tsugimori/plugin-sdk';

import type { Locale } from './i18n.ts';

import { i18n } from './i18n.ts';

const escapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const clocks = new Map<string, Intl.DateTimeFormat>();
const numbers = new Intl.NumberFormat('en-US');

export function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => escapes[char]!);
}

export function number(value: number) {
  return numbers.format(value);
}

export function formatTime(ms: number, tz: string) {
  let formatter = clocks.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    clocks.set(tz, formatter);
  }
  return formatter.format(ms);
}

export function relative(ms: number, now: number, locale: Locale) {
  const m = i18n(locale);
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes <= 0) return m.justNow;
  if (minutes < 60) return m.minutesAgo(minutes);
  if (minutes < 1440) return m.hoursAgo(Math.floor(minutes / 60));
  if (minutes < 2880) return m.yesterday;
  return m.daysAgo(Math.floor(minutes / 1440));
}

export function duration(ms: number, locale: Locale = 'en') {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)} ms`;
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)} s`;
  const seconds = Math.round(safe / 1000);
  return i18n(locale).longDuration(Math.floor(seconds / 60), seconds % 60);
}

export interface ViewContext extends AdminWorkspace {
  now: number;
  pending: number;
  schedules: boolean;
}

export function time(
  ms: number | null,
  { timezone, now, locale }: ViewContext,
  mode: 'relative' | 'absolute' | 'clock' | 'future' = 'relative',
) {
  if (ms === null) return '—';
  const absolute = formatTime(ms, timezone);
  const elapsed = relative(ms, now, locale);
  const start = `<time datetime="${new Date(ms).toISOString()}" title="${escapeHtml(absolute + ' (' + timezone + ')')}">`;
  if (mode === 'relative') return `${start}${escapeHtml(elapsed)}</time>`;
  if (mode === 'future') return `${start}${absolute}</time>`;
  return `${start}${mode === 'clock' ? absolute.slice(11) : absolute}</time> <span class="meta">(${escapeHtml(elapsed)})</span>`;
}

const omission = /…\[omitted ([\d,]+) chars\]…/g;

export function wasTruncated(text: string | null) {
  return text !== null && text.search(omission) !== -1;
}

export function codeBlock(text: string, locale: Locale, error = false) {
  let contents = text;
  if (!wasTruncated(text)) {
    try {
      contents = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Display raw text when the stored value is not JSON.
    }
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const match of contents.matchAll(omission)) {
    parts.push(
      escapeHtml(contents.slice(cursor, match.index)),
      `<span class="omit">${escapeHtml(i18n(locale).omitted(match[1]!))}</span>`,
    );
    cursor = match.index + match[0].length;
  }
  parts.push(escapeHtml(contents.slice(cursor)));
  return `<pre class="code${error ? ' err' : ''}">${parts.join('')}</pre>`;
}
