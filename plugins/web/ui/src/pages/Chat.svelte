<script lang="ts">
  import type { AdminConversation, AdminOverview } from '@tsugimori/plugin-sdk';

  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';

  import type { ViewContext } from '../lib/format.ts';

  import ChatDetails from '../components/ChatDetails.svelte';
  import ChatList from '../components/ChatList.svelte';
  import LoadState from '../components/LoadState.svelte';
  import Timeline from '../components/Timeline.svelte';
  import { ApiError, chatApi, fetchData } from '../lib/api.ts';
  import { chatHref, chatTitle, platformLabel } from '../lib/display.ts';
  import { i18n } from '../lib/i18n.ts';
  import { resource } from '../lib/resource.svelte.ts';

  let {
    data,
    ctx,
    error,
    hash = '',
    preview = false,
    mobilePreview = false,
    previewChats,
    retry,
  }: {
    ctx: ViewContext;
    data: AdminConversation;
    error?: string;
    hash?: string;
    mobilePreview?: boolean;
    preview?: boolean;
    previewChats?: AdminOverview;
    retry?: () => void;
  } = $props();

  let earlier = $state.raw<AdminConversation[]>([]);
  let overflow = $state.raw<AdminConversation[]>([]);
  let paging = $state(false);
  let pagingError = $state<string>();
  let request: AbortController | undefined;
  let pendingPage: Promise<boolean> | undefined;
  let mounted = true;
  let wide = $state(true);
  let showWide = $state(true);
  let detailsDrawer: HTMLDialogElement;
  let chatsDrawer: HTMLDialogElement;
  let detailsTrigger: HTMLButtonElement;
  let chatsTrigger: HTMLButtonElement;
  let scroller: HTMLDivElement;
  let content: HTMLDivElement;
  let query = $state('');
  let positioned = $state(false);
  let newItems = $state(0);
  let clock = $state<number>();
  let following = true;
  let jumping = false;
  let programmaticTop: number | undefined;
  let previous: AdminConversation | undefined;
  let lastHash = '';
  let highlight: number | undefined;
  let anchorRequest: object | undefined;

  const currentCtx = $derived({ ...ctx, now: Math.max(clock ?? 0, ctx.now) });
  const m = $derived(i18n(ctx.locale));
  const chat = $derived(data.chat);
  const overview = resource<AdminOverview>(
    () => (preview ? undefined : 'overview'),
    (event) => ['chat', 'summary', 'task', 'message'].includes(event.kind),
  );
  const listCtx = $derived({
    ...currentCtx,
    now: Math.max(currentCtx.now, overview.updated),
  });
  const older = $derived(
    earlier.length
      ? earlier.at(-1)?.older
      : overflow.length
        ? overflow[0]?.older
        : data.older,
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

  function distance() {
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  }

  function move(top: number) {
    scroller.scrollTo({ top, behavior: 'instant' });
    programmaticTop = scroller.scrollTop;
  }

  function bottom(smooth = false) {
    following = true;
    newItems = 0;
    jumping =
      smooth &&
      distance() > 2 &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (jumping)
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    else move(scroller.scrollHeight);
  }

  function scroll() {
    if (!positioned || anchorRequest || paging || jumping) return;
    const top = scroller.scrollTop;
    if (programmaticTop === top) return;
    programmaticTop = undefined;
    following = distance() <= 80;
    if (following) newItems = 0;
    if (top < 200 && !pagingError) void loadEarlier();
  }

  function scrollEnded() {
    if (!jumping) return;
    jumping = false;
    scroll();
    if (following) bottom();
  }

  function keyboard(event: KeyboardEvent) {
    const target = event.target;
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      detailsDrawer.open ||
      chatsDrawer.open ||
      (target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest('input, textarea, select, [role="textbox"]')))
    )
      return;
    if (event.key === 'End' || event.key.toLowerCase() === 'g') {
      event.preventDefault();
      bottom(true);
    }
  }

  onMount(() => {
    const desktop = window.matchMedia('(min-width: 1100px)');
    const tablet = window.matchMedia('(760px <= width < 1100px)');
    const resize = () => {
      wide = desktop.matches;
      if (wide && detailsDrawer.open) detailsDrawer.close();
      if (!tablet.matches && chatsDrawer.open) chatsDrawer.close();
    };
    resize();
    desktop.addEventListener('change', resize);
    tablet.addEventListener('change', resize);
    try {
      showWide = localStorage.getItem('tsugimori.details') !== 'closed';
    } catch {
      // The details panel still works when browser storage is blocked.
    }
    const observer = new ResizeObserver(() => {
      if (positioned && following && !jumping && !paging) bottom();
    });
    observer.observe(content);
    observer.observe(scroller);
    const timer = setInterval(() => {
      if (display.tasks.some((task) => task.finishedAt === null))
        clock = Date.now();
    }, 1000);
    return () => {
      mounted = false;
      request?.abort();
      observer.disconnect();
      clearInterval(timer);
      clearTimeout(highlight);
      desktop.removeEventListener('change', resize);
      tablet.removeEventListener('change', resize);
    };
  });

  function toggleWide(value: boolean) {
    showWide = value;
    if (!value) detailsTrigger.focus();
    try {
      localStorage.setItem('tsugimori.details', value ? 'open' : 'closed');
    } catch {
      // Storage access is optional.
    }
  }

  function closeOnBackdrop(
    event: MouseEvent & { currentTarget: HTMLDialogElement },
  ) {
    const dialog = event.currentTarget;
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX >= bounds.right ||
      event.clientY < bounds.top ||
      event.clientY >= bounds.bottom
    )
      dialog.close();
  }

  function locate(id: string) {
    const el = document.getElementById(id);
    return el && content.contains(el) ? el : undefined;
  }

  async function focusAnchor(fragment: string) {
    const current = (anchorRequest = {});
    following = jumping = false;
    try {
      const id = decodeURIComponent(fragment.slice(1)).replace(
        /^m-(?=\d)/,
        'msg-',
      );
      if (!/^(?:task-|msg-|call-)/.test(id)) return;
      await tick();
      if (!mounted || anchorRequest !== current) return;
      let target = locate(id);
      while (
        mounted &&
        anchorRequest === current &&
        !target &&
        older !== undefined &&
        !id.startsWith('call-')
      ) {
        if (!(await loadEarlier())) break;
        target = locate(id);
      }
      if (!mounted || anchorRequest !== current || !target) return;
      if (id.startsWith('task-')) {
        target
          .querySelector<HTMLButtonElement>(
            '.task-toggle[aria-expanded="false"]',
          )
          ?.click();
        await tick();
      } else if (id.startsWith('msg-')) {
        clearTimeout(highlight);
        content.querySelector('.msg.highlight')?.classList.remove('highlight');
        target.classList.add('highlight');
        highlight = window.setTimeout(
          () => target.classList.remove('highlight'),
          1500,
        );
      }
      if (mounted && anchorRequest === current) {
        move(
          scroller.scrollTop +
            target.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            12,
        );
      }
    } catch (cause) {
      if (!(cause instanceof URIError)) throw cause;
    } finally {
      if (anchorRequest === current) {
        anchorRequest = undefined;
        positioned = true;
      }
    }
  }

  $effect.pre(() => {
    const current = data;
    const fragment = hash;
    untrack(() => {
      const old = previous;
      previous = current;
      const changedHash = fragment !== lastHash;
      lastHash = fragment;

      if (old && old !== current) {
        const oldSeq = new Set(old.messages.map((item) => item.seq));
        const oldTasks = new Map(old.tasks.map((item) => [item.id, item]));
        const nextSeq = new Set(current.messages.map((item) => item.seq));
        const nextTasks = new Set(current.tasks.map((item) => item.id));
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
        if (!following) {
          newItems +=
            current.messages.filter((item) => !oldSeq.has(item.seq)).length +
            current.tasks.reduce((sum, item) => {
              const prior = oldTasks.get(item.id);
              if (!prior) return sum + 1;
              const priorTools = new Set(prior.tools.map((tool) => tool.seq));
              return (
                sum +
                item.tools.filter((tool) => !priorTools.has(tool.seq)).length
              );
            }, 0);
        }
      }

      if (fragment && (changedHash || !old)) {
        void focusAnchor(fragment);
      } else if (!old || changedHash) {
        anchorRequest = undefined;
        void tick().then(() => {
          if (mounted && !hash) {
            bottom();
            positioned = true;
          }
        });
      }
    });
  });

  function loadEarlier() {
    const cursor = older;
    if (cursor === undefined) return Promise.resolve(false);
    return (pendingPage ??= loadPage(cursor));
  }

  async function loadPage(cursor: number) {
    paging = true;
    pagingError = undefined;
    const controller = (request = new AbortController());
    try {
      const page = await fetchData<AdminConversation>(
        chatApi(chat, cursor),
        controller.signal,
      );
      if (controller.signal.aborted) return false;
      const top = scroller.scrollTop;
      const height = scroller.scrollHeight;
      earlier = [...earlier, page];
      paging = false;
      await tick();
      if (!mounted) return false;
      move(top + scroller.scrollHeight - height);
      return page.older !== cursor;
    } catch (cause) {
      if (!controller.signal.aborted)
        pagingError = cause instanceof ApiError ? cause.key : 'internal';
      return false;
    } finally {
      request = undefined;
      pendingPage = undefined;
      paging = false;
    }
  }
