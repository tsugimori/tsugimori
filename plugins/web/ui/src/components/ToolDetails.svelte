<script lang="ts">
  import type { AdminToolCall } from '@tsugimori/plugin-sdk';

  import type { Locale } from '../lib/i18n.ts';

  import { wasTruncated } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';
  import JsonView from './JsonView.svelte';

  let { tool, locale }: { locale: Locale; tool?: AdminToolCall } = $props();
  const m = $derived(i18n(locale));
</script>

<div class="tool-body">
  {#if tool?.args == null && tool?.result == null}<p class="meta">
      {m.noDetails}
    </p>{/if}
  {#if tool?.args != null}<JsonView
      text={tool.args}
      label={m.args}
      {locale}
    />{/if}
  {#if tool?.result != null}<JsonView
      text={tool.result}
      label={m.result}
      {locale}
      error={tool.status === 'error'}
    />{/if}
  {#if tool?.callId}<p class="meta">{m.callId} · {tool.callId}</p>{/if}
  {#if tool && (wasTruncated(tool.args) || wasTruncated(tool.result))}<p
      class="meta"
    >
      {m.truncated}
    </p>{/if}
</div>
