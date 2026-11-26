import type {
  CheckContext,
  CheckItem,
  PluginInstanceConfig,
  SetupCompletion,
  SetupStep,
} from '@tsugimori/plugin-sdk';

import { credentialKey, SetupError, yesNoChoices } from '@tsugimori/plugin-sdk';

import { LineApi } from './api.ts';
import { webhookPath } from './webhook.ts';

const envPattern = '^[A-Za-z_][A-Za-z0-9_]*$';
export const defaultSecretEnv = 'LINE_CHANNEL_SECRET';
export const defaultTokenEnv = 'LINE_CHANNEL_ACCESS_TOKEN';
export const defaultReplyTokenTtlMs = 50_000;

const optionProperties = {
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
  let tokenAccepted = false;
  const api = validToken(token) ? new LineApi(ctx.fetch, token) : undefined;
  if (!api) {
    items.push(lineIdentityFailure);
  } else if (!ctx.startup) {
    try {
      await api.identity(AbortSignal.timeout(8000));
      tokenAccepted = true;
      items.push({
        ...identity,
        status: 'ok',
        detail: 'LINE accepted the channel access token.',
      });
    } catch {
      items.push(lineIdentityFailure);
    }
  }
  const ingress = ctx.webhookIngress?.status();
  // The gateway probes its ingress right after startup checks and reports its
  // own failures; skip this item until that first probe settles.
  if (ctx.startup && ingress?.state === 'checking') return items;
  const path = webhookPath(ctx.entry.id);
  const url =
    ingress?.state === 'ok' && ingress.baseUrl
      ? ingress.baseUrl + path
      : undefined;
  let status: CheckItem['status'] = 'fail';
  let reason = ingress?.reason;
  let message:
    'ingress' | 'missing' | 'mismatch' | 'unknown' | 'matched' | 'disabled' =
    'ingress';
  if (url) {
    status = 'warn';
    message = 'unknown';
    if (api && tokenAccepted) {
      try {
        const endpoint = await api.webhookEndpoint(AbortSignal.timeout(8000));
        if (!endpoint?.endpoint) message = 'missing';
        else if (endpoint.endpoint !== url) message = 'mismatch';
        else if (endpoint.active === false) message = 'disabled';
        else {
          status = 'ok';
          message = 'matched';
        }
      } catch {
        // Keep the endpoint check at warn when LINE cannot report its settings.
      }
    }
    if (ctx.startup) return items;
    reason = undefined;
  }
  const en = reason ?? messages.en[message];
  const zh = reason ?? messages['zh-TW'][message];
  items.push({
    id: 'line-webhook',
    capabilities: ['webhook'],
    title: 'LINE webhook endpoint',
    status,
    detail: en,
    localized: {
      'zh-TW': { title: 'LINE Webhook 網址', detail: zh, hint: zh },
    },
  });
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
      `LINE identified the bot as ${name}. Type yes to confirm or no to decline.`,
    unconfirmed: 'LINE bot identity was not confirmed.',
    ingress: 'Gateway webhook ingress is unavailable.',
    missing: 'LINE has no configured webhook endpoint.',
    mismatch: 'The webhook endpoint configured in LINE differs.',
    unknown: 'Could not read the configured webhook endpoint from LINE.',
    matched: 'The webhook endpoint configured in LINE matches.',
    disabled: 'The endpoint matches, but “Use webhook” is disabled in LINE.',
    confirmWebhook: (url: string) =>
      `Replace the current LINE webhook endpoint with ${url} and test it?`,
    declined: 'The existing endpoint was left in place.',
    saveFailed: 'LINE could not save the webhook endpoint.',
    testFailed: 'The LINE webhook test failed.',
    passed: (url: string) =>
      `Connected. Webhook URL: ${url} (LINE test passed).`,
    reminder: 'Enable “Use webhook” in the LINE Developers Console.',
    saved: (reason: string) =>
      `Saved, but the webhook is disconnected and cannot receive LINE messages: ${reason} Fix the issue, then run /webhook check or verify the URL in the LINE Developers Console.`,
  },
  'zh-TW': {
    secret: '請輸入 LINE 頻道密鑰。',
    invalidSecret: '請提供 LINE 頻道密鑰。',
    token: '請輸入 LINE 頻道的長效存取權杖。',
    invalidToken: '請輸入有效的 LINE 頻道存取權杖。',
    rejectedToken: '無法取得 LINE 機器人資訊。請檢查頻道存取權杖後重試。',
    confirm: (name: string) =>
      `LINE 機器人名稱為 ${name}。請輸入 yes 確認或 no 拒絕。`,
    unconfirmed: '尚未確認 LINE 機器人身分。',
    ingress: '閘道器的 Webhook 尚未就緒。',
    missing: 'LINE 尚未設定 Webhook 網址。',
    mismatch: 'LINE 已設定的 Webhook 網址不同。',
    unknown: '無法從 LINE 讀取已設定的 Webhook 網址。',
    matched: 'LINE 已設定的 Webhook 網址相符。',
    disabled: 'Webhook 網址相符，但 LINE 尚未啟用「Use webhook」。',
    confirmWebhook: (url: string) =>
      `要將 LINE 目前的 Webhook 網址換成 ${url} 並測試嗎？`,
    declined: '保留了原有的 Webhook 網址。',
    saveFailed: 'LINE 無法儲存 Webhook 網址。',
    testFailed: 'LINE Webhook 測試未通過。',
    passed: (url: string) => `已接上。Webhook 網址：${url} （LINE 測試通過）`,
    reminder: '請在 LINE Developers Console 啟用「Use webhook」。',
    saved: (reason: string) =>
      `已儲存，但 webhook 還沒接通，現在收不到 LINE 訊息：${reason}修好後執行 /webhook check，或在 LINE Developers Console 驗證網址。`,
  },
};

