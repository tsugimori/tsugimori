<script setup lang="ts">
import { Check, Circle, Clock3, LoaderCircle, X } from '@lucide/vue';

import { statusStyle } from '../lib/display.ts';

const props = defineProps<{ status: string | null; label?: string }>();
const { m } = useConsole();
const style = computed(() => statusStyle(props.status));
const glyphs = {
  ok: Check,
  run: LoaderCircle,
  warn: Clock3,
  err: X,
  idle: Circle,
};
</script>

<template>
  <Tag class="state-tag" :class="'state-' + style[0]">
    <component :is="glyphs[style[0]]" :size="12" aria-hidden="true" />
    {{ label ?? m[style[1]] }}
  </Tag>
</template>
