<script lang="ts">
  import type { AdminTaskRecord } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import { duration } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';
  import { resource } from '../lib/resource.svelte.ts';
  import LoadState from './LoadState.svelte';
  import Time from './Time.svelte';
  import ToolDetails from './ToolDetails.svelte';

  let { ctx, taskId }: { ctx: ViewContext; taskId: string } = $props();
  const m = $derived(i18n(ctx.locale));
  const record = resource<AdminTaskRecord>(
    () => 'task?' + new URLSearchParams({ id: taskId }),
    (event) =>
      (event.kind === 'task' && event.id === taskId) ||
      (event.kind === 'tool' && event.taskId === taskId),
  );
  const data = $derived(record.data);
</script>

{#if !data}
  <LoadState locale={ctx.locale} error={record.error} retry={record.retry} />
{:else}
  <div class="execution-record">
    <section>
      <h3>{m.trigger}</h3>
      {#if data.trigger}
        <p>
          {data.trigger.triggered ? m.triggered : m.skipped} ·
          <code>{data.trigger.reason}</code>
        </p>
      {:else}<p class="meta">{m.unavailable}</p>{/if}
    </section>
    <section>
      <h3>{m.agent}</h3>
      {#if data.agent}
        <p>
          {data.agent.agentId} · {data.agent.model}
          {#if data.agent.requestedModel !== data.agent.model}
            <span class="meta">
              ({m.requestedModel}
              {data.agent.requestedModel})
            </span>
          {/if}
          {#if data.agent.reasoning}
            · {data.agent.reasoning}{/if}
          {#if data.agent.serviceTier}
            · {data.agent.serviceTier}{/if}
        </p>
      {:else}<p class="meta">{data.task.model ?? m.unavailable}</p>{/if}
      {#if data.refs}
        <p class="meta">
          {data.refs.session.mode === 'new' ? m.sessionNew : m.sessionResumed}
          {#if data.refs.session.sessionId}
            · <code>{data.refs.session.sessionId}</code>{/if}
          {#if data.refs.session.reason}
            · {data.refs.session.reason}{/if}
        </p>
      {/if}
    </section>
    <section>
      <h3>{m.context}</h3>
      {#each data.context as section (section)}
        <details open={section.kind === 'new'}>
          <summary>{section.title}</summary>
          {#if section.text !== undefined}
            <pre>{section.text}</pre>
          {:else}
            <p class="meta">{m.unavailable} · <code>{section.ref}</code></p>
          {/if}
        </details>
      {:else}<p class="meta">{m.unavailable}</p>{/each}
    </section>
    <section>
      <h3>{m.transcript}</h3>
      <ol>
        {#each data.events as event (event.seq)}
          <li>
            <span class="meta"><Time at={event.at} {ctx} mode="clock" /></span>
            {#if event.kind === 'tool'}
              <details open>
                <summary>
                  {event.tool?.name ?? m.tool} · #{event.data.toolSeq}
                </summary>
                <ToolDetails tool={event.tool} locale={ctx.locale} />
              </details>
            {:else if event.kind === 'text' || event.kind === 'reasoning'}
              <span class="meta">
                · {event.kind === 'text' ? m.textLabel : m.reasoning}
              </span>
              <pre>{event.data.text}</pre>
            {:else if event.kind === 'compaction'}
              <span>
                · {m.compaction} · {event.data.trigger}
                {#if event.data.tokensBefore !== undefined}
                  · {event.data.tokensBefore} → {event.data.tokensAfter ??
                    '—'}{/if}
                {#if event.data.status}
                  · {event.data.status}{/if}
              </span>
            {:else if event.kind === 'error'}
              <span class="err">
                · {event.data.stage} · {event.data.message}
              </span>
            {:else if event.kind === 'supplement'}
              <span>· {m.supplement} · {event.data.messageId}</span>
            {/if}
          </li>
        {:else}<li class="meta">{m.unavailable}</li>{/each}
      </ol>
    </section>
    <section>
      <h3>{m.output}</h3>
      {#if data.output != null}
        <pre>{data.output || m.emptyOutput}</pre>
      {:else}<p class="meta">{m.unavailable}</p>{/if}
    </section>
    <section>
      <h3>{m.outcome}</h3>
      {#if data.outcome}
        <p>
          {m.outcomeKind[data.outcome.kind]}{data.outcome.silentReason
            ? ' · ' + data.outcome.silentReason
            : ''}
        </p>
        {#if data.outcome.error}
          <p class="err">
            {data.outcome.error.stage} · {data.outcome.error.code} · {data
              .outcome.error.message}
          </p>
        {/if}
        {#if data.outcome.delivery}
          <ul>
            {#each data.outcome.delivery.parts as part, index (index)}
              <li>
                {data.outcome.delivery.adapterId} · {part.messageId ??
                  m.outcomeKind.failed}{part.error ? ' · ' + part.error : ''}
              </li>
            {/each}
          </ul>
        {/if}
      {:else}<p class="meta">{m.unavailable}</p>{/if}
    </section>
    <section>
      <h3>{m.timing}</h3>
      {#if data.timing}
        <p class="meta">
          {Object.entries(data.timing)
            .map(
              ([key, value]) =>
                m.timingLabel[key as keyof typeof m.timingLabel] +
                ' ' +
                duration(value, ctx.locale),
            )
            .join(' · ')}
        </p>
      {:else}<p class="meta">{m.unavailable}</p>{/if}
    </section>
    <section>
      <h3>{m.supplements}</h3>
      {#if data.supplements?.length}
        <ul>
          {#each data.supplements as item (item.messageId)}
            <li>
              <Time at={item.at} {ctx} mode="clock" /> · {item.messageId} · {m.afterEvent}
              #{item.afterEventSeq}
            </li>
          {/each}
        </ul>
      {:else}<p class="meta">—</p>{/if}
    </section>
  </div>
{/if}

<style>
  .execution-record {
    display: grid;
    gap: 0.75rem;
    margin: 0.6rem 0;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    overflow-wrap: anywhere;
  }
  h3,
  p,
  ol,
  ul,
  pre {
    margin: 0.2em 0;
  }
  h3 {
    font-size: 0.93rem;
  }
  ol,
  ul {
    list-style: none;
    padding: 0;
  }
  ol li + li {
    margin-top: 0.45rem;
  }
  pre {
    white-space: pre-wrap;
    font-size: 0.85rem;
    max-height: 24rem;
    overflow: auto;
  }
</style>
