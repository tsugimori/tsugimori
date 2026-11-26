<script lang="ts">
  import type { AdminConversation, AdminTask } from '@tsugimori/plugin-sdk';

  import { SvelteMap } from 'svelte/reactivity';

  import type { ViewContext } from '../lib/format.ts';

  import { formatTime } from '../lib/format.ts';
  import Message from './Message.svelte';
  import TaskBlock from './TaskBlock.svelte';

  let {
    data,
    ctx,
    preview = false,
  }: {
    ctx: ViewContext;
    data: Pick<AdminConversation, 'messages' | 'tasks'>;
    preview?: boolean;
  } = $props();
  type MessageItem = AdminConversation['messages'][number];

  const layout = $derived.by(() => {
    const bySource = new SvelteMap<number, AdminTask[]>();
    const replies = new SvelteMap<string, MessageItem[]>();
    const messageSeqs = new Set(data.messages.map(({ seq }) => seq));
    const turns = data.tasks
      .flatMap(({ id, startedAt, finishedAt, silent }) =>
        startedAt === null || silent
          ? []
          : [{ id, start: startedAt, end: finishedAt ?? Infinity }],
      )
      .sort((a, b) => b.start - a.start);
    const timeline: {
      at: number | null;
      key: string;
      message?: MessageItem;
      tasks: AdminTask[];
    }[] = [];
    for (const task of data.tasks) {
      if (task.sourceSeq != null && messageSeqs.has(task.sourceSeq)) {
        const list = bySource.get(task.sourceSeq) ?? [];
        list.push(task);
        bySource.set(task.sourceSeq, list);
      } else {
        timeline.push({
          at: task.startedAt ?? task.createdAt,
          tasks: [task],
          key: 'task-' + task.id,
        });
      }
    }
    let lastTime: number | null = null;
    for (const message of [...data.messages].sort((a, b) => a.seq - b.seq)) {
      lastTime = message.recordedAt ?? lastTime;
      const at = message.recordedAt;
      const turn =
        message.direction === 'outbound' && at !== null
          ? turns.find(({ start, end }) => at >= start && at <= end)
          : undefined;
      if (turn) {
        const messages = replies.get(turn.id);
        if (messages) messages.push(message);
        else replies.set(turn.id, [message]);
      }
      timeline.push({
        at: lastTime,
        message: turn ? undefined : message,
        tasks: (bySource.get(message.seq) ?? []).sort(
          (a, b) => a.createdAt - b.createdAt,
        ),
        key: 'msg-' + message.seq,
      });
    }
    const sorted = timeline
      .filter(({ message, tasks }) => message || tasks.length)
      .sort(
        (a, b) =>
          (a.at ?? -Infinity) - (b.at ?? -Infinity) ||
          (a.message?.seq ?? Infinity) - (b.message?.seq ?? Infinity),
      );
    let lastDay = '';
    const items = sorted.map((item) => {
      const day =
        item.at === null ? '' : formatTime(item.at, ctx.timezone).slice(0, 10);
      const separator = day !== lastDay ? day : '';
      lastDay = day;
      return { ...item, separator };
    });
    return { items, replies };
  });
</script>

<ol class="timeline">
  {#each layout.items as { message, tasks, key, separator } (key)}
    {#if separator}<li class="day meta">{separator}</li>{/if}
    {#if message}<Message {message} {ctx} />{/if}
    {#each tasks as task (task.id)}<TaskBlock
        {task}
        {ctx}
        {preview}
        messages={layout.replies.get(task.id) ?? []}
      />{/each}
  {/each}
</ol>
