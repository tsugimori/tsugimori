import type {
  AgentQuotaWindow,
  ChatRef,
  TextEntity,
} from '@tsugimori/plugin-sdk';
import type { ScheduleAddress, Store } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { defaultCompactAt } from '@tsugimori/plugin-sdk';
import { scheduleRef } from '@tsugimori/scheduler';

import type { AttachmentStatus, Runtime } from './runtime.ts';
import type { Tasks } from './tasks.ts';

import { gatewayBuild } from './version.ts';

const messages = {
  en: {
    uptime: (age: string, time: string) => `up ${age} (started ${time})`,
    chat: 'This chat',
    labelSeparator: ': ',
    model: 'Model',
    effort: 'Effort',
    fast: 'Fast',
    fastOn: 'on',
    fastOff: 'off',
    default: (value: string) => `${value} (default)`,
    unset: 'default',
    context: 'Context',
    contextUsage: (counts: string, percent: number) =>
      `${counts} (${percent}%)`,
    quota: 'Quota',
    quotaDaily: 'daily ',
    quotaWeekly: 'weekly ',
    quotaHours: (hours: number) => `${hours}h `,
    quotaMinutes: (minutes: number) => `${minutes}m `,
    quotaLeft: (percent: number) => `${percent}% left`,
    quotaReset: (time: string) => `, resets ${time}`,
    quotaReached: 'limit reached',
    unknown: 'unknown',
    compaction: 'Last compaction',
    compactionCount: (count: number) => `${count} total`,
    session: 'Session',
    sessionAge: (age: string) => `active for ${age}`,
    modes: {
      manual: 'manual',
      'post-turn': 'post-turn',
      async: 'auto (async)',
      native: 'auto',
    },
    summary: 'Summary',
    covered: (count: number, time: string) =>
      `${count} ${count === 1 ? 'message' : 'messages'}, updated ${time}`,
    work: 'Work',
    stages: {
      preparing: 'preparing',
      context: 'assembling context',
      agent: 'running agent',
      approval: 'waiting for approval',
      compaction: 'compacting',
      delivery: 'sending',
      recording: 'recording workspace',
    },
    running: 'running',
    runningFor: (duration: string, stage: string) =>
      `running for ${duration} (${stage})`,
    queued: (count: number) => `${count} queued`,
    approvals: 'Approvals',
    pending: (chat: number, total: number) => `${chat} here / ${total} total`,
    expires: (time: string) => `, earliest expiry ${time}`,
    lastApproval: 'Last approval',
    decisions: { approved: 'approved', denied: 'denied', expired: 'expired' },
    schedules: 'Schedules',
    active: (count: number) => `${count} active`,
    failed: 'failed',
    due: (time: string) => `, next ${time}`,
    system: 'System',
    componentSeparator: ', ',
    disabled: 'disabled',
    unavailable: 'unavailable',
    starting: 'starting',
    retrying: (attempt: number) => `retrying (attempt ${attempt})`,
    nextRetry: (time: string) => `, next retry ${time}`,
    sandbox: (enabled: boolean) =>
      `Sandbox ${enabled ? 'enabled' : 'disabled'}`,
    healthy: 'checks passing',
    failing: (count: number) =>
      `${count} ${count === 1 ? 'check' : 'checks'} failing`,
    units: ['d', 'h', 'm', 's'],
  },
  'zh-TW': {
    uptime: (age: string, time: string) => `已運作 ${age}（${time} 啟動）`,
    chat: '此聊天室',
    labelSeparator: '：',
    model: '模型',
    effort: '推理',
    fast: '快速',
    fastOn: '開',
    fastOff: '關',
    default: (value: string) => `${value}（預設）`,
    unset: '預設',
    context: '上下文',
    contextUsage: (counts: string, percent: number) =>
      `${counts}（${percent}%）`,
    quota: '額度',
    quotaDaily: '每日',
    quotaWeekly: '每週',
    quotaHours: (hours: number) => `${hours} 小時 `,
    quotaMinutes: (minutes: number) => `${minutes} 分鐘 `,
    quotaLeft: (percent: number) => `剩 ${percent}%`,
    quotaReset: (time: string) => `，${time} 重置`,
    quotaReached: '已達上限',
    unknown: '未知',
    compaction: '上次壓縮',
    compactionCount: (count: number) => `共 ${count} 次`,
    session: '對話',
    sessionAge: (age: string) => `已持續 ${age}`,
    modes: {
      manual: '手動',
      'post-turn': '回合後',
      async: '自動（非同步）',
      native: '自動',
    },
    summary: '摘要',
    covered: (count: number, time: string) => `${count} 則訊息，${time} 更新`,
    work: '工作',
    stages: {
      preparing: '準備中',
      context: '組裝上下文',
      agent: '代理程式執行中',
      approval: '等待核准',
      compaction: '壓縮中',
      delivery: '傳送中',
      recording: '記錄工作區',
    },
    running: '運作中',
    runningFor: (duration: string, stage: string) =>
      `執行中 ${duration}（${stage}）`,
    queued: (count: number) => `${count} 則排隊`,
    approvals: '待核准',
    pending: (chat: number, total: number) =>
      `此聊天室 ${chat} 件／共 ${total} 件`,
    expires: (time: string) => `，最早 ${time} 到期`,
    lastApproval: '最近核准結果',
    decisions: { approved: '已核准', denied: '已拒絕', expired: '已逾時' },
    schedules: '排程',
    active: (count: number) => `${count} 項啟用`,
    failed: '失敗',
    due: (time: string) => `，下次 ${time}`,
    system: '系統',
    componentSeparator: '、',
    disabled: '已停用',
    unavailable: '無法使用',
    starting: '啟動中',
    retrying: (attempt: number) => `重試中（第 ${attempt} 次）`,
    nextRetry: (time: string) => `，下次 ${time}`,
    sandbox: (enabled: boolean) => `沙箱${enabled ? '已啟用' : '已停用'}`,
    healthy: '環境檢查正常',
    failing: (count: number) => `環境檢查 ${count} 項未通過`,
    units: [' 天', ' 小時', ' 分鐘', ' 秒'],
  },
};

