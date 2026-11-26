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
    buttons: {
      once: 'Allow once',
      always: 'Always allow (this recurring schedule)',
      deny: 'Deny',
    },
    outcomes: {
      denied: 'The request was denied.',
      completed: 'The approved action completed.',
      failed: 'The approved action could not be completed.',
      interrupted:
        'The agent turn ended before it could carry out the approved action. Please submit a new request.',
      scheduleCreated: (ref: string) => `Schedule #${ref} was created.`,
      scheduleUpdated: (ref: string) => `Schedule #${ref} was updated.`,
      scheduleDenied: (ref: string) =>
        `Approval for schedule #${ref} was denied.`,
      scheduleFailed: (ref: string) =>
        `Schedule #${ref} could not be saved after approval.`,
    },
    decisions: {
      once: '✅ Allowed once',
      always: '✅ Always allowed',
      deny: '❌ Denied',
    },
    alwaysAsOnce:
      '✅ Allowed once (“always” counts as “allow once” for this request)',
    unavailable: 'Approval is unavailable.',
    replyRecurring:
      'Reply directly with “yes”, “always” (this recurring schedule only), or “no”.',
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
    mentions: 'Mentions',
    recipient: 'Recipient',
    requester: 'Requested by',
    when: 'When',
    until: 'Until',
    content: 'Content',
    model: 'Model',
    path: 'Path',
    globalScope: 'Scope: Global',
    noMentions: 'none',
    unknownUser: 'Unknown user',
    reference: 'Ref',
    reason: 'Reason',
    reasons: {
      agent: 'The agent requested owner approval.',
      crossChat: 'This agent task reads one chat and delivers to another.',
      delivery: 'This will send a message to another location.',
      recurringGroup: 'This will send recurring messages to the group.',
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
    buttons: {
      once: '允許一次',
      always: '一律允許（此週期排程）',
      deny: '拒絕',
    },
    decisions: {
      once: '✅ 已允許一次',
      always: '✅ 已設為一律允許',
      deny: '❌ 已拒絕',
    },
    outcomes: {
      denied: '這項請求已被拒絕。',
      completed: '核准的操作已完成。',
      failed: '核准的操作未能完成。',
      interrupted: '代理程式的回合已結束，無法執行核准的操作。請重新提出請求。',
      scheduleCreated: (ref: string) => `已建立排程 #${ref}。`,
      scheduleUpdated: (ref: string) => `已更新排程 #${ref}。`,
      scheduleDenied: (ref: string) => `排程 #${ref} 的請求已被拒絕。`,
      scheduleFailed: (ref: string) => `排程 #${ref} 已獲核准，但未能儲存。`,
    },
    alwaysAsOnce: '✅ 已允許一次（此請求的「一律允許」視為「允許一次」）',
    unavailable: '這項審核已無法處理。',
    replyRecurring:
      '請直接回覆「允許一次」、「一律允許」（僅限此週期排程）或「拒絕」。',
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
    mentions: '對象',
    recipient: '對象',
    requester: '發起',
    when: '時間',
    until: '截止',
    content: '內容',
    model: '模型',
    path: '路徑',
    globalScope: '範圍：全域',
    noMentions: '不提及任何人',
    unknownUser: '未知使用者',
    reference: '識別碼',
    reason: '原因',
    reasons: {
      agent: '代理程式要求主人審核。',
      crossChat: '這項代理任務會讀取一個聊天室的內容，並傳送到另一個聊天室。',
      delivery: '會發訊息到其他位置',
      recurringGroup: '會定時在群組發訊息',
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
  alwaysAsOnce?: boolean,
) {
  const messages = approvalMessages(locale);
  if (!decision) return { notice: messages.unavailable };
  const notice = messages.decisions[decision];
  return {
    notice,
    decisionText: alwaysAsOnce ? messages.alwaysAsOnce : notice,
  };
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
        ...(useButtons ? [] : [m.replyOnce]),
      ],
      description,
    );
  }

  const { recipients, timezone } = schedule;
  const date = (timestamp: number) =>
    scheduleTime(timestamp, timezone, locale, now);
  const title = field('🔔 ' + m.title, m[schedule.operation][schedule.kind]);
  const recipientsPrefix = field(
    schedule.targetUserId ? m.recipient : m.mentions,
    '',
  );
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
    recipientsPrefix + (names || m.noMentions),
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
    .flatMap((reason) => {
      if (reason !== 'delivery' || schedule.targetUserId)
        return [m.reasons[reason]];
      const reasons = schedule.repeat ? [m.reasons.recurringGroup] : [];
      if (recipients.length) reasons.push(m.reasons.mentions);
      return reasons.length ? reasons : [m.reasons.delivery];
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
  if (!useButtons) lines.push(schedule.repeat ? m.replyRecurring : m.replyOnce);
  return withContent(lines, schedule.content);
}
