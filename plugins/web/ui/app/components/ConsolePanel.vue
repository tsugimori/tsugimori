<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{ title: string; icon?: Component; subtitle?: string }>();
</script>

<template>
  <Panel class="console-panel">
    <template #header>
      <div class="panel-title">
        <component
          :is="icon"
          v-if="icon"
          class="panel-icon"
          :size="17"
          aria-hidden="true"
        />
        <h2>{{ title }}</h2>
        <span v-if="subtitle" class="muted small panel-subtitle">{{
          subtitle
        }}</span>
      </div>
    </template>
    <template v-if="$slots.actions" #icons><slot name="actions" /></template>
    <slot />
  </Panel>
</template>
