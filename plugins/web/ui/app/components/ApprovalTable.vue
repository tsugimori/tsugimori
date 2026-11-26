<script setup lang="ts">
import type { AdminApprovals } from '@tsugimori/plugin-sdk';

import { chatHref, chatTitle } from '../lib/display.ts';

defineProps<{ approvals: AdminApprovals['approvals']; pending?: boolean }>();
const { m, t } = useConsole();
</script>

<template>
  <p v-if="!approvals.length" class="empty">
    {{ pending ? m.noPending : m.noRecent }}
  </p>
  <table v-else class="console-table approval-table">
    <thead>
      <tr>
        <th>{{ t('Action', '動作') }}</th>
        <th v-if="pending">{{ m.scope }}</th>
        <th>{{ m.chat }}</th>
        <th>{{ m.requester }}</th>
        <th>{{ t('Requested', '申請時間') }}</th>
        <th>{{ t('Status', '狀態') }}</th>
        <th>{{ pending ? m.args : m.decidedBy }}</th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="approval in approvals"
        :id="'approval-' + approval.id"
        :key="approval.id"
      >
        <td class="primary-cell">
          <strong
            ><code>{{ approval.action }}</code></strong
          ><small v-if="approval.failureReason" class="error-text">{{
            approval.failureReason
          }}</small>
        </td>
        <td v-if="pending" :data-label="m.scope">
          <code class="scope-code">{{
            JSON.stringify(approval.resource)
          }}</code>
        </td>
        <td :data-label="m.chat">
          <PlatformTag
            v-if="pending && approval.chat"
            :platform="approval.chat.platform"
          />
          <NuxtLink
            :to="chatHref(approval.chat ?? approval)"
            class="section-link"
            >{{
              approval.chat ? chatTitle(approval.chat) : approval.chatId
            }}</NuxtLink
          >
        </td>
        <td :data-label="m.requester">
          {{ approval.requesterDisplay || approval.requester
          }}<small v-if="approval.requesterDisplay">{{
            approval.requester
          }}</small>
        </td>
        <td :data-label="t('Requested', '申請時間')">
          <ConsoleTime :at="approval.requestedAt" format="absolute" />
        </td>
        <td :data-label="t('Status', '狀態')">
          <StateTag :status="approval.status" />
        </td>
        <td :data-label="pending ? m.args : m.decidedBy">
          <template v-if="!pending"
            >{{ approval.decidedBy ?? '—'
            }}<small
              ><ConsoleTime :at="approval.decidedAt" format="absolute" /></small
          ></template>
          <details v-if="approval.args != null" :open="pending">
            <summary class="section-link">{{ m.args }}</summary>
            <pre class="code-block approval-args">{{ approval.args }}</pre>
          </details>
          <template v-else-if="pending">—</template>
        </td>
      </tr>
    </tbody>
  </table>
</template>
