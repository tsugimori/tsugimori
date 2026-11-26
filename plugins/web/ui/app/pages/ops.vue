<script setup lang="ts">
import type {
  AdminApprovals,
  AdminChat,
  AdminSchedules,
} from '@tsugimori/plugin-sdk';

import {
  CalendarClock,
  Clock3,
  History,
  LockKeyhole,
  ShieldCheck,
} from '@lucide/vue';

import { chatHref, chatKey, chatTitle } from '../lib/display.ts';

const { m, t, workspace } = useConsole();
const requests = useConsoleQuery<AdminApprovals>(
  () => 'approvals?recent=50',
  ({ kind }) => kind === 'approval',
);
const schedules = useConsoleQuery<AdminSchedules>(
  () => (workspace.value.schedules ? 'schedules' : undefined),
  ({ kind }) => kind === 'schedule',
);
const { data: rooms } = useConsoleQuery<readonly AdminChat[]>(() => 'chats');
const approvals = computed(
  () =>
    requests.data.value?.approvals.filter(
      ({ status }) => status === 'pending',
    ) ?? [],
);
const recent = computed(
  () =>
    requests.data.value?.approvals.filter(
      ({ status }) => status !== 'pending',
    ) ?? [],
);
const chats = computed(
  () => new Map(rooms.value?.map((chat) => [chatKey(chat), chat])),
);
const title = computed(() => t('Approvals & schedules', '核准與排程'));
const grants = computed(() => requests.data.value?.grants ?? []);
useHead({ title });
useFragment(
  () =>
    Boolean(requests.data.value) &&
    (!workspace.value.schedules || Boolean(schedules.data.value)),
);
</script>

<template>
  <div class="page-head ops-head">
    <div>
      <h1>{{ title }}</h1>
      <p class="muted">
        <LockKeyhole :size="14" />{{
          t(
            'Read only. Handle approvals in the chat.',
            '唯讀，請在聊天室內處理核准。',
          )
        }}
      </p>
    </div>
    <nav class="jump-links" :aria-label="title">
      <a href="#pending">{{ m.pending }}</a><a href="#recent">{{ m.recent }}</a
      ><a href="#grants">{{ m.grants }}</a
      ><a v-if="workspace.schedules" href="#schedules">{{ m.schedules }}</a>
    </nav>
  </div>
  <div class="panel-stack">
    <LoadState
      v-if="!requests.data.value || requests.error.value"
      :pending="requests.pending.value"
      :error="requests.error.value"
      @retry="requests.refresh()"
    />
    <ConsolePanel
      v-if="requests.data.value"
      id="pending"
      :title="m.pending"
      :icon="Clock3"
    >
      <template #actions
        ><Tag
          v-if="approvals.length"
          class="state-tag state-warn"
          :value="m.pendingCount(String(approvals.length))"
      /></template>
      <ApprovalTable :approvals="approvals" pending />
    </ConsolePanel>
    <div class="ops-split" :class="{ 'ops-full': !workspace.schedules }">
      <ConsolePanel
        v-if="requests.data.value"
        id="recent"
        :title="m.recent"
        :icon="History"
        :subtitle="t('Latest 50', '最近 50 筆')"
      >
        <ApprovalTable :approvals="recent" />
      </ConsolePanel>
      <ConsolePanel
        v-if="workspace.schedules"
        id="schedules"
        :title="m.schedules"
        :icon="CalendarClock"
      >
        <LoadState
          v-if="!schedules.data.value || schedules.error.value"
          :pending="schedules.pending.value"
          :error="schedules.error.value"
          @retry="schedules.refresh()"
        />
        <p v-if="schedules.data.value?.schedules.length === 0" class="empty">
          {{ m.noSchedules }}
        </p>
        <table v-else-if="schedules.data.value" class="console-table">
          <thead>
            <tr>
              <th>{{ t('Status', '狀態') }}</th>
              <th>{{ t('Schedule', '內容') }}</th>
              <th>{{ m.chat }}</th>
              <th>{{ m.nextRun }}</th>
              <th>{{ m.lastRun }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="schedule in schedules.data.value.schedules"
              :id="'schedule-' + schedule.id"
              :key="schedule.id"
            >
              <td :data-label="t('Status', '狀態')">
                <StateTag :status="schedule.status" />
              </td>
              <td class="primary-cell">
                <strong>{{ schedule.title }}</strong>
              </td>
              <td :data-label="m.chat">
                <NuxtLink
                  :to="chatHref(schedule.chat ?? schedule)"
                  class="section-link"
                  >{{
                    schedule.chat ? chatTitle(schedule.chat) : schedule.chatId
                  }}</NuxtLink
                >
              </td>
              <td :data-label="m.nextRun">
                <ConsoleTime :at="schedule.nextDueAt" format="absolute" />
              </td>
              <td :data-label="m.lastRun">
                <ConsoleTime :at="schedule.lastRun" format="absolute" />
              </td>
            </tr>
          </tbody>
        </table>
      </ConsolePanel>
    </div>
    <ConsolePanel
      v-if="requests.data.value"
      id="grants"
      :title="m.grants"
      :icon="ShieldCheck"
      :subtitle="String(grants.length)"
    >
      <p v-if="!grants.length" class="empty">{{ m.noGrants }}</p>
      <table v-else class="console-table">
        <thead>
          <tr>
            <th>{{ t('Action', '動作') }}</th>
            <th>{{ m.scope }}</th>
            <th>{{ m.chat }}</th>
            <th>{{ m.grantedBy }}</th>
            <th>{{ m.grantedTo }}</th>
            <th>{{ t('Created', '時間') }}</th>
            <th>{{ t('Type', '類型') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(grant, index) in grants" :key="index">
            <td class="primary-cell">
              <code>{{ grant.action }}</code>
            </td>
            <td :data-label="m.scope">
              <code class="scope-code">{{ JSON.stringify(grant.scope) }}</code>
            </td>
            <td :data-label="m.chat">
              <NuxtLink
                :to="chatHref(chats.get(chatKey(grant)) ?? grant)"
                class="section-link"
                >{{
                  chats.get(chatKey(grant))?.title ?? grant.chatId
                }}</NuxtLink
              >
            </td>
            <td :data-label="m.grantedBy">{{ grant.grantedBy }}</td>
            <td :data-label="m.grantedTo">{{ grant.grantedTo }}</td>
            <td :data-label="t('Created', '時間')">
              <ConsoleTime :at="grant.createdAt" format="absolute" />
            </td>
            <td :data-label="t('Type', '類型')">
              <Tag
                severity="secondary"
                :value="
                  grant.revokedAt != null
                    ? m.revoked
                    : grant.mode === 'always'
                      ? m.always
                      : m.once
                "
              /><small v-if="grant.revokedAt"
                ><ConsoleTime :at="grant.revokedAt" format="absolute"
              /></small>
            </td>
          </tr>
        </tbody>
      </table>
    </ConsolePanel>
  </div>
</template>
