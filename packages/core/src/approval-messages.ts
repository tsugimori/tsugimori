import type { Config } from '@tsugimori/config';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatRef,
  ScheduleApprovalRequest,
  TextEntity,
  TextRange,
} from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';

import {
  scheduleCadence,
  scheduleChatName,
  scheduleTime,
} from '@tsugimori/scheduler';

const catalogs = {
  en: {
    buttons: { once: 'Allow once', always: 'Always allow', deny: 'Deny' },
    decisions: {
      once: '✅ Allowed once',
      always: '✅ Always allowed',
      deny: '❌ Denied',
    },
    unavailable: 'Approval is unavailable.',
    reply: 'Reply directly to this message with “yes”, “always”, or “no”.',
    replyOnce: 'Reply directly to this message with “yes” or “no”.',
    title: 'Approval requested',
    create: { message: 'Schedule a reminder', agent: 'Schedule an agent task' },
    update: {
      message: 'Update a reminder',
      agent: 'Update a scheduled agent task',
    },
    actions: {
      'codex.command': 'Run a Codex command',
      'codex.file_change': 'Apply Codex file changes',
      'codex.permissions': 'Change Codex permissions',
      'workspace.configure': 'Change chat workspace settings',
    },
    chat: 'Location',
    recipient: 'Recipient',
    requester: 'Requested by',
    when: 'When',
    until: 'Until',
    content: 'Content',
    model: 'Model',
    path: 'Path',
    globalScope: 'Scope: Global',
    everyone: 'Everyone',
    unknownUser: 'Unknown user',
    reference: 'Ref',
    reason: 'Reason',
    reasons: {
      agent: 'The agent requested owner approval.',
      crossChat: 'This agent task reads one chat and delivers to another.',
      delivery: 'Delivery to this destination requires approval.',
      mentions: 'This will mention specific people.',
      frequency:
        'The schedule can run faster than the configured minimum interval.',
      model: 'The selected model requires owner approval.',
    },
    separator: ': ',
    reasonSeparator: '; ',
    names: ', ',
  },
  'zh-TW': {
    buttons: { once: '允許一次', always: '一律允許', deny: '拒絕' },
    decisions: {
      once: '✅ 已允許一次',
      always: '✅ 已設為一律允許',
      deny: '❌ 已拒絕',
    },
    unavailable: '這項審核已無法處理。',
    reply: '請直接回覆這則訊息，輸入「允許一次」、「一律允許」或「拒絕」。',
    replyOnce: '請直接回覆這則訊息，輸入「允許一次」或「拒絕」。',
    title: '需要你同意',
    create: { message: '排程提醒', agent: '排程代理任務' },
    update: { message: '修改排程提醒', agent: '修改排程代理任務' },
    actions: {
      'codex.command': '執行 Codex 指令',
      'codex.file_change': '套用 Codex 檔案變更',
      'codex.permissions': '變更 Codex 權限',
      'workspace.configure': '變更聊天室工作區設定',
    },
    chat: '位置',
    recipient: '對象',
    requester: '發起',
    when: '時間',
    until: '截止',
    content: '內容',
    model: '模型',
    path: '路徑',
    globalScope: '範圍：全域',
    everyone: '大家',
    unknownUser: '未知使用者',
    reference: '識別碼',
    reason: '原因',
    reasons: {
      agent: '代理程式要求主人審核。',
      crossChat: '這項代理任務會讀取一個聊天室的內容，並傳送到另一個聊天室。',
      delivery: '傳送到這個位置需要同意。',
      mentions: '會提及特定的人',
      frequency: '這項排程的執行間隔可能短於設定的下限。',
      model: '所選模型需要主人授權。',
    },
    separator: '：',
    reasonSeparator: '；',
    names: '、',
  },
};

export function approvalMessages(locale: Config['locale']) {
  return catalogs[locale];
}

export function approvalDecisionText(
  locale: Config['locale'],
  decision: ApprovalDecision | undefined,
) {
  const messages = approvalMessages(locale);
  if (!decision) return { notice: messages.unavailable };
  const notice = messages.decisions[decision];
  return { notice, decisionText: notice };
}

function withoutPings(text: string) {
  return text
    .replace(/@(?=[a-z0-9_])/gi, '＠')
    .replace(/[\r\n\u2028\u2029]+/g, ' ');
}

