<script setup lang="ts">
import type {
  AdminAgent,
  AdminChat,
  AdminTaskPage,
  AdminTaskSort,
} from '@tsugimori/plugin-sdk';

import { ListTodo, SlidersHorizontal } from '@lucide/vue';

import {
  chatHref,
  taskDuration,
  taskHref,
  taskTokenLabel,
} from '../lib/display.ts';
import { duration } from '../lib/format.ts';

const route = useRoute();
const { locale, m, now, t, updated } = useConsole();
const drawer = ref(false);
function draft() {
  const get = (key: string) =>
    typeof route.query[key] === 'string' ? route.query[key] : '';
  return {
    agent: get('agent'),
    before: get('before'),
    chat: get('chat'),
    platform: get('platform'),
    q: get('q'),
    since: get('since'),
    status: get('status'),
  } as Record<
    'agent' | 'before' | 'chat' | 'platform' | 'q' | 'since' | 'status',
    string
  >;
}
const filters = ref(draft());
const sort = computed(() => {
  const value = route.query.sort;
  return typeof value === 'string' ? value : 'newest';
});
watch(
  () => route.query,
  () => {
    filters.value = draft();
  },
);
const cursors = ref<(string | null)[]>([null]);
const page = ref(0);
const query = computed(() =>
  Object.entries(draft()).filter(([, value]) => value),
);
const filterKey = computed(() =>
  new URLSearchParams([...query.value, ['sort', sort.value]]).toString(),
);
watch(
  filterKey,
  () => {
    cursors.value = [null];
    page.value = 0;
  },
  { flush: 'sync' },
);
const path = computed(() => {
  const params = new URLSearchParams(filterKey.value);
  params.set('limit', '25');
  const cursor = cursors.value[page.value];
  if (cursor) params.set('cursor', cursor);
  return 'tasks?' + params;
});
const { data, pending, error, refresh } = useConsoleQuery<AdminTaskPage>(
  () => path.value,
  ({ kind }) => page.value === 0 && (kind === 'task' || kind === 'tool'),
);
const { data: chats } = useConsoleQuery<readonly AdminChat[]>(
  () => 'chats',
  ({ kind }) => kind === 'chat',
);
const { data: agents } = useConsoleQuery<readonly AdminAgent[]>(() => 'agents');
const agentIds = computed(() => agents.value?.map(({ id }) => id) ?? []);

function apply() {
  drawer.value = false;
  return navigateTo({
    path: '/tasks',
    query: Object.fromEntries(
      [...Object.entries(filters.value), ['sort', route.query.sort]].filter(
        ([, value]) => value,
      ),
    ),
  });
}
function clear() {
  drawer.value = false;
  filters.value = {
    agent: '',
    before: '',
    chat: '',
    platform: '',
    q: '',
    since: '',
    status: '',
  };
  return navigateTo({ path: '/tasks', query: { sort: route.query.sort } });
}
function changeSort(event: Event) {
  const value = (event.target as HTMLSelectElement).value as AdminTaskSort;
  return navigateTo({
    path: '/tasks',
    query: { ...route.query, sort: value === 'newest' ? undefined : value },
  });
}
function next() {
  if (!data.value?.nextCursor) return;
  cursors.value.splice(page.value + 1, Infinity, data.value.nextCursor);
  page.value++;
}
useHead({ title: computed(() => t('Tasks', '任務')) });
</script>

