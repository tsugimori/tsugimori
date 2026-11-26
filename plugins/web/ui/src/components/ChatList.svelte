<script lang="ts">
  import type { AdminChat } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import {
    chatHref,
    chatTitle,
    platformLabel,
    statusStyle,
  } from '../lib/display.ts';
  import { i18n } from '../lib/i18n.ts';
  import LoadState from './LoadState.svelte';
  import Time from './Time.svelte';

  let {
    chats,
    current,
    ctx,
    error,
    query = $bindable(''),
    retry,
    select,
  }: {
    chats?: readonly AdminChat[];
    ctx: ViewContext;
    current: AdminChat;
    error?: string;
    query?: string;
    retry: () => void;
    select?: () => void;
  } = $props();

  const m = $derived(i18n(ctx.locale));
  const currentHref = $derived(chatHref(current));
  const normalized = $derived(query.trim().toLocaleLowerCase(ctx.locale));
  const filtered = $derived(
    chats
      ?.filter((chat) =>
        [chatTitle(chat), chat.preview?.sender, chat.preview?.text].some(
          (part) => part?.toLocaleLowerCase(ctx.locale).includes(normalized),
        ),
      )
      .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)),
  );
</script>

<div class="chat-search">
  <input
    type="search"
    aria-label={m.searchChats}
    placeholder={m.searchChats}
    bind:value={query}
  />
  {#if select}<button class="btn" type="button" onclick={select}>
      {m.close}
    </button>{/if}
</div>
{#if error || !filtered}
  <LoadState locale={ctx.locale} {error} {retry} compact />
{/if}
{#if filtered?.length === 0}
  <p class="chat-list-empty meta">
    {normalized ? m.noMatchingChats : m.noChats}
  </p>
{/if}
{#each filtered ?? [] as chat (chatHref(chat))}
  {@const href = chatHref(chat)}
  {@const failed = statusStyle(chat.lastTaskStatus)[0] === 'err'}
  {@const state = chat.activeTask ? m.running : failed ? m.failed : m.idle}
  <a
    class="chat-list-row"
    {href}
    aria-current={href === currentHref ? 'page' : undefined}
    onclick={select}
  >
    <span class="chat-list-name">
      <span
        class="status-dot {chat.activeTask ? 'run' : failed ? 'err' : 'idle'}"
        role="img"
        aria-label={state}
        title={state}
      ></span>
      <span class="tag">{platformLabel(chat.platform)}</span>
      <span class="ellipsis">
        <b>{chatTitle(chat)}</b>{#if chat.threadId}
          <span class="meta">· {m.topic} {chat.threadId}</span>{/if}
      </span>
    </span>
    <span class="chat-list-time meta">
      <Time at={chat.lastActivity} {ctx} />
    </span>
    <span class="chat-list-preview meta ellipsis">
      {#if chat.preview}{chat.preview.sender ?? m.bot}{ctx.locale === 'zh-TW'
          ? '：'
          : ': '}{chat.preview.text}{:else}—{/if}
    </span>
  </a>
{/each}
