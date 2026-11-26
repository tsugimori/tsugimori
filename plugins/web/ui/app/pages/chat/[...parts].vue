<script setup lang="ts">
import type {
  AdminChat,
  AdminConversation,
  AdminTask,
} from '@tsugimori/plugin-sdk';

import {
  ArrowDown,
  ArrowUp,
  ListTodo,
  MessageCircle,
  MessagesSquare,
  PanelRight,
} from '@lucide/vue';

import { ApiError, chatApi, fetchData } from '../../lib/api.ts';
import { chatHref, chatKey, chatTitle } from '../../lib/display.ts';
import { formatTime, number } from '../../lib/format.ts';

type Message = AdminConversation['messages'][number];
const route = useRoute();
const { m, t, workspace } = useConsole();
const chatDrawer = ref(false);
const detailDrawer = ref(false);
const showSidebar = ref(true);
const wide = ref(false);
let screen: MediaQueryList | undefined;
const syncWidth = () => {
  wide.value = Boolean(screen?.matches);
  if (wide.value) detailDrawer.value = false;
};
function toggleDetails() {
  if (!wide.value) {
    detailDrawer.value = true;
    return;
  }
  showSidebar.value = !showSidebar.value;
  try {
    localStorage.setItem(
      'tsugimori.details',
      showSidebar.value ? 'open' : 'closed',
    );
  } catch {
    // The visible state still works when storage is restricted.
  }
}
onMounted(() => {
  screen = window.matchMedia('(min-width: 1060px)');
  screen.addEventListener('change', syncWidth);
  syncWidth();
  try {
    showSidebar.value = localStorage.getItem('tsugimori.details') !== 'closed';
  } catch {
    // Use the default layout when storage is restricted.
  }
  window.addEventListener('keydown', jumpToLatest);
});
function jumpToLatest(event: KeyboardEvent) {
  if (
    !stream.value ||
    tab.value !== 'messages' ||
    chatDrawer.value ||
    detailDrawer.value ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    (event.target instanceof HTMLElement &&
      (event.target.isContentEditable ||
        event.target.closest('input, textarea, select, [role="textbox"]')))
  )
    return;
  if (event.key === 'End' || event.key.toLowerCase() === 'g') {
    event.preventDefault();
    bottom();
  }
}
const search = ref('');
const tab = ref<'messages' | 'tasks'>('messages');
const stream = ref<HTMLElement>();
const newest = ref<HTMLElement>();
const newItems = ref(0);
const manualOpen = ref(false);
const earlier = shallowRef<AdminConversation[]>([]);
const overflow = shallowRef<AdminConversation[]>([]);
const olderError = ref<string>();
const loadingOlder = ref(false);
let pageRequest: AbortController | undefined;
let jumping = false;
let positioned = false;
const parts = computed(() =>
  Array.isArray(route.params.parts) ? route.params.parts : [route.params.parts],
);
const refKey = computed(() => JSON.stringify(parts.value.slice(0, 2)));
const selected = computed(() => {
  const [adapterId, chatId] = parts.value;
  return adapterId && chatId ? { adapterId, chatId } : undefined;
});
const before = computed(() =>
  typeof route.query.before === 'string' &&
  /^\d+$/.test(route.query.before) &&
  Number(route.query.before) > 0
    ? Number(route.query.before)
    : undefined,
);
const {
  data: rooms,
  pending: roomsPending,
  error: roomsError,
  refresh: reloadRooms,
} = useConsoleQuery<readonly AdminChat[]>(
  () => 'chats',
  ({ kind }) =>
    ['chat', 'summary', 'task', 'message', 'approval', 'tool'].includes(kind),
);
const { data, error, pending, refresh } = useConsoleQuery<AdminConversation>(
  () => (selected.value ? chatApi(selected.value, before.value) : undefined),
  (event): boolean =>
    'adapterId' in event
      ? [selected.value, data.value?.chat].some(
          (ref) => ref && chatKey(ref) === chatKey(event),
        )
      : event.kind === 'schedule' ||
        (event.kind === 'tool' &&
          Boolean(data.value?.tasks.some(({ id }) => id === event.taskId))),
);
const chat = computed(() => data.value?.chat);
const older = computed(() =>
  earlier.value.length
    ? earlier.value.at(-1)?.older
    : (overflow.value[0]?.older ?? data.value?.older),
);
const display = computed(() => {
  const messages = new Map<number, Message>();
  const tasks = new Map<string, AdminTask>();
  for (const page of [
    ...earlier.value,
    ...overflow.value,
    ...(data.value ? [data.value] : []),
  ]) {
    for (const message of page.messages) messages.set(message.seq, message);
    for (const task of page.tasks) tasks.set(task.id, task);
  }
  return { messages: [...messages.values()], tasks: [...tasks.values()] };
});
const tasks = computed(() =>
  [...display.value.tasks].sort((a, b) => b.createdAt - a.createdAt),
);
const timeline = computed(() => {
  const sources = new Map<number, AdminTask[]>();
  const replies = new Map<string, Message[]>();
  const seqs = new Set(display.value.messages.map(({ seq }) => seq));
  const turns = tasks.value
    .filter((task) => task.startedAt !== null && !task.silent)
    .sort((a, b) => b.startedAt! - a.startedAt!);
  const items: {
    at: number | null;
    key: string;
    message?: Message;
    tasks: AdminTask[];
  }[] = [];
  for (const task of tasks.value) {
    if (task.sourceSeq != null && seqs.has(task.sourceSeq)) {
      const group = sources.get(task.sourceSeq) ?? [];
      group.unshift(task);
      sources.set(task.sourceSeq, group);
    } else
      items.push({
        at: task.startedAt ?? task.createdAt,
        tasks: [task],
        key: 'task-' + task.id,
      });
  }
  let lastTime: number | null = null;
  for (const message of [...display.value.messages].sort(
    (a, b) => a.seq - b.seq,
  )) {
    lastTime = message.recordedAt ?? lastTime;
    const at = message.recordedAt;
    const turn =
      message.direction === 'outbound' && at !== null
        ? turns.find(
            (task) =>
              at >= task.startedAt! && at <= (task.finishedAt ?? Infinity),
          )
        : undefined;
    if (turn) {
      const group = replies.get(turn.id) ?? [];
      group.push(message);
      replies.set(turn.id, group);
    }
    const related = sources.get(message.seq) ?? [];
    if (!turn || related.length)
      items.push({
        at: lastTime,
        message: turn ? undefined : message,
        tasks: related,
        key: 'msg-' + message.seq,
      });
  }
  let lastDay = '';
  return {
    replies,
    items: items
      .sort(
        (a, b) =>
          (a.at ?? -Infinity) - (b.at ?? -Infinity) ||
          (a.message?.seq ?? Infinity) - (b.message?.seq ?? Infinity),
      )
      .map((item) => {
        const day =
          item.at === null
            ? ''
            : formatTime(item.at, workspace.value.timezone).slice(0, 10);
        const separator = day !== lastDay ? day : '';
        lastDay = day;
        return { ...item, separator };
      }),
  };
});
const filteredTasks = computed(() => ({
  path: '/tasks',
  query: { chat: chat.value ? chatKey(chat.value) : undefined },
}));
const historyHref = computed(() =>
  chat.value
    ? chatHref(chat.value) +
      '?' +
      new URLSearchParams({
        view: 'history',
        ...(before.value ? { before: String(before.value) } : {}),
      }) +
      '#newest'
    : undefined,
);