</script>

<svelte:window onkeydown={keyboard} />

{#snippet list(close?: () => void)}
  <ChatList
    chats={(previewChats ?? overview.data)?.chats}
    current={chat}
    ctx={preview ? ctx : listCtx}
    error={overview.error}
    bind:query
    retry={overview.retry}
    select={close}
  />
{/snippet}

<div class="chat-layout" class:with-details={showWide}>
  <aside class="chat-list chat-pane" aria-label={m.chats}>
    {@render list()}
  </aside>
  <section class="chat-column">
    <div class="chat-head">
      <button
        type="button"
        class="btn chat-menu"
        bind:this={chatsTrigger}
        aria-haspopup="dialog"
        onclick={() => chatsDrawer.showModal()}
      >
        ☰ {m.chats}
      </button>
      <a href="/chats" class="btn chat-back">← {m.chats}</a>
      <div class="title-line">
        <span class="tag">{platformLabel(chat.platform)}</span>
        <h1 class="ellipsis">{chatTitle(chat)}</h1>
        {#if chat.threadId}<span class="meta chat-topic">
            · {m.topic}
            {chat.threadId}
          </span>{/if}
      </div>
      <button
        class="btn"
        type="button"
        bind:this={detailsTrigger}
        aria-expanded={wide ? showWide : undefined}
        aria-haspopup={wide ? undefined : 'dialog'}
        onclick={() =>
          wide ? toggleWide(!showWide) : detailsDrawer.showModal()}
      >
        {m.details}
      </button>
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scroll pane needs keyboard focus.) -->
    <div
      class="timeline-scroll chat-pane"
      bind:this={scroller}
      onscroll={scroll}
      onscrollend={scrollEnded}
      role="region"
      aria-label={m.messages}
      tabindex="0"
    >
      <div
        class="timeline-content"
        class:positioning={!preview && !positioned}
        bind:this={content}
      >
        <div class="paging meta" aria-live="polite">
          {#if paging}
            <span>{m.loading}…</span>
          {:else if older !== undefined}
            <a
              class="btn"
              href={chatHref(chat) + '?before=' + older}
              onclick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                void loadEarlier();
              }}
            >
              {m.older}
            </a>
          {:else if display.messages.length}
            <span>{m.oldest}</span>
          {/if}
        </div>
        {#if error}<LoadState
            locale={ctx.locale}
            {error}
            {retry}
            compact
          />{/if}
        {#if pagingError}<LoadState
            locale={ctx.locale}
            error={pagingError}
            retry={loadEarlier}
            compact
          />{/if}
        {#if display.messages.length || display.tasks.length}
          <Timeline data={display} ctx={currentCtx} {preview} />
        {:else}<p class="card empty">{m.noMessages}</p>{/if}
      </div>
    </div>
    {#if newItems}
      <div class="latest-row">
        <button class="latest" type="button" onclick={() => bottom(true)}>
          ↓ {m.newest} ({newItems})
        </button>
      </div>
    {/if}
  </section>
  {#if showWide}
    <aside class="chat-details chat-pane" aria-label={m.details}>
      <ChatDetails {data} {ctx} close={() => toggleWide(false)} />
    </aside>
  {/if}
</div>
<dialog
  bind:this={chatsDrawer}
  class="chat-drawer chat-list-drawer"
  aria-label={m.chats}
  onclose={() => chatsTrigger?.focus()}
  onclick={closeOnBackdrop}
>
  {@render list(() => chatsDrawer.close())}
</dialog>
<dialog
  bind:this={detailsDrawer}
  class="chat-drawer details-drawer"
  class:preview-drawer={mobilePreview}
  open={mobilePreview || undefined}
  aria-label={m.details}
  onclose={() => detailsTrigger?.focus()}
  onclick={closeOnBackdrop}
>
  <ChatDetails {data} {ctx} close={() => detailsDrawer.close()} />
</dialog>
