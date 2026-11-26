<script lang="ts">
  import type { Snippet } from 'svelte';

  import type { Locale } from '../lib/i18n.ts';

  import { i18n } from '../lib/i18n.ts';

  let {
    locale,
    error,
    retry,
    compact = false,
    children,
  }: {
    children?: Snippet;
    compact?: boolean;
    error?: string;
    locale: Locale;
    retry?: () => void;
  } = $props();
  const m = $derived(i18n(locale));
  const errors = $derived({
    internal: m.internal,
    forbidden: m.forbidden,
    invalidChat: m.invalidChat,
    notFound: m.notFound,
  });
</script>

{#if error}
  <div class="card error-page" role="alert">
    {#if !compact}<h1>{m.error}</h1>{/if}
    <p>{errors[error as keyof typeof errors] ?? m.internal}</p>
    {#if retry}<button class="btn" type="button" onclick={retry}>
        {m.retry}
      </button>{/if}
  </div>
{:else if children}
  {@render children()}
{:else}
  <div
    class:skeleton-card={!compact}
    class="skeleton"
    role="status"
    aria-label={m.loading}
  >
    <span></span><span></span>{#if !compact}<span></span>{/if}
  </div>
{/if}
