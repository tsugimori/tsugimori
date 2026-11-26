import type {
  CheckContext,
  CheckItem,
  PluginInstanceConfig,
  SetupStep,
} from '@tsugimori/plugin-sdk';

import { credentialKey, SetupError } from '@tsugimori/plugin-sdk';
import { createServer } from 'node:http';

import { LineApi } from './api.ts';
import {
  closeServer,
  defaultListen,
  listen,
  listenAddress,
  listenPattern,
  webhookPath,
} from './webhook.ts';

const envPattern = '^[A-Za-z_][A-Za-z0-9_]*$';
export const defaultSecretEnv = 'LINE_CHANNEL_SECRET';
export const defaultTokenEnv = 'LINE_CHANNEL_ACCESS_TOKEN';
export const defaultReplyTokenTtlMs = 50_000;

const optionProperties = {
  listen: { type: 'string', pattern: listenPattern, default: defaultListen },
  replyTokenTtlMs: {
    type: 'integer',
    minimum: 1,
    maximum: 60_000,
    default: defaultReplyTokenTtlMs,
  },
  secretEnv: { type: 'string', pattern: envPattern, default: defaultSecretEnv },
  tokenEnv: { type: 'string', pattern: envPattern, default: defaultTokenEnv },
};

export const lineConfigSchema = {
  type: 'object',
  properties: optionProperties,
};

export function lineCredentials(entry: PluginInstanceConfig) {
  const secretEnv = 'secretEnv' in entry ? entry.secretEnv : undefined;
  const tokenEnv = 'tokenEnv' in entry ? entry.tokenEnv : undefined;
  return [
    typeof secretEnv === 'string' ? secretEnv : defaultSecretEnv,
    typeof tokenEnv === 'string' ? tokenEnv : defaultTokenEnv,
  ] as const;
}

const identity = {
  id: 'line-token',
  title: 'LINE channel access token',
  capabilities: ['platform'],
};

export const lineIdentityFailure: CheckItem = {
  ...identity,
  status: 'fail',
  detail:
    'LINE bot info failed. Check the channel access token and LINE connectivity.',
  localized: {
    'zh-TW': {
      title: 'LINE 頻道存取權杖',
      hint: '請檢查頻道存取權杖以及與 LINE 的連線。',
    },
  },
};

const tokenSyntax = /^[\x21-\x7E]+$/;
export function validToken(token: string | undefined): token is string {
  return !!token && tokenSyntax.test(token);
}

const listenItem = {
  id: 'line-listen',
  title: 'LINE webhook listener',
  capabilities: ['platform'],
};

export function lineListenFailure(error: unknown): CheckItem {
  const busy = recordCode(error) === 'EADDRINUSE';
  return {
    ...listenItem,
    status: 'fail',
    detail: busy
      ? 'LINE webhook listen address is already in use. Choose another loopback port.'
      : 'LINE could not bind the webhook listener. Check the loopback address and port.',
    localized: {
      'zh-TW': {
        title: 'LINE Webhook 監聽位址',
        hint: busy
          ? '連接埠已被使用，請選擇其他本機連接埠。'
          : '請檢查本機監聽位址和連接埠。',
      },
    },
  };
}

