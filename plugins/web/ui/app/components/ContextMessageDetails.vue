<script setup lang="ts">
import type { ContextMessage } from '@tsugimori/plugin-sdk';

const props = defineProps<{ message: ContextMessage }>();
const { locale, t } = useConsole();
const showJson = ref(false);
const byteFormat = computed(() => new Intl.NumberFormat(locale.value));
const replyQuote = computed(() => {
  const reply = props.message.replyTo;
  const quote = (reply?.quote || reply?.text)?.replace(/\s+/g, ' ').trim();
  return quote && quote.length > 120 ? quote.slice(0, 117) + '…' : quote;
});
const sections = computed(() =>
  [props.message, props.message.replyTo].filter((part) => part !== undefined),
);
</script>

<template>
  <div class="message-details">
    <div v-for="(part, index) in sections" :key="index" class="message-part">
      <div v-if="index === 1">
        <strong>{{ t('Reply to', '回覆對象') }}</strong>
        <code>{{ part.id }}</code>
        <q v-if="replyQuote">{{ replyQuote }}</q>
      </div>
      <div v-if="part.albumId">
        <strong>{{ t('Album', '相簿') }}</strong>
        <code>{{ part.albumId }}</code>
      </div>
      <ul v-if="part.attachments.length" class="attachments">
        <li v-for="attachment in part.attachments" :key="attachment.index">
          <div class="attachment-fields">
            <strong>{{ attachment.kind }}</strong>
            <span v-if="attachment.name">{{ attachment.name }}</span>
            <code v-if="attachment.mime">{{ attachment.mime }}</code>
            <span v-if="attachment.size != null"
              >{{ byteFormat.format(attachment.size) }} B</span
            >
            <span v-if="attachment.set"
              >{{ t('Set', '貼圖組') }} <code>{{ attachment.set }}</code></span
            >
            <span v-if="attachment.stickerId"
              >ID <code>{{ attachment.stickerId }}</code></span
            >
            <code v-if="attachment.stickerFormat">{{
              attachment.stickerFormat
            }}</code>
            <span v-if="attachment.emoji">{{ attachment.emoji }}</span>
          </div>
          <div v-if="attachment.keywords?.length" class="keywords">
            <strong>{{ t('Keywords', '關鍵字') }}</strong>
            {{ attachment.keywords.join(' · ') }}
          </div>
        </li>
      </ul>
    </div>
    <button
      type="button"
      class="text-button"
      :aria-expanded="showJson"
      @click="showJson = !showJson"
    >
      {{ t('Message metadata JSON', '訊息中繼資料 JSON') }}
    </button>
    <CodeInspector
      v-if="showJson"
      :label="t('Message metadata', '訊息中繼資料')"
      :text="JSON.stringify(message, null, 2)"
    />
  </div>
</template>

<style scoped>
.message-details {
  min-width: 0;
  margin: 0 10px 10px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.message-part > div,
.keywords {
  color: var(--muted);
}
.message-part strong,
.message-part > div code {
  margin-inline-end: 4px;
}
.message-part strong {
  color: var(--ink);
}
.attachments {
  list-style: none;
  margin: 4px 0;
  padding: 0;
}
.attachments li {
  border-inline-start: 2px solid var(--line);
  padding-inline-start: 8px;
  margin-block: 4px;
}
.attachment-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
}
.attachment-fields > * {
  min-width: 0;
}
</style>
