<script setup lang="ts">
import { platformLabel } from '../lib/display.ts';

defineProps<{ platform: string }>();
</script>

<template>
  <Tag
    :value="platformLabel(platform)"
    class="platform-tag"
    :class="{ 'platform-line': platform === 'line' }"
  />
</template>
