<script lang="ts">
  import type { AdminTask } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import { statusStyle, traceHref } from '../lib/display.ts';
  import { duration, number } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';
  import Badge from './Badge.svelte';
  import Time from './Time.svelte';
  import ToolRow from './ToolRow.svelte';

  let {
    task,
    ctx,
    preview = false,
  }: { ctx: ViewContext; preview?: boolean; task: AdminTask } = $props();
  const m = $derived(i18n(ctx.locale));
  const initialStyle = $derived(statusStyle(task.status)[0]);
  const status = $derived(
    initialStyle === 'run' &&
      task.tools.some((tool) => tool.status === 'pending-approval')
      ? 'pending-approval'
      : task.status,
  );
  const started = $derived(task.startedAt ?? task.createdAt);
  const usage = $derived(
    [
      task.inputTokens === undefined
        ? ''
        : m.input + ' ' + number(task.inputTokens),
      task.outputTokens === undefined
        ? ''
        : m.output + ' ' + number(task.outputTokens),
    ]
      .filter(Boolean)
      .join(' · '),
  );
  let opened = $state<boolean>();
  let defaultOpen = $state(false);
  $effect(() => {
    if (initialStyle === 'run' || initialStyle === 'err') defaultOpen = true;
  });
  const open = $derived(
    opened ?? (defaultOpen || initialStyle === 'run' || initialStyle === 'err'),
  );
</script>

<li class="task" id={'task-' + task.id}>
  <details
    class="task card {statusStyle(status)[0]}"
    {open}
    ontoggle={(event) => {
      const isOpen = event.currentTarget.open;
      if (isOpen !== open) opened = isOpen;
    }}
  >
    <summary>
      <b>{m.task}</b><Badge {status} locale={ctx.locale} />
      <span class="meta">
        {[
          task.agentId,
          task.model,
          duration((task.finishedAt ?? ctx.now) - started, ctx.locale),
          m.toolCount(number(task.tools.length)),
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <span class="meta"><Time at={started} {ctx} mode="clock" /></span>
    </summary>
    {#if task.error || initialStyle === 'err'}<p class="alert err">
        {task.error || m.taskError}
      </p>{/if}
    {#if task.tools.length}
      <ol class="tools">
        {#each task.tools as tool (tool.seq)}<li>
            <ToolRow
              {tool}
              task={task.id}
              {ctx}
              initialOpen={preview && tool.result !== null}
            />
          </li>{/each}
      </ol>
    {/if}
    <div class="task-footer meta">
      {#if usage}<span>{m.tokens} {usage}</span>{/if}
      <a href={traceHref(task.id)}>{m.trace} →</a>
    </div>
  </details>
</li>
