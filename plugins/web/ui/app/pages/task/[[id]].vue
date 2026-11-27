<script setup lang="ts">
import type {
  AdminAgentRun,
  AdminModelGap,
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
  cacheHitRatio,
  chatHref,
  chatKey,
  chatTitle,
  statusStyle,
  taskDuration,
  tokenPair,
} from '../../lib/display.ts';
import { duration, number } from '../../lib/format.ts';
import { renderMarkdown } from '../../lib/markdown.ts';
import {
  callAnchor,
  modelGapsByEvent,
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
const agentRuns = computed<readonly AdminAgentRun[]>(() => {
  const current = task.value;
  if (!current) return [];
  return current.agentRuns?.length
    ? current.agentRuns
    : [{ ...current, startedAt: current.startedAt ?? current.createdAt }];
});
function count(value?: number) {
  return value === undefined ? '—' : number(value);
}
const agentTiming = computed(() => task.value?.agentTiming);
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
const timings = computed(() => {
  const timings = Object.entries(data.value?.timing ?? {}) as [
    keyof TaskTiming,
    number,
  ][];
  return agentTiming.value
    ? timings.filter(([key]) => key !== 'agentMs' && key !== 'toolsMs')
    : timings;
});
const modelRows = computed(() =>
  modelGapsByEvent(
    agentTiming.value?.modelGaps ?? [],
    data.value?.events ?? [],
  ),
);
function modelLabel({
  startedAt,
  endedAt,
  inputTokens,
  outputTokens,
}: AdminModelGap) {
  const time = `${m.value.modelLane} ${duration(endedAt - startedAt, locale.value)}`;
  if (inputTokens === undefined && outputTokens === undefined) return time;
  const [input, output] = tokenPair(inputTokens, outputTokens).split(' / ');
  return `${time} · ${t('in', '輸入')} ${input} / ${t('out', '輸出')} ${output}`;
}
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
const sentIds = computed(() =>
  (data.value?.outcome?.delivery?.parts ?? []).flatMap(({ messageId, ok }) =>
    ok && messageId ? [messageId] : [],
  ),
);
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
      <p v-if="sentIds.length" class="muted delivery-ids">
        <span>{{ t('Sent message IDs', '已傳送訊息 ID') }}</span>
        <code v-for="(messageId, index) in sentIds" :key="index">{{
          messageId
        }}</code>
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
          <div v-if="lanes?.model.length" class="timing-lane">
            <span>{{ m.modelLane }}</span><TimingTrack
              :segments="lanes.model"
            />
          </div>
          <div v-if="lanes?.tools.length" class="timing-lane">
            <span>{{ m.toolLane }}</span><TimingTrack :segments="lanes.tools" />
          </div>
          <ul v-if="agentTiming" class="timing-labels agent-timing">
            <li>
              <span>{{ t('Agent run', '代理執行') }}</span>
              <strong>{{ duration(agentTiming.agentMs, locale) }}</strong>
            </li>
            <li>
              <span>{{ m.modelLane }}</span>
              <strong>{{ duration(agentTiming.modelMs, locale) }}</strong>
            </li>
            <li>
              <span>{{ m.toolLane }}</span>
              <strong>{{ duration(agentTiming.toolMs, locale) }}</strong>
            </li>
          </ul>
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
            <pre
              v-if="context.text !== undefined"
              class="code-block prose-block"
              >{{ context.text }}</pre>
            <p v-else class="detail-inset muted">
              {{ m.unavailable }} · {{ context.ref }}
            </p>
            <ContextMessageDetails
              v-if="context.message"
              :message="context.message"
            />
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
              <small
                v-for="gap in modelRows.get(event.seq)"
                :key="gap.startedAt"
                class="model-gap"
                >{{ modelLabel(gap) }}</small
              >
              <ConsoleTime :at="event.at" format="clock" />
              <span
                v-if="event.kind !== 'tool'"
                class="muted execution-offset"
                >{{ toolOffset(event.at - start) }}</span
              >
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
                <pre class="code-block prose-block">{{ event.data.text }}</pre>
              </details>
              <div v-else-if="event.kind === 'text'" class="transcript-text">
                <NuxtLink
                  v-if="event.seq === finalEvent"
                  class="section-link"
                  :to="{ hash: '#output' }"
                  >{{ t('See final output', '查看最終輸出') }} ↓</NuxtLink
                >
                <pre v-else class="code-block prose-block">{{
                  event.data.text
                }}</pre>
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
              <small
                v-for="gap in modelRows.get(undefined)"
                :key="gap.startedAt"
                class="model-gap"
                >{{ modelLabel(gap) }}</small
              >
              <ConsoleTime :at="task.finishedAt" format="clock" />
              <span
                v-if="task.finishedAt !== null"
                class="muted execution-offset"
                >{{ toolOffset(task.finishedAt - start) }}</span
              >
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
            <pre v-if="raw" class="code-block prose-block">{{
              data.output
            }}</pre>
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
                  {
                    new: m.sessionNew,
                    ephemeral: m.sessionEphemeral,
                    fork: m.sessionFork,
                    resumed: m.sessionResumed,
                  }[data.refs.session.mode]
                }}<small v-if="data.refs.session.sessionId"
                  ><code>{{ data.refs.session.sessionId }}</code></small
                ><small v-if="data.refs.session.previousSessionId"
                  ><code>{{ data.refs.session.previousSessionId }}</code></small
                ><small v-if="data.refs.session.reason">{{
                  data.refs.session.reason
                }}</small>
              </dd></template
            >
          </dl>
        </div>
        <div
          v-for="(run, index) in agentRuns"
          :key="index"
          class="summary-group"
        >
          <h3>
            {{ m.tokens
            }}<template v-if="agentRuns.length > 1">
              · {{ t('Run', '執行') }} {{ index + 1 }}</template
            >
          </h3>
          <dl class="key-values">
            <dt>{{ m.input }}</dt>
            <dd>{{ count(run.inputTokens) }}</dd>
            <dt>{{ t('Cached input', '快取輸入') }}</dt>
            <dd>{{ count(run.cachedInputTokens) }}</dd>
            <dt>{{ t('Cache write', '寫入快取') }}</dt>
            <dd>{{ count(run.cacheWriteTokens) }}</dd>
            <dt>{{ m.output }}</dt>
            <dd>{{ count(run.outputTokens) }}</dd>
            <dt>{{ m.cacheHit }}</dt>
            <dd>
              {{
                cacheHitRatio(run.inputTokens, run.cachedInputTokens, locale) ??
                '—'
              }}
            </dd>
          </dl>
          <template v-if="run.prompt">
            <h3>{{ t('Prompt', '提示詞') }}</h3>
            <dl class="key-values">
              <dt>{{ t('Resumed session', '延續工作階段') }}</dt>
              <dd>{{ run.prompt.resumed ? t('Yes', '是') : t('No', '否') }}</dd>
              <dt>{{ t('Tools', '工具') }}</dt>
              <dd>
                {{ number(run.prompt.toolCount) }} ·
                {{ number(run.prompt.toolsChars) }} {{ t('chars', '字元') }}
                <small
                  ><code>{{ run.prompt.toolsHash }}</code>
                  <template v-if="run.prompt.toolsChanged !== undefined">
                    ·
                    {{
                      run.prompt.toolsChanged
                        ? t('Changed', '已變更')
                        : t('Unchanged', '無變更')
                    }}
                  </template>
                </small>
              </dd>
              <dt>{{ t('Instructions', '指示') }}</dt>
              <dd>
                {{ number(run.prompt.instructionsChars) }}
                {{ t('chars', '字元') }}
                <small
                  ><code>{{ run.prompt.instructionsHash }}</code>
                  <template v-if="run.prompt.instructionsChanged !== undefined">
                    ·
                    {{
                      run.prompt.instructionsChanged
                        ? t('Changed', '已變更')
                        : t('Unchanged', '無變更')
                    }}
                  </template>
                </small>
              </dd>
              <dt>{{ t('Summary', '摘要') }}</dt>
              <dd>
                {{ number(run.prompt.summaryChars) }} {{ t('chars', '字元') }}
              </dd>
              <dt>{{ t('History', '歷史訊息') }}</dt>
              <dd>
                {{ number(run.prompt.historyChars) }} {{ t('chars', '字元') }}
              </dd>
              <dt>{{ t('New messages', '新訊息') }}</dt>
              <dd>
                {{ number(run.prompt.newChars) }} {{ t('chars', '字元') }}
              </dd>
              <dt>{{ t('Images', '圖片') }}</dt>
              <dd>{{ number(run.prompt.imageCount) }}</dd>
            </dl>
          </template>
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

<style scoped>
.delivery-ids {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.delivery-ids code {
  min-width: 0;
}
</style>
