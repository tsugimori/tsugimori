<script lang="ts">
  import type { ViewContext } from '../lib/format.ts';

  import { formatTime } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';

  let {
    ctx,
    active,
    state,
    last = null,
  }: {
    active: string;
    ctx: ViewContext;
    last?: number | null;
    state: 'connected' | 'reconnecting' | 'offline';
  } = $props();
  const m = $derived(i18n(ctx.locale));
  const links = $derived([
    ['/', m.overview, 'overview'],
    ['/agents', m.agents, 'agents'],
    ['/chats', m.chats, 'chats'],
    ['/approvals', m.approvals, 'approvals'],
    ...(ctx.schedules ? [['/schedules', m.schedules, 'schedules']] : []),
  ]);
</script>

<header class="top">
  <div class="wrap shell-row">
    <a href="/" class="brand">
      <span class="dot" aria-hidden="true"></span><b>
        tsugimori
      </b>{#if ctx.name}<span class="meta ellipsis">{ctx.name}</span>{/if}
    </a>
    <nav aria-label={m.nav}>
      {#each links as [href, label, page] (href)}
        <a {href} aria-current={active === page ? 'page' : undefined}>
          {label}{#if page === 'approvals' && ctx.pending > 0}<span
              class="pill"
            >
              {ctx.pending}
            </span>{/if}
        </a>
      {/each}
    </nav>
    <div
      class="connection meta {state}"
      title={last === null
        ? undefined
        : formatTime(last, ctx.timezone) + ' (' + ctx.timezone + ')'}
    >
      <span aria-hidden="true"></span>{m[
        state === 'connected' ? 'live' : state
      ]}
      {#if state === 'offline'}<button
          class="text-button"
          type="button"
          onclick={() => window.location.reload()}
        >
          {m.refresh}
        </button>{/if}
    </div>
  </div>
</header>
