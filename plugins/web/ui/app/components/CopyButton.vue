<script setup lang="ts">
import { Check, Copy } from '@lucide/vue';

const props = defineProps<{ text: string }>();
const { m } = useConsole();
const feedback = ref<'copied' | 'copyFailed'>();
let timer: ReturnType<typeof setTimeout> | undefined;
async function copy() {
  try {
    await navigator.clipboard.writeText(props.text);
    feedback.value = 'copied';
  } catch {
    feedback.value = 'copyFailed';
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    feedback.value = undefined;
  }, 1500);
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <Button
    class="copy-btn"
    size="small"
    severity="secondary"
    outlined
    :aria-label="m.copy"
    @click="copy"
  >
    <component
      :is="feedback === 'copied' ? Check : Copy"
      :size="14"
      aria-hidden="true"
    />
    <span aria-live="polite">{{ m[feedback ?? 'copy'] }}</span>
  </Button>
</template>
