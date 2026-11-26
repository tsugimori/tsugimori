<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';

defineProps<{ pending?: boolean; error?: string }>();
defineEmits<{ retry: [] }>();
const { m, t } = useConsole();
const errors = computed<Record<string, string>>(() => ({
  forbidden: m.value.forbidden,
  notFound: m.value.notFound,
  invalidChat: m.value.invalidChat,
  invalidTaskFilter: t(
    'Check the filters and try again.',
    '請檢查篩選條件後再試一次。',
  ),
}));
</script>

<template>
  <p v-if="pending && !error" class="empty load-state" role="status">
    <LoaderCircle :size="16" class="spin" />{{ m.loading }}…
  </p>
  <div v-if="error" class="empty load-state error-text" role="alert">
    {{ errors[error] ?? m.internal }}
    <Button size="small" outlined :label="m.retry" @click="$emit('retry')" />
  </div>
</template>
