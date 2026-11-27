import type { CheckContext, CheckItem, SetupStep } from '@tsugimori/plugin-sdk';

import { credentialKey, SetupError } from '@tsugimori/plugin-sdk';

import { BotApi, BotApiError, nativeId, record } from './api.ts';

export async function telegramIdentity(
  fetch: typeof globalThis.fetch,
  token: string,
  signal: AbortSignal,
  retries = 2,
) {
  const bot = record(
    await new BotApi(fetch, token).call('getMe', {}, signal, retries),
  );
  const id = nativeId(bot?.id);
  if (!id || typeof bot?.username !== 'string')
    throw new Error('Telegram getMe returned an invalid bot identity');
  const displayName = bot.first_name;
  return {
    id,
    username: bot.username.toLowerCase(),
    ...(typeof displayName === 'string' && { displayName }),
  };
}

const identity = {
  id: 'telegram-token',
  title: 'Telegram bot token',
  capabilities: ['platform'],
};

export const telegramIdentityFailure: CheckItem = {
  ...identity,
  status: 'fail',
  detail:
    'Telegram getMe failed. Check the bot token and Telegram connectivity.',
  localized: {
    'zh-TW': {
      title: 'Telegram 機器人權杖',
      hint: '請檢查機器人權杖以及與 Telegram 的連線。',
    },
  },
};

export async function telegramChecks(ctx: CheckContext): Promise<CheckItem[]> {
  const key =
    'tokenEnv' in ctx.entry && typeof ctx.entry.tokenEnv === 'string'
      ? ctx.entry.tokenEnv
      : undefined;
  const token = key ? ctx.credential(key) : undefined;
  if (token) {
    try {
      if (ctx.startup) {
        // Validate the token format locally. The runtime supervises getMe.
        new BotApi(ctx.fetch, token);
        return [];
      }
      await telegramIdentity(ctx.fetch, token, AbortSignal.timeout(8_000), 0);
      return [
        {
          ...identity,
          status: 'ok',
          detail: 'Telegram accepted the bot token.',
        },
      ];
    } catch (error) {
      if (ctx.startup || (error instanceof BotApiError && error.invalidToken))
        return [telegramIdentityFailure];
      return [
        {
          ...identity,
          status: 'fail',
          detail: 'Telegram is unavailable. The getMe request did not succeed.',
          localized: {
            'zh-TW': {
              title: 'Telegram 連線',
              hint: 'Telegram 目前無法使用，getMe 請求失敗。',
            },
          },
        },
      ];
    }
  }
  return [
    {
      ...identity,
      status: 'fail',
      detail: 'Set the environment variable named by tokenEnv.',
      localized: {
        'zh-TW': {
          title: 'Telegram 機器人權杖',
          hint: '請設定 tokenEnv 指定的環境變數。',
        },
      },
    },
  ];
}

const setupMessages = {
  en: {
    token: 'Enter the Telegram bot token.',
    invalidToken: 'Enter a valid Telegram bot token.',
    rejectedToken: 'Telegram getMe failed. Check the token and try again.',
    owner: 'Enter the Telegram owner’s numeric user ID.',
    invalidOwner: 'A numeric Telegram user ID is required.',
  },
  'zh-TW': {
    token: '請輸入 Telegram 機器人權杖。',
    invalidToken: '請輸入有效的 Telegram 機器人權杖。',
    rejectedToken: 'Telegram getMe 檢查失敗。請確認權杖後重試。',
    owner: '請輸入 Telegram 主人的數字使用者 ID。',
    invalidOwner: '請使用數字形式的 Telegram 使用者 ID。',
  },
};

export const telegramSetup: SetupStep[] = [
  {
    id: 'token',
    title: 'Verify Telegram bot token',
    localized: { 'zh-TW': '驗證 Telegram 機器人權杖' },
    asks: [
      { text: 'Bot token', localized: { 'zh-TW': '機器人權杖' }, secret: true },
    ],
    saves: {
      text: 'writes the bot token to .env after Telegram verifies it',
      localized: { 'zh-TW': '在 Telegram 驗證通過後將機器人權杖寫入 .env' },
    },
    async run(ctx) {
      const m = setupMessages[ctx.locale ?? 'en'];
      const token = (
        await ctx.prompt({
          secret: true,
          text: m.token,
        })
      ).trim();
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
        throw new SetupError(m.invalidToken);
      try {
        await telegramIdentity(
          ctx.fetch,
          token,
          AbortSignal.any([ctx.signal, AbortSignal.timeout(8_000)]),
        );
      } catch {
        throw new SetupError(m.rejectedToken);
      }
      const tokenEnv = credentialKey('TELEGRAM_BOT_TOKEN', ctx.entry.id);
      await ctx.writeEnv(tokenEnv, token);
      ctx.writeConfig({ entry: { tokenEnv } });
    },
  },
  {
    id: 'owner',
    title: 'Set Telegram owner',
    localized: { 'zh-TW': '設定 Telegram 主人' },
    asks: [
      {
        text: 'Owner’s numeric user ID',
        localized: { 'zh-TW': '主人的數字使用者 ID' },
      },
    ],
    async run(ctx) {
      const m = setupMessages[ctx.locale ?? 'en'];
      const ownerId = (
        await ctx.prompt({
          text: m.owner,
        })
      ).trim();
      if (!/^[1-9]\d{0,19}$/.test(ownerId))
        throw new SetupError(m.invalidOwner);
      ctx.writeConfig({ ownerId });
    },
  },
];
