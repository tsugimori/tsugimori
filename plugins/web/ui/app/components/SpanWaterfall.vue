<script setup lang="ts">
import type { AdminTrace } from '@tsugimori/plugin-sdk';

import { Workflow } from '@lucide/vue';

import { statusStyle } from '../lib/display.ts';
import { duration } from '../lib/format.ts';

type Span = AdminTrace['spans'][number];
const props = defineProps<{
  trace: AdminTrace;
  start: number;
  elapsed: number;
}>();
const { locale, m, t } = useConsole();
const calls = computed(
  () => new Map(props.trace.task.tools.map((tool) => [tool.seq, tool])),
);
const rows = computed(() => {
  const sorted = [...props.trace.spans].sort(
    (a, b) => a.startedAt - b.startedAt,
  );
  const ids = new Map(
    sorted.flatMap((span) =>
      span.id == null ? [] : [[span.id, span] as const],
    ),
  );
  const children = new Map<Span | undefined, Span[]>();
  for (const span of sorted) {
    const id = span.parentId ?? span.attrs.parentSpanId;
    const parent =
      typeof id === 'string' || typeof id === 'number'
        ? ids.get(id)
        : undefined;
    const group = children.get(parent) ?? [];
    group.push(span);
    children.set(parent, group);
  }
  const seen = new Set<Span>();
  const ordered: { depth: number; span: Span }[] = [];
  function visit(span: Span, depth: number) {
    if (seen.has(span)) return;
    seen.add(span);
    ordered.push({ depth, span });
    for (const child of children.get(span) ?? []) visit(child, depth + 1);
  }
  for (const span of children.get(undefined) ?? []) visit(span, 0);
  for (const span of sorted) visit(span, 0);
  return ordered;
});
function track(span: Span) {
  const elapsed = Math.max(1, props.elapsed);
  const at = Math.min(
    100,
    Math.max(0, ((span.startedAt - props.start) * 100) / elapsed),
  );
  return [
    {
      at,
      width: Math.min(100 - at, (span.durationMs * 100) / elapsed),
      tone:
        statusStyle(span.status)[0] === 'err'
          ? 'err'
          : span.name === 'outbound.typing'
            ? 'idle'
            : 'run',
    },
  ];
}
</script>

<template>
  <ConsolePanel
    id="trace"
    :title="m.trace"
    :icon="Workflow"
    :subtitle="rows.length + ' ' + t('spans', '個 span')"
  >
    <div v-if="rows.length" class="detail-inset">
      <details
        v-for="({ span, depth }, index) in rows"
        :key="span.id ?? index"
        class="span-row"
      >
        <summary>
          <span class="span-name" :class="'depth-' + Math.min(5, depth)"
            ><code>{{ span.name }}</code
            ><small v-if="typeof span.attrs.name === 'string'">
              · {{ span.attrs.name }}</small
            ></span
          >
          <TimingTrack :segments="track(span)" />
          <span class="span-duration muted">{{
            duration(span.durationMs, locale)
          }}</span>
        </summary>
        <div class="detail-inset span-detail">
          <p class="inline muted">
            <ConsoleTime :at="span.startedAt" format="absolute" /><StateTag
              :status="span.status"
            />
          </p>
          <CodeInspector
            v-if="Object.keys(span.attrs).length"
            :label="m.attributes"
            :text="JSON.stringify(span.attrs, null, 2)"
          />
          <p v-else class="muted">{{ m.noAttributes }}</p>
          <ToolDetails
            v-if="span.name === 'agent.tool' || span.name === 'tool.run'"
            :tool="
              typeof span.attrs.toolCallSeq === 'number'
                ? calls.get(span.attrs.toolCallSeq)
                : undefined
            "
          />
        </div>
      </details>
    </div>
    <p v-else class="empty">{{ m.noSpans }}</p>
  </ConsolePanel>
</template>