const separator = ' · ';
const maxStatusLength = 4_096;

interface StatusDependencies {
  build?: { revision?: string; version: string };
  runtime: Pick<Runtime, 'attachments' | 'config' | 'environmentReports'>;
  sandboxEnabled: boolean;
  showRecentApproval?: boolean;
  startedAt: number;
  store: Pick<Store, 'approvalStatus' | 'getSummaryStatus' | 'scheduleStatus'>;
  tasks: Pick<Tasks, 'status'>;
  trace: Pick<Tracer, 'latestSessionSpan' | 'sessionHistory'>;
}

export function statusCard(
  {
    build = gatewayBuild,
    runtime,
    sandboxEnabled,
    showRecentApproval,
    startedAt,
    store,
    tasks,
    trace,
  }: StatusDependencies,
  chat: ChatRef,
  target: ScheduleAddress,
  now = Date.now(),
) {
  const { locale, timezone } = runtime.config;
  const m = messages[locale];
  const { format } = new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: timezone,
    hourCycle: 'h23',
  });
  const today = format(now).slice(0, 10);
  const date = (timestamp: number) => {
    const local = format(timestamp);
    const clock = local.slice(-5);
    return local.startsWith(today)
      ? clock
      : `${local.slice(5, 10).replace('-', '/')} ${clock}`;
  };
  const elapsed = (from: number) => duration(now - from, m.units);
  const tokenCount = (value: unknown) =>
    typeof value === 'number' ? compactTokens(value) : m.unknown;
  const entities: TextEntity[] = [];
  let text = '';
  let hasChat = false;

  function bold(label: string) {
    entities.push({ type: 'bold', offset: text.length, length: label.length });
    text += label;
  }
  function section(icon: string, title: string) {
    text += `\n\n${icon} `;
    bold(title);
  }
  function field(label: string, ...details: string[]) {
    if (!hasChat) {
      section('💬', m.chat);
      hasChat = true;
    }
    text += '\n';
    inlineField(label, details.filter(Boolean).join(separator));
  }
  function inlineField(label: string, value: string) {
    bold(label);
    text += m.labelSeparator + value;
  }

  const { platforms, agents } = runtime.attachments;
  const components = [
    ...platforms.map((entry) => ({ name: entry.id, entry })),
    ...agents.map((entry) => ({ name: agentName(entry), entry })),
  ];
  const failures = runtime.environmentReports.filter(
    ({ status }) => status === 'fail',
  ).length;
  const health = components.some(({ entry }) => entry.state === 'unavailable')
    ? '🔴'
    : failures ||
        components.some(
          ({ entry }) =>
            entry.state === 'starting' || entry.state === 'retrying',
        )
      ? '🟡'
      : '🟢';
  text = `${health} `;
  bold('tsugimori');
  if (build.version !== '0.0.0') text += ` v${build.version}`;
  if (build.revision) text += ` ${build.revision}`;
  text += separator + m.uptime(elapsed(startedAt), date(startedAt));

  const work = tasks.status(chat);
  const { agentId, defaults, quota, serviceTier, thinking } = work;
  if (agentId) {
    const agent = agents.find(({ id }) => id === agentId);
    field('Agent', agent ? agentName(agent) : agentId);
    const model = work.model === 'default' ? undefined : work.model;
    const setting = (override?: string, fallback?: string) =>
      override || (fallback ? m.default(fallback) : m.unset);
    field(m.model, setting(model, defaults?.model));
    text += separator;
    inlineField(m.effort, setting(thinking, defaults?.effort));
    text += separator;
    inlineField(
      m.fast,
      fastMode(
        serviceTier === undefined ? defaults?.serviceTier : serviceTier,
        m,
      ),
    );

    const scope = work.sessionScope;
    const usage = scope ? trace.latestSessionSpan(scope, 'context') : undefined;
    const used = usage?.attrs.contextTokens;
    const window = scope
      ? trace.latestSessionSpan(scope, 'contextWindow')?.attrs.contextWindow
      : undefined;
    const limit =
      typeof window === 'number' && window > 0
        ? window
        : (work.compactAt ?? defaultCompactAt);
    field(
      m.context,
      typeof used === 'number'
        ? m.contextUsage(
            `${tokenCount(used)} / ${tokenCount(limit)}`,
            Math.round((100 * used) / limit),
          )
        : m.unknown,
    );
    if (quota) {
      const details = [
        quotaWindow(quota.primary, m, date),
        quotaWindow(quota.secondary, m, date),
        quota.rateLimitReachedType ? m.quotaReached : '',
      ].filter(Boolean);
      if (details.length) field(m.quota, ...details);
    }
    const history = scope ? trace.sessionHistory(scope) : undefined;
    if (history) {
      const since = history.createdAt ?? history.firstActivityAt;
      field(
        m.session,
        since === undefined
          ? m.unknown
          : m.sessionAge(duration(now - since, m.units, true)),
      );
    }
    const compacted = scope
      ? trace.latestSessionSpan(scope, 'compaction')
      : undefined;
    if (compacted) {
      const { trigger, tokensBefore, tokensAfter } = compacted.attrs;
      const mode =
        typeof trigger === 'string' && Object.hasOwn(m.modes, trigger)
          ? m.modes[trigger as keyof typeof m.modes]
          : m.unknown;
      field(
        m.compaction,
        date(compacted.endedAt),
        mode,
        `${tokenCount(tokensBefore)} → ${tokenCount(tokensAfter)}`,
        history?.compactions ? m.compactionCount(history.compactions) : '',
      );
    }
  }
  const summary = store.getSummaryStatus(chat);
  if (summary)
    field(
      m.summary,
      m.covered(
        summary.messages,
        summary.updatedAt === null ? m.unknown : date(summary.updatedAt),
      ),
    );

  const { running, queued } = work;
  if (running || queued) {
    field(
      m.work,
      running
        ? m.runningFor(elapsed(running.startedAt), m.stages[running.stage])
        : '',
      queued ? m.queued(queued) : '',
    );
  }

  const approvals = store.approvalStatus(chat, now, showRecentApproval);
  if (approvals.total)
    field(
      m.approvals,
      m.pending(approvals.chat, approvals.total) +
        (approvals.nextExpiry === null
          ? ''
          : m.expires(date(approvals.nextExpiry))),
    );
  const latest = approvals.latest;
  if (
    latest &&
    (latest.status === 'approved' ||
      latest.status === 'denied' ||
      latest.status === 'expired')
  )
    field(
      m.lastApproval,
      m.decisions[latest.status],
      latest.failureReason ?? '',
    );

  const { count, next, failed } = store.scheduleStatus(chat.adapterId, target);
  if (count || failed) {
    let details = m.active(count);
    if (next?.nextDueAt != null) {
      const { action } = next;
      const content = shortText(
        action.kind === 'message' ? action.text : action.prompt,
        30,
      );
      details += `${m.due(date(next.nextDueAt))} #${scheduleRef(next.id)}`;
      if (content) details += ` ${content}`;
    }
    field(
      m.schedules,
      details,
      failed ? `#${scheduleRef(failed.id)} ${m.failed}` : '',
      failed?.failureReason ?? '',
    );
  }

  section('🖥', m.system);
  const runningNames = components
    .filter(({ entry }) => entry.state === 'running')
    .map(({ name }) => name);
  if (runningNames.length)
    text += `\n${runningNames.join(m.componentSeparator)} ${m.running}`;
  for (const { name, entry } of components) {
    if (entry.state !== 'running')
      text += `\n${name} ${attachmentState(entry, m, locale, date, now)}`;
  }
  text += `\n${m.sandbox(sandboxEnabled)}${separator}${failures ? m.failing(failures) : m.healthy}`;

  if (text.length > maxStatusLength) {
    const prefix = text
      .slice(0, maxStatusLength - 1)
      .replace(/[\uD800-\uDBFF]$/u, '');
    return {
      text: prefix + '…',
      entities: entities.filter(
        ({ offset, length }) => offset + length <= prefix.length,
      ),
      parseTextMentions: false,
    };
  }
  return { text, entities, parseTextMentions: false };
}

