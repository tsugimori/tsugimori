<script setup lang="ts">
import type {
  AdminTaskRecord,
  AdminTrace,
  TaskTiming,
} from '@tsugimori/plugin-sdk';

import type { ConsoleEvent } from '../../composables/useConsole.ts';

import {
  Clock3,
  Code,
  Layers3,
  ListTree,
  Terminal,
  TextAlignStart,
} from '@lucide/vue';

import {
  chatHref,
  chatKey,
  chatTitle,
  statusStyle,
  taskDuration,
  tokenPair,
} from '../../lib/display.ts';
import { duration } from '../../lib/format.ts';
import { renderMarkdown } from '../../lib/markdown.ts';
import {
  callAnchor,
  taskLanes,
  toolOffset,
  toolStatus,
} from '../../lib/timeline.ts';

const route = useRoute();
const { locale, m, now, t } = useConsole();
const id = computed(() =>
  typeof route.params.id === 'string' ? route.params.id : undefined,
);
const live = (event: ConsoleEvent) =>
  (event.kind === 'task' && event.id === id.value) ||
  (event.kind === 'tool' && event.taskId === id.value);
const record = useConsoleQuery<AdminTaskRecord>(
  () =>
    id.value ? 'task?' + new URLSearchParams({ id: id.value }) : undefined,
  live,
);
const tracing = useConsoleQuery<AdminTrace>(
  () =>
    id.value ? 'trace?' + new URLSearchParams({ task: id.value }) : undefined,
  live,
);
const data = record.data;
const trace = tracing.data;
const task = computed(() => data.value?.task ?? trace.value?.task);
const start = computed(
  () => task.value?.startedAt ?? task.value?.createdAt ?? now.value,
);
const elapsed = computed(() =>
  task.value
    ? (taskDuration(task.value, now.value) ??
      Math.max(0, now.value - start.value))
    : 0,
);
const wallStart = computed(() =>
  Math.min(
    task.value?.createdAt ?? start.value,
    start.value,
    trace.value?.spans[0]?.startedAt ?? start.value,
  ),
);
const wallTime = computed(() =>
  Math.max(
    1,
    start.value + elapsed.value - wallStart.value,
    ...(trace.value?.spans ?? []).map(
      (span) => span.startedAt + span.durationMs - wallStart.value,
    ),
  ),
);
const lanes = computed(() =>
  task.value
    ? taskLanes(task.value, start.value, start.value + elapsed.value)
    : undefined,
);
const stages = computed(() => {
  const timing = data.value?.timing;
  if (!timing) return [];
  const keys = ['queuedMs', 'contextMs', 'agentMs', 'deliveryMs'] as const;
  const total = Math.max(
    1,
    timing.totalMs,
    keys.reduce((sum, key) => sum + timing[key], 0),
  );
  let at = 0;
  return keys.flatMap((key, index) => {
    const width = (timing[key] * 100) / total;
    const segment = { at, width, tone: 'phase-' + index };
    at += width;
    return width > 0 ? [segment] : [];
  });
});
const timings = computed(
  () =>
    Object.entries(data.value?.timing ?? {}) as [keyof TaskTiming, number][],
);
const finalEvent = computed(() => {
  const last = data.value?.events.findLast(({ kind }) => kind === 'text');
  return last?.kind === 'text' && last.data.text === data.value?.output
    ? last.seq
    : undefined;
});
const raw = ref(false);
const showReasoning = ref(true);
const rendered = computed(() => renderMarkdown(data.value?.output ?? ''));
const tools = computed(
  () => new Map(task.value?.tools.map((tool) => [tool.seq, tool])),
);
const relatedChat = computed(() => trace.value?.chat ?? task.value);
useFragment(() => Boolean(data.value) || Boolean(trace.value));
useHead({
  title: computed(() =>
    id.value ? m.value.task + ' ' + id.value : m.value.task,
  ),
});
</script>

