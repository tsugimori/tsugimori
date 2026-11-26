<script setup lang="ts">
defineProps<{
  segments: readonly { at: number; width: number; tone?: string }[];
}>();
</script>

<template>
  <svg
    class="timing-track"
    viewBox="0 0 1000 10"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <rect class="track-background" width="1000" height="10" rx="3" />
    <rect
      v-for="(segment, index) of segments"
      :key="index"
      :x="Math.min(998, Math.max(0, segment.at * 10))"
      :width="
        Math.max(2, Math.min((100 - segment.at) * 10, segment.width * 10))
      "
      :class="'track-' + (segment.tone ?? 'run')"
      height="10"
      rx="2"
    />
  </svg>
</template>
