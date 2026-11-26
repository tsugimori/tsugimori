<script lang="ts">
  import type { AdminOverview } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import Badge from '../components/Badge.svelte';
  import Time from '../components/Time.svelte';
  import {
    chatHref,
    chatTitle,
    platformLabel,
    routeLabel,
    statusStyle,
    summaryProgress,
  } from '../lib/display.ts';
  import { formatTime, number } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';

  let {
    data,
    ctx,
    chatsOnly = false,
    agent,
  }: {
    agent?: string;
    chatsOnly?: boolean;
    ctx: ViewContext;
    data: AdminOverview;
  } = $props();
  const m = $derived(i18n(ctx.locale));

  function bytes(value: number) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unit = Math.min(
      units.length - 1,
      Math.max(0, Math.floor(Math.log2(Math.max(1, value)) / 10)),
    );
    return (
      new Intl.NumberFormat(ctx.locale, { maximumFractionDigits: 1 }).format(
        value / 1024 ** unit,
      ) +
      ' ' +
      units[unit]
    );
  }

  function shortId(id: string) {
    return id.length > 20 ? id.slice(0, 9) + '…' + id.slice(-5) : id;
  }

  function flash(node: HTMLElement, initial: string) {
    let version = initial;
    let timeout: ReturnType<typeof setTimeout>;
    return {
      update(next: string) {
        if (next === version) return;
        version = next;
        clearTimeout(timeout);
        node.classList.remove('changed');
        void node.offsetWidth;
        node.classList.add('changed');
        timeout = setTimeout(() => node.classList.remove('changed'), 1200);
      },
      destroy() {
        clearTimeout(timeout);
      },
    };
  }
</script>

<div class="section-head">
  <h1>{chatsOnly ? m.chats : m.overview}</h1>
  <span class="meta">
    {m.updated}
    {formatTime(ctx.now, ctx.timezone).slice(11)}
  </span>
</div>
{#if !chatsOnly}
  <div class="stats">
    <div class="stat card">
      <span class="meta">{m.chats}</span><strong>
        {number(data.totals.chats)}
      </strong>
    </div>
    <div class="stat card">
      <span class="meta">{m.tasksToday}</span><strong>
        {number(data.totals.tasksToday)}
      </strong>
    </div>
    <div class="stat card" class:err={data.totals.failedToday > 0}>
      <span class="meta">{m.failedToday}</span><strong>
        {number(data.totals.failedToday)}
      </strong>
    </div>
    <a
      href="/approvals"
      class="stat card"
      class:warn={data.totals.pendingApprovals > 0}
    >
      <span class="meta">{m.pending}</span><strong>
        {number(data.totals.pendingApprovals)}
      </strong>
    </a>
  </div>
  <p class="meta webhook-status">
    <span
      class:ok={data.webhook.state === 'ok'}
      class:fail={data.webhook.state === 'failed'}
      aria-hidden="true"
    >
      ●
    </span>
    {m.webhook}{ctx.locale === 'zh-TW' ? '：' : ': '}{m.webhookState[
      data.webhook.state
    ]}{data.webhook.reason
      ? (ctx.locale === 'zh-TW' ? '：' : ': ') + data.webhook.reason
      : ''}
    {#if data.webhook.baseUrl}
      · {data.webhook.baseUrl}{/if}
  </p>
  {#if data.records}
    <p class="meta">
      {m.records}{ctx.locale === 'zh-TW' ? '：' : ': '}{bytes(
        data.records.bytes,
      )} / {bytes(data.records.maxBytes)}{#if data.records.oldestFullTaskAt}
        · {m.recordsSince}{ctx.locale === 'zh-TW' ? '：' : ' '}{formatTime(
          data.records.oldestFullTaskAt,
          ctx.timezone,
        ).slice(0, 16)}{/if}
    </p>
  {/if}
  <div class="section-head">
    <h2>
      {m.chats}
      {#if agent}<span class="meta">
          · {agent} · <a href="/">{m.clearFilter}</a>
        </span>{/if}
    </h2>
    <span class="meta">{m.sort}</span>
  </div>
{/if}
{#if data.chats.length === 0}<p class="card empty">{m.noChats}</p>{/if}
<div class="chat-grid">
  {#each data.chats as chat (JSON.stringify([chat.adapterId, chat.chatId]))}
    <a
      href={chatHref(chat)}
      class="card chat-card"
      use:flash={JSON.stringify(chat)}
    >
      <div class="card-head">
        <span class="tag">{platformLabel(chat.platform)}</span>
        <span class="chat-title ellipsis">{chatTitle(chat)}</span>
        {#if chat.activeTask}<Badge status="running" locale={ctx.locale} />
        {:else if statusStyle(chat.lastTaskStatus)[0] === 'err'}<Badge
            status={chat.lastTaskStatus}
            locale={ctx.locale}
          />{/if}
      </div>
      {#if chat.preview}<p class="meta ellipsis chat-preview">
          {chat.preview.sender ?? m.bot}{ctx.locale === 'zh-TW'
            ? '：'
            : ': '}{chat.preview.text || m.attachmentShort}
        </p>{/if}
      <div class="meta" title={chat.chatId}>
        {chat.threadId ? m.topic + ' ' + chat.threadId + ' · ' : ''}{shortId(
          chat.chatId,
        )}
      </div>
      {#if chat.currentTool}<code
          class="meta ellipsis current-tool"
          title={chat.currentTool}
        >
          {chat.currentTool}…
        </code>{/if}
      <dl class="kv">
        <dt>{m.lastActivity}</dt>
        <dd><Time at={chat.lastActivity} {ctx} /></dd>
        <dt>{m.messages}</dt>
        <dd>{number(chat.messageCount)}</dd>
        <dt>{m.agent}</dt>
        <dd>{routeLabel(chat.route, ctx.locale)}</dd>
        <dt>{m.summary}</dt>
        <dd>
          {#if chat.summary}{summaryProgress(
              chat,
            )}{#if chat.summary.updatedAt !== null}
              · <Time
                at={chat.summary.updatedAt}
                {ctx}
              />{/if}{:else}{m.noSummary}{/if}
        </dd>
      </dl>
      {#if chat.pendingApprovals > 0}<p class="pending meta">
          ⚠ {m.pendingCount(number(chat.pendingApprovals))}
        </p>{/if}
    </a>
  {/each}
</div>
{#if data.chats.length < data.totals.chats}<p class="meta limit-note">
    {m.limited(number(data.chats.length), number(data.totals.chats))}
  </p>{/if}

<style>
  .webhook-status {
    overflow-wrap: anywhere;
  }
  .webhook-status .ok {
    color: var(--ok);
  }
  .webhook-status .fail {
    color: var(--err);
  }
</style>
