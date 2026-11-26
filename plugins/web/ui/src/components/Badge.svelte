<script lang="ts">
  import type { Locale } from '../lib/i18n.ts';

  import { statusStyle } from '../lib/display.ts';
  import { i18n } from '../lib/i18n.ts';

  let {
    locale,
    status,
    label,
    denialIsError = false,
  }: {
    denialIsError?: boolean;
    label?: string;
    locale: Locale;
    status: string | null;
  } = $props();
  const style = $derived(
    status === null ? (['run', 'running'] as const) : statusStyle(status),
  );
</script>

<span class="badge {denialIsError && status === 'denied' ? 'err' : style[0]}">
  {label ?? i18n(locale)[style[1]]}
</span>
