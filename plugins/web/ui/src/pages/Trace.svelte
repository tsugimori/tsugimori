<script lang="ts">
  import type { AdminTrace } from '@tsugimori/plugin-sdk';

  import { SvelteMap, SvelteSet } from 'svelte/reactivity';

  import type { ViewContext } from '../lib/format.ts';

  import Badge from '../components/Badge.svelte';
  import JsonView from '../components/JsonView.svelte';
  import TaskRecord from '../components/TaskRecord.svelte';
  import Time from '../components/Time.svelte';
  import ToolDetails from '../components/ToolDetails.svelte';
  import { chatHref, statusStyle } from '../lib/display.ts';
  import { duration } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';

  let {
    data,
    ctx,
    preview = false,
  }: { ctx: ViewContext; data: AdminTrace; preview?: boolean } = $props();
  const m = $derived(i18n(ctx.locale));
  const task = $derived(data.task);
  const started = $derived(task.startedAt ?? task.createdAt);
  const elapsed = $derived(Math.max(1, (task.finishedAt ?? ctx.now) - started));
  const calls = $derived(new Map(task.tools.map((tool) => [tool.seq, tool])));
  type Span = AdminTrace['spans'][number];

  function ordered(spans: readonly Span[]) {
    const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt);
    const ids = new Map(
      sorted.flatMap((span) =>
        span.id == null ? [] : [[span.id, span] as const],
      ),
    );
    const children = new SvelteMap<Span | undefined, Span[]>();
    for (const span of sorted) {
      const id = span.parentId ?? span.attrs.parentSpanId;
      const parent =
        typeof id === 'string' || typeof id === 'number'
          ? ids.get(id)
          : undefined;
      const group = children.get(parent) ?? [];
      group.push(span);
      children.set(parent, group);
    }
    const seen = new SvelteSet<Span>();
    const rows: { depth: number; span: Span }[] = [];
    function visit(span: Span, depth: number) {
      if (seen.has(span)) return;
      seen.add(span);
      rows.push({ depth, span });
      for (const child of children.get(span) ?? []) visit(child, depth + 1);
    }
    for (const span of children.get(undefined) ?? []) visit(span, 0);
    for (const span of sorted) visit(span, 0);
    return rows;
  }

  function position(node: HTMLElement, properties: Record<string, string>) {
    function update(values: Record<string, string>) {
      for (const [key, value] of Object.entries(values))
        node.style.setProperty(key, value);
    }
    update(properties);
    return { update };
  }
</script>

<a
  href={chatHref(data.chat) + '#task-' + encodeURIComponent(task.id)}
  class="meta"
>
  ← {m.chat}
</a>
<div class="trace-head">
  <h1 title={task.id}>
    {m.task}
    {task.id.length <= 8 ? task.id : task.id.slice(0, 8) + '…'}
  </h1>
  <Badge status={task.status} locale={ctx.locale} />
  <p class="meta">
    {m.started}
    <Time at={started} {ctx} mode="absolute" /> · {duration(
      elapsed,
      ctx.locale,
    )}
  </p>
</div>
{#if !preview}<TaskRecord taskId={task.id} {ctx} />{/if}
{#if data.spans.length}
  <div class="card">
    <ol class="spans">
      {#each ordered(data.spans) as { depth, span }, index (span.id ?? index)}
        {@const left = Math.min(
          100,
          Math.max(0, ((span.startedAt - started) * 100) / elapsed),
        )}
        {@const width = Math.max(
          0,
          Math.min(100 - left, (span.durationMs * 100) / elapsed),
        )}
        {@const seq = span.attrs.toolCallSeq}
        {@const attributes = Object.fromEntries(
          Object.entries(span.attrs).filter(([key]) => key !== 'toolCallSeq'),
        )}
        <li>
          <details class="span">
            <summary>
              <code
                class="span-name"
                data-indent={preview ? Math.min(depth, 12) * 16 : undefined}
                use:position={{ '--indent': Math.min(depth, 12) * 16 + 'px' }}
              >
                {span.name}{#if typeof span.attrs.name === 'string'}
                  <span class="meta">{span.attrs.name}</span>{/if}
              </code>
              <span class="track" aria-hidden="true">
                <span
                  class="fill {statusStyle(span.status)[0]}"
                  data-left={preview ? left : undefined}
                  data-width={preview ? width : undefined}
                  use:position={{
                    '--left': left + '%',
                    '--width': width + '%',
                  }}
                ></span>
              </span>
              <span class="elapsed meta">
                {duration(span.durationMs, ctx.locale)}
              </span>
            </summary>
            <div class="span-body">
              <p class="meta">
                <Time at={span.startedAt} {ctx} mode="absolute" />
                <Badge status={span.status} locale={ctx.locale} />
              </p>
              {#if Object.keys(attributes).length}<JsonView
                  text={JSON.stringify(attributes, null, 2)}
                  label={m.attributes}
                  locale={ctx.locale}
                />
              {:else}<p class="meta">{m.noAttributes}</p>{/if}
              {#if span.name === 'agent.tool' || span.name === 'tool.run'}
                <ToolDetails
                  tool={typeof seq === 'number' ? calls.get(seq) : undefined}
                  locale={ctx.locale}
                />
              {/if}
            </div>
          </details>
        </li>
      {/each}
    </ol>
  </div>
{:else}<p class="card empty">{m.noSpans}</p>{/if}
