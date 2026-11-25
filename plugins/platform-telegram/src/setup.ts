import type { CheckContext, CheckItem, SetupStep } from '@tsugimori/plugin-sdk';

import { credentialKey, SetupError } from '@tsugimori/plugin-sdk';

import { BotApi, nativeId, record } from './api.ts';

export async function telegramIdentity(
  fetch: typeof globalThis.fetch,
  token: string,
  signal: AbortSignal,
) {
  const bot = record(await new BotApi(fetch, token).call('getMe', {}, signal));
  const id = nativeId(bot?.id);
  if (!id || typeof bot?.username !== 'string')
    throw new Error('Telegram getMe returned an invalid bot identity');
  return { id, username: bot.username.toLowerCase() };
}

export async function telegramChecks(ctx: CheckContext): Promise<CheckItem[]> {
  const key =
    'tokenEnv' in ctx.entry && typeof ctx.entry.tokenEnv === 'string'
      ? ctx.entry.tokenEnv
      : undefined;
  const token = key ? ctx.credential(key) : undefined;
  const identity = {
    id: 'telegram-token',
    title: 'Telegram bot token',
    capabilities: ['platform'],
  };
  if (token) {
    try {
      await telegramIdentity(ctx.fetch, token, AbortSignal.timeout(8_000));
      return [
        {
          ...identity,
          status: 'ok',
          detail: 'Telegram accepted the bot token.',
        },
      ];
    } catch {
      return [
        {
          ...identity,
          status: 'fail',
          detail:
            'Telegram getMe failed. Check the bot token and Telegram connectivity.',
        },
      ];
    }
  }
  return [
    {
      ...identity,
      status: 'fail',
      detail: 'Set the environment variable named by tokenEnv.',
    },
  ];
}

export const telegramSetup: SetupStep[] = [
  {
    id: 'token',
    title: 'Verify Telegram bot token',
    async run(ctx) {
      const token = (
        await ctx.prompt({
          secret: true,
          text: 'Enter the Telegram bot token.',
        })
      ).trim();
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
        throw new SetupError('Enter a valid Telegram bot token.');
      try {
        await telegramIdentity(
          ctx.fetch,
          token,
          AbortSignal.any([ctx.signal, AbortSignal.timeout(8_000)]),
        );
      } catch {
        throw new SetupError(
          'Telegram getMe failed. Check the token and try again.',
        );
      }
      const tokenEnv = credentialKey('TELEGRAM_BOT_TOKEN', ctx.entry.id);
      await ctx.writeEnv(tokenEnv, token);
      ctx.writeConfig({ entry: { tokenEnv } });
    },
  },
  {
    id: 'owner',
    title: 'Set Telegram owner',
    async run(ctx) {
      const ownerId = (
        await ctx.prompt({
          text: 'Enter the Telegram owner’s numeric user ID.',
        })
      ).trim();
      if (!/^[1-9]\d{0,19}$/.test(ownerId))
        throw new SetupError('A numeric Telegram user ID is required.');
      ctx.writeConfig({ ownerId });
    },
  },
];
