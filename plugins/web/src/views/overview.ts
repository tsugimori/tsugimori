import type { AdminChat, AdminOverview } from '@tsugimori/plugin-sdk';

import type { ViewContext } from '../format.ts';

import { escapeHtml, number, time } from '../format.ts';
import { i18n } from '../i18n.ts';
import {
  badge,
  chatHref,
  chatTitle,
  empty,
  kv,
  routeLabel,
  summaryProgress,
  tag,
} from './shared.ts';

function shortId(id: string) {
  return id.length <= 24 ? id : id.slice(0, 12) + '…' + id.slice(-8);
}

function card(chat: AdminChat, ctx: ViewContext) {
  const { locale } = ctx;
  const m = i18n(locale);
  const suffix = '_' + chat.threadId;
  const id =
    chat.threadId && chat.chatId.endsWith(suffix)
      ? chat.chatId.slice(0, -suffix.length)
      : chat.chatId;
  const pending =
    chat.pendingApprovals > 0
      ? `<p class="meta pending"><span aria-hidden="true">⚠</span> ${m.pendingCount(number(chat.pendingApprovals))}</p>`
      : '';
  return `<a class="card chat-card" href="${chatHref(chat)}">
<div class="card-head">${tag(chat.platform)} <span class="chat-title ellipsis">${escapeHtml(chatTitle(chat))}</span>${chat.activeTask ? badge('running', locale) : chat.lastTaskStatus === 'failed' || chat.lastTaskStatus === 'delivery-unknown' ? badge('failed', locale) : ''}</div>
<p class="meta ellipsis" title="${escapeHtml(id)}">${chat.threadId ? `${m.topic} ${escapeHtml(chat.threadId)} · ` : ''}${escapeHtml(shortId(id))}</p>
${kv([
  [m.lastActivity, time(chat.lastActivity, ctx)],
  [m.messages, number(chat.messageCount)],
  [m.agent, routeLabel(chat.route, locale)],
  [m.summary, summaryProgress(chat, ctx)],
])}${pending}</a>`;
}

export function overviewView(
  { chats, totals }: AdminOverview,
  ctx: ViewContext,
  chatsOnly = false,
) {
  const m = i18n(ctx.locale);
  const stat = (label: string, value: number, tone = '', link = false) => {
    const body = `<span class="meta">${label}</span><strong>${number(value)}</strong>`;
    const klass = `stat card${value > 0 && tone ? ' ' + tone : ''}`;
    return link && value > 0
      ? `<a class="${klass}" href="/approvals">${body}</a>`
      : `<div class="${klass}">${body}</div>`;
  };
  const title = chatsOnly ? m.chats : m.overview;
  return `<div class="section-head"><h1>${title}</h1><span class="meta">${chatsOnly ? m.sort : `${m.updated} ${time(ctx.now, ctx, 'clock')}`}</span></div>
${
  chatsOnly
    ? ''
    : `<div class="stats">
${stat(m.chats, totals.chats)}${stat(m.tasksToday, totals.tasksToday)}${stat(m.failedToday, totals.failedToday, 'err')}${stat(m.pending, totals.pendingApprovals, 'warn', true)}
</div><div class="section-head"><h2>${m.chats}</h2><span class="meta">${m.sort}</span></div>`
}
${chats.length ? `<div class="chat-grid">${chats.map((chat) => card(chat, ctx)).join('\n')}</div>` : empty(m.noChats)}
${totals.chats > chats.length ? `<p class="meta limit-note">${m.limited(number(chats.length), number(totals.chats))}</p>` : ''}`;
}