type StatusMessages = (typeof messages)[keyof typeof messages];

function agentName({
  id,
  implementation,
  kind,
}: Runtime['attachments']['agents'][number]) {
  const name = implementation || kind;
  return id === kind ? name : `${id}${separator}${name}`;
}

function attachmentState(
  entry: AttachmentStatus,
  m: StatusMessages,
  locale: Runtime['config']['locale'],
  date: (timestamp: number) => string,
  now: number,
) {
  if (entry.state === 'retrying')
    return (
      m.retrying(entry.attempt) +
      (entry.retryAt >= now ? m.nextRetry(date(entry.retryAt)) : '')
    );
  if (entry.state === 'unavailable') {
    const { failure } = entry;
    const localized =
      locale === 'zh-TW' ? failure?.localized?.[locale] : undefined;
    const reason = localized?.detail ?? localized?.hint ?? failure?.detail;
    return reason
      ? `${m.unavailable}${separator}${shortText(reason, 72)}`
      : m.unavailable;
  }
  return m[entry.state];
}

function fastMode(tier: string | null | undefined, m: StatusMessages) {
  switch (tier) {
    case undefined:
    case null:
    case '':
      return m.unset;
    case 'fast':
    case 'priority':
      return m.fastOn;
    case 'default':
      return m.fastOff;
    default:
      return tier;
  }
}

