import type { Config } from '@tsugimori/config';

const descriptions = {
  add: {
    en: 'Add an agent or platform ([--id <id>])',
    'zh-TW': '新增代理或平台（[--id <id>]）',
  },
  allow: {
    en: 'Allow members to use the bot here',
    'zh-TW': '允許成員在此使用機器人',
  },
  ask: {
    en: 'Ask a one-off question in a fresh session (<message>)',
    'zh-TW': '在新的工作階段詢問單次問題（<訊息>）',
  },
  btw: {
    en: 'Ask a side question about this conversation (<message>)',
    'zh-TW': '詢問目前對話的延伸問題（<訊息>）',
  },
  cancel: { en: 'Cancel guided setup', 'zh-TW': '取消引導設定' },
  compact: {
    en: 'Compact this chat’s context',
    'zh-TW': '壓縮目前對話的上下文',
  },
  context: {
    en: 'Show session context and token usage',
    'zh-TW': '查看工作階段的上下文與 token 用量',
  },
  deny: {
    en: 'Remove this chat from the allowlist',
    'zh-TW': '將這個對話移出允許清單',
  },
  fast: {
    en: 'Show or set fast mode (on, off, default)',
    'zh-TW': '查看或設定快速模式（on、off、default）',
  },
  help: { en: 'Show available commands', 'zh-TW': '查看可用指令' },
  incognito: {
    en: 'Toggle incognito mode (on or off)',
    'zh-TW': '切換無痕模式（on 開啟、off 關閉）',
  },
  login: { en: 'Sign in to an agent', 'zh-TW': '登入代理' },
  model: {
    en: 'Choose a provider and model (default to reset)',
    'zh-TW': '選擇供應商和模型（default 還原）',
  },
  new: {
    en: 'Start a new conversation',
    'zh-TW': '開始新對話',
  },
  pair: {
    en: 'Get a new pairing code in DM (/pair new <adapterId>)',
    'zh-TW': '在私訊取得新配對碼（/pair new <adapterId>）',
  },
  preview: { en: 'Close a preview', 'zh-TW': '關閉預覽' },
  previews: { en: 'List open previews', 'zh-TW': '列出開啟中的預覽' },
  remove: {
    en: 'Remove an instance (/remove <platform|agent> <id>)',
    'zh-TW': '移除實例（/remove <platform|agent> <id>）',
  },
  status: { en: 'Show status', 'zh-TW': '查看狀態' },
  sticker: {
    en: 'List, block or unblock sticker sets',
    'zh-TW': '查看、封鎖或解除封鎖貼圖集',
  },
  stop: {
    en: 'Stop the running task in this chat',
    'zh-TW': '停止此聊天室正在執行的任務',
  },
  thinking: {
    en: 'Show or set reasoning effort (default to reset)',
    'zh-TW': '查看或設定推理強度（default 還原）',
  },
  webhook: {
    en: 'Configure or check webhook ingress',
    'zh-TW': '設定或檢查 Webhook',
  },
};

export type Command = { args: string; name: keyof typeof descriptions };

const memberCommands = new Set<Command['name']>([
  'ask',
  'btw',
  'context',
  'help',
  'incognito',
  'new',
]);

export function canRunCommand(
  name: Command['name'],
  owner: boolean,
  allowlisted: boolean,
) {
  return owner || (allowlisted && memberCommands.has(name));
}

export function parseCommand(
  text: string,
  botUsername?: string,
): Command | 'other-bot' | undefined {
  const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(
    text.trim(),
  );
  if (!match) return;
  const [, command, recipient, args] = match;
  if (!command) return;
  if (recipient) {
    if (!botUsername) return;
    if (recipient.toLowerCase() !== botUsername.toLowerCase())
      return 'other-bot';
  }
  const name = command.toLowerCase();
  if (Object.hasOwn(descriptions, name))
    return { name: name as Command['name'], args: args?.trim() ?? '' };
}

export function chatCommands(locale: Config['locale']) {
  const describe = (name: Command['name']) => ({
    name,
    description: descriptions[name][locale],
  });
  return {
    member: Array.from(memberCommands, describe),
    owner: (Object.keys(descriptions) as Command['name'][]).map(describe),
    pair: [
      {
        name: 'pair',
        description:
          locale === 'zh-TW'
            ? '配對並成為機器人主人'
            : 'Pair with the bot as its owner',
      },
    ],
  };
}
