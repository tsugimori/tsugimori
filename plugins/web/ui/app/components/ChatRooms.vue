<script setup lang="ts">
import type { AdminChat } from '@tsugimori/plugin-sdk';

import { chatHref, chatKey, chatTitle, statusStyle } from '../lib/display.ts';

const props = defineProps<{
  chats: readonly AdminChat[];
  current?: AdminChat;
}>();
defineEmits<{ selected: [] }>();
const { m, t } = useConsole();
const search = defineModel<string>({ required: true });
const count = ref(8);
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  return props.chats
    .filter(
      (chat) =>
        !query ||
        [
          chatTitle(chat),
          chat.chatId,
          chat.preview?.sender,
          chat.preview?.text,
        ].some((part) => part?.toLowerCase().includes(query)),
    )
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
});
</script>

<template>
  <div class="room-search">
    <InputText
      v-model="search"
      type="search"
      :aria-label="m.searchChats"
      :placeholder="m.searchChats"
    />
  </div>
  <p v-if="!filtered.length" class="empty">
    {{ search ? m.noMatchingChats : m.noChats }}
  </p>
  <NuxtLink
    v-for="chat in filtered.slice(0, count)"
    :key="chatKey(chat)"
    :to="chatHref(chat)"
    class="room-item"
    :aria-current="
      current && chatKey(current) === chatKey(chat) ? 'page' : undefined
    "
    @click="$emit('selected')"
  >
    <span class="room-item-head">
      <span
        class="activity-dot"
        :class="
          'dot-' +
          (chat.activeTask ? 'run' : statusStyle(chat.lastTaskStatus)[0])
        "
      ></span>
      <strong>{{ chatTitle(chat) }}</strong><small v-if="chat.threadId"
        >{{ m.topic }} {{ chat.threadId }}</small
      >
    </span>
    <span class="room-preview">{{
      chat.preview
        ? [chat.preview.sender || m.bot, chat.preview.text].join(' · ')
        : '—'
    }}</span>
    <span class="room-item-meta"
      ><PlatformTag :platform="chat.platform" /><ConsoleTime
        :at="chat.lastActivity"
    /></span>
  </NuxtLink>
  <div v-if="filtered.length > count" class="room-more">
    <Button text size="small" @click="count += 8"
      >{{ t('Show more chats', '顯示更多聊天室') }} ({{
        filtered.length - count
      }})</Button
    >
  </div>
</template>
