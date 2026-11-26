<script setup lang="ts">
import type { AdminToolCall } from '@tsugimori/plugin-sdk';

defineProps<{ tool?: AdminToolCall }>();
const { m } = useConsole();
</script>

<template>
  <div
    v-if="tool?.args != null || tool?.result != null"
    class="tool-inspectors"
  >
    <CodeInspector v-if="tool.args != null" :text="tool.args" :label="m.args" />
    <CodeInspector
      v-if="tool.result != null"
      :text="tool.result"
      :label="m.result"
      :error="tool.status === 'error' || tool.status === 'denied'"
    />
  </div>
  <p v-else class="detail-inset muted">{{ m.noDetails }}</p>
  <p v-if="tool?.callId" class="tool-id muted">
    {{ m.callId }} · <code>{{ tool.callId }}</code>
  </p>
</template>
