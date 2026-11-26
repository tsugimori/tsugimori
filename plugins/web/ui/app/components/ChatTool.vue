<script setup lang="ts">
import type { AdminToolCall } from '@tsugimori/plugin-sdk';

import { statusStyle } from '../lib/display.ts';
import { duration } from '../lib/format.ts';
import { callAnchor, toolOffset, toolStatus } from '../lib/timeline.ts';

const props = defineProps<{
  start: number;
  taskId: string;
  tool: AdminToolCall;
}>();
const { locale } = useConsole();
const open = ref(false);
const detail = useConsoleQuery<AdminToolCall>(
  () =>
    open.value && props.tool.seq > 0
      ? 'tool-call?' +
        new URLSearchParams({ task: props.taskId, seq: String(props.tool.seq) })
      : undefined,
  (event) =>
    event.kind === 'tool' &&
    event.taskId === props.taskId &&
    event.seq === props.tool.seq,
);
</script>

<template>
  <details
    :id="callAnchor(taskId, tool.seq)"
    class="chat-tool"
    @toggle="open = ($event.target as HTMLDetailsElement).open"
  >
    <summary>
      <small class="muted">{{ toolOffset(tool.startedAt - start) }}</small>
      <span
        class="activity-dot"
        :class="'dot-' + statusStyle(toolStatus(tool))[0]"
      ></span>
      <code>{{ tool.name }}</code><code class="muted tool-preview">{{
        tool.argsPreview
      }}</code>
      <small>{{
        tool.endedAt === null
          ? '…'
          : duration(tool.endedAt - tool.startedAt, locale)
      }}</small>
    </summary>
    <LoadState
      v-if="detail.pending.value || detail.error.value"
      :pending="detail.pending.value"
      :error="detail.error.value"
      @retry="detail.refresh()"
    />
    <ToolDetails v-else :tool="detail.data.value ?? tool" />
  </details>
</template>
