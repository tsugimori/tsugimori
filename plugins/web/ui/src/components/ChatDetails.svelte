<script lang="ts">
  import type { AdminConversation } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import { summaryProgress } from '../lib/display.ts';
  import { number } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';
  import Time from './Time.svelte';

  let {
    data,
    ctx,
    close,
  }: { close: () => void; ctx: ViewContext; data: AdminConversation } =
    $props();
  const m = $derived(i18n(ctx.locale));
  const chat = $derived(data.chat);
  const fraction = $derived(
    chat.latestSeq > 0 && chat.summary
      ? Math.min(1, chat.summary.throughSeq / chat.latestSeq)
      : 0,
  );
  const reasoning = $derived(
    (
      {
        high: m.high,
        low: m.low,
        medium: m.medium,
        minimal: m.minimal,
        xhigh: m.xhigh,
        max: m.max,
        none: m.off,
      } as Record<string, string>
    )[chat.route.thinking ?? ''] ?? chat.route.thinking,
  );
</script>

<div class="section-head">
  <h2>{m.details}</h2>
  <button
    type="button"
    class="text-button close-details"
    aria-label={m.close}
    onclick={close}
  >
    ✕
  </button>
</div>
<div class="details-section">
  <h3>{m.agent}</h3>
  <p>
    {[chat.route.agentId, chat.route.model].filter(Boolean).join(' · ') || '—'}
  </p>
  {#if reasoning || chat.route.serviceTier}
    <p class="meta">
      {[
        reasoning && m.thinking + ' ' + reasoning,
        chat.route.serviceTier &&
          m.fastMode +
            ' ' +
            (['fast', 'priority'].includes(chat.route.serviceTier)
              ? m.enabled
              : m.off),
      ]
        .filter(Boolean)
        .join(' · ')}
    </p>
  {/if}
</div>
<div class="details-section">
  <h3>{m.summary}</h3>
  {#if chat.summary}
    <p>{summaryProgress(chat)}</p>
    <div class="summary-progress">
      <progress value={fraction} max="1" aria-label={m.summary}></progress>
      <span class="meta">{Math.floor(fraction * 100)}%</span>
    </div>
    <p class="meta"><Time at={chat.summary.updatedAt} {ctx} /></p>
  {:else}
    <p class="meta">{m.noSummary}</p>
  {/if}
</div>
<div class="details-section">
  <h3>{m.pending} ({number(chat.pendingApprovals)})</h3>
  {#each data.approvals ?? [] as approval (approval.id)}
    <p class="detail-link">
      <a href={'/approvals#approval-' + encodeURIComponent(approval.id)}>
        <code>{approval.action}</code>
      </a>
      <span class="meta">· <Time at={approval.requestedAt} {ctx} /> →</span>
    </p>
  {:else}<p class="meta">{m.noPending}</p>{/each}
</div>
{#if ctx.schedules}
  <div class="details-section">
    <h3>{m.schedules} ({number(data.schedules?.length ?? 0)})</h3>
    {#each data.schedules ?? [] as schedule (schedule.id)}
      <p class="detail-link">
        <a href={'/schedules#schedule-' + encodeURIComponent(schedule.id)}>
          {schedule.title}
        </a>
        {#if schedule.nextDueAt != null}<span class="meta">
            · {m.scheduledFor}
            <Time at={schedule.nextDueAt} {ctx} mode="future" />
          </span>{/if}
      </p>
    {:else}<p class="meta">{m.noSchedules}</p>{/each}
  </div>
{/if}
<div class="details-section">
  <h3>{m.chat}</h3>
  <p>ID <code>{chat.chatId}</code></p>
  <p class="meta">
    {m.allowlist}
    {chat.allowlisted ? m.yes : m.no} · {m.messages}
    {number(chat.messageCount)}
  </p>
</div>
