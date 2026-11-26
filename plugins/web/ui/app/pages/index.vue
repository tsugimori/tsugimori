<script setup lang="ts">
import type {
  AdminAgent,
  AdminOverview,
  AdminTaskPage,
} from '@tsugimori/plugin-sdk';

import {
  Activity,
  Bot,
  CircleAlert,
  ClipboardCheck,
  Database,
  ListTodo,
  MessagesSquare,
} from '@lucide/vue';

import {
  chatHref,
  chatKey,
  chatTitle,
  routeLabel,
  statusStyle,
  summaryProgress,
  taskDuration,
  taskHref,
} from '../lib/display.ts';
import { duration, number } from '../lib/format.ts';

const route = useRoute();
const { locale, m, now, t, updated, workspace } = useConsole();
const agent = computed(() =>
  typeof route.query.agent === 'string' ? route.query.agent : '',
);
const { data, error, pending, refresh } = useConsoleQuery<AdminOverview>(
  () =>
    agent.value
      ? 'overview?agent=' + encodeURIComponent(agent.value)
      : 'overview',
  () => true,
);
const agents = useConsoleQuery<readonly AdminAgent[]>(
  () => 'agents',
  ({ kind }) => kind === 'task' || kind === 'chat',
);
const recent = useConsoleQuery<AdminTaskPage>(
  () => 'tasks?limit=5',
  ({ kind }) => kind === 'task',
);
const search = ref('');
const platform = ref('');
const order = ref<'activity' | 'messages'>('activity');
const page = ref(0);
const perPage = 6;
useHead({ title: computed(() => m.value.overview) });
useFragment(() => Boolean(data.value));
const stats = computed(() =>
  data.value
    ? [
        {
          label: m.value.chats,
          value: data.value.totals.chats,
          icon: MessagesSquare,
        },
        {
          label: m.value.running,
          value:
            agents.data.value?.reduce((sum, row) => sum + row.active, 0) ?? 0,
          icon: Activity,
          tone: 'run',
        },
        {
          label: m.value.tasksToday,
          value: data.value.totals.tasksToday,
          icon: ListTodo,
        },
        {
          label: m.value.failedToday,
          value: data.value.totals.failedToday,
          icon: CircleAlert,
          tone: 'err',
        },
        {
          label: m.value.pending,
          value: data.value.totals.pendingApprovals,
          icon: ClipboardCheck,
          tone: 'warn',
          to: '/ops#pending',
        },
      ]
    : [],
);
const platforms = computed(() => [
  ...new Set(data.value?.chats.map((chat) => chat.platform)),
]);
const chats = computed(() => {
  const term = search.value.trim().toLowerCase();
  const matches = (data.value?.chats ?? []).filter(
    (chat) =>
      (!platform.value || chat.platform === platform.value) &&
      (!term ||
        [chat.title, chat.chatId, chat.preview?.text, chat.route.agentId].some(
          (value) => value?.toLowerCase().includes(term),
        )),
  );
  return order.value === 'messages'
    ? matches.sort((a, b) => b.messageCount - a.messageCount)
    : matches;
});
watch([search, platform, agent, order], () => {
  page.value = 0;
});
watch(
  () => chats.value.length,
  (count) => {
    page.value = Math.min(
      page.value,
      Math.max(0, Math.ceil(count / perPage) - 1),
    );
  },
);
const refreshedAt = ref<number>();
watch(data, () => {
  refreshedAt.value = Date.now();
});
const displayed = computed(() =>
  chats.value.slice(page.value * perPage, (page.value + 1) * perPage),
);

function bytes(value: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(
    units.length - 1,
    Math.floor(Math.log2(Math.max(1, value)) / 10),
  );
  return (
    new Intl.NumberFormat(locale.value, { maximumFractionDigits: 1 }).format(
      value / 1024 ** unit,
    ) +
    ' ' +
    units[unit]
  );
}
</script>

