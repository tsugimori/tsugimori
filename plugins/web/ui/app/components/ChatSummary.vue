<script setup lang="ts">
import type { AdminConversation } from '@tsugimori/plugin-sdk';

import { Bot } from '@lucide/vue';

import { number } from '../lib/format.ts';
import { summaryProgress } from '../lib/display.ts';

const props = defineProps<{ data: AdminConversation }>();
const { m, t, workspace } = useConsole();
const chat = computed(() => props.data.chat);
const fraction = computed(() =>
  chat.value.summary && chat.value.latestSeq > 0
    ? Math.min(
        100,
        Math.floor(
          (chat.value.summary.throughSeq * 100) / chat.value.latestSeq,
        ),
      )
    : 0,
);
const pending = computed(
  () =>
    props.data.approvals?.filter(({ status }) => status === 'pending') ?? [],
);
</script>

<template>
  <div class="summary-group">
    <h3>{{ m.agent }}</h3>
    <p class="inline">
      <Bot :size="14" /><strong>{{ chat.route.agentId ?? '—' }}</strong>
      <code>{{ chat.route.model }}</code>
    </p>
    <p class="muted">
      <template v-if="chat.route.thinking"
        >{{ m.thinking }}
        {{
          {
            none: m.off,
            minimal: m.minimal,
            low: m.low,
            medium: m.medium,
            high: m.high,
            xhigh: m.xhigh,
            max: m.max,
          }[chat.route.thinking] ?? chat.route.thinking
        }}</template
      >
      <template v-if="chat.route.serviceTier">
        · {{ m.fastMode }}
        {{
          ['fast', 'priority'].includes(chat.route.serviceTier)
            ? m.enabled
            : m.off
        }}</template
      >
    </p>
  </div>
  <div class="summary-group">
    <h3>{{ m.summary }}</h3>
    <template v-if="chat.summary">
      <div class="split-line">
        <strong>{{ summaryProgress(chat) }}</strong><small class="muted"
          ><ConsoleTime :at="chat.summary.updatedAt"
        /></small>
      </div>
      <progress :value="fraction" max="100" :aria-label="m.summary" />
      <small class="muted">{{ t('Coverage', '涵蓋') }} {{ fraction }}%</small>
    </template>
    <p v-else class="muted">{{ m.noSummary }}</p>
  </div>
  <div class="summary-group">
    <h3>
      {{ m.pending }} <Badge :value="chat.pendingApprovals" severity="warn" />
    </h3>
    <p v-if="!pending.length" class="muted">{{ m.noPending }}</p>
    <p v-for="approval in pending" :key="approval.id">
      <NuxtLink
        class="section-link"
        :to="{
          path: '/ops',
          hash: '#approval-' + encodeURIComponent(approval.id),
        }"
        ><code>{{ approval.action }}</code> →</NuxtLink
      >
      · <ConsoleTime :at="approval.requestedAt" />
    </p>
  </div>
  <div v-if="workspace.schedules" class="summary-group">
    <h3>{{ m.schedules }} ({{ data.schedules?.length ?? 0 }})</h3>
    <p v-for="schedule in data.schedules" :key="schedule.id">
      <NuxtLink
        class="section-link"
        :to="{
          path: '/ops',
          hash: '#schedule-' + encodeURIComponent(schedule.id),
        }"
        >{{ schedule.title }} →</NuxtLink
      >
      <small class="muted"
        >{{ m.nextRun }}
        <ConsoleTime :at="schedule.nextDueAt" format="absolute"
      /></small>
    </p>
    <p v-if="!data.schedules?.length" class="muted">{{ m.noSchedules }}</p>
  </div>
  <div class="summary-group">
    <h3>{{ m.chat }}</h3>
    <p>
      ID <code>{{ chat.chatId }}</code><template v-if="chat.threadId">
        · {{ m.topic }} {{ chat.threadId }}</template
      >
    </p>
    <p class="muted">
      {{ m.allowlist }} {{ chat.allowlisted ? m.yes : m.no }} · {{ m.messages }}
      {{ number(chat.messageCount) }}
    </p>
  </div>
</template>
