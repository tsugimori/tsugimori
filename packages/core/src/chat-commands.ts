import type { Config } from '@tsugimori/config';

const descriptions = {
  add: {
    en: 'Add an agent or platform ([--id <id>])',
    'zh-TW': '新增代理或平台（[--id <id>]）',
  },
  agent: { en: 'Switch this chat’s agent', 'zh-TW': '切換這個對話的代理' },
  allow: {
    en: 'Allow members to use the bot here',
    'zh-TW': '允許成員在此使用機器人',
  },
  cancel: { en: 'Cancel guided setup', 'zh-TW': '取消引導設定' },
  compact: {
    en: 'Compact this chat’s context',
    'zh-TW': '壓縮目前對話的上下文',
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
  login: { en: 'Sign in to an agent', 'zh-TW': '登入代理' },
  model: {
    en: 'Show or set the model (default to reset)',
    'zh-TW': '查看或設定模型（default 還原）',
  },
  pair: {
    en: 'Pair with the bot as its owner',
    'zh-TW': '配對並成為機器人主人',
  },
  preview: { en: 'Close a preview', 'zh-TW': '關閉預覽' },
  previews: { en: 'List open previews', 'zh-TW': '列出開啟中的預覽' },
  status: { en: 'Show status', 'zh-TW': '查看狀態' },
  thinking: {
    en: 'Show or set reasoning effort (default to reset)',
    'zh-TW': '查看或設定推理強度（default 還原）',
  },
};

export type Command = { args: string; name: keyof typeof descriptions };

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
  const { pair, ...owner } = descriptions;
  return {
    owner: Object.entries(owner).map(([name, localized]) => ({
      name,
      description: localized[locale],
    })),
    pair: [{ name: 'pair', description: pair[locale] }],
  };
}
