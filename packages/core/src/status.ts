import type {
  AgentQuotaWindow,
  ChatRef,
  TextEntity,
} from '@tsugimori/plugin-sdk';
import type { ScheduleAddress, Store } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { defaultCompactAt } from '@tsugimori/plugin-sdk';
import { scheduleRecordTime, scheduleRef } from '@tsugimori/scheduler';

import type { AttachmentStatus, Runtime } from './runtime.ts';
import type { Tasks } from './tasks.ts';

import { gatewayVersion } from './version.ts';

const messages = {
  en: {
    gateway: 'Gateway',
    uptime: 'up',
    started: 'Started',
    chat: 'This chat',
    model: 'Model',
    effort: 'Effort',
    fastOn: 'Fast on',
    fastOff: 'Fast off',
    fastDefault: 'Fast default',
    speed: 'Speed',
    fieldSeparator: ' | ',
    default: (value: string) => `${value} (default)`,
    unset: 'default',
    context: 'Context',
    quota: 'Quota',
    quotaDaily: 'daily',
    quotaWeekly: 'weekly',
    quotaHours: (hours: number) => `${hours}h`,
    quotaMinutes: (minutes: number) => `${minutes}m`,
    quotaLeft: (percent: number) => `${percent}% left`,
    quotaReset: (time: string) => ` (resets ${time})`,
    quotaReached: 'limit reached',
    unknown: 'unknown',
    tokens: 'tokens',
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
    covered: (count: number) =>
      `${count} ${count === 1 ? 'message' : 'messages'}`,
    updated: 'updated',
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
    runningTotal: (count: number) => `${count} running total`,
    approvals: 'Approvals',
    pending: (chat: number, total: number) => `${chat} here / ${total} total`,
    expires: 'next expiry',
    lastApproval: 'Last approval',
    decisions: { approved: 'approved', denied: 'denied', expired: 'expired' },
    schedules: 'Schedules',
    active: (count: number) => `${count} active`,
    failed: 'failed',
    due: 'next due',
    platforms: 'Platforms',
    agents: 'Agents',
    unavailable: 'unavailable',
    starting: 'starting',
    retrying: (attempt: number) => `retrying (attempt ${attempt})`,
    nextRetry: 'next retry',
    sandbox: 'Exec sandbox',
    enabled: 'enabled',
    disabled: 'disabled',
    health: 'Health',
    healthy: 'all checks passed',
    failing: (count: number) =>
      `${count} failing ${count === 1 ? 'check' : 'checks'}`,
    units: ['d', 'h', 'm', 's'],
  },
  'zh-TW': {
    gateway: '閘道器',
    uptime: '已運作',
    started: '啟動時間',
    chat: '此聊天室',
    model: '模型',
    effort: '推理強度',
    fastOn: '快速模式 開',
    fastOff: '快速模式 關',
    fastDefault: '快速模式 預設',
    speed: '速度',
    fieldSeparator: '｜',
    default: (value: string) => `${value}（預設）`,
    unset: '預設',
    context: '上下文',
    quota: '額度',
    quotaDaily: '每日',
    quotaWeekly: '每週',
    quotaHours: (hours: number) => `${hours} 小時`,
    quotaMinutes: (minutes: number) => `${minutes} 分鐘`,
    quotaLeft: (percent: number) => `剩 ${percent}%`,
    quotaReset: (time: string) => `（${time} 重置）`,
    quotaReached: '已達上限',
    unknown: '未知',
    tokens: 'tokens',
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
    summary: '對話摘要',
    covered: (count: number) => `涵蓋 ${count} 則訊息`,
    updated: '更新時間',
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
      `已執行 ${duration}（${stage}）`,
    queued: (count: number) => `${count} 則排隊中`,
    runningTotal: (count: number) => `共 ${count} 個任務執行中`,
    approvals: '待核准',
    pending: (chat: number, total: number) =>
      `此聊天室 ${chat} 件／共 ${total} 件`,
    expires: '最早到期',
    lastApproval: '最近核准結果',
    decisions: { approved: '已核准', denied: '已拒絕', expired: '已逾時' },
    schedules: '排程',
    active: (count: number) => `${count} 項啟用`,
    failed: '失敗',
    due: '下次執行',
    platforms: '平台',
    agents: '代理程式',
    unavailable: '無法使用',
    starting: '啟動中',
    retrying: (attempt: number) => `重試中（第 ${attempt} 次）`,
    nextRetry: '下次重試',
    sandbox: '執行沙箱',
    enabled: '已啟用',
    disabled: '已停用',
    health: '環境檢查',
    healthy: '全部正常',
    failing: (count: number) => `${count} 項未通過`,
    units: [' 天', ' 小時', ' 分鐘', ' 秒'],
  },
};

