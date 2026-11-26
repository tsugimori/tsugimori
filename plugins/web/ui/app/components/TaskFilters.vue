<script setup lang="ts">
import type { AdminChat } from '@tsugimori/plugin-sdk';

import { chatKey, chatTitle, platformLabel } from '../lib/display.ts';

const props = defineProps<{
  agents: readonly string[];
  chats: readonly AdminChat[];
}>();
const filters = defineModel<{
  agent: string;
  before: string;
  chat: string;
  platform: string;
  q: string;
  since: string;
  status: string;
}>({ required: true });
defineEmits<{ apply: []; clear: [] }>();
const { m, t } = useConsole();
const platforms = computed(() => [
  ...new Set(props.chats.map((chat) => chat.platform)),
]);
const statuses = computed(() => [
  { value: 'queued', label: m.value.queued },
  { value: 'running', label: m.value.running },
  { value: 'sending', label: t('Sending', '傳送中') },
  { value: 'completed', label: m.value.done },
  { value: 'sent', label: t('Sent', '已傳送') },
  { value: 'failed', label: m.value.failed },
  { value: 'delivery-unknown', label: t('Delivery unknown', '傳送狀態不明') },
  { value: 'cancelled', label: m.value.cancelled },
]);
</script>

<template>
  <form class="task-filters" @submit.prevent="$emit('apply')">
    <label
      >{{ t('Trigger text', '觸發訊息')
      }}<InputText
        v-model="filters.q"
        type="search"
        maxlength="500"
        :placeholder="t('Search messages', '搜尋訊息內容')"
    /></label>
    <label
      >{{ t('Status', '狀態')
      }}<select v-model="filters.status">
        <option value="">{{ t('All', '全部') }}</option>
        <option
          v-for="status in statuses"
          :key="status.value"
          :value="status.value"
        >
          {{ status.label }}
        </option>
      </select></label
    >
    <label
      >{{ m.agent
      }}<select v-model="filters.agent">
        <option value="">{{ t('All', '全部') }}</option>
        <option v-if="filters.agent && !agents.includes(filters.agent)">
          {{ filters.agent }}
        </option>
        <option v-for="item in agents" :key="item">{{ item }}</option>
      </select></label
    >
    <label
      >{{ t('Platform', '平台')
      }}<select v-model="filters.platform">
        <option value="">{{ t('All', '全部') }}</option>
        <option
          v-if="filters.platform && !platforms.includes(filters.platform)"
        >
          {{ filters.platform }}
        </option>
        <option v-for="item in platforms" :key="item" :value="item">
          {{ platformLabel(item) }}
        </option>
      </select></label
    >
    <label
      >{{ m.chat
      }}<select v-model="filters.chat">
        <option value="">{{ t('All', '全部') }}</option>
        <option
          v-if="
            filters.chat &&
            !chats.some((chat) => chatKey(chat) === filters.chat)
          "
        >
          {{ filters.chat }}
        </option>
        <option
          v-for="item in chats"
          :key="chatKey(item)"
          :value="chatKey(item)"
        >
          {{ chatTitle(item) }}
        </option>
      </select></label
    >
    <label
      >{{ t('Since (UTC)', '起始日期（UTC）')
      }}<input v-model="filters.since" type="date"
    /></label>
    <label
      >{{ t('Before (UTC)', '截止日期（UTC）')
      }}<input v-model="filters.before" type="date"
    /></label>
    <div class="inline filter-buttons">
      <Button type="submit" :label="t('Apply', '套用')" size="small" />
      <Button
        type="button"
        outlined
        :label="t('Clear', '清除')"
        size="small"
        @click="$emit('clear')"
      />
    </div>
  </form>
</template>
