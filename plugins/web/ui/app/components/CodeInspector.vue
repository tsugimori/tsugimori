<script setup lang="ts">
import { omission, wasTruncated } from '../lib/format.ts';

const props = defineProps<{ label: string; text: string; error?: boolean }>();
const { m } = useConsole();
const raw = ref(false);
const truncated = computed(() => wasTruncated(props.text));
const tree = computed(() => {
  if (truncated.value) return null;
  try {
    const value: unknown = JSON.parse(props.text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
});
const parts = computed(() => props.text.split(omission));
</script>

<template>
  <section class="inspector">
    <div class="inspector-head">
      <h3>{{ label }}</h3>
      <Tag v-if="truncated" :value="m.truncated" severity="secondary" />
      <div v-if="tree" class="segments">
        <button :aria-pressed="!raw" @click="raw = false">{{ m.tree }}</button>
        <button :aria-pressed="raw" @click="raw = true">{{ m.raw }}</button>
      </div>
      <CopyButton :text="text" />
    </div>
    <div
      v-if="tree && !raw"
      class="code-block json-tree"
      :class="{ 'code-error': error }"
    >
      <JsonNode :level="0" :value="tree" />
    </div>
    <pre
      v-else
      class="code-block"
      :class="{ 'code-error': error }"
    ><code><template v-for="(part, index) of parts" :key="index"><mark v-if="index % 2">{{ m.omitted(part) }}</mark><template v-else>{{ part }}</template></template></code></pre>
  </section>
</template>
