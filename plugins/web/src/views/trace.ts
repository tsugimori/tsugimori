import type { AdminTrace } from '@tsugimori/plugin-sdk';

import type { ViewContext } from '../format.ts';

import { codeBlock, duration, escapeHtml, time } from '../format.ts';
import { i18n } from '../i18n.ts';
import { badge, chatHref, empty, kv, statusStyle, toolBody } from './shared.ts';

type Span = AdminTrace['spans'][number];

function ordered(spans: readonly Span[]) {
  const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt);
  const ids = new Map(
    sorted.flatMap((span) =>
      span.id == null ? [] : [[span.id, span] as const],
    ),
  );
  const children = new Map<Span | undefined, Span[]>();
  for (const span of sorted) {
    const id = span.parentId ?? span.attrs.parentSpanId;
    const parent =
      typeof id === 'string' || typeof id === 'number'
        ? ids.get(id)
        : undefined;
    const group = children.get(parent) ?? [];
    group.push(span);
    children.set(parent, group);
  }
  const seen = new Set<Span>();
  const rows: { depth: number; span: Span }[] = [];
  function visit(span: Span, depth: number) {
    if (seen.has(span)) return;
    seen.add(span);
    rows.push({ depth, span });
    for (const child of children.get(span) ?? []) visit(child, depth + 1);
  }
  for (const span of children.get(undefined) ?? []) visit(span, 0);
  for (const span of sorted) visit(span, 0);
  return rows;
}

export function traceView({ chat, task, spans }: AdminTrace, ctx: ViewContext) {
  const { locale, now } = ctx;
  const m = i18n(locale);
  const started = task.startedAt ?? task.createdAt;
  const elapsed = Math.max(0, (task.finishedAt ?? now) - started);
  const spanName = (span: Span) =>
    typeof span.attrs.name === 'string'
      ? ` <span class="meta">${escapeHtml(span.attrs.name)}</span>`
      : '';
  const calls = new Map(task.tools.map((tool) => [tool.seq, tool]));
  const rows = ordered(spans).map(({ depth, span }) => {
    const left = Math.min(
      100,
      Math.max(0, ((span.startedAt - started) * 100) / Math.max(1, elapsed)),
    );
    const width = Math.max(
      0,
      Math.min(100 - left, (span.durationMs * 100) / Math.max(1, elapsed)),
    );
    const shade = statusStyle(span.status)[0];
    const attrs = Object.entries(span.attrs).filter(
      ([key]) => key !== 'toolCallSeq',
    );
    const values = attrs.map(([key, value]) => {
      const text =
        typeof value === 'string'
          ? value
          : (JSON.stringify(value) ?? String(value));
      return [
        key,
        text.length > 100 || text.includes('\n')
          ? codeBlock(text, locale)
          : escapeHtml(text),
      ] as const;
    });
    const seq = span.attrs.toolCallSeq;
    const tool = span.name === 'agent.tool' || span.name === 'tool.run';
    return `<li><details class="span"><summary>
<code class="span-name" style="--indent:${Math.min(depth, 12) * 16}px">${escapeHtml(span.name)}${spanName(span)}</code>
<span class="track" aria-hidden="true"><span class="fill ${shade}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></span></span>
<span class="elapsed meta">${duration(span.durationMs, locale)}</span></summary>
<div class="span-body"><p class="meta">${time(span.startedAt, ctx, 'absolute')} ${badge(span.status, locale)}</p>
${values.length ? kv(values) : `<p class="meta">${m.noAttributes}</p>`}
${tool ? toolBody(typeof seq === 'number' ? calls.get(seq) : undefined, locale) : ''}</div></details></li>`;
  });
  const short = task.id.length <= 8 ? task.id : task.id.slice(0, 8) + '…';
  return `<a href="${chatHref(chat)}" class="meta">← ${m.chat}</a>
<div class="trace-head"><h1 title="${escapeHtml(task.id)}">${m.task} ${escapeHtml(short)}</h1>${badge(task.status, locale)}
<p class="meta">${m.started} ${time(started, ctx, 'absolute')} · ${duration(elapsed, locale)}</p></div>
${rows.length ? `<div class="card"><ol class="spans">${rows.join('\n')}</ol></div>` : empty(m.noSpans)}`;
}
