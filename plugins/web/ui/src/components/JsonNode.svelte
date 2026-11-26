<script lang="ts">
  import type { Locale } from '../lib/i18n.ts';

  import { i18n } from '../lib/i18n.ts';
  import JsonNode from './JsonNode.svelte';

  let {
    value,
    label,
    level,
    locale,
  }: { label?: string; level: number; locale: Locale; value: unknown } =
    $props();
  let all = $state(false);
  let full = $state(false);
  const m = $derived(i18n(locale));
  const array = $derived(Array.isArray(value));
  const entries = $derived(
    value && typeof value === 'object' ? Object.entries(value) : null,
  );
</script>

{#snippet key()}
  {#if label !== undefined}<span class="json-key">{label}:</span>
  {/if}
{/snippet}

{#if entries}
  <details class="json-node" open={level <= 2}>
    <summary>
      {@render key()}<span class="meta">
        {array ? '[' : '{'}{entries.length}{array ? ']' : '}'}
      </span>
    </summary>
    <div class="json-children">
      {#each array && !all ? entries.slice(0, 50) : entries as [name, member] (name)}
        <JsonNode value={member} label={name} level={level + 1} {locale} />
      {/each}
      {#if array && entries.length > 50 && !all}
        <button
          class="text-button"
          type="button"
          onclick={() => {
            all = true;
          }}
        >
          {m.remaining(entries.length - 50)}
        </button>
      {/if}
    </div>
  </details>
{:else if typeof value === 'string'}
  <div>
    {@render key()}<span
      class="json-string"
      class:multiline={value.includes('\n')}
    >
      "{!full && value.length > 300 ? value.slice(0, 300) + '…' : value}"
    </span>
    {#if value.length > 300}
      <button
        class="text-button"
        type="button"
        onclick={() => {
          full = !full;
        }}
      >
        {full ? m.collapse : m.expand}
      </button>
    {/if}
  </div>
{:else}
  <div>{@render key()}<span class="json-scalar">{String(value)}</span></div>
{/if}
