<script lang="ts">
  import type { AdminAgent } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import AgentCard from '../components/AgentCard.svelte';
  import { i18n } from '../lib/i18n.ts';

  let { data, ctx }: { ctx: ViewContext; data: readonly AdminAgent[] } =
    $props();
  const m = $derived(i18n(ctx.locale));
</script>

<div class="section-head"><h1>{m.agents}</h1></div>
{#if data.length === 0}<p class="card empty">{m.noAgents}</p>{/if}
<div class="chat-grid">
  {#each data as agent (agent.id)}<AgentCard {agent} {ctx} />{/each}
</div>
