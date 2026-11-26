import type { AdminApprovals } from '@tsugimori/plugin-sdk';

import type { ViewContext } from '../format.ts';

import { codeBlock, escapeHtml, time } from '../format.ts';
import { i18n } from '../i18n.ts';
import { badge, empty, kv, linkedChat } from './shared.ts';

export function approvalsView(
  { approvals, grants }: AdminApprovals,
  ctx: ViewContext,
) {
  const { locale } = ctx;
  const m = i18n(locale);
  const pending = approvals.filter(({ status }) => status === 'pending');
  const recent = approvals
    .filter(({ status }) => status !== 'pending')
    .sort(
      (a, b) =>
        (b.decidedAt ?? b.requestedAt ?? 0) -
        (a.decidedAt ?? a.requestedAt ?? 0),
    )
    .slice(0, 50);
  const row = (approval: AdminApprovals['approvals'][number]) => {
    const requester = approval.requesterDisplay
      ? `${approval.requesterDisplay} (${approval.requester})`
      : approval.requester;
    return `<article class="card"><div class="approval-row">
<div><code>${escapeHtml(approval.action)}</code><p>${linkedChat(approval, approval.chat)}</p><p class="meta">${m.requester} · ${escapeHtml(requester)}</p></div>
<p class="requested meta">${time(approval.requestedAt ?? null, ctx, 'absolute')}</p>
<div class="decision">${badge(approval.status, locale, true)}
${approval.decidedBy ? `<p class="meta">${m.decidedBy} · ${escapeHtml(approval.decidedBy)}</p>` : ''}
${approval.decidedAt === null ? '' : `<p class="meta">${time(approval.decidedAt, ctx, 'absolute')}</p>`}</div></div>
<details class="approval-details"><summary class="meta">${m.args}</summary>${approval.args == null ? `<p class="meta">${m.noDetails}</p>` : codeBlock(approval.args, locale)}</details>
<details class="approval-details"><summary class="meta">${m.scope}</summary>${codeBlock(JSON.stringify(approval.resource), locale)}</details>
${approval.failureReason ? `<p class="alert err">${escapeHtml(approval.failureReason)}</p>` : ''}</article>`;
  };
  const grantRows = grants.map(
    (grant) => `<article class="card"><div class="approval-row">
<div><code>${escapeHtml(grant.action)}</code><p>${linkedChat(grant)}</p></div>
<p class="requested meta">${time(grant.createdAt, ctx, 'absolute')}</p>
<p class="decision meta">${grant.mode === 'once' ? m.once : m.always}</p></div>
<details class="approval-details"><summary class="meta">${m.scope}</summary>
${kv([
  [m.grantedBy, escapeHtml(grant.grantedBy)],
  [m.grantedTo, escapeHtml(grant.grantedTo)],
  ...(grant.revokedAt === null
    ? []
    : [[m.revoked, time(grant.revokedAt, ctx, 'absolute')] as const]),
])}${codeBlock(JSON.stringify(grant.scope), locale)}</details></article>`,
  );
  return `<div class="approvals"><div class="section-head"><h1>${m.approvals}</h1></div>
<section><div class="section-head"><h2>${m.pending}</h2></div>${pending.length ? pending.map(row).join('\n') : empty(m.noPending)}</section>
<section><div class="section-head"><h2>${m.recent}</h2></div>${recent.length ? recent.map(row).join('\n') : empty(m.noRecent)}</section>
<section><div class="section-head"><h2>${m.grants}</h2></div>${grantRows.length ? grantRows.join('\n') : empty(m.noGrants)}</section></div>`;
}