function quotaWindow(
  window: AgentQuotaWindow | undefined,
  m: StatusMessages,
  date: (timestamp: number) => string,
) {
  if (!window || window.usedPercent === undefined) return '';
  const { windowDurationMins: minutes, resetsAt } = window;
  let label = '';
  if (minutes === 10_080) label = m.quotaWeekly;
  else if (minutes === 1_440) label = m.quotaDaily;
  else if (minutes !== undefined && minutes > 0)
    label =
      minutes % 60 === 0 ? m.quotaHours(minutes / 60) : m.quotaMinutes(minutes);

  const left = Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
  const reset =
    resetsAt !== undefined && Math.abs(resetsAt) <= 8.64e12
      ? m.quotaReset(date(resetsAt * 1_000))
      : '';
  return label + m.quotaLeft(left) + reset;
}

function compactTokens(tokens: number) {
  if (tokens < 1_000) return String(tokens);
  const millions = tokens >= 999_500;
  const scaled = tokens / (millions ? 1_000_000 : 1_000);
  const rounded =
    scaled < 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
  return `${rounded}${millions ? 'M' : 'k'}`;
}

function duration(ms: number, units: string[], roundMinutes = false) {
  let seconds = Math.max(0, Math.floor(ms / 1_000));
  if (roundMinutes && seconds >= 60) seconds = Math.round(seconds / 60) * 60;
  const values = (
    seconds >= 60 ? [86_400, 3_600, 60] : [86_400, 3_600, 60, 1]
  ).map((unit, index) => {
    const value = Math.floor(seconds / unit);
    seconds %= unit;
    return value ? `${value}${units[index]}` : '';
  });
  return values.filter(Boolean).slice(0, 2).join(' ') || `0${units[3]}`;
}

function shortText(text: string, limit: number) {
  const compact = text.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(compact);
  return characters.length > limit
    ? characters.slice(0, limit - 1).join('') + '…'
    : compact;
}
