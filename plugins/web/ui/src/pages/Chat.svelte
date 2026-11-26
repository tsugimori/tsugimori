<script lang="ts">
  import type { AdminConversation } from '@tsugimori/plugin-sdk';

  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';

  import type { ViewContext } from '../lib/format.ts';

  import ChatDetails from '../components/ChatDetails.svelte';
  import LoadState from '../components/LoadState.svelte';
  import Timeline from '../components/Timeline.svelte';
  import { chatApi, fetchData } from '../lib/api.ts';
  import { chatTitle, platformLabel } from '../lib/display.ts';
  import { i18n } from '../lib/i18n.ts';

  let {
    data,
    ctx,
    hash = '',
    preview = false,
    mobilePreview = false,
  }: {
    ctx: ViewContext;
    data: AdminConversation;
    hash?: string;
    mobilePreview?: boolean;
    preview?: boolean;
  } = $props();

  let earlier = $state.raw<AdminConversation[]>([]);
  let overflow = $state.raw<AdminConversation[]>([]);
  let paging = $state(false);
  let pagingError = $state<string>();
  let request: AbortController | undefined;
  let mounted = true;
  let wide = $state(true);
  let showWide = $state(true);
  let drawer: HTMLDialogElement;
  let trigger: HTMLButtonElement;
  let newItems = $state(0);
  let clock = $state<number>();
  let following = true;
  let previous: AdminConversation | undefined;
  let lastHash = '';
  let highlight: number | undefined;
  let anchoring = false;
  const currentCtx = $derived({ ...ctx, now: Math.max(clock ?? 0, ctx.now) });
  const m = $derived(i18n(ctx.locale));
  const chat = $derived(data.chat);
  const older = $derived(
    earlier.length
      ? earlier.at(-1)?.older
      : (overflow.at(0)?.older ?? data.older),
  );
  const display = $derived.by(() => {
    const messages = new SvelteMap<
      number,
      AdminConversation['messages'][number]
    >();
    const tasks = new SvelteMap<string, AdminConversation['tasks'][number]>();
    for (const page of [...earlier, ...overflow, data]) {
      for (const message of page.messages) messages.set(message.seq, message);
      for (const task of page.tasks) tasks.set(task.id, task);
    }
    return { messages: [...messages.values()], tasks: [...tasks.values()] };
  });

  function smooth() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'instant'
      : 'smooth';
  }

  function distance() {
    return (
      document.documentElement.scrollHeight -
      window.innerHeight -
      window.scrollY
    );
  }

  function bottom(behavior: ScrollBehavior = smooth()) {
    following = true;
    newItems = 0;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  }

  onMount(() => {
    const media = window.matchMedia('(min-width: 1100px)');
    const resize = () => {
      wide = media.matches;
      if (wide && drawer?.open) drawer.close();
    };
    const scroll = () => {
      following = distance() <= 120;
      if (following) newItems = 0;
    };
    resize();
    media.addEventListener('change', resize);
    window.addEventListener('scroll', scroll, { passive: true });
    try {
      showWide = localStorage.getItem('tsugimori.details') !== 'closed';
    } catch {
      // The details panel still works when browser storage is blocked.
    }
    const timer = setInterval(() => {
      if (data.tasks.some((task) => task.finishedAt === null))
        clock = Date.now();
    }, 1000);
    return () => {
      mounted = false;
      request?.abort();
      clearInterval(timer);
      clearTimeout(highlight);
      media.removeEventListener('change', resize);
      window.removeEventListener('scroll', scroll);
    };
  });

  function toggleWide(value: boolean) {
    showWide = value;
    if (!value) trigger?.focus();
    try {
      localStorage.setItem('tsugimori.details', value ? 'open' : 'closed');
    } catch {
      // Storage access is optional.
    }
  }

  async function focusAnchor(fragment: string) {
    let id: string;
    try {
      id = decodeURIComponent(fragment.slice(1));
    } catch {
      return;
    }
    if (!/^(?:task-|msg-)/.test(id)) return;
    await tick();
    if (!mounted || hash !== fragment) return;
    let target = document.getElementById(id);
    if (!target) {
      anchoring = true;
      try {
        while (mounted && hash === fragment && !target && older) {
          if (!(await loadEarlier())) break;
          target = document.getElementById(id);
        }
      } finally {
        anchoring = false;
      }
    }
    if (!target || hash !== fragment) return;
    if (id.startsWith('task-')) {
      const details = target.querySelector('details');
      if (details) details.open = true;
    } else {
      clearTimeout(highlight);
      document.querySelector('.msg.highlight')?.classList.remove('highlight');
      target.classList.add('highlight');
      highlight = window.setTimeout(
        () => target.classList.remove('highlight'),
        1500,
      );
    }
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
    following = distance() <= 120;
  }

  $effect.pre(() => {
    const current = data;
    const fragment = hash;
    untrack(() => {
      const old = previous;
      previous = current;
      const changedHash = fragment !== lastHash;
      lastHash = fragment;
      if (fragment && (changedHash || !old)) {
        void focusAnchor(fragment);
        return;
      }
      if (!old) {
        if (!preview)
          void tick().then(() => {
            if (mounted) bottom('instant');
          });
        return;
      }
      if (old === current) return;
      const oldSeq = new Set(old.messages.map((item) => item.seq));
      const oldTasks = new Map(old.tasks.map((item) => [item.id, item]));
      const nextSeq = new Set(current.messages.map((item) => item.seq));
      const nextTasks = new Set(current.tasks.map((item) => item.id));
      const count =
        current.messages.filter((item) => !oldSeq.has(item.seq)).length +
        current.tasks.reduce((sum, item) => {
          const prior = oldTasks.get(item.id);
          if (!prior) return sum + 1;
          const priorTools = new Set(prior.tools.map((tool) => tool.seq));
          return (
            sum + item.tools.filter((tool) => !priorTools.has(tool.seq)).length
          );
        }, 0);
      const lostMessages = old.messages.filter(
        (item) => !nextSeq.has(item.seq),
      );
      const lostTasks = old.tasks.filter((item) => !nextTasks.has(item.id));
      if (lostMessages.length || lostTasks.length) {
        overflow = [
          ...overflow,
          { ...old, messages: lostMessages, tasks: lostTasks },
        ];
      }
      if (anchoring) return;
      if (following && distance() <= 120) {
        void tick().then(() => {
          if (mounted) bottom();
        });
      } else {
        newItems += count;
      }
    });
  });

  async function loadEarlier() {
    const cursor = older;
    if (paging || cursor === undefined) return false;
    paging = true;
    pagingError = undefined;
    const controller = (request = new AbortController());
    try {
      const page = await fetchData<AdminConversation>(
        chatApi(chat, cursor),
        controller.signal,
      );
      if (controller.signal.aborted) return false;
      const boundary = document.getElementById('msg-' + cursor);
      const offset = boundary?.getBoundingClientRect().top;
      earlier = [...earlier, page];
      await tick();
      if (mounted && boundary && offset !== undefined) {
        window.scrollBy({
          top: boundary.getBoundingClientRect().top - offset,
          behavior: 'instant',
        });
      }
      return page.older !== cursor;
    } catch {
      if (!controller.signal.aborted) pagingError = 'internal';
      return false;
    } finally {
      paging = false;
    }
  }
