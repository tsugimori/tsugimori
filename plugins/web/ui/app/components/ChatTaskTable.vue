<script setup lang="ts">
import type { AdminTask } from '@tsugimori/plugin-sdk';

import { taskDuration, taskHref } from '../lib/display.ts';
import { duration } from '../lib/format.ts';

defineProps<{ tasks: readonly AdminTask[] }>();
const { locale, m, now, t } = useConsole();
</script>

<template>
  <p v-if="!tasks.length" class="empty">
    {{ t('No tasks in this chat.', '此聊天室尚無任務。') }}
  </p>
  <table v-else class="console-table chat-task-table">
    <thead>
      <tr>
        <th>{{ t('Status', '狀態') }}</th>
        <th>{{ m.started }}</th>
        <th>{{ m.timing }}</th>
        <th>{{ m.toolLane }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="task in tasks" :key="task.id">
        <td :data-label="t('Status', '狀態')">
          <StateTag
            :status="task.silent ? 'idle' : task.status"
            :label="task.silent ? m.silent : undefined"
          />
        </td>
        <td class="primary-cell">
          <NuxtLink
            class="section-link"
            :to="taskHref(task.id)"
            :title="task.id"
            ><ConsoleTime
              :at="task.startedAt ?? task.createdAt"
              format="clock"
            />
            ↗</NuxtLink
          >
        </td>
        <td :data-label="m.timing">
          {{
            taskDuration(task, now) === null
              ? '—'
              : duration(taskDuration(task, now)!, locale)
          }}
        </td>
        <td :data-label="m.toolLane">{{ task.tools.length }}</td>
      </tr>
    </tbody>
  </table>
</template>
