import type { Config } from '@tsugimori/config';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatRef,
  ScheduleApprovalRequest,
} from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';

import { userMentionLinks } from '@tsugimori/plugin-sdk';

const catalogs = {
  en: {
    buttons: { once: 'Allow once', always: 'Always', deny: 'Deny' },
    decisions: {
      once: 'Allowed once.',
      always: 'Always allowed.',
      deny: 'Denied.',
    },
    unavailable: 'Approval is unavailable.',
    decision: 'Decision',
    reply: 'Reply directly to this message with “yes”, “always”, or “no”.',
    replyOnce: 'Reply directly to this message with “yes” or “no”.',
    title: 'Approval requested',
    create: { message: 'Schedule a message', agent: 'Schedule an agent task' },
    update: {
      message: 'Update a scheduled message',
      agent: 'Update a scheduled agent task',
    },
    actions: {
      'codex.command': 'Run a Codex command',
      'codex.file_change': 'Apply Codex file changes',
      'codex.permissions': 'Change Codex permissions',
      'workspace.configure': 'Change chat workspace settings',
    },
    chat: 'Chat',
    mentions: 'Mentions',
    when: 'When',
    firstRun: 'First run',
    repeat: 'Repeat',
    until: 'Until',
    message: 'Message',
    agent: 'Agent instructions',
    model: 'Model',
    path: 'Path',
    globalScope: 'Scope: Global',
    none: 'None',
    unnamedChat: 'Unnamed chat',
    privateChat: 'Private chat',
    unknownUser: 'Unknown user',
    reference: 'Ref',
    reasons: {
      agent: 'The agent requested owner approval.',
      crossChat: 'This agent task reads one chat and delivers to another.',
      delivery: 'The destination or mentions require delivery approval.',
      frequency:
        'The schedule can run faster than the configured minimum interval.',
      model: 'The selected model requires owner approval.',
    },
    agentReason: 'Agent’s reason',
    every: (interval: string) => 'Every ' + interval,
  },
  'zh-TW': {
    buttons: { once: '允許一次', always: '一律允許', deny: '拒絕' },
    decisions: {
      once: '已允許一次。',
      always: '已設為一律允許。',
      deny: '已拒絕。',
    },
    unavailable: '這項審核已無法處理。',
    decision: '審核結果',
    reply: '請直接回覆這則訊息，輸入「允許一次」、「一律允許」或「拒絕」。',
    replyOnce: '請直接回覆這則訊息，輸入「允許一次」或「拒絕」。',
    title: '審核請求',
    create: { message: '建立排程訊息', agent: '建立排程代理任務' },
    update: { message: '修改排程訊息', agent: '修改排程代理任務' },
    actions: {
      'codex.command': '執行 Codex 指令',
      'codex.file_change': '套用 Codex 檔案變更',
      'codex.permissions': '變更 Codex 權限',
      'workspace.configure': '變更聊天室工作區設定',
    },
    chat: '聊天室',
    mentions: '提及對象',
    when: '時間',
    firstRun: '首次執行',
    repeat: '重複',
    until: '截止',
    message: '訊息',
    agent: '代理任務指示',
    model: '模型',
    path: '路徑',
    globalScope: '範圍: 全域',
    none: '無',
    unnamedChat: '未命名的聊天室',
    privateChat: '私人對話',
    unknownUser: '未知使用者',
    reference: '識別碼',
    reasons: {
      agent: '代理程式要求主人審核。',
      crossChat: '這項代理任務會讀取一個聊天室的內容，並傳送到另一個聊天室。',
      delivery: '傳送目的地或提及對象需要授權。',
      frequency: '這項排程的執行間隔可能短於設定的下限。',
      model: '所選模型需要主人授權。',
    },
    agentReason: '代理程式提供的理由',
    every: (interval: string) => '每 ' + interval,
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
  return { notice, decisionText: field(messages.decision, notice) };
}

function field(label: string, value: string) {
  return label + ': ' + value;
}

function chatName(
  store: Store,
  chat: ChatRef,
  messages: ReturnType<typeof approvalMessages>,
  userId?: string,
) {
  const record = store.getChat(chat);
  if (record?.title) return record.title;
  if (record?.kind !== 'dm') return messages.unnamedChat;
  const recipient = userId ?? store.deliveryAddress(chat)?.userId;
  return (
    (recipient && store.getUserDisplay({ ...chat, userId: recipient })) ||
    messages.privateChat
  );
}

export function approvalPrompt({
  chat,
  locale,
  request,
  schedule,
  store,
}: {
  chat: ChatRef;
  locale: Config['locale'];
  request: ApprovalRequest;
  schedule?: ScheduleApprovalRequest;
  store: Store;
}) {
  const messages = approvalMessages(locale);
  if (!schedule) {
    const { action, description, resource } = request;
    const target = resource.type === 'chat' ? resource : chat;
    const title = Object.hasOwn(messages.actions, action)
      ? messages.actions[action as keyof typeof messages.actions]
      : action;
    const reference =
      resource.type === 'project'
        ? resource.id.slice(0, 12)
        : resource.type === 'chat'
          ? target.chatId
          : undefined;
    return [
      field(messages.title, title),
      field(messages.chat, chatName(store, target, messages)),
      ...(resource.type === 'path'
        ? [field(messages.path, resource.path)]
        : []),
      ...(resource.type === 'global' ? [messages.globalScope] : []),
      messages.reply,
      ...(description ? ['', description] : []),
      ...(reference ? ['', field(messages.reference, reference)] : []),
    ].join('\n');
  }

  const { adapterId } = schedule.target;
  const links = [...userMentionLinks(schedule.content)];
  const users = new Map(links.map(({ userId, label }) => [userId, label]));
  for (const id of schedule.mentions) {
    if (!users.has(id)) users.set(id, messages.unknownUser);
  }
  let content = '';
  let unlinkedText = '';
  let end = 0;
  for (const link of links) {
    const before = schedule.content.slice(end, link.start);
    content += before + link.label;
    unlinkedText += before + ' ';
    end = link.end;
  }
  const tail = schedule.content.slice(end);
  content += tail;
  unlinkedText += tail;
  const handles = new Set(
    [...unlinkedText.matchAll(/@[\p{L}\p{N}_]+/gu)].map(([handle]) => handle),
  );
  for (const [userId, label] of users)
    users.set(userId, store.getUserDisplay({ adapterId, userId }) ?? label);
  // A preview can be posted in the destination chat. Leave username pings for delivery.
  const preview = (text: string) => text.replace(/@(?=[\p{L}\p{N}_])/gu, '＠');
  const recipients = [...users.values(), ...handles].map(preview);
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    hourCycle: 'h23',
    timeZone: schedule.timezone,
  });
  const date = (timestamp: number) =>
    formatter.format(timestamp) + ' (' + schedule.timezone + ')';
  const lines = [
    field(messages.title, messages[schedule.operation][schedule.kind]),
    field(
      messages.chat,
      preview(
        chatName(store, schedule.target, messages, schedule.targetUserId),
      ),
    ),
    field(
      messages.mentions,
      recipients.join(locale === 'zh-TW' ? '、' : ', ') || messages.none,
    ),
    field(
      schedule.repeat ? messages.firstRun : messages.when,
      date(schedule.dueAt),
    ),
  ];
  if (schedule.repeat) {
    const repeat = schedule.repeat;
    lines.push(
      field(
        messages.repeat,
        'cron' in repeat
          ? 'Cron ' + repeat.cron
          : messages.every(
              new Intl.NumberFormat(locale, {
                style: 'unit',
                unit: 'minute',
                unitDisplay: 'long',
              }).format(repeat.minutes),
            ),
      ),
    );
  }
  if (schedule.until !== undefined)
    lines.push(field(messages.until, date(schedule.until)));
  if (schedule.model) lines.push(field(messages.model, schedule.model));
  for (const reason of schedule.reasons)
    lines.push('• ' + messages.reasons[reason]);
  if (schedule.agentReason) {
    const reason = schedule.agentReason.replace(
      /\b(?:Telegram\s+)?(?:user\s+)?ID\s*[:：=]?\s*([1-9]\d{0,19})\b/gi,
      (reference, userId: string) => users.get(userId) ?? reference,
    );
    lines.push('• ' + field(messages.agentReason, preview(reason)));
  }
  lines.push(
    messages.replyOnce,
    '',
    messages[schedule.kind] + ':',
    preview(content),
    '',
    field(
      messages.reference,
      [schedule.id.slice(0, 8), schedule.target.chatId, ...users.keys()].join(
        ' · ',
      ),
    ),
  );
  return lines.join('\n');
}
