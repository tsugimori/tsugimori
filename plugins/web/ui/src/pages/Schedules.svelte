<script lang="ts">
  import type { AdminSchedules } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import Badge from '../components/Badge.svelte';
  import LinkedChat from '../components/LinkedChat.svelte';
  import Time from '../components/Time.svelte';
  import { i18n } from '../lib/i18n.ts';

  let { data, ctx }: { ctx: ViewContext; data: AdminSchedules } = $props();
  const m = $derived(i18n(ctx.locale));
</script>

<div class="section-head"><h1>{m.schedules}</h1></div>
<div class="schedule-list">
  {#each data.schedules as schedule (schedule.id)}
    <article class="card" id={'schedule-' + schedule.id}>
      <div class="card-head">
        <h2 class="ellipsis" title={schedule.title}>{schedule.title}</h2>
        <Badge status={schedule.status} locale={ctx.locale} />
      </div>
      <p><LinkedChat ref={schedule} chat={schedule.chat} /></p>
      <dl class="kv">
        <dt>{m.nextRun}</dt>
        <dd><Time at={schedule.nextDueAt} {ctx} mode="future" /></dd>
        {#if schedule.lastRun != null}<dt>{m.lastRun}</dt>
          <dd><Time at={schedule.lastRun} {ctx} mode="absolute" /></dd>{/if}
      </dl>
    </article>
  {:else}<p class="card empty">{m.noSchedules}</p>{/each}
</div>
