<script setup lang="ts">
import {
  Activity,
  ClipboardCheck,
  LayoutDashboard,
  ListTodo,
  Menu,
  MessagesSquare,
  Workflow,
} from '@lucide/vue';

import type { AdminWorkspace } from '@tsugimori/plugin-sdk';
import type { ConsoleEvent } from '../composables/useConsole.ts';

import { fetchData } from '../lib/api.ts';

declare global {
  interface Window {
    tsugimoriTheme?: { preference: string; set(value: string): void };
  }
}

const route = useRoute();
const { connection, event, m, now, t, updated, workspace } = useConsole();
const drawer = ref(false);
const theme = ref('system');
const nav = computed(() => [
  { to: '/', label: m.value.overview, icon: LayoutDashboard },
  { to: '/tasks', label: t('Tasks', '任務'), icon: ListTodo },
  { to: '/chat', label: m.value.chats, icon: MessagesSquare },
  {
    to: '/ops',
    label: t('Approvals & schedules', '核准與排程'),
    icon: ClipboardCheck,
  },
]);
const active = (to: string) =>
  to === '/'
    ? route.path === '/'
    : route.path === to ||
      route.path.startsWith(to + '/') ||
      (to === '/tasks' && /^\/task(?:\/|$)/.test(route.path));

const clock = () => {
  now.value = Date.now();
};
let source: EventSource | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let offline: ReturnType<typeof setTimeout> | undefined;
let workspaceRequest: AbortController | undefined;

async function loadWorkspace() {
  workspaceRequest?.abort();
  const controller = new AbortController();
  workspaceRequest = controller;
  try {
    workspace.value = await fetchData<AdminWorkspace>(
      'workspace',
      controller.signal,
    );
  } catch (error) {
    if (!controller.signal.aborted)
      console.warn('Console workspace request failed', error);
  }
}

onMounted(() => {
  theme.value = window.tsugimoriTheme?.preference ?? 'system';
  clock();
  timer = setInterval(clock, 1_000);
  void loadWorkspace();
  source = new EventSource('/api/events');
  source.onopen = () => {
    clearTimeout(offline);
    offline = undefined;
    connection.value = 'live';
  };
  source.onerror = () => {
    if (connection.value !== 'offline') connection.value = 'reconnecting';
    offline ??= setTimeout(() => {
      connection.value = 'offline';
    }, 30_000);
  };
  for (const kind of [
    'ready',
    'reset',
    'message',
    'task',
    'tool',
    'approval',
    'summary',
    'chat',
    'schedule',
  ]) {
    source.addEventListener(kind, (message: MessageEvent<string>) => {
      if (kind !== 'ready') updated.value = Date.now();
      const signal = (
        kind === 'ready' || kind === 'reset'
          ? { kind: 'reset' }
          : { ...JSON.parse(message.data), kind }
      ) as ConsoleEvent;
      event.value = { signal };
      if (signal.kind === 'reset' || signal.kind === 'approval')
        void loadWorkspace();
    });
  }
});
onBeforeUnmount(() => {
  source?.close();
  workspaceRequest?.abort();
  clearInterval(timer);
  clearTimeout(offline);
});
watch(theme, (value) => window.tsugimoriTheme?.set(value));
watch(
  () => route.fullPath,
  () => {
    drawer.value = false;
  },
);
useHead({ htmlAttrs: { lang: computed(() => workspace.value.locale) } });
</script>

<template>
  <header class="topbar">
    <div class="topbar-inner">
      <NuxtLink to="/" class="brand">
        <span class="brand-mark"
          ><Workflow :size="18" aria-hidden="true"
        /></span>
        <strong>tsugimori</strong>
        <span v-if="workspace.name" class="workspace-name">{{
          workspace.name
        }}</span>
      </NuxtLink>
      <nav class="desktop-nav" :aria-label="m.nav">
        <NuxtLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          :aria-current="active(item.to) ? 'page' : undefined"
        >
          <component :is="item.icon" :size="16" aria-hidden="true" />
          {{ item.label }}
          <Badge
            v-if="item.to === '/ops' && workspace.pendingApprovals"
            :value="workspace.pendingApprovals"
            severity="warn"
          />
        </NuxtLink>
      </nav>
      <div class="header-tools">
        <select
          v-model="theme"
          class="theme-select"
          :aria-label="t('Color theme', '色彩主題')"
        >
          <option value="system">{{ t('System', '系統') }}</option>
          <option value="light">{{ t('Light', '淺色') }}</option>
          <option value="dark">{{ t('Dark', '深色') }}</option>
        </select>
        <span
          class="connection"
          :class="connection"
          :title="
            updated
              ? new Date(updated).toLocaleTimeString(workspace.locale, {
                  timeZone: workspace.timezone,
                })
              : undefined
          "
        >
          <Activity :size="15" aria-hidden="true" />{{ m[connection] }}
        </span>
        <Button
          class="mobile-nav"
          text
          :aria-label="m.nav"
          :aria-expanded="drawer"
          @click="drawer = true"
          ><Menu :size="20"
        /></Button>
      </div>
    </div>
  </header>
  <Drawer v-model:visible="drawer" :header="m.nav" :auto-z-index="false">
    <nav class="drawer-nav" :aria-label="m.nav">
      <NuxtLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        :aria-current="active(item.to) ? 'page' : undefined"
        @click="drawer = false"
      >
        <component :is="item.icon" :size="18" aria-hidden="true" />
        {{ item.label }}
        <Badge
          v-if="item.to === '/ops' && workspace.pendingApprovals"
          :value="workspace.pendingApprovals"
          severity="warn"
        />
      </NuxtLink>
    </nav>
  </Drawer>
  <main class="wrap"><slot /></main>
</template>