function scrollPane() {
  const node = stream.value;
  return node && getComputedStyle(node).overflowY === 'auto' ? node : undefined;
}
function following() {
  const node = scrollPane();
  return node
    ? node.scrollHeight - node.clientHeight - node.scrollTop < 105
    : newest.value
      ? newest.value.getBoundingClientRect().top - window.innerHeight < 105
      : true;
}
function bottom() {
  const node = scrollPane();
  if (node) node.scrollTop = node.scrollHeight;
  else newest.value?.scrollIntoView({ block: 'end' });
  newItems.value = 0;
}
function streamScroll() {
  const node = scrollPane();
  if (!node || jumping || !positioned) return;
  if (following()) newItems.value = 0;
  if (
    manualOpen.value &&
    node.scrollTop < 50 &&
    older.value &&
    !olderError.value
  )
    void loadOlder();
}

async function loadOlder() {
  const cursor = older.value;
  const chatRef = selected.value;
  if (!cursor || !chatRef || loadingOlder.value) return false;
  const node = scrollPane();
  const height = node?.scrollHeight;
  const top = node?.scrollTop;
  const controller = new AbortController();
  pageRequest = controller;
  loadingOlder.value = true;
  olderError.value = undefined;
  try {
    const page = await fetchData<AdminConversation>(
      chatApi(chatRef, cursor),
      controller.signal,
    );
    if (controller.signal.aborted) return false;
    earlier.value = [...earlier.value, page];
    await nextTick();
    if (node && height !== undefined && top !== undefined)
      node.scrollTop = top + node.scrollHeight - height;
    return page.older !== cursor;
  } catch (cause) {
    if (!controller.signal.aborted)
      olderError.value = cause instanceof ApiError ? cause.key : 'internal';
    return false;
  } finally {
    if (!controller.signal.aborted) loadingOlder.value = false;
  }
}