</script>

<div class="chat-layout" class:with-details={wide && showWide}>
  <section class="chat-column">
    <div class="chat-head">
      <div>
        <a href="/" class="meta">← {m.overview}</a>
        <div class="title-line">
          <span class="tag">{platformLabel(chat.platform)}</span>
          <h1>{chatTitle(chat)}</h1>
          {#if chat.threadId}<span class="meta">
              · {m.topic}
              {chat.threadId}
            </span>{/if}
        </div>
      </div>
      <button
        class="btn"
        type="button"
        bind:this={trigger}
        aria-expanded={wide ? showWide : undefined}
        onclick={() => (wide ? toggleWide(!showWide) : drawer.showModal())}
      >
        {m.details} ▸
      </button>
    </div>
    {#if older !== undefined}
      <p class="paging">
        <button
          class="btn"
          type="button"
          disabled={paging}
          onclick={loadEarlier}
        >
          {paging ? m.loading : m.older}
        </button>
      </p>
    {/if}
    {#if pagingError}<LoadState
        locale={ctx.locale}
        error={pagingError}
        retry={loadEarlier}
        compact
      />{/if}
    {#if display.messages.length || display.tasks.length}
      <Timeline data={display} ctx={currentCtx} {preview} />
    {:else}<p class="card empty">{m.noMessages}</p>{/if}
    {#if newItems}<div class="latest-row">
        <button class="latest" type="button" onclick={() => bottom()}>
          ↓ {m.newest} ({newItems})
        </button>
      </div>{/if}
  </section>
  {#if wide && showWide}
    <aside class="card chat-details">
      <ChatDetails {data} {ctx} close={() => toggleWide(false)} />
    </aside>
  {/if}
</div>
<dialog
  bind:this={drawer}
  class="details-drawer card"
  class:preview-drawer={mobilePreview}
  open={mobilePreview || undefined}
  aria-label={m.details}
  onclose={() => trigger?.focus()}
  onclick={(event) => {
    if (event.target !== drawer) return;
    const bounds = drawer.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX >= bounds.right ||
      event.clientY < bounds.top ||
      event.clientY >= bounds.bottom
    )
      drawer.close();
  }}
>
  <ChatDetails {data} {ctx} close={() => drawer.close()} />
</dialog>
