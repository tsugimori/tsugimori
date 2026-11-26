<script lang="ts">
  import type { AdminToolCall } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import { statusStyle } from '../lib/display.ts';
  import { duration } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';
  import { resource } from '../lib/resource.svelte.ts';
  import { callAnchor, toolOffset, toolStatus } from '../lib/timeline.ts';
  import LoadState from './LoadState.svelte';
  import ToolDetails from './ToolDetails.svelte';

  let {
    tool,
    task,
    taskStart,
    ctx,
    initialOpen = false,
  }: {
    ctx: ViewContext;
    initialOpen?: boolean;
    task: string;
    taskStart: number;
    tool: AdminToolCall;
  } = $props();
  let open = $state<boolean>();
  const expanded = $derived(open ?? initialOpen);
  const bundled = $derived(
    tool.args !== null || tool.result !== null || tool.seq < 0,
  );
  const status = $derived(statusStyle(toolStatus(tool)));
  const label = $derived(i18n(ctx.locale)[status[1]]);

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
  id={callAnchor(task, tool.seq)}
  open={expanded}
  ontoggle={(event) => {
    open = event.currentTarget.open;
  }}
>
  <summary>
    <span class="tool-offset">{toolOffset(tool.startedAt - taskStart)}</span>
    <span
      class="status-dot {status[0]}"
      role="img"
      aria-label={label}
      title={label}
    ></span>
    <code class="tool-name ellipsis" title={tool.name}>{tool.name}</code>
    <span class="tool-preview meta ellipsis" title={tool.argsPreview}>
      {tool.argsPreview ?? ''}
    </span>
    <span class="elapsed meta">
      {duration((tool.endedAt ?? ctx.now) - tool.startedAt, ctx.locale)}
    </span>
  </summary>
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
