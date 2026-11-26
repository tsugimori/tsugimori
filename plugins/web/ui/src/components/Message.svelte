<script lang="ts">
  import type { AdminConversation } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import { number } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';
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
</li>