<template>
  <div class="page-head">
    <h1>{{ t('Tasks', '任務') }}</h1>
    <p v-if="updated" class="muted">
      {{ m.updated }} <ConsoleTime :at="updated" format="clock" />
    </p>
  </div>
  <ConsolePanel :title="t('Task list', '任務清單')" :icon="ListTodo">
    <template #actions>
      <label class="task-sort">
        <span>{{ t('Sort', '排序') }}</span>
        <select :value="sort" @change="changeSort">
          <option value="newest">{{ t('Newest', '最新優先') }}</option>
          <option value="oldest">{{ t('Oldest', '最舊優先') }}</option>
          <option value="duration">{{ t('Longest', '耗時最長') }}</option>
        </select>
      </label>
      <Button
        class="mobile-filter"
        outlined
        size="small"
        :aria-expanded="drawer"
        @click="drawer = true"
        ><SlidersHorizontal :size="16" />{{ t('Filters', '篩選條件')
        }}<Badge v-if="query.length" :value="query.length"
      /></Button>
    </template>
    <div class="desktop-filters">
      <TaskFilters
        v-model="filters"
        :agents="agentIds"
        :chats="chats ?? []"
        @apply="apply"
        @clear="clear"
      />
    </div>
    <Drawer
      v-model:visible="drawer"
      :header="t('Task filters', '任務篩選')"
      position="right"
      :auto-z-index="false"
    >
      <TaskFilters
        v-model="filters"
        :agents="agentIds"
        :chats="chats ?? []"
        @apply="apply"
        @clear="clear"
      />
    </Drawer>
    <LoadState
      v-if="!data || error"
      :pending="pending"
      :error="error"
      @retry="refresh()"
    />
    <p v-if="data?.tasks.length === 0" class="empty">
      {{ t('No tasks match these filters.', '沒有符合篩選條件的任務。') }}
    </p>
    <table v-else-if="data" class="console-table task-table">
      <thead>
        <tr>
          <th>{{ t('Status', '狀態') }}</th>
          <th>{{ m.started }}</th>
          <th :aria-sort="sort === 'duration' ? 'descending' : undefined">
            {{ m.timing }}{{ sort === 'duration' ? ' ↓' : '' }}
          </th>
          <th>{{ m.chat }}</th>
          <th>{{ m.trigger }}</th>
          <th>{{ m.agent }}</th>
          <th>{{ m.toolLane }}</th>
          <th>{{ m.tokens }} ⇄</th>
          <th>{{ m.task }} ID</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="task in data.tasks"
          :key="task.id"
          :class="{ 'failed-row': task.error }"
        >
          <td class="task-state" :data-label="t('Status', '狀態')">
            <StateTag
              :status="task.silent ? 'idle' : task.status"
              :label="task.silent ? m.silent : undefined"
            />
          </td>
          <td :data-label="m.started">
            <ConsoleTime
              :at="task.startedAt ?? task.createdAt"
              format="clock"
            />
          </td>
          <td :data-label="m.timing">
            {{
              taskDuration(task, now) === null
                ? '—'
                : duration(taskDuration(task, now)!, locale)
            }}
          </td>
          <td :data-label="m.chat">
            <NuxtLink class="section-link" :to="chatHref(task)">{{
              task.chatTitle
            }}</NuxtLink><small
              ><PlatformTag :platform="task.platform"
            /></small>
          </td>
          <td class="task-trigger" :data-label="m.trigger">
            {{ task.triggerText ?? '—'
            }}<small v-if="task.triggerReason"
              ><code>{{ task.triggerReason }}</code></small
            ><small v-if="task.error" class="error-text">{{
              task.error
            }}</small>
          </td>
          <td :data-label="m.agent">
            {{ task.agentId ?? '—'
            }}<small v-if="task.model"
              ><code>{{ task.model }}</code></small
            >
          </td>
          <td :data-label="m.toolLane">{{ task.toolCount }}</td>
          <td :data-label="m.tokens">
            {{ taskTokenLabel(task, locale) }}
          </td>
          <td class="primary-cell">
            <NuxtLink
              class="section-link mono"
              :to="taskHref(task.id)"
              :title="task.id"
              >{{
                task.id.length > 14 ? task.id.slice(0, 12) + '…' : task.id
              }}
              ↗</NuxtLink
            >
          </td>
        </tr>
      </tbody>
    </table>
    <footer v-if="data || page" class="table-footer">
      <span class="muted" aria-live="polite"
        >{{ t('Page', '頁次') }} {{ page + 1
        }}<template v-if="data">
          · {{ data.tasks.length }} {{ t('tasks', '筆任務') }}</template
        ></span
      >
      <div class="inline">
        <Button
          outlined
          size="small"
          :label="t('Previous', '上一頁')"
          :disabled="page === 0"
          @click="page--"
        />
        <Button
          outlined
          size="small"
          :label="t('Next', '下一頁')"
          :disabled="!data?.nextCursor || pending"
          @click="next"
        />
      </div>
    </footer>
  </ConsolePanel>
</template>