export const lineSetup: SetupStep[] = [
  {
    id: 'credentials',
    title: 'Verify LINE channel credentials',
    localized: { 'zh-TW': '驗證 LINE 頻道憑證' },
    asks: [
      {
        text: 'Channel secret',
        localized: { 'zh-TW': '頻道密鑰' },
        secret: true,
      },
      {
        text: 'Long-lived access token',
        localized: { 'zh-TW': '長效存取權杖' },
        secret: true,
      },
      {
        text: 'Confirm the bot name (yes/no)',
        localized: { 'zh-TW': '確認機器人名稱（yes/no）' },
      },
    ],
    saves: {
      text: 'writes the channel secret and access token to .env after you confirm the bot name',
      localized: {
        'zh-TW': '在你確認機器人名稱後將頻道密鑰與存取權杖寫入 .env',
      },
    },
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
      const answer = await ctx.prompt({
        choices: yesNoChoices,
        text: m.confirm(name),
      });
      if (answer.trim().toLowerCase() !== 'yes')
        throw new SetupError(m.unconfirmed);
      const secretEnv = credentialKey(defaultSecretEnv, ctx.entry.id);
      const tokenEnv = credentialKey(defaultTokenEnv, ctx.entry.id);
      await ctx.writeEnv(secretEnv, secret);
      await ctx.writeEnv(tokenEnv, token);
      ctx.writeConfig({ entry: { secretEnv, tokenEnv } });
    },
  },
];

export const lineCompletion: SetupCompletion = {
  title: 'Check the webhook endpoint in LINE after saving',
  localized: { 'zh-TW': '儲存設定後檢查 LINE 的 Webhook 網址' },
  asks: [
    {
      text: 'Confirm replacement if LINE already has a different endpoint',
      localized: { 'zh-TW': 'LINE 已設定其他 Webhook 網址時，確認是否替換' },
    },
  ],
  async run(ctx) {
    const m = messages[ctx.locale ?? 'en'];
    const ingress = ctx.webhookIngress;
    const url = ingress?.url(webhookPath(ctx.entry.id));
    if (!url) return m.saved(ingress?.status().reason ?? m.ingress);
    const token = ctx.credential(lineCredentials(ctx.entry)[1]);
    if (!validToken(token)) return m.saved(m.unknown);
    const api = new LineApi(ctx.fetch, token);
    const signal = () =>
      AbortSignal.any([ctx.signal, AbortSignal.timeout(8000)]);
    let current;
    try {
      current = await api.webhookEndpoint(signal());
    } catch {
      ctx.signal.throwIfAborted();
      return m.saved(m.unknown);
    }
    if (current?.endpoint && current.endpoint !== url) {
      const answer = await ctx.prompt({
        choices: yesNoChoices,
        text: m.confirmWebhook(url),
      });
      if (answer.trim().toLowerCase() !== 'yes') return m.saved(m.declined);
    }
    if (current?.endpoint !== url) {
      try {
        await api.setWebhookEndpoint(url, signal());
      } catch {
        ctx.signal.throwIfAborted();
        return m.saved(m.saveFailed);
      }
    }
    try {
      if (!(await api.testWebhookEndpoint(url, signal())))
        return m.saved(m.testFailed);
    } catch {
      ctx.signal.throwIfAborted();
      return m.saved(m.testFailed);
    }
    return [m.passed(url), current?.active === true ? undefined : m.reminder]
      .filter(Boolean)
      .join('\n');
  },
};
