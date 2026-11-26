<script lang="ts">
  import type { AdminAgent } from '@tsugimori/plugin-sdk';

  import type { ViewContext } from '../lib/format.ts';

  import { chatHref } from '../lib/display.ts';
  import { duration, number } from '../lib/format.ts';
  import { i18n } from '../lib/i18n.ts';
  import Badge from './Badge.svelte';
  import Time from './Time.svelte';

  let { agent, ctx }: { agent: AdminAgent; ctx: ViewContext } = $props();
  const m = $derived(i18n(ctx.locale));
  const status = $derived(
    agent.state === 'error'
      ? 'unavailable'
      : agent.state === 'disabled'
        ? 'disabled'
        : agent.active
          ? 'running'
          : 'idle',
  );
</script>

<article class="card agent-card">
  <div class="card-head">
    <span class="avatar" aria-hidden="true">
      {[...agent.id][0]?.toUpperCase()}
    </span>
    <h2 class="ellipsis">{agent.id}</h2>
    {#if agent.isDefault}<span class="meta">{m.default}</span>{/if}
    <Badge
      {status}
      locale={ctx.locale}
      label={status === 'running'
        ? m.running + ' ' + number(agent.active)
        : undefined}
    />
  </div>
  <p class="meta">{agent.implementation}</p>
  <dl class="kv">
    <dt>{m.model}</dt>
    <dd>{agent.model ?? '—'}</dd>
    <dt>{m.inUse}</dt>
    <dd>
      <a href={'/?' + new URLSearchParams({ agent: agent.id })}>
        {m.usingChats(number(agent.chats))}
      </a>
    </dd>
    <dt>{m.lastActivity}</dt>
    <dd><Time at={agent.lastActivity} {ctx} /></dd>
    <dt>{m.tasksToday}</dt>
    <dd>
      {number(agent.tasksToday)} ·
      <span class:danger={agent.failedToday > 0}>
        {m.failed + ' ' + number(agent.failedToday)}
      </span>
    </dd>
    <dt>{m.login}</dt>
    <dd class:pending={agent.login === 'required'}>
      {m[
        agent.login === 'signed-in'
          ? 'signedIn'
          : agent.login === 'required'
            ? 'loginRequired'
            : 'unknown'
      ]}
    </dd>
  </dl>
  {#if agent.recent.length > 0}
    <section class="agent-recent">
      <h3>{m.recentTasks}</h3>
      <ul>
        {#each agent.recent as task (task.id)}
          <li>
            <a
              class="ellipsis"
              href={chatHref(task) + '#task-' + encodeURIComponent(task.id)}
            >
              {task.chatTitle}
            </a>
            <Badge locale={ctx.locale} status={task.status} />
            <span class="meta">
              {task.durationMs === null
                ? '—'
                : duration(task.durationMs, ctx.locale)}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</article>
