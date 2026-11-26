<script lang="ts">
  import type { AdminConversation, AdminTask } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import { statusStyle, traceHref } from '../lib/display.ts';
  import { duration, formatTime, number } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';
  import Message from './Message.svelte';
  import TaskLanes from './TaskLanes.svelte';
  import ToolRow from './ToolRow.svelte';

  type MessageItem = AdminConversation['messages'][number];
  let {
    task,
    ctx,
    messages,
    preview = false,
  }: {
    ctx: ViewContext;
    messages: readonly MessageItem[];
    preview?: boolean;
    task: AdminTask;
  } = $props();
  const m = $derived(i18n(ctx.locale));
  const initialStyle = $derived(statusStyle(task.status)[0]);
  const status = $derived(
    statusStyle(
      initialStyle === 'run' &&
        task.tools.some((tool) => tool.status === 'pending-approval')
        ? 'pending-approval'
        : task.status,
    ),
  );
  const started = $derived(task.startedAt ?? task.createdAt);
  const end = $derived(task.finishedAt ?? ctx.now);
  const compact = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const tokenCount = (value: number | undefined) =>
    value === undefined ? '—' : compact.format(value).toLowerCase();
  const usage = $derived(
    task.inputTokens !== undefined || task.outputTokens !== undefined
      ? `${tokenCount(task.inputTokens)}/${tokenCount(task.outputTokens)}`
      : undefined,
  );

  const rows = $derived(
    [
      ...task.tools.map((tool) => ({
        at: tool.startedAt,
        key: 'tool-' + tool.seq,
        tool,
      })),
      ...messages.map((message) => ({
        at: message.recordedAt ?? started,
        key: 'message-' + message.seq,
        message,
      })),
    ].sort((a, b) => a.at - b.at),
  );

  let opened = $state<boolean>();
  const open = $derived(opened ?? initialStyle === 'run');
</script>

<li class="task" id={'task-' + task.id}>
  <div class="task-divider">
    <button
      type="button"
      class="task-toggle"
      aria-expanded={open}
      aria-controls={'task-body-' + task.id}
      onclick={() => (opened = !open)}
    >
      <span class="status-dot {status[0]}" aria-hidden="true"></span>
      <span title={formatTime(started, ctx.timezone)}>
        {m.task}
        {m[status[1]]}
      </span>
      <span class="task-meta">
        · {[
          duration(end - started, ctx.locale),
          task.agentId,
          task.model,
          m.toolCount(number(task.tools.length)),
          usage && usage + ' ' + m.tokens,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {#if task.silent}<span class="task-meta">· {m.silent}</span>{/if}
    </button>
    <a href={traceHref(task.id)}>{m.trace} →</a>
  </div>
  <div id={'task-body-' + task.id}>
    {#if open}
      {#if task.error || initialStyle === 'err'}<p class="alert err">
          {task.error || m.taskError}
        </p>{/if}
      <TaskLanes {task} start={started} {end} locale={ctx.locale} />
    {/if}
    {#if messages.length || (open && task.tools.length)}
      <ol class="tools">
        {#each rows as row (row.key)}
          {#if 'message' in row}<Message message={row.message} {ctx} />
          {:else if open}
            <li>
              <ToolRow
                tool={row.tool}
                task={task.id}
                {ctx}
                taskStart={started}
                initialOpen={preview && row.tool.result !== null}
              />
            </li>
          {/if}
        {/each}
      </ol>
    {/if}
  </div>
</li>
