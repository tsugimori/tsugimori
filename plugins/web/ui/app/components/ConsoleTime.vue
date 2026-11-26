<script setup lang="ts">
import { formatTime, relative } from '../lib/format.ts';

const props = defineProps<{
  at?: number | null;
  format?: 'absolute' | 'clock' | 'relative';
}>();
const { locale, now, workspace } = useConsole();
const absolute = computed(() =>
  props.at == null ? '' : formatTime(props.at, workspace.value.timezone),
);
</script>

<template>
  <time
    v-if="at != null"
    :datetime="new Date(at).toISOString()"
    :title="absolute + ' (' + workspace.timezone + ')'"
  >
    {{
      format === 'absolute'
        ? absolute
        : format === 'clock'
          ? absolute.slice(11)
          : relative(at, now, locale)
    }}
  </time>
  <span v-else>—</span>
</template>
