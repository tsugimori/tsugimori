<script lang="ts">
  import type { AdminToolCall } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import { duration } from '../lib/format.ts';
  import { resource } from '../lib/resource.svelte.ts';
  import Badge from './Badge.svelte';
  import LoadState from './LoadState.svelte';
  import ToolDetails from './ToolDetails.svelte';

  let {
    tool,
    task,
    ctx,
    initialOpen = false,
  }: {
    ctx: ViewContext;
    initialOpen?: boolean;
    task: string;
    tool: AdminToolCall;
  } = $props();
  let open = $state<boolean>();
  const expanded = $derived(open ?? initialOpen);
  const bundled = $derived(
    tool.args !== null || tool.result !== null || tool.seq < 0,
  );
  const running = $derived(tool.endedAt === null && tool.status === null);

  const path = $derived(
    expanded && !bundled
      ? 'tool-call?' + new URLSearchParams({ task, seq: String(tool.seq) })
      : undefined,
  );
  const details = resource<AdminToolCall>(
    () => path,
    (event) =>
      event.kind === 'tool' && event.taskId === task && event.seq === tool.seq,
  );
</script>

<details
  class="tool"
  open={expanded}
  ontoggle={(event) => {
    open = event.currentTarget.open;
  }}
>
  <summary>
    <code class="tool-name ellipsis" title={tool.name}>{tool.name}</code>
    <Badge status={tool.status} locale={ctx.locale} />
    <span class="elapsed meta">
      {duration((tool.endedAt ?? ctx.now) - tool.startedAt, ctx.locale)}
    </span>
  </summary>
  {#if running}<div class="tool-progress" aria-hidden="true"></div>{/if}
  {#if details.error}
    <LoadState
      locale={ctx.locale}
      error={details.error}
      compact
      retry={details.retry}
    />
  {/if}
  {#if bundled || details.data}
    <ToolDetails tool={bundled ? tool : details.data} locale={ctx.locale} />
  {:else if expanded && !details.error}
    <LoadState locale={ctx.locale} compact />
  {/if}
</details>
