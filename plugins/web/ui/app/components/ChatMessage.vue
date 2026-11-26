<script setup lang="ts">
import type { AdminConversation, ChatRef } from '@tsugimori/plugin-sdk';

import { Bot, UserRound } from '@lucide/vue';

const props = defineProps<{
  message: AdminConversation['messages'][number];
  chat: ChatRef;
}>();
const { m } = useConsole();
const rawOpen = ref(false);
const raw = useConsoleQuery<unknown>(
  () =>
    rawOpen.value
      ? 'message-raw?' +
        new URLSearchParams({
          adapter: props.message.adapterId ?? props.chat.adapterId,
          chat: props.message.chatId ?? props.chat.chatId,
          seq: String(props.message.seq),
        })
      : undefined,
  (event) => event.kind === 'message' && event.seq === props.message.seq,
);
const lines = computed(() => props.message.text.split('\n'));
const excerpt = computed(() =>
  lines.value.slice(0, 20).join('\n').slice(0, 1500),
);
const rest = computed(() => props.message.text.slice(excerpt.value.length));
const outgoing = computed(() => props.message.direction === 'outbound');
</script>

<template>
  <article
    :id="'msg-' + message.seq"
    class="chat-message"
    :class="{ outgoing }"
  >
    <span class="message-avatar"
      ><component
        :is="outgoing ? Bot : UserRound"
        :size="15"
        aria-hidden="true"
    /></span>
    <div class="message-content">
      <div class="message-byline">
        <strong>{{
          outgoing ? m.bot : message.displayName || message.userId || m.unknown
        }}</strong>
        <small
          v-if="!outgoing && message.displayName && message.userId"
          class="muted"
          >{{ message.userId }}</small
        >
        <ConsoleTime :at="message.recordedAt" format="clock" />
      </div>
      <div class="bubble">
        <template v-if="message.deleted">{{ m.deleted }}</template><template
          v-else-if="!message.text"
          >{{ m.attachment }}</template
        ><template v-else
          >{{ excerpt }}
          <details v-if="rest">
            <summary class="section-link">
              {{ m.more(String(lines.length)) }}
            </summary>
            {{ rest }}
          </details></template
        >
      </div>
      <div class="message-labels">
        <Tag
          v-if="message.trigger"
          :value="message.trigger.reason"
          severity="secondary"
        />
        <button
          type="button"
          class="section-link text-button"
          :aria-expanded="rawOpen"
          @click="rawOpen = !rawOpen"
        >
          {{ m.raw }}
        </button>
      </div>
      <template v-if="rawOpen">
        <LoadState
          v-if="raw.data.value === undefined"
          :pending="raw.pending.value"
          :error="raw.error.value"
          @retry="raw.refresh()"
        />
        <p v-else-if="raw.data.value === null" class="muted">
          {{ m.unavailable }}
        </p>
        <CodeInspector
          v-else
          :label="m.raw"
          :text="JSON.stringify(raw.data.value, null, 2)"
        />
      </template>
    </div>
  </article>
</template>
