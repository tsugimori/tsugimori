<script lang="ts">
  import type { ViewContext } from '../lib/format.ts';

  import { formatTime, relative } from '../lib/format.ts';

  let {
    at,
    ctx,
    mode = 'relative',
  }: {
    at: number | null | undefined;
    ctx: ViewContext;
    mode?: 'relative' | 'absolute' | 'clock' | 'future';
  } = $props();
</script>

{#if at == null}—{:else}
  {@const stamp = formatTime(at, ctx.timezone)}
  {@const age = relative(at, ctx.now, ctx.locale)}
  <time
    datetime={new Date(at).toISOString()}
    title={stamp + ' (' + ctx.timezone + ')'}
  >
    {mode === 'relative' ? age : mode === 'clock' ? stamp.slice(11) : stamp}
  </time>{#if mode === 'clock' || mode === 'absolute'}
    <span class="meta">({age})</span>{/if}
{/if}