interface StatusDependencies {
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
  const { locale = 'en', timezone } = runtime.config;
  const m = messages[locale];
  const { format: formatNumber } = new Intl.NumberFormat(locale);
  // Use the same unambiguous numeric date in both locales.
  const { format: date } = new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: timezone,
    hourCycle: 'h23',
  });
  const elapsed = (from: number) => duration(now - from, m.units);
  const tokenCount = (value: unknown) =>
    typeof value === 'number' ? formatNumber(value) : m.unknown;
  const entities: TextEntity[] = [];
  let text = '';
  function line(label: string, ...details: string[]) {
    if (text) text += '\n';
    entities.push({ type: 'bold', offset: text.length, length: label.length });
    text += [label, ...details.filter(Boolean)].join(' · ');
  }
  function attachment(entry: AttachmentStatus) {
    const { id, state } = entry;
    let detail: string;
    if (state === 'retrying')
      detail = [
        m.retrying(entry.attempt),
        entry.retryAt >= now && `${m.nextRetry} ${date(entry.retryAt)}`,
      ]
        .filter(Boolean)
        .join(' · ');
    else if (state === 'unavailable') {
      const { failure } = entry;
      const localized =
        locale === 'zh-TW' ? failure?.localized?.[locale] : undefined;
      const reason = localized?.detail ?? localized?.hint ?? failure?.detail;
      detail = reason
        ? `${m.unavailable} · ${shortText(reason, 72)}`
        : m.unavailable;
    } else detail = m[state];
    return `${id} ${detail}`;
  }

  line(m.gateway, `v${gatewayVersion}`, `${m.uptime} ${elapsed(startedAt)}`);
  line(m.started, `${date(startedAt)} (${timezone})`);
  const work = tasks.status(chat);
  const { agentId, defaults, quota, serviceTier, thinking } = work;
  if (agentId) {
    const model = work.model === 'default' ? undefined : work.model;
    const setting = (
      override: string | undefined,
      fallback: string | undefined,
      limit: number,
    ) => {
      if (override) return shortText(override, limit);
      if (fallback) return m.default(shortText(fallback, limit));
      return m.unset;
    };
    line(
      m.chat,
      [
        `Agent ${agentId}`,
        `${m.model} ${setting(model, defaults?.model, 80)}`,
        `${m.effort} ${setting(thinking, defaults?.effort, 30)}`,
        fastMode(
          serviceTier === undefined ? defaults?.serviceTier : serviceTier,
          m,
        ),
      ].join(m.fieldSeparator),
    );
    const scope = work.sessionScope;
    const usage = scope ? trace.latestSessionSpan(scope, 'context') : undefined;
    const used = usage?.attrs.contextTokens;
    const limit = work.compactAt ?? defaultCompactAt;
    line(
      m.context,
      typeof used === 'number'
        ? `${formatNumber(used)} / ${formatNumber(limit)} ${m.tokens} (${formatNumber(Math.round((100 * used) / limit))}%)`
        : m.unknown,
    );
    if (quota) {
      const details = [
        quotaWindow(quota.primary, m, date, now),
        quotaWindow(quota.secondary, m, date, now),
        quota.rateLimitReachedType ? m.quotaReached : '',
      ]
        .filter(Boolean)
        .join(' · ');
      if (details)
        line(
          m.quota,
          locale === 'zh-TW' ? details.replaceAll('） · ', '）· ') : details,
        );
    }
    const compacted = scope
      ? trace.latestSessionSpan(scope, 'compaction')
      : undefined;
    const history = scope ? trace.sessionHistory(scope) : undefined;
    if (compacted) {
      const { trigger, tokensBefore, tokensAfter } = compacted.attrs;
      const mode =
        typeof trigger === 'string' && Object.hasOwn(m.modes, trigger)
          ? m.modes[trigger as keyof typeof m.modes]
          : m.unknown;
      line(
        m.compaction,
        date(compacted.endedAt),
        mode,
        `${tokenCount(tokensBefore)} → ${tokenCount(tokensAfter)} ${m.tokens}`,
        history?.compactions ? m.compactionCount(history.compactions) : '',
      );
    }
    if (history) {
      const since = history.createdAt ?? history.firstActivityAt;
      line(
        m.session,
        since === undefined ? m.unknown : m.sessionAge(elapsed(since)),
      );
    }
  }
  const summary = store.getSummaryStatus(chat);
  if (summary)
    line(
      m.summary,
      m.covered(summary.messages),
      `${m.updated} ${summary.updatedAt === null ? m.unknown : date(summary.updatedAt)}`,
    );

  const { running, queued, totalRunning } = work;
  if (running || queued || totalRunning) {
    line(
      m.work,
      running
        ? m.runningFor(elapsed(running.startedAt), m.stages[running.stage])
        : '',
      m.queued(queued),
      m.runningTotal(totalRunning),
    );
  }

  const approvals = store.approvalStatus(chat, now, showRecentApproval);
  if (approvals.total)
    line(
      m.approvals,
      m.pending(approvals.chat, approvals.total),
      approvals.nextExpiry === null
        ? ''
        : `${m.expires} ${date(approvals.nextExpiry)}`,
    );
  const latest = approvals.latest;
  if (
    latest &&
    (latest.status === 'approved' ||
      latest.status === 'denied' ||
      latest.status === 'expired')
  )
    line(
      m.lastApproval,
      m.decisions[latest.status],
      latest.failureReason ?? '',
    );

  const schedules = store.scheduleStatus(chat.adapterId, target);
  if (schedules.count || schedules.failed) {
    const { next, failed } = schedules;
    let details = '';
    if (next?.nextDueAt != null) {
      const time =
        next.trigger.kind === 'once'
          ? `${m.due} ${date(next.nextDueAt)}`
          : scheduleRecordTime(next, locale, now);
      const { action } = next;
      const content = shortText(
        action.kind === 'message' ? action.text : action.prompt,
        30,
      );
      details = `#${scheduleRef(next.id)} · ${time} · ${content}`;
    }
    line(
      m.schedules,
      m.active(schedules.count),
      details,
      failed ? `#${scheduleRef(failed.id)} ${m.failed}` : '',
      failed?.failureReason ?? '',
    );
  }

  const { platforms, agents } = runtime.attachments;
  if (platforms.length)
    line(m.platforms, platforms.map(attachment).join(' | '));
  if (agents.length) line(m.agents, agents.map(attachment).join(' | '));
  line(m.sandbox, sandboxEnabled ? m.enabled : m.disabled);

  const failures = runtime.environmentReports.filter(
    ({ status }) => status === 'fail',
  );
  if (failures.length) {
    const names = failures.map(({ title, localized }) =>
      shortText(
        (locale === 'zh-TW' ? localized?.[locale]?.title : undefined) ?? title,
        40,
      ),
    );
    line(
      m.health,
      m.failing(failures.length),
      names.join(locale === 'zh-TW' ? '、' : ' | '),
    );
  } else line(m.health, m.healthy);
  return { text, entities, parseTextMentions: false };
}

type StatusMessages = (typeof messages)[keyof typeof messages];

function fastMode(tier: string | null | undefined, m: StatusMessages) {
  switch (tier) {
    case undefined:
    case null:
    case '':
      return m.fastDefault;
    case 'fast':
    case 'priority':
      return m.fastOn;
    case 'default':
      return m.fastOff;
    default:
      return `${m.speed} ${shortText(tier, 30)}`;
  }
}

function quotaWindow(
  window: AgentQuotaWindow | undefined,
  m: StatusMessages,
  date: (timestamp: number) => string,
  now: number,
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
  let reset = '';
  if (resetsAt !== undefined && Math.abs(resetsAt) <= 8.64e12) {
    const [day, clock] = date(resetsAt * 1_000).split(' ');
    const time = clock!.slice(0, 5);
    const stamp =
      day === date(now).slice(0, 10)
        ? time
        : `${day!.slice(5).replace('-', '/')} ${time}`;
    reset = m.quotaReset(stamp);
  }
  return [label, m.quotaLeft(left) + reset].filter(Boolean).join(' ');
}

function duration(ms: number, units: string[]) {
  let seconds = Math.max(0, Math.floor(ms / 1_000));
  const values = [86_400, 3_600, 60, 1].map((unit, index) => {
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
