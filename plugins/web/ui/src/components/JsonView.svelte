<script lang="ts">
  import type { Locale } from '../lib/i18n.ts';

  import { omission, wasTruncated } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';
  import JsonNode from './JsonNode.svelte';

  let {
    text,
    label,
    locale,
    error = false,
  }: {
    error?: boolean;
    label: string;
    locale: Locale;
    text: string;
  } = $props();
  let raw = $state(false);
  let copy = $state<'copied' | 'copyFailed'>();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const m = $derived(i18n(locale));
  const tree = $derived.by(() => {
    if (wasTruncated(text)) return null;
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  });
  const parts = $derived(text.split(omission));
  const clipboard = typeof navigator !== 'undefined' && navigator.clipboard;
  $effect(() => () => clearTimeout(timeout));

  async function copyText() {
    if (!clipboard) return;
    clearTimeout(timeout);
    try {
      await clipboard.writeText(text);
      copy = 'copied';
    } catch {
      copy = 'copyFailed';
    }
    timeout = setTimeout(() => {
      copy = undefined;
    }, 1500);
  }
</script>

<section class="json-view">
  <div class="json-toolbar">
    <b class="meta">{label}</b>
    {#if tree}
      <div class="segments">
        <button
          class="btn"
          type="button"
          aria-pressed={!raw}
          onclick={() => {
            raw = false;
          }}
        >
          {m.tree}
        </button>
        <button
          class="btn"
          type="button"
          aria-pressed={raw}
          onclick={() => {
            raw = true;
          }}
        >
          {m.raw}
        </button>
      </div>
    {/if}
    {#if clipboard}<button class="btn" type="button" onclick={copyText}>
        {m[copy ?? 'copy']}
      </button>{/if}
  </div>
  {#if tree && !raw}
    <div class="code json-tree" class:err={error}>
      <JsonNode value={tree} level={0} {locale} />
    </div>
  {:else}
    <pre
      class="code"
      class:err={error}>{#each parts as part, index (index)}{#if index % 2}<span
            class="omit">{m.omitted(part)}</span
          >{:else}{part}{/if}{/each}</pre>
  {/if}
</section>