watch(
  [refKey, before],
  () => {
    pageRequest?.abort();
    loadingOlder.value = false;
    olderError.value = undefined;
    earlier.value = [];
    overflow.value = [];
    chatDrawer.value = false;
    detailDrawer.value = false;
    newItems.value = 0;
    tab.value = 'messages';
    positioned = false;
    manualOpen.value = false;
  },
  { flush: 'sync' },
);
watch(data, async (current, previous) => {
  if (!current) return;
  const attached = tab.value === 'messages' && following();
  if (previous && current.chat.chatId === previous.chat.chatId) {
    const currentSeq = new Set(current.messages.map(({ seq }) => seq));
    const currentTasks = new Set(current.tasks.map(({ id }) => id));
    const messages = previous.messages.filter(
      ({ seq }) => !currentSeq.has(seq),
    );
    const archivedTasks = previous.tasks.filter(
      ({ id }) => !currentTasks.has(id),
    );
    if (messages.length || archivedTasks.length)
      overflow.value = [
        ...overflow.value,
        { ...previous, messages, tasks: archivedTasks },
      ];
    if (!attached) {
      const knownMessages = new Set(previous.messages.map(({ seq }) => seq));
      const knownCalls = new Map(
        previous.tasks.map((task) => [
          task.id,
          new Set(task.tools.map(({ seq }) => seq)),
        ]),
      );
      newItems.value += current.messages.filter(
        ({ seq }) => !knownMessages.has(seq),
      ).length;
      for (const task of current.tasks) {
        const prior = knownCalls.get(task.id);
        newItems.value += prior
          ? task.tools.filter(({ seq }) => !prior.has(seq)).length
          : 1;
      }
    }
  }
  await nextTick();
  if (
    (!positioned && !before.value && !route.hash && scrollPane()) ||
    (positioned && attached && previous)
  )
    bottom();
  positioned = true;
});

watch(
  [() => route.hash, () => Boolean(data.value)],
  async ([hash, ready], _, cleanup) => {
    if (!ready || !hash || !import.meta.client) return;
    let cancelled = false;
    let target: HTMLElement | null = null;
    cleanup(() => {
      cancelled = true;
      target?.classList.remove('fragment-target');
    });
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    if (!/^(?:msg-|task-|call-|newest$)/.test(id)) return;
    tab.value = 'messages';
    jumping = true;
    try {
      await nextTick();
      if (id === 'newest') return bottom();
      target = document.getElementById(id);
      while (!target && !cancelled && older.value && (await loadOlder())) {
        target = document.getElementById(id);
        if (
          /^msg-\d+$/.test(id) &&
          display.value.messages.some(({ seq }) => seq <= Number(id.slice(4)))
        )
          break;
      }
      if (!cancelled) {
        if (target && id.startsWith('task-'))
          target
            .querySelector<HTMLButtonElement>(
              '.chat-task-toggle[aria-expanded="false"]',
            )
            ?.click();
        target?.classList.add('fragment-target');
        target?.scrollIntoView({ block: 'nearest' });
      }
    } finally {
      jumping = false;
    }
  },
  { flush: 'post' },
);