<template>
  <div class="breadcrumb">
    <NuxtLink to="/tasks">{{ t('Tasks', '任務') }}</NuxtLink>
    <template v-if="relatedChat"
      >›
      <NuxtLink
        :to="chatHref(relatedChat) + '#task-' + encodeURIComponent(id ?? '')"
        >{{
          trace?.chat ? chatTitle(trace.chat) : relatedChat.chatId
        }}</NuxtLink
      ></template
    >
    <span>› {{ t('Task details', '任務詳情') }}</span>
  </div>
  <div class="page-head task-head">
    <div>
      <h1>
        {{ m.task }}
        <code v-if="id" :title="id">{{
          id.length > 20 ? id.slice(0, 19) + '…' : id
        }}</code>
        <StateTag
          v-if="task"
          :status="task.silent ? 'idle' : task.status"
          :label="task.silent ? m.silent : undefined"
        />
        <Tag
          v-if="data?.outcome"
          severity="secondary"
          :value="m.outcomeKind[data.outcome.kind]"
        />
      </h1>
      <p v-if="task" class="muted detail-meta">
        <Clock3 :size="14" />
        <span
          >{{ m.started }}
          <ConsoleTime :at="task.startedAt ?? task.createdAt" format="absolute"
        /></span>
        <span>{{ duration(elapsed, locale) }}</span><span>{{
          m.toolCount(String(task.tools.length))
        }}</span>
        <span v-if="task.inputTokens != null || task.outputTokens != null"
          >{{ tokenPair(task.inputTokens, task.outputTokens) }}
          {{ m.tokens }}</span
        >
      </p>
    </div>
    <nav
      v-if="task"
      class="jump-links"
      :aria-label="t('Task sections', '任務區段')"
    >
      <a v-if="data" href="#context">{{ m.context }}</a><a
        v-if="data"
        href="#transcript"
        >{{ m.transcript }}</a
      ><a v-if="data" href="#output">{{ m.output }}</a
      ><a v-if="trace" href="#trace">{{ m.trace }}</a>
    </nav>
  </div>
  <p v-if="!id" class="empty">
    {{ t('Open a task from the task list.', '請從任務清單開啟任務。') }}
  </p>
  <LoadState
    v-else-if="!task || record.error.value"
    :pending="record.pending.value"
    :error="record.error.value"
    @retry="record.refresh()"
  />
  <div v-if="task" class="task-layout">
    <div class="panel-stack">
      <ConsolePanel :title="m.timing" :icon="Clock3">
        <template #actions
          ><Tag
            severity="secondary"
            :value="
              m.timingLabel.totalMs +
              ' ' +
              duration(data?.timing?.totalMs ?? elapsed, locale)
            "
        /></template>
        <div class="detail-inset">
          <TimingTrack
            class="phase-track"
            :segments="stages.length ? stages : [{ at: 0, width: 100 }]"
          />
          <div v-if="lanes?.tools.length" class="timing-lane">
            <span>{{ m.toolLane }}</span><TimingTrack
              :segments="
                lanes.tools.map(({ left, width, tool }) => ({
                  at: left,
                  width,
                  tone: statusStyle(toolStatus(tool))[0],
                }))
              "
            />
          </div>
          <ul v-if="timings.length" class="timing-labels">
            <li v-for="[key, value] in timings" :key="key">
              <span>{{ m.timingLabel[key] }}</span>
              <strong>{{ duration(value, locale) }}</strong>
            </li>
          </ul>
        </div>
      </ConsolePanel>
      <template v-if="data">
        <ConsolePanel
          id="context"
          :title="m.context"
          :icon="Layers3"
          :subtitle="data.context.length + ' ' + t('blocks', '個區塊')"
        >
          <template #actions
            ><span v-if="data.refs" class="muted revision-text"
              >tsugimori
              <code>{{ data.refs.tsugimori.commit.slice(0, 8) }}</code><template
                v-if="data.refs.workspace?.commit"
              >
                · workspace
                <code>{{
                  data.refs.workspace.commit.slice(0, 8)
                }}</code></template
              ></span
            ></template
          >
          <details
            v-for="(context, index) in data.context"
            :key="index"
            class="context-row"
            :open="context.kind === 'new'"
          >
            <summary>
              <Tag :value="context.kind" severity="secondary" />
              <strong>{{ context.title }}</strong><code class="muted">{{
                context.ref
              }}</code>
            </summary>
            <pre v-if="context.text !== undefined" class="code-block">{{
              context.text
            }}</pre>
            <p v-else class="detail-inset muted">
              {{ m.unavailable }} · {{ context.ref }}
            </p>
          </details>
          <p v-if="!data.context.length" class="empty">{{ m.unavailable }}</p>
        </ConsolePanel>
        <ConsolePanel
          id="transcript"
          :title="m.transcript"
          :icon="Terminal"
          :subtitle="data.events.length + ' ' + t('events', '個事件')"
        >
          <template #actions
            ><Button
              text
              size="small"
              :aria-pressed="showReasoning"
              @click="showReasoning = !showReasoning"
              >{{
                showReasoning
                  ? t('Hide reasoning', '隱藏推理')
                  : t('Show reasoning', '顯示推理')
              }}</Button
            ></template
          >
          <ol
            v-if="data.events.length || data.outcome?.delivery"
            class="detail-inset transcript"
          >
            <li
              v-for="event in data.events"
              :hidden="!showReasoning && event.kind === 'reasoning'"
              :key="event.seq"
              class="execution-event"
            >
              <ConsoleTime :at="event.at" format="clock" />
              <template v-if="event.kind === 'tool'">
                <details
                  :id="callAnchor(task.id, event.data.toolSeq)"
                  open
                  class="tool-card"
                  :class="{ 'tool-error': event.tool?.status === 'error' }"
                >
                  <summary>
                    <span
                      class="activity-dot"
                      :class="
                        'dot-' +
                        statusStyle(
                          event.tool ? toolStatus(event.tool) : null,
                        )[0]
                      "
                    ></span>
                    <strong
                      ><code
                        >{{ event.tool?.name ?? m.tool }} #{{
                          event.data.toolSeq
                        }}</code
                      ></strong
                    >
                    <code
                      v-if="event.tool?.argsPreview"
                      class="muted tool-preview"
                      >{{ event.tool.argsPreview }}</code
                    >
                    <span class="muted tool-duration"
                      >{{ toolOffset(event.at - start)
                      }}<template v-if="event.tool?.endedAt != null">
                        ·
                        {{
                          duration(
                            event.tool.endedAt - event.tool.startedAt,
                            locale,
                          )
                        }}</template
                      ></span
                    >
                  </summary>
                  <ToolDetails
                    :tool="event.tool ?? tools.get(event.data.toolSeq)"
                  />
                </details>
              </template>
              <details
                v-else-if="event.kind === 'reasoning'"
                open
                class="reasoning"
              >
                <summary>{{ m.reasoning }}</summary>
                <pre class="code-block">{{ event.data.text }}</pre>
              </details>
              <div v-else-if="event.kind === 'text'" class="transcript-text">
                <NuxtLink
                  v-if="event.seq === finalEvent"
                  class="section-link"
                  :to="{ hash: '#output' }"
                  >{{ t('See final output', '查看最終輸出') }} ↓</NuxtLink
                >
                <pre v-else class="code-block">{{ event.data.text }}</pre>
              </div>
              <p v-else-if="event.kind === 'compaction'">
                <strong>{{ m.compaction }}</strong> · {{ event.data.trigger
                }}<template v-if="event.data.tokensBefore !== undefined">
                  · {{ event.data.tokensBefore }} →
                  {{ event.data.tokensAfter ?? '—' }}</template
                >
                · {{ event.data.status }}
              </p>
              <p v-else-if="event.kind === 'supplement'">
                <strong>{{ m.supplement }}</strong> · {{ event.data.messageId }}
              </p>
              <p v-else-if="event.kind === 'error'" class="error-text">
                <strong>{{ event.data.stage }} · {{ event.data.code }}</strong>
                · {{ event.data.message }}
              </p>
            </li>
            <li v-if="data.outcome?.delivery" class="execution-event">
              <ConsoleTime :at="task.finishedAt" format="clock" />
              <p>
                <strong>{{ m.timingLabel.deliveryMs }}</strong> ·
                {{ data.outcome.delivery.adapterId }} ·
                {{
                  data.outcome.delivery.parts
                    .map((part) => part.messageId ?? part.error ?? m.failed)
                    .join(' · ')
                }}
              </p>
            </li>
          </ol>
          <p v-else class="empty">{{ m.unavailable }}</p>
        </ConsolePanel>
        <ConsolePanel id="output" :title="m.output" :icon="TextAlignStart">
          <template v-if="data.output != null" #actions>
            <div class="inline">
              <div class="segments">
                <button :aria-pressed="!raw" @click="raw = false">
                  {{ t('Rendered', '渲染') }}</button><button
                  :aria-pressed="raw"
                  @click="raw = true"
                >
                  {{ m.raw }}
                </button>
              </div>
              <CopyButton :text="data.output" />
            </div>
          </template>
          <p v-if="data.output == null || data.output === ''" class="empty">
            {{ data.output === '' ? m.emptyOutput : m.unavailable }}
          </p>
          <div v-else class="detail-inset">
            <pre v-if="raw" class="code-block">{{ data.output }}</pre>
            <div v-else class="markdown" v-html="rendered"></div>
          </div>
        </ConsolePanel>
      </template>
      <SpanWaterfall
        v-if="trace"
        :trace="trace"
        :start="wallStart"
        :elapsed="wallTime"
      />
      <LoadState
        v-else
        :pending="tracing.pending.value"
        :error="tracing.error.value"
        @retry="tracing.refresh()"
      />
    </div>

    <aside class="task-sidebar panel-stack">
      <ConsolePanel :title="m.summary" :icon="ListTree">
        <div class="summary-group">
          <h3>{{ m.trigger }}</h3>
          <p v-if="data?.trigger">
            {{ data.trigger.triggered ? m.triggered : m.skipped }} ·
            <code>{{ data.trigger.reason }}</code>
          </p>
          <p v-else class="muted">{{ m.unavailable }}</p>
          <p v-if="task.sourceSeq && relatedChat">
            <NuxtLink
              class="section-link"
              :to="chatHref(relatedChat) + '#msg-' + task.sourceSeq"
              >#{{ task.sourceSeq }}</NuxtLink
            >
            · <ConsoleTime :at="data?.trigger?.at" format="clock" />
          </p>
        </div>
        <div class="summary-group">
          <h3>{{ m.agent }}</h3>
          <dl class="key-values">
            <dt>{{ m.agent }}</dt>
            <dd>
              {{ data?.agent?.agentId ?? task.agentId ?? '—' }}
              <small v-if="data?.agent?.kind">· {{ data.agent.kind }}</small>
            </dd>
            <dt>{{ t('Model', '模型') }}</dt>
            <dd>
              <code>{{ data?.agent?.model ?? task.model ?? '—' }}</code>
            </dd>
            <template
              v-if="
                data?.agent && data.agent.requestedModel !== data.agent.model
              "
              ><dt>{{ m.requestedModel }}</dt>
              <dd>{{ data.agent.requestedModel }}</dd></template
            >
            <template v-if="data?.agent?.reasoning"
              ><dt>{{ m.thinking }}</dt>
              <dd>{{ data.agent.reasoning }}</dd></template
            >
            <template v-if="data?.agent?.serviceTier"
              ><dt>{{ m.fastMode }}</dt>
              <dd>{{ data.agent.serviceTier }}</dd></template
            >
            <template v-if="data?.refs"
              ><dt>{{ t('Session', '工作階段') }}</dt>
              <dd>
                {{
                  data.refs.session.mode === 'new'
                    ? m.sessionNew
                    : m.sessionResumed
                }}<small v-if="data.refs.session.sessionId"
                  ><code>{{ data.refs.session.sessionId }}</code></small
                ><small v-if="data.refs.session.previousSessionId"
                  ><code>{{ data.refs.session.previousSessionId }}</code></small
                ><small v-if="data.refs.session.reason">{{
                  data.refs.session.reason
                }}</small>
              </dd></template
            >
            <dt>{{ m.tokens }}</dt>
            <dd>{{ tokenPair(task.inputTokens, task.outputTokens) }}</dd>
          </dl>
        </div>
        <div class="summary-group">
          <h3>{{ m.outcome }}</h3>
          <p v-if="data?.outcome">
            {{ m.outcomeKind[data.outcome.kind]
            }}<template v-if="data.outcome.silentReason">
              · {{ data.outcome.silentReason }}</template
            >
          </p>
          <p v-if="data?.outcome?.error || task.error" class="error-text">
            {{
              data?.outcome?.error
                ? [
                    data.outcome.error.stage,
                    data.outcome.error.code,
                    data.outcome.error.message,
                  ].join(' · ')
                : task.error
            }}
          </p>
          <ul v-if="data?.outcome?.delivery">
            <li
              v-for="(part, index) in data.outcome.delivery.parts"
              :key="index"
            >
              {{ data.outcome.delivery.adapterId }} ·
              {{ part.messageId ?? (part.ok ? m.done : m.failed)
              }}<template v-if="part.error"> · {{ part.error }}</template>
            </li>
          </ul>
        </div>
        <div v-if="data?.supplements?.length" class="summary-group">
          <h3>{{ m.supplements }}</h3>
          <p v-for="item in data.supplements" :key="item.messageId">
            <ConsoleTime :at="item.at" format="clock" /> ·
            {{ item.messageId }} · {{ m.afterEvent }} #{{ item.afterEventSeq }}
          </p>
        </div>
        <div class="summary-group">
          <h3>{{ t('Versions', '版本') }}</h3>
          <dl class="key-values">
            <template v-if="data?.refs"
              ><dt>tsugimori</dt>
              <dd>
                <code>{{ data.refs.tsugimori.commit }}</code>
                <span v-if="data.refs.tsugimori.dirty">{{
                  t('modified', '有修改')
                }}</span>
              </dd>
              <dt>workspace</dt>
              <dd>
                <code>{{ data.refs.workspace?.commit ?? '—' }}</code> ·
                {{ data.refs.workspace?.files.length ?? 0 }}
                {{ t('files', '個檔案') }}
              </dd>
            </template>
            <dt>{{ m.task }} ID</dt>
            <dd>
              <code>{{ task.id }}</code>
            </dd>
          </dl>
        </div>
      </ConsolePanel>
      <ConsolePanel
        v-if="task.tools.length"
        :title="m.toolLane"
        :icon="Code"
        :subtitle="m.toolCount(String(task.tools.length))"
      >
        <a
          v-for="tool in task.tools"
          :key="tool.seq"
          :href="'#' + callAnchor(task.id, tool.seq)"
          class="tool-link"
        >
          <span
            class="activity-dot"
            :class="'dot-' + statusStyle(toolStatus(tool))[0]"
          ></span
          ><code>{{ tool.name }}</code
          ><small>{{ toolOffset(tool.startedAt - start) }}</small
          ><small>{{
            tool.endedAt == null
              ? '…'
              : duration(tool.endedAt - tool.startedAt, locale)
          }}</small>
        </a>
      </ConsolePanel>
      <NuxtLink
        class="section-link"
        :to="{ path: '/tasks', query: { chat: chatKey(task) } }"
        >{{
          t('More tasks in this chat', '查看此聊天室的其他任務')
        }}
        →</NuxtLink
      >
    </aside>
  </div>
</template>
