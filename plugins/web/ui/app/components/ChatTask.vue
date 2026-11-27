<script setup lang="ts">
import type { AdminConversation, AdminTask } from '@tsugimori/plugin-sdk';

import { ChevronRight } from '@lucide/vue';

import { statusStyle, tokenPair, taskHref } from '../lib/display.ts';
import { duration } from '../lib/format.ts';
import { taskLanes } from '../lib/timeline.ts';

// Render a native button even when PrimeVue registers Button globally.
const TaskHeader = defineComponent({
  props: { expandable: Boolean },
  setup(props, { slots }) {
    return () => h(props.expandable ? 'button' : 'div', slots.default?.());
  },
});

const props = defineProps<{
  task: AdminTask;
  replies: readonly AdminConversation['messages'][number][];
}>();
const { locale, m, now, t } = useConsole();
const start = computed(() => props.task.startedAt ?? props.task.createdAt);
const end = computed(() => props.task.finishedAt ?? now.value);
const active = computed(() => statusStyle(props.task.status)[0] === 'run');
const status = computed(() =>
  active.value &&
  props.task.tools.some(({ status }) => status === 'pending-approval')
    ? 'pending-approval'
    : props.task.status,
);
const open = ref<boolean>();
const expandable = computed(
  () => props.task.tools.length > 0 || Boolean(props.task.error),
);
const expanded = computed(() => open.value ?? active.value);
const lanes = computed(() => taskLanes(props.task, start.value, end.value));
const rows = computed(() =>
  [
    ...props.task.tools.map((tool) => ({
      at: tool.startedAt,
      key: 'tool-' + tool.seq,
      tool,
    })),
    ...props.replies.map((message) => ({
      at: message.recordedAt ?? start.value,
      key: 'message-' + message.seq,
      message,
    })),
  ].sort((a, b) => a.at - b.at),
);

function toggle() {
  open.value = !expanded.value;
}
</script>

<template>
  <div
    :id="'task-' + task.id"
    class="chat-task-card"
    :class="{ 'live-task': active }"
  >
    <div class="chat-task-head">
      <TaskHeader
        :expandable="expandable"
        class="chat-task-summary"
        :class="{ 'chat-task-toggle text-button': expandable }"
        v-bind="
          expandable
            ? {
                type: 'button',
                'aria-expanded': expanded,
                'aria-controls': 'task-body-' + task.id,
                onClick: toggle,
              }
            : {}
        "
      >
        <ChevronRight
          v-if="expandable"
          class="chat-task-chevron"
          :size="16"
          aria-hidden="true"
        />
        <StateTag
          :status="task.silent ? 'idle' : status"
          :label="task.silent ? m.silent : undefined"
        />
        <span class="muted"
          >{{ duration(end - start, locale) }} ·
          {{
            [task.agentId, task.model, m.toolCount(String(task.tools.length))]
              .filter(Boolean)
              .join(' · ')
          }}
          <small v-if="task.inputTokens != null || task.outputTokens != null"
            >{{ tokenPair(task.inputTokens, task.outputTokens) }}
            {{ m.tokens }}</small
          >
        </span>
        <span v-if="!expanded && task.tools.length" class="chat-task-hint">
          {{ m.showTools(task.tools.length) }}
        </span>
      </TaskHeader>
      <NuxtLink :to="taskHref(task.id)" class="section-link"
        >{{ t('Task details', '任務詳情') }} →</NuxtLink
      >
    </div>
    <div v-if="lanes.model.length || lanes.tools.length" class="chat-lane">
      <div v-if="lanes.model.length" class="timing-lane">
        <span>{{ m.modelLane }}</span><TimingTrack :segments="lanes.model" />
      </div>
      <div v-if="lanes.tools.length" class="timing-lane">
        <span>{{ m.toolLane }}</span><TimingTrack :segments="lanes.tools" />
      </div>
    </div>
    <div :id="'task-body-' + task.id" class="chat-task-body">
      <template v-for="row in rows" :key="row.key">
        <ChatTool
          v-if="'tool' in row && expanded"
          :tool="row.tool"
          :task-id="task.id"
          :start="start"
        />
        <ChatMessage
          v-else-if="'message' in row"
          :message="row.message"
          :chat="task"
        />
      </template>
      <p v-if="task.error && expanded" class="error-text">
        {{ task.error }}
      </p>
    </div>
  </div>
</template>