function recordCode(error: unknown) {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

export async function lineChecks(ctx: CheckContext): Promise<CheckItem[]> {
  const [secretEnv, tokenEnv] = lineCredentials(ctx.entry);
  const token = ctx.credential(tokenEnv);
  const items: CheckItem[] = [];
  if (!ctx.credential(secretEnv)?.trim()) {
    items.push({
      id: 'line-secret',
      title: 'LINE channel secret',
      capabilities: ['platform'],
      status: 'fail',
      detail: 'Set the environment variable named by secretEnv.',
      localized: {
        'zh-TW': {
          title: 'LINE 頻道密鑰',
          hint: '請設定 secretEnv 指定的環境變數。',
        },
      },
    });
  }
  if (!validToken(token)) {
    items.push(lineIdentityFailure);
  } else if (!ctx.startup) {
    try {
      await new LineApi(ctx.fetch, token).identity(AbortSignal.timeout(8000));
      items.push({
        ...identity,
        status: 'ok',
        detail: 'LINE accepted the channel access token.',
      });
    } catch {
      items.push(lineIdentityFailure);
    }
  }
  try {
    const address = listenAddress(
      'listen' in ctx.entry ? ctx.entry.listen : undefined,
    );
    if (!ctx.startup) {
      const server = createServer();
      await listen(server, address);
      await closeServer(server);
      items.push({
        ...listenItem,
        status: 'ok',
        detail: 'LINE webhook listen address is available.',
      });
    }
  } catch (error) {
    items.push(lineListenFailure(error));
  }
  return items;
}

const messages = {
  en: {
    secret: 'Enter the LINE channel secret.',
    invalidSecret: 'Enter a LINE channel secret.',
    token: 'Enter the long-lived LINE channel access token.',
    invalidToken: 'Enter a valid LINE channel access token.',
    rejectedToken:
      'LINE bot info failed. Check the channel access token and try again.',
    confirm: (name: string) =>
      `LINE identified the bot as ${name}. Type yes to confirm.`,
    unconfirmed: 'LINE bot identity was not confirmed.',
    webhook: (path: string) =>
      `Webhook path: ${path}. Set the public HTTPS Webhook URL in the LINE Developers Console and enable “Use webhook”.`,
  },
  'zh-TW': {
    secret: '請輸入 LINE 頻道密鑰。',
    invalidSecret: '請提供 LINE 頻道密鑰。',
    token: '請輸入 LINE 頻道的長效存取權杖。',
    invalidToken: '請輸入有效的 LINE 頻道存取權杖。',
    rejectedToken: '無法取得 LINE 機器人資訊。請檢查頻道存取權杖後重試。',
    confirm: (name: string) => `LINE 機器人名稱為 ${name}。請輸入 yes 確認。`,
    unconfirmed: '尚未確認 LINE 機器人身分。',
    webhook: (path: string) =>
      `Webhook 路徑為 ${path}。請在 LINE Developers Console 設定公開的 HTTPS Webhook URL，並啟用「Use webhook」。`,
  },
};

export const lineSetup: SetupStep[] = [
  {
    id: 'credentials',
    title: 'Verify LINE channel credentials',
    localized: { 'zh-TW': '驗證 LINE 頻道憑證' },
    async run(ctx) {
      const m = messages[ctx.locale ?? 'en'];
      const secret = (
        await ctx.prompt({ text: m.secret, secret: true })
      ).trim();
      if (!secret || /[\r\n]/.test(secret))
        throw new SetupError(m.invalidSecret);
      const token = (await ctx.prompt({ text: m.token, secret: true })).trim();
      if (!validToken(token)) throw new SetupError(m.invalidToken);
      let bot;
      try {
        bot = await new LineApi(ctx.fetch, token).identity(
          AbortSignal.any([ctx.signal, AbortSignal.timeout(8000)]),
        );
      } catch {
        ctx.signal.throwIfAborted();
        throw new SetupError(m.rejectedToken);
      }
      const name = bot.displayName.replace(/[\r\n\u2028\u2029]+/gu, ' ');
      const answer = await ctx.prompt({ text: m.confirm(name) });
      if (answer.trim().toLowerCase() !== 'yes')
        throw new SetupError(m.unconfirmed);
      const secretEnv = credentialKey(defaultSecretEnv, ctx.entry.id);
      const tokenEnv = credentialKey(defaultTokenEnv, ctx.entry.id);
      await ctx.writeEnv(secretEnv, secret);
      await ctx.writeEnv(tokenEnv, token);
      ctx.writeConfig({ entry: { secretEnv, tokenEnv } });
      await ctx.show(m.webhook(webhookPath(ctx.entry.id)));
    },
  },
];
