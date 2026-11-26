<script lang="ts">
  import type { AdminConversation } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import { number } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';
  import { resource } from '../lib/resource.svelte.ts';
  import JsonView from './JsonView.svelte';
  import LoadState from './LoadState.svelte';
  import Time from './Time.svelte';

  let {
    message,
    ctx,
  }: { ctx: ViewContext; message: AdminConversation['messages'][number] } =
    $props();
  const m = $derived(i18n(ctx.locale));
  const lines = $derived(message.text.split('\n'));
  const head = $derived(lines.slice(0, 20).join('\n').slice(0, 1500));
  const tail = $derived(message.text.slice(head.length));
  let rawOpen = $state(false);
  const raw = resource<unknown>(
    () =>
      rawOpen && message.adapterId && message.chatId
        ? 'message-raw?' +
          new URLSearchParams({
            adapter: message.adapterId,
            chat: message.chatId,
            seq: String(message.seq),
          })
        : undefined,
    (event) => event.kind === 'message' && event.seq === message.seq,
  );
</script>

<li
  id={'msg-' + message.seq}
  class="msg"
  class:out={message.direction === 'outbound'}
  class:system={message.direction !== 'inbound' &&
    message.direction !== 'outbound'}
>
  {#if message.direction === 'inbound' || message.direction === 'outbound'}
    <div class="who">
      {#if message.direction === 'inbound'}
        <b>{message.displayName || message.userId || m.unknown}</b>
        {#if message.displayName && message.userId}<span class="meta">
            ({message.userId})
          </span>{/if}
      {/if}
      <span class="meta">
        <Time at={message.recordedAt} {ctx} mode="clock" />
      </span>
      {#if message.direction === 'outbound'}<b>{m.bot}</b>{/if}
    </div>
  {/if}
  <div class="bubble">
    {#if message.deleted}<em class="meta">
        {m.deleted}
      </em>{:else if !message.text}<em class="meta">
        {m.attachment}
      </em>{:else}{head}{#if tail}<details class="more">
          <summary>{m.more(number(lines.length))}</summary>{tail}
        </details>{/if}{/if}
  </div>
  {#if message.trigger || (message.adapterId && message.chatId)}
    <div class="message-record">
      {#if message.trigger}<span class="tag">
          {message.trigger.reason}
        </span>{/if}
      {#if message.adapterId && message.chatId}
        <button
          type="button"
          class="meta"
          aria-expanded={rawOpen}
          onclick={() => (rawOpen = !rawOpen)}
        >
          {m.raw}
        </button>
      {/if}
    </div>
    {#if rawOpen}
      {#if raw.data === undefined}
        <LoadState locale={ctx.locale} error={raw.error} retry={raw.retry} />
      {:else if raw.data === null}
        <p class="meta">{m.unavailable}</p>
      {:else}
        <JsonView
          text={JSON.stringify(raw.data, null, 2)}
          label={m.raw}
          locale={ctx.locale}
        />
      {/if}
    {/if}
  {/if}
</li>

<style>
  .message-record {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.2rem 0;
  }
  .message-record button {
    font-size: 0.75rem;
    padding: 0.1rem 0.35rem;
  }
</style>
