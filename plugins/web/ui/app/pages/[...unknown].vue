<script setup lang="ts">
const { m } = useConsole();
</script>

<template>
  <div class="page-head">
    <h1>{{ m.notFound }}</h1>
    <NuxtLink class="section-link" to="/">{{ m.overview }}</NuxtLink>
  </div>
</template>
