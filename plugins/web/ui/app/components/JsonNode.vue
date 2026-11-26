<script setup lang="ts">
const props = defineProps<{ label?: string; level: number; value: unknown }>();
const { m } = useConsole();
const all = ref(false);
const full = ref(false);
const entries = computed(() =>
  props.value && typeof props.value === 'object'
    ? Object.entries(props.value)
    : undefined,
);
const array = computed(() => Array.isArray(props.value));
</script>

<template>
  <details v-if="entries" class="json-node" :open="level <= 2">
    <summary>
      <b v-if="label !== undefined" class="json-key">{{ label }}: </b
      >{{ array ? '[' : '{' }}{{ entries.length }}{{ array ? ']' : '}' }}
    </summary>
    <div class="json-children">
      <JsonNode
        v-for="[name, item] of array && !all ? entries.slice(0, 50) : entries"
        :key="name"
        :label="name"
        :level="level + 1"
        :value="item"
      />
      <button
        v-if="array && !all && entries.length > 50"
        class="text-button"
        @click="all = true"
      >
        {{ m.remaining(entries.length - 50) }}
      </button>
    </div>
  </details>
  <div v-else>
    <b v-if="label !== undefined" class="json-key">{{ label }}: </b>
    <span v-if="typeof value === 'string'" class="json-string"
      >"{{
        !full && value.length > 300 ? value.slice(0, 300) + '…' : value
      }}"</span
    >
    <span v-else class="json-scalar">{{ String(value) }}</span>
    <button
      v-if="typeof value === 'string' && value.length > 300"
      class="text-button"
      @click="full = !full"
    >
      {{ full ? m.collapse : m.expand }}
    </button>
  </div>
</template>
