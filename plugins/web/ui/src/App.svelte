<script lang="ts">
  import type { AdminWorkspace } from '@tsugimori/plugin-sdk';

  import { onMount } from 'svelte';

  import Header from './components/Header.svelte';
  import LoadState from './components/LoadState.svelte';
  import { live } from './lib/live.svelte.ts';
  import { resource } from './lib/resource.svelte.ts';
  import { createRouter } from './lib/router.svelte.ts';
  import Page from './Page.svelte';

  const router = createRouter();
  const workspace = resource<AdminWorkspace>(
    () => 'workspace',
    (event) => event.kind === 'approval',
  );
  const ctx = $derived({
    locale: workspace.data?.locale ?? ('en' as const),
    timezone: workspace.data?.timezone ?? 'UTC',
    name: workspace.data?.name,
    now: workspace.updated,
    pending: workspace.data?.pendingApprovals ?? 0,
    schedules: workspace.data?.schedules ?? false,
  });
  const path = $derived(router.location.pathname);
  const active = $derived(
    /^\/(chat|trace)(?:\/|$)/.test(path)
      ? 'chats'
      : path.split('/')[1] || 'overview',
  );

  onMount(router.start);
  let loaded = $state(false);
  $effect(() => {
    if (workspace.data) loaded = true;
  });
  $effect(() => {
    if (loaded) return live.start();
  });
  $effect(() => {
    document.documentElement.lang = ctx.locale;
  });
</script>

<Header {ctx} {active} state={live.status} last={live.last} />
<main class="wrap">
  {#if workspace.error || !workspace.data}
    <LoadState
      locale={ctx.locale}
      error={workspace.error}
      retry={workspace.retry}
    />
  {/if}
  {#if workspace.data}
    {#key path + router.location.search}
      <Page location={router.location} {ctx} />
    {/key}
  {/if}
</main>