<template>
  <div class="page-head">
    <h1>{{ m.overview }}</h1>
    <p class="muted">
      <Activity :size="14" />
      <template v-if="updated || refreshedAt"
        >{{ m.updated }}
        <ConsoleTime :at="updated ?? refreshedAt" format="clock" /> · </template
      >{{ workspace.timezone }}
    </p>
  </div>
  <LoadState
    v-if="!data || error"
    :pending="pending"
    :error="error"
    @retry="refresh()"
  />
  <template v-if="data">
    <div class="stat-grid">
      <component
        :is="stat.to ? 'a' : 'div'"
        v-for="stat in stats"
        :key="stat.label"
        :href="stat.to"
        class="stat-card"
        :class="'stat-' + (stat.tone ?? 'idle')"
      >
        <span>{{ stat.label }}</span>
        <strong>{{ number(stat.value) }}</strong>
        <span class="stat-icon"
          ><component :is="stat.icon" :size="18" aria-hidden="true"
        /></span>
      </component>
    </div>
    <div class="workspace-status">
      <div class="inline">
        <Tag
          class="state-tag"
          :class="
            data.webhook.state === 'ok'
              ? 'state-ok'
              : data.webhook.state === 'failed'
                ? 'state-err'
                : 'state-idle'
          "
        >
          {{ m.webhook }} · {{ m.webhookState[data.webhook.state] }}
        </Tag>
        <code v-if="data.webhook.baseUrl">{{ data.webhook.baseUrl }}</code>
        <span v-if="data.webhook.reason">{{ data.webhook.reason }}</span>
      </div>
      <div class="inline">
        <Database :size="16" /> {{ m.records }}
        <strong
          >{{ bytes(data.records.bytes) }} /
          {{ bytes(data.records.maxBytes) }}</strong
        >
        <progress
          :value="data.records.bytes"
          :max="Math.max(1, data.records.maxBytes)"
          :aria-label="m.records"
        />
        <span v-if="data.records.oldestFullTaskAt" class="muted"
          >{{ m.recordsSince }}
          <ConsoleTime :at="data.records.oldestFullTaskAt" format="absolute"
        /></span>
      </div>
    </div>

    <div class="overview-split">
      <ConsolePanel id="agents" :title="m.agents" :icon="Bot">
        <LoadState
          v-if="!agents.data.value || agents.error.value"
          :pending="agents.pending.value"
          :error="agents.error.value"
          @retry="agents.refresh()"
        />
        <p v-if="agents.data.value?.length === 0" class="empty">
          {{ m.noAgents }}
        </p>
        <table v-else-if="agents.data.value" class="console-table">
          <thead>
            <tr>
              <th>{{ m.agent }}</th>
              <th>{{ m.model }}</th>
              <th>{{ m.login }}</th>
              <th>{{ m.inUse }}</th>
              <th>{{ m.tasksToday }}</th>
              <th>{{ m.failedToday }}</th>
              <th>{{ m.lastActivity }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in agents.data.value" :key="row.id">
              <td class="primary-cell">
                <strong>{{ row.id }}</strong>
                <Tag
                  v-if="row.isDefault"
                  :value="m.default"
                  severity="secondary"
                /><small>{{ row.implementation }}</small>
              </td>
              <td :data-label="m.model">
                <code>{{ row.model ?? '—' }}</code>
              </td>
              <td :data-label="m.login">
                <StateTag
                  :status="
                    row.state === 'ready'
                      ? row.active
                        ? 'running'
                        : 'idle'
                      : row.state
                  "
                  :label="row.active ? m.running + ' ' + row.active : undefined"
                />
                <small>{{
                  row.login === 'signed-in'
                    ? m.signedIn
                    : row.login === 'required'
                      ? m.loginRequired
                      : m.unknown
                }}</small>
              </td>
              <td :data-label="m.inUse">
                <NuxtLink
                  class="section-link"
                  :to="{ path: '/', query: { agent: row.id }, hash: '#chats' }"
                  >{{ m.usingChats(number(row.chats)) }}</NuxtLink
                >
              </td>
              <td :data-label="m.tasksToday">{{ number(row.tasksToday) }}</td>
              <td
                :data-label="m.failedToday"
                :class="{ 'error-text': row.failedToday }"
              >
                {{ number(row.failedToday) }}
              </td>
              <td :data-label="m.lastActivity">
                <ConsoleTime :at="row.lastActivity" />
                <details v-if="row.recent.length" class="agent-recent">
                  <summary>{{ m.recentTasks }}</summary>
                  <NuxtLink
                    v-for="task in row.recent"
                    :key="task.id"
                    class="section-link"
                    :to="taskHref(task.id)"
                    >{{ task.chatTitle }} ·
                    {{
                      task.durationMs == null
                        ? '—'
                        : duration(task.durationMs, locale)
                    }}</NuxtLink
                  >
                </details>
              </td>
            </tr>
          </tbody>
        </table>
      </ConsolePanel>
      <ConsolePanel :title="t('Recent tasks', '最近任務')" :icon="ListTodo">
        <template #actions
          ><NuxtLink to="/tasks" class="section-link"
            >{{ t('All tasks', '全部任務') }} →</NuxtLink
          ></template
        >
        <LoadState
          v-if="!recent.data.value || recent.error.value"
          :pending="recent.pending.value"
          :error="recent.error.value"
          @retry="recent.refresh()"
        />
        <p v-if="recent.data.value?.tasks.length === 0" class="empty">
          {{ t('No tasks yet.', '尚無任務。') }}
        </p>
        <table v-else-if="recent.data.value" class="console-table recent-table">
          <thead>
            <tr>
              <th>{{ t('Status', '狀態') }}</th>
              <th>{{ m.chat }}</th>
              <th>{{ m.agent }}</th>
              <th>{{ m.timing }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="task in recent.data.value.tasks" :key="task.id">
              <td class="primary-cell">
                <NuxtLink
                  :to="taskHref(task.id)"
                  :aria-label="m.task + ' ' + task.id"
                  ><StateTag
                    :status="task.silent ? 'idle' : task.status"
                    :label="task.silent ? m.silent : undefined"
                /></NuxtLink>
              </td>
              <td :data-label="m.chat">
                <NuxtLink :to="taskHref(task.id)" class="section-link">{{
                  task.chatTitle
                }}</NuxtLink>
              </td>
              <td :data-label="m.agent">{{ task.agentId ?? '—' }}</td>
              <td :data-label="m.timing">
                {{
                  taskDuration(task, now) == null
                    ? '—'
                    : duration(taskDuration(task, now)!, locale)
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </ConsolePanel>
    </div>

    <ConsolePanel id="chats" :title="m.chats" :icon="MessagesSquare">
      <template #actions>
        <div class="toolbar">
          <InputText
            v-model="search"
            type="search"
            :placeholder="m.searchChats"
            :aria-label="m.searchChats"
          />
          <select v-model="platform" :aria-label="t('Platform', '平台')">
            <option value="">{{ t('All platforms', '所有平台') }}</option>
            <option v-for="item in platforms" :key="item">{{ item }}</option>
          </select>
          <select
            :value="agent"
            :aria-label="m.agent"
            @change="
              navigateTo({
                path: '/',
                query: {
                  agent:
                    ($event.target as HTMLSelectElement).value || undefined,
                },
                hash: '#chats',
              })
            "
          >
            <option value="">{{ t('All agents', '所有代理') }}</option>
            <option v-for="row in agents.data.value ?? []" :key="row.id">
              {{ row.id }}
            </option>
          </select>
        </div>
      </template>
      <p v-if="chats.length === 0" class="empty">
        {{ search || platform || agent ? m.noMatchingChats : m.noChats }}
      </p>
      <table v-else class="console-table">
        <thead>
          <tr>
            <th>{{ t('Platform', '平台') }}</th>
            <th>{{ m.chat }}</th>
            <th>{{ t('Latest message', '最新訊息') }}</th>
            <th>{{ m.agent }}</th>
            <th>
              <button
                class="text-button"
                @click="order = order === 'messages' ? 'activity' : 'messages'"
              >
                {{ m.messages }} ↕
              </button>
            </th>
            <th>{{ m.summary }}</th>
            <th>{{ m.pending }}</th>
            <th>{{ m.lastActivity }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="chat in displayed" :key="chatKey(chat)">
            <td :data-label="t('Platform', '平台')">
              <span
                class="activity-dot"
                :class="'dot-' + statusStyle(chat.lastTaskStatus)[0]"
              ></span>
              <PlatformTag :platform="chat.platform" />
            </td>
            <td class="primary-cell">
              <NuxtLink class="section-link" :to="chatHref(chat)">{{
                chatTitle(chat)
              }}</NuxtLink>
              <small
                >{{ chat.chatId }}
                <template v-if="chat.threadId"
                  >· {{ m.topic }} {{ chat.threadId }}</template
                ></small
              >
            </td>
            <td :data-label="t('Latest message', '最新訊息')">
              {{
                chat.preview
                  ? [chat.preview.sender, chat.preview.text]
                      .filter(Boolean)
                      .join(' · ')
                  : '—'
              }}<small v-if="chat.currentTool"
                ><code>{{ chat.currentTool }}…</code></small
              >
            </td>
            <td :data-label="m.agent">{{ routeLabel(chat.route, locale) }}</td>
            <td :data-label="m.messages">{{ number(chat.messageCount) }}</td>
            <td :data-label="m.summary">
              {{ summaryProgress(chat) || m.noSummary }}
              <small v-if="chat.summary"
                ><ConsoleTime :at="chat.summary.updatedAt"
              /></small>
            </td>
            <td :data-label="m.pending">
              <NuxtLink v-if="chat.pendingApprovals" to="/ops#pending"
                ><Badge
                  :value="chat.pendingApprovals"
                  severity="warn" /></NuxtLink
              ><template v-else>—</template>
            </td>
            <td :data-label="m.lastActivity">
              <ConsoleTime :at="chat.lastActivity" />
            </td>
          </tr>
        </tbody>
      </table>
      <footer v-if="chats.length" class="table-footer">
        <span class="muted"
          >{{
            order === 'activity'
              ? m.sort
              : t('Sorted by message count', '依訊息數排序')
          }}
          · {{ page * perPage + 1 }}–{{
            Math.min((page + 1) * perPage, chats.length)
          }}
          / {{ chats.length
          }}<template v-if="data.totals.chats > data.chats.length">
            ({{
              m.limited(number(data.chats.length), number(data.totals.chats))
            }})</template
          ></span
        >
        <div class="inline">
          <Button
            outlined
            size="small"
            :aria-label="t('Previous page', '上一頁')"
            :disabled="page === 0"
            @click="page--"
            >‹</Button
          ><Button
            outlined
            size="small"
            :aria-label="t('Next page', '下一頁')"
            :disabled="!((page + 1) * perPage < chats.length)"
            @click="page++"
            >›</Button
          >
        </div>
      </footer>
    </ConsolePanel>
  </template>
</template>
