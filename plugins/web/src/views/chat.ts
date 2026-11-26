import type {
  AdminConversation,
  AdminTask,
  AdminToolCall,
} from '@tsugimori/plugin-sdk';

import type { ViewContext } from '../format.ts';
import type { Locale } from '../i18n.ts';

import { duration, escapeHtml, formatTime, number, time } from '../format.ts';
import { i18n } from '../i18n.ts';
import {
  badge,
  chatHref,
  chatTitle,
  empty,
  kv,
  routeLabel,
  statusStyle,
  summaryProgress,
  tag,
  toolBody,
  traceHref,
} from './shared.ts';

function messageText(text: string, locale: Locale) {
  const lines = text.split('\n');
  if (lines.length <= 20 && text.length <= 1500) return escapeHtml(text);
  const limit = Math.min(lines.slice(0, 20).join('\n').length, 1500);
  const head = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');
  return `${escapeHtml(head)}<details class="more"><summary>${i18n(locale).more(number(lines.length))}</summary>${escapeHtml(text.slice(head.length).replace(/^\n/, ''))}</details>`;
}

function bubble(
  message: AdminConversation['messages'][number],
  ctx: ViewContext,
) {
  const { locale } = ctx;
  const m = i18n(locale);
  const outbound = message.direction === 'outbound';
  const identity = message.displayName || message.userId;
  const stamp = `<span class="meta">${time(message.recordedAt, ctx, 'clock')}</span>`;
  const id =
    message.displayName && message.userId
      ? ` <span class="meta">(${escapeHtml(message.userId)})</span>`
      : '';
  const who = outbound
    ? `${stamp} <b>${m.bot}</b>`
    : `<b>${escapeHtml(identity ?? m.unknown)}</b>${id} ${stamp}`;
  const text = message.deleted
    ? `<em class="meta">${m.deleted}</em>`
    : message.text
      ? messageText(message.text, locale)
      : `<em class="meta">${m.attachment}</em>`;
  return `<li class="msg ${outbound ? 'out' : 'in'}"><div class="who">${who}</div><div class="bubble">${text}</div></li>`;
}

function toolRow(tool: AdminToolCall, ctx: ViewContext) {
  return `<li><details class="tool"><summary>
<code class="tool-name ellipsis" title="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</code>${badge(tool.status, ctx.locale)}
<span class="elapsed meta">${duration((tool.endedAt ?? ctx.now) - tool.startedAt, ctx.locale)}</span>
</summary>${toolBody(tool, ctx.locale)}</details></li>`;
}

function taskBlock(task: AdminTask, ctx: ViewContext) {
  const { locale } = ctx;
  const m = i18n(locale);
  const style = statusStyle(task.status)[0];
  const started = task.startedAt ?? task.createdAt;
  const status =
    task.tools.some(({ status }) => status === 'pending-approval') &&
    style === 'run'
      ? 'pending-approval'
      : task.status;
  const meta = [
    task.agentId,
    task.model,
    duration((task.finishedAt ?? ctx.now) - started, locale),
    m.toolCount(number(task.tools.length)),
  ]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ');
  const usage = [
    task.inputTokens === undefined
      ? ''
      : `${m.input} ${number(task.inputTokens)}`,
    task.outputTokens === undefined
      ? ''
      : `${m.output} ${number(task.outputTokens)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return `<li class="task"><details class="task card ${statusStyle(status)[0]}"${style === 'run' || style === 'err' ? ' open' : ''}>
<summary><b>${m.task}</b>${badge(status, locale)}<span class="meta">${meta}</span><span class="meta">${time(started, ctx, 'clock')}</span></summary>
${task.error || style === 'err' ? `<p class="alert err">${escapeHtml(task.error || m.taskError)}</p>` : ''}
${task.tools.length ? `<ol class="tools">${task.tools.map((tool) => toolRow(tool, ctx)).join('')}</ol>` : ''}
<div class="task-footer meta">${usage ? `<span>${m.tokens} ${usage}</span>` : ''}<a href="${traceHref(task.id)}">${m.trace} →</a></div></details></li>`;
}

export function chatView(
  { chat, messages, tasks, older }: AdminConversation,
  ctx: ViewContext,
) {
  const m = i18n(ctx.locale);
  const timeline: { at: number | null; html: string; seq: number }[] = [];
  const bySource = new Map<number, AdminTask[]>();
  const messageSeqs = new Set(messages.map(({ seq }) => seq));
  for (const task of tasks) {
    if (task.sourceSeq != null && messageSeqs.has(task.sourceSeq)) {
      const list = bySource.get(task.sourceSeq) ?? [];
      list.push(task);
      bySource.set(task.sourceSeq, list);
    } else
      timeline.push({
        at: task.startedAt ?? task.createdAt,
        html: taskBlock(task, ctx),
        seq: Infinity,
      });
  }
  let lastTime: number | null = null;
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    lastTime = message.recordedAt ?? lastTime;
    const following = (bySource.get(message.seq) ?? []).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    timeline.push({
      at: lastTime,
      seq: message.seq,
      html:
        bubble(message, ctx) +
        following.map((task) => taskBlock(task, ctx)).join(''),
    });
  }
  timeline.sort(
    (a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity) || a.seq - b.seq,
  );
  let day = '';
  const items = timeline
    .map(({ at, html }) => {
      const localDay =
        at === null ? '' : formatTime(at, ctx.timezone).slice(0, 10);
      const separator =
        localDay && day !== localDay
          ? `<li class="day meta">${localDay}</li>`
          : '';
      day = localDay;
      return separator + html;
    })
    .join('\n');
  return `<div class="chat-head"><div><a href="/" class="meta">← ${m.overview}</a>
<div class="title-line">${tag(chat.platform)} <h1>${escapeHtml(chatTitle(chat))}</h1>${chat.threadId ? `<span class="meta">· ${m.topic} ${escapeHtml(chat.threadId)}</span>` : ''}</div></div>
${kv([
  [m.agent, routeLabel(chat.route, ctx.locale)],
  [m.summary, summaryProgress(chat, ctx)],
])}</div>
${older === undefined ? '' : `<p class="paging"><a class="btn" href="${chatHref(chat, older)}">${m.older}</a></p>`}
${items ? `<ol class="timeline">${items}</ol>` : empty(m.noMessages)}`;
}
