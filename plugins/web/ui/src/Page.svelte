<script lang="ts">
  import type {
    AdminAgent,
    AdminApprovals,
    AdminConversation,
    AdminOverview,
    AdminSchedules,
    AdminTrace,
  } from '@tsugimori/plugin-sdk';

  import { tick } from 'svelte';

  import type { ViewContext } from './lib/format.ts';

  import LoadState from './components/LoadState.svelte';
  import { chatApi } from './lib/api.ts';
  import { chatTitle } from './lib/display.ts';
  import { i18n } from './lib/i18n.ts';
  import { resource } from './lib/resource.svelte.ts';
  import { segments } from './lib/router.svelte.ts';
  import Agents from './pages/Agents.svelte';
  import Approvals from './pages/Approvals.svelte';
  import Chat from './pages/Chat.svelte';
  import Overview from './pages/Overview.svelte';
  import Schedules from './pages/Schedules.svelte';
  import Trace from './pages/Trace.svelte';

  let { location, ctx }: { ctx: ViewContext; location: URL } = $props();
  const parts = $derived(segments(location.pathname));
  const page = $derived(parts[0] || 'overview');
  const agent = $derived(location.searchParams.get('agent') ?? undefined);
  const chat = $derived({ adapterId: parts[1] ?? '', chatId: parts[2] ?? '' });
  const task = $derived(parts[1] ?? '');
  const m = $derived(i18n(ctx.locale));

  function route() {
    if (page === 'overview' || page === 'chats')
      return (
        'overview?' +
        (agent === undefined ? '' : new URLSearchParams({ agent }))
      );
    if (page === 'agents' || page === 'schedules') return page;
    if (page === 'approvals') return 'approvals?recent=50';
    if (page === 'chat') {
      const cursor = location.searchParams.get('before');
      return chatApi(chat, cursor === null ? undefined : Number(cursor));
    }
    if (page === 'trace') return 'trace?' + new URLSearchParams({ task });
    return 'not-found';
  }

  const apiPath = $derived(route());
  const view = resource<unknown>(
    () => apiPath,
    (event, current) => {
      if (page === 'overview' || page === 'chats')
        return event.kind !== 'schedule';
      if (page === 'agents')
        return ['task', 'chat', 'message'].includes(event.kind);
      if (page === 'approvals') return event.kind === 'approval';
      if (page === 'schedules') return event.kind === 'schedule';
      if (page === 'trace')
        return (
          (event.kind === 'task' && task === event.id) ||
          (event.kind === 'tool' && task === event.taskId)
        );
      if (page !== 'chat') return false;
      if (event.kind === 'tool')
        return (
          !(current as AdminConversation | undefined) ||
          (current as AdminConversation).tasks.some(
            ({ id }) => id === event.taskId,
          )
        );
      if (event.kind === 'schedule') return true;
      if (!('chatId' in event)) return false;
      const resolved = (current as AdminConversation | undefined)?.chat;
      return (
        (event.chatId === chat.chatId && event.adapterId === chat.adapterId) ||
        (event.chatId === resolved?.chatId &&
          event.adapterId === resolved.adapterId)
      );
    },
  );

  const pageCtx = $derived({ ...ctx, now: view.updated });
  $effect(() => {
    const names: Record<string, string> = {
      overview: m.overview,
      chats: m.chats,
      chat: m.chats,
      agents: m.agents,
      approvals: m.approvals,
      schedules: m.schedules,
      trace: m.traceTitle,
    };
    const suffix =
      page === 'chat' && view.data
        ? ' · ' + chatTitle((view.data as AdminConversation).chat)
        : '';
    document.title = (names[page] ?? m.error) + suffix + ' · tsugimori';
  });

  $effect(() => {
    const fragment = location.hash;
    if (page === 'chat' || !fragment || !view.data) return;
    let id: string;
    try {
      id = decodeURIComponent(fragment.slice(1));
    } catch {
      return;
    }
    void tick().then(() =>
      document.getElementById(id)?.scrollIntoView({ block: 'start' }),
    );
  });
</script>

{#if !view.data || (view.error && page !== 'chat')}
  <LoadState locale={ctx.locale} error={view.error} retry={view.retry} />
{/if}
{#if view.data && (page === 'overview' || page === 'chats')}
  <Overview
    data={view.data as AdminOverview}
    ctx={pageCtx}
    chatsOnly={page === 'chats'}
    {agent}
  />
{:else if view.data && page === 'agents'}
  <Agents data={view.data as readonly AdminAgent[]} ctx={pageCtx} />
{:else if view.data && page === 'chat'}
  <Chat
    data={view.data as AdminConversation}
    ctx={pageCtx}
    hash={location.hash}
    error={view.error}
    retry={view.retry}
  />
{:else if view.data && page === 'trace'}
  <Trace data={view.data as AdminTrace} ctx={pageCtx} />
{:else if view.data && page === 'approvals'}
  <Approvals data={view.data as AdminApprovals} ctx={pageCtx} />
{:else if view.data && page === 'schedules'}
  <Schedules data={view.data as AdminSchedules} ctx={pageCtx} />
{/if}