function focusTab(value: 'messages' | 'tasks') {
  chooseTab(value);
  void nextTick(() => document.getElementById(value + '-tab')?.focus());
}
function chooseTab(value: 'messages' | 'tasks') {
  tab.value = value;
  if (value === 'messages')
    void nextTick(() => {
      if (scrollPane()) bottom();
    });
}
onBeforeUnmount(() => {
  pageRequest?.abort();
  screen?.removeEventListener('change', syncWidth);
  window.removeEventListener('keydown', jumpToLatest);
});
useHead({
  title: computed(() =>
    chat.value ? m.value.chat + ' · ' + chatTitle(chat.value) : m.value.chats,
  ),
});
</script>

<template>
  <div class="page-head">
    <h1>{{ m.chats }}</h1>
    <div v-if="selected" class="chat-page-actions inline">
      <Button
        class="chat-rooms-button"
        size="small"
        outlined
        :aria-expanded="chatDrawer"
        @click="chatDrawer = true"
        ><MessagesSquare :size="15" />{{ m.chats }}</Button
      >
      <Button
        v-if="chat"
        size="small"
        outlined
        :aria-expanded="wide ? showSidebar : detailDrawer"
        @click="toggleDetails"
        ><PanelRight :size="15" />{{ m.details }}</Button
      >
    </div>
  </div>
  <div
    class="chat-layout"
    :class="{ 'chat-index': !selected, 'chat-sidebar-hidden': !showSidebar }"
  >
    <ConsolePanel class="chat-rooms" :title="m.chats" :icon="MessagesSquare">
      <LoadState
        v-if="!rooms || roomsError"
        :pending="roomsPending"
        :error="roomsError"
        @retry="reloadRooms()"
      />
      <ChatRooms v-if="rooms" v-model="search" :chats="rooms" :current="chat" />
    </ConsolePanel>
    <Drawer
      v-model:visible="chatDrawer"
      :header="m.chats"
      :auto-z-index="false"
    >
      <LoadState
        v-if="!rooms || roomsError"
        :pending="roomsPending"
        :error="roomsError"
        @retry="reloadRooms()"
      />
      <ChatRooms
        v-if="rooms"
        v-model="search"
        :chats="rooms"
        :current="chat"
        @selected="chatDrawer = false"
      />
    </Drawer>
    <Drawer
      v-model:visible="detailDrawer"
      :header="m.details"
      position="right"
      :auto-z-index="false"
    >
      <ChatSummary v-if="data" :data="data" />
    </Drawer>
    <div v-if="!selected" class="chat-picker panel-stack">
      <ConsolePanel :title="m.messages" :icon="MessageCircle"
        ><p class="empty">
          {{
            t(
              'Select a chat to view its messages and tasks.',
              '選擇聊天室以查看訊息與任務。',
            )
          }}
        </p></ConsolePanel
      >
    </div>
    <LoadState
      v-else-if="!data"
      :pending="pending"
      :error="error"
      @retry="refresh()"
    />
    <template v-else>
      <ConsolePanel :title="chatTitle(data.chat)" :icon="MessageCircle">
        <template #actions
          ><PlatformTag :platform="data.chat.platform"
        /></template>
        <p v-if="error" class="detail-inset error-text" role="alert">
          {{ m[error === 'notFound' ? 'notFound' : 'internal'] }}
          <button class="text-button section-link" @click="refresh()">
            {{ m.retry }}
          </button>
        </p>
        <div class="chat-tabs" role="tablist" :aria-label="m.chat">
          <button
            id="messages-tab"
            role="tab"
            aria-controls="chat-messages"
            :aria-selected="tab === 'messages'"
            :tabindex="tab === 'messages' ? 0 : -1"
            @click="chooseTab('messages')"
            @keydown.right.prevent="focusTab('tasks')"
          >
            {{ m.messages }} <small>{{ number(data.chat.messageCount) }}</small>
          </button>
          <button
            id="tasks-tab"
            role="tab"
            aria-controls="chat-tasks"
            :aria-selected="tab === 'tasks'"
            :tabindex="tab === 'tasks' ? 0 : -1"
            @click="chooseTab('tasks')"
            @keydown.left.prevent="focusTab('messages')"
          >
            {{ t('Tasks', '任務') }} <small>{{ tasks.length }}</small>
          </button>
        </div>
        <div
          :hidden="tab !== 'messages'"
          id="chat-messages"
          role="tabpanel"
          aria-labelledby="messages-tab"
        >
          <div class="chat-toolbar">
            <Button
              v-if="older"
              size="small"
              outlined
              :disabled="loadingOlder"
              @click="loadOlder()"
              ><ArrowUp :size="14" />{{ m.older }}</Button
            >
            <small v-else-if="display.messages.length" class="muted">{{
              m.oldest
            }}</small>
          </div>
          <div
            ref="stream"
            class="chat-stream"
            role="region"
            tabindex="0"
            :aria-label="m.messages"
            @scroll.passive="streamScroll"
            @wheel.passive="manualOpen = true"
            @touchmove.passive="manualOpen = true"
            @pointerdown.passive="manualOpen = true"
            @keydown.end.prevent="bottom()"
            @keydown.home.prevent="stream?.scrollTo({ top: 0 })"
          >
            <LoadState
              v-if="olderError"
              :error="olderError"
              @retry="loadOlder()"
            />
            <p v-if="!timeline.items.length" class="empty">
              {{ m.noMessages }}
            </p>
            <template v-for="item in timeline.items" :key="item.key">
              <p v-if="item.separator" class="date-divider">
                {{ item.separator }}
              </p>
              <ChatMessage
                v-if="item.message"
                :message="item.message"
                :chat="data.chat"
              />
              <ChatTask
                v-for="task in item.tasks"
                :key="task.id"
                :task="task"
                :replies="timeline.replies.get(task.id) ?? []"
              />
            </template>
            <div id="newest" ref="newest"></div>
          </div>
          <footer class="table-footer">
            <a v-if="historyHref" :href="historyHref" class="section-link">{{
              t('Plain history', '純文字紀錄')
            }}</a>
            <Button size="small" outlined @click="bottom()"
              ><ArrowDown :size="14" />{{ m.newest
              }}<template v-if="newItems"> ({{ newItems }})</template></Button
            >
          </footer>
        </div>
        <div
          v-if="tab === 'tasks'"
          id="chat-tasks"
          role="tabpanel"
          aria-labelledby="tasks-tab"
        >
          <ChatTaskTable :tasks="tasks" />
          <footer class="table-footer">
            <NuxtLink class="section-link" :to="filteredTasks"
              >{{ t('Filter in Tasks', '在任務頁篩選') }} →</NuxtLink
            >
          </footer>
        </div>
      </ConsolePanel>
      <aside v-if="showSidebar" class="chat-sidebar panel-stack">
        <ConsolePanel :title="m.details" :icon="PanelRight"
          ><ChatSummary :data="data"
        /></ConsolePanel>
        <ConsolePanel
          :title="t('Tasks in this chat', '此聊天室的任務')"
          :icon="ListTodo"
        >
          <ChatTaskTable :tasks="tasks.slice(0, 5)" />
          <footer class="table-footer">
            <NuxtLink class="section-link" :to="filteredTasks"
              >{{ t('Filter in Tasks', '在任務頁篩選') }} →</NuxtLink
            >
          </footer>
        </ConsolePanel>
      </aside>
    </template>
  </div>
</template>
