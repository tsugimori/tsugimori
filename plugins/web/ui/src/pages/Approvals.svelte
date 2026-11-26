<script lang="ts">
  import type { AdminApprovals } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import Badge from '../components/Badge.svelte';
  import JsonView from '../components/JsonView.svelte';
  import LinkedChat from '../components/LinkedChat.svelte';
  import Time from '../components/Time.svelte';
  import { i18n } from '../lib/i18n.ts';

  let { data, ctx }: { ctx: ViewContext; data: AdminApprovals } = $props();
  const m = $derived(i18n(ctx.locale));
  const pending = $derived(
    data.approvals.filter((approval) => approval.status === 'pending'),
  );
  const recent = $derived(
    data.approvals.filter((approval) => approval.status !== 'pending'),
  );
</script>

{#snippet row(approval: AdminApprovals['approvals'][number])}
  <article class="card" id={'approval-' + approval.id}>
    <div class="approval-row">
      <div>
        <code>{approval.action}</code>
        <p><LinkedChat ref={approval} chat={approval.chat} /></p>
        <p class="meta">
          {m.requester} · {approval.requesterDisplay ?? approval.requester}
        </p>
      </div>
      <p class="meta requested">
        <Time at={approval.requestedAt} {ctx} mode="absolute" />
      </p>
      <div class="decision">
        <Badge status={approval.status} locale={ctx.locale} denialIsError />
        {#if approval.decidedAt !== null}
          <p class="meta">
            {approval.decidedBy
              ? m.decidedBy + ' ' + approval.decidedBy + ' · '
              : ''}<Time at={approval.decidedAt} {ctx} mode="absolute" />
          </p>
        {/if}
      </div>
    </div>
    {#if approval.failureReason}<p class="alert err">
        {approval.failureReason}
      </p>{/if}
    {#if approval.args != null}
      <details class="approval-details">
        <summary class="meta">{m.args}</summary><JsonView
          text={approval.args}
          label={m.args}
          locale={ctx.locale}
        />
      </details>
    {/if}
  </article>
{/snippet}

<div class="section-head"><h1>{m.approvals}</h1></div>
<div class="approvals">
  <section>
    <div class="section-head"><h2>{m.pending}</h2></div>
    {#each pending as approval (approval.id)}{@render row(approval)}
    {:else}<p class="card empty">{m.noPending}</p>{/each}
  </section>
  <section>
    <div class="section-head"><h2>{m.recent}</h2></div>
    {#each recent as approval (approval.id)}{@render row(approval)}
    {:else}<p class="card empty">{m.noRecent}</p>{/each}
  </section>
  <section>
    <div class="section-head"><h2>{m.grants}</h2></div>
    {#each data.grants as grant (grant)}
      <article class="card">
        <div class="approval-row">
          <div>
            <code>{grant.action}</code>
            <p><LinkedChat ref={grant} /></p>
          </div>
          <p class="meta requested">
            <Time at={grant.createdAt} {ctx} mode="absolute" />
          </p>
          <span class="meta decision">
            {grant.revokedAt !== null
              ? m.revoked
              : grant.mode === 'once'
                ? m.once
                : m.always}
          </span>
        </div>
        <dl class="kv">
          <dt>{m.scope}</dt>
          <dd><code>{JSON.stringify(grant.scope)}</code></dd>
          <dt>{m.grantedBy}</dt>
          <dd>{grant.grantedBy}</dd>
          <dt>{m.grantedTo}</dt>
          <dd>{grant.grantedTo}</dd>
        </dl>
      </article>
    {:else}<p class="card empty">{m.noGrants}</p>{/each}
  </section>
</div>