export function approvalPrompt({
  chat,
  locale,
  now = Date.now(),
  request,
  requester,
  schedule,
  store,
  useButtons,
}: {
  chat: ChatRef;
  locale: Config['locale'];
  now?: number;
  request: ApprovalRequest;
  requester?: string;
  schedule?: ScheduleApprovalRequest;
  store: Store;
  useButtons: boolean;
}): { entities: TextEntity[]; pre?: TextRange; text: string } {
  const m = approvalMessages(locale);
  const entities: TextEntity[] = [];
  const field = (label: string, value: string) => label + m.separator + value;
  const withContent = (lines: string[], content?: string) => {
    const header = lines.join('\n');
    if (!content) return { text: header, entities };
    const prefix = header + '\n' + m.content + m.separator.trimEnd() + '\n';
    const pre = { offset: prefix.length, length: content.length };
    entities.push({ ...pre, type: 'pre' });
    return {
      text: prefix + content,
      entities,
      pre,
    };
  };
  if (!schedule) {
    const { action, description, resource } = request;
    const target = resource.type === 'chat' ? resource : chat;
    const title = Object.hasOwn(m.actions, action)
      ? m.actions[action as keyof typeof m.actions]
      : action;
    const reference =
      resource.type === 'project'
        ? resource.id.slice(0, 12)
        : resource.type === 'chat'
          ? target.chatId
          : undefined;
    return withContent(
      [
        field(m.title, title),
        field(m.chat, withoutPings(scheduleChatName(store, target, locale))),
        ...(resource.type === 'path'
          ? [field(m.path, withoutPings(resource.path))]
          : []),
        ...(resource.type === 'global' ? [m.globalScope] : []),
        ...(reference ? [field(m.reference, reference)] : []),
        ...(useButtons ? [] : [m.reply]),
      ],
      description,
    );
  }

  const { recipients, timezone } = schedule;
  const date = (timestamp: number) =>
    scheduleTime(timestamp, timezone, locale, now);
  const title = field('🔔 ' + m.title, m[schedule.operation][schedule.kind]);
  const recipientsPrefix = field(m.recipient, '');
  let names = '';
  for (const { name, userId } of recipients) {
    if (names) names += m.names;
    const user = userId
      ? store.getUser({ adapterId: schedule.target.adapterId, userId })
      : undefined;
    const display = user?.display || name;
    const label = display
      ? withoutPings(display.startsWith('@') ? display : '@' + display)
      : m.unknownUser;
    if (userId && (display || user?.username))
      entities.push({
        type: 'mention',
        userId,
        offset: title.length + 1 + recipientsPrefix.length + names.length,
        length: label.length,
      });
    names += label;
  }
  const lines = [
    title,
    recipientsPrefix + (names || m.everyone),
    field(
      m.when,
      date(schedule.dueAt) + scheduleCadence(schedule.repeat, locale),
    ),
    field(
      m.chat,
      withoutPings(
        scheduleChatName(store, schedule.target, locale, schedule.targetUserId),
      ),
    ),
    field(m.requester, withoutPings(requester || m.unknownUser)),
  ];
  if (schedule.until !== undefined)
    lines.push(field(m.until, date(schedule.until)));
  if (schedule.model) lines.push(field(m.model, withoutPings(schedule.model)));
  const reasons = schedule.reasons
    .filter((reason) => reason !== 'agent')
    .map((reason) => {
      const mentions =
        reason === 'delivery' &&
        recipients.length > 0 &&
        !schedule.targetUserId;
      return m.reasons[mentions ? 'mentions' : reason];
    });
  if (schedule.agentReason) {
    const reason = schedule.agentReason.replace(
      /\b(?:Telegram\s+)?(?:user\s+)?ID\s*[:：=]?\s*([1-9]\d{0,19})\b/gi,
      (_match, userId: string) =>
        store.getUserDisplay({
          adapterId: schedule.target.adapterId,
          userId,
        }) || m.unknownUser,
    );
    const description = withoutPings(reason).replace(/\s+/g, ' ').trim();
    if (description) reasons.push(description);
  }
  const withoutPeriod = (reason: string) => reason.replace(/[.。]+$/u, '');
  const unique = new Map<string, string>();
  for (const reason of reasons) {
    const key = withoutPeriod(reason);
    if (key && key !== withoutPeriod(m.reasons.agent) && !unique.has(key))
      unique.set(key, reason);
  }
  const specific = [...unique.values()];
  lines.push(
    field(
      m.reason,
      specific.length
        ? specific
            .map((reason, index) =>
              index === specific.length - 1 ? reason : withoutPeriod(reason),
            )
            .join(m.reasonSeparator)
        : m.reasons.agent,
    ),
  );
  if (!useButtons)
    lines.push(schedule.operation === 'update' ? m.replyOnce : m.reply);
  return withContent(lines, schedule.content);
}
