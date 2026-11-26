import type {
  CheckContext,
  CheckItem,
  PluginInstanceConfig,
  SetupCompletion,
  SetupStep,
} from '@tsugimori/plugin-sdk';

import {
  credentialKey,
  parseWebhookBaseUrl,
  SetupError,
  webhookBaseUrlPattern,
} from '@tsugimori/plugin-sdk';
import { createServer } from 'node:http';

import { LineApi } from './api.ts';
import {
  closeServer,
  defaultListen,
  hasLineListener,
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
  publicUrl: { type: 'string', pattern: webhookBaseUrlPattern },
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

function webhookLocation(ctx: CheckContext) {
  const path = webhookPath(ctx.entry.id);
  const value =
    ('publicUrl' in ctx.entry ? ctx.entry.publicUrl : undefined) ??
    ctx.webhooks?.publicBaseUrl;
  const base = parseWebhookBaseUrl(value);
  if (value !== undefined && !base)
    throw new Error('Invalid LINE public webhook base URL');
  return {
    path,
    url: base && `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`,
  };
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
  const address = listenAddressOrReport(ctx, items);
  if (ctx.startup) return items;
  if (address) items.push(await checkListener(ctx, address));
  const { path, url } = webhookLocation(ctx);
  const en = webhookInstructions('en', path, url);
  const zh = webhookInstructions('zh-TW', path, url);
  items.push({
    id: 'line-webhook',
    title: 'LINE webhook endpoint',
    status: url ? 'ok' : 'warn',
    detail: en,
    localized: {
      'zh-TW': { title: 'LINE Webhook 網址', detail: zh, hint: zh },
    },
  });
  return items;
}

function listenAddressOrReport(ctx: CheckContext, items: CheckItem[]) {
  try {
    return listenAddress('listen' in ctx.entry ? ctx.entry.listen : undefined);
  } catch (error) {
    items.push(lineListenFailure(error));
  }
}

/** An unsigned POST to this instance's path gets 401 only from a running LINE listener that owns it. */
async function gatewayServes(
  ctx: CheckContext,
  address: ReturnType<typeof listenAddress>,
) {
  const host = address.host.includes(':') ? `[${address.host}]` : address.host;
  try {
    const response = await fetch(
      `http://${host}:${address.port}${webhookPath(ctx.entry.id)}`,
      { method: 'POST', body: '{}', signal: AbortSignal.timeout(2000) },
    );
    await response.body?.cancel();
    return response.status === 401;
  } catch {
    return false;
  }
}

async function checkListener(
  ctx: CheckContext,
  address: ReturnType<typeof listenAddress>,
): Promise<CheckItem> {
  try {
    const shared = hasLineListener(address);
    if (!shared) {
      const server = createServer();
      await listen(server, address);
      await closeServer(server);
    }
    return {
      ...listenItem,
      status: 'ok',
      detail: shared
        ? 'LINE is sharing the webhook listener.'
        : 'LINE webhook listen address is available.',
    };
  } catch (error) {
    const sharedConfig =
      recordCode(error) === 'EADDRINUSE' &&
      ctx.configuredPlatforms?.some((entry) => {
        if (entry.enabled === false || entry.kind !== 'line') return false;
        try {
          const configured = listenAddress(entry.listen);
          return (
            configured.host === address.host && configured.port === address.port
          );
        } catch {
          return false; // The invalid address is reported by that instance's check.
        }
      });
    if (!sharedConfig) return lineListenFailure(error);
    if (await gatewayServes(ctx, address))
      return {
        ...listenItem,
        status: 'ok',
        detail: 'The running gateway is serving this LINE webhook path.',
        localized: {
          'zh-TW': {
            title: 'LINE Webhook 監聽位址',
            hint: '閘道器已在執行。',
            detail: '執行中的閘道器正在接收這個 LINE Webhook 路徑。',
          },
        },
      };
    return {
      ...listenItem,
      status: 'warn',
      detail:
        'The address is in use and is configured for a shared LINE listener. Check gateway startup to confirm it owns the listener.',
      localized: {
        'zh-TW': {
          title: 'LINE Webhook 監聽位址',
          hint: '請確認閘道器已啟動共用的 LINE 監聽服務。',
          detail:
            '位址已使用且設定為 LINE 共用。請確認閘道器已啟動共用的 LINE 監聽服務。',
        },
      },
    };
  }
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
    askUrl:
      'Enter the public HTTPS base URL for LINE (a path prefix is optional), or reply skip.',
    invalidUrl:
      'Enter a valid HTTPS base URL without credentials, a query, or a fragment, or reply skip.',
    path: (path: string) =>
      `Webhook path: ${path}. Set publicUrl or webhooks.publicBaseUrl to display the full HTTPS URL.`,
    url: (url: string) => `Webhook URL: ${url}`,
    console:
      'In the LINE Developers Console, verify the Webhook URL and enable “Use webhook”.',
    match: 'The webhook endpoint configured in LINE matches.',
    mismatch: 'The webhook endpoint configured in LINE differs.',
    missing: 'LINE has no configured webhook endpoint.',
    unknown: 'Could not read the configured webhook endpoint from LINE.',
    confirmWebhook: (status: string, url: string) =>
      `${status} Set the LINE channel webhook endpoint to ${url} and send a test webhook? Type yes to confirm, or no to skip.`,
    saved: 'LINE saved the webhook endpoint.',
    saveFailed:
      'Could not confirm that LINE saved the webhook endpoint. Check the LINE Developers Console.',
    testPassed: 'The LINE webhook test passed.',
    testFailed:
      'The LINE webhook test did not pass. Check that the gateway and public route are running, then verify the URL in the LINE Developers Console.',
  },
  'zh-TW': {
    secret: '請輸入 LINE 頻道密鑰。',
    invalidSecret: '請提供 LINE 頻道密鑰。',
    token: '請輸入 LINE 頻道的長效存取權杖。',
    invalidToken: '請輸入有效的 LINE 頻道存取權杖。',
    rejectedToken: '無法取得 LINE 機器人資訊。請檢查頻道存取權杖後重試。',
    confirm: (name: string) => `LINE 機器人名稱為 ${name}。請輸入 yes 確認。`,
    unconfirmed: '尚未確認 LINE 機器人身分。',
    askUrl:
      '請輸入 LINE 公開的 HTTPS 基底網址（可包含路徑前綴），或回覆 skip 略過。',
    invalidUrl:
      '請輸入不含憑證、查詢參數或片段的有效 HTTPS 基底網址，或回覆 skip 略過。',
    path: (path: string) =>
      `Webhook 路徑為 ${path}。設定 publicUrl 或 webhooks.publicBaseUrl 即可顯示完整 HTTPS 網址。`,
    url: (url: string) => `Webhook 網址為 ${url}`,
    console:
      '請在 LINE Developers Console 驗證 Webhook 網址，並啟用「Use webhook」。',
    match: 'LINE 已設定的 Webhook 網址相符。',
    mismatch: 'LINE 已設定的 Webhook 網址不同。',
    missing: 'LINE 尚未設定 Webhook 網址。',
    unknown: '無法從 LINE 讀取已設定的 Webhook 網址。',
    confirmWebhook: (status: string, url: string) =>
      `${status} 要將 LINE 頻道的 Webhook 網址設定為 ${url}，並傳送測試請求嗎？請輸入 yes 確認，或回覆 no 略過。`,
    saved: 'LINE 已儲存 Webhook 網址。',
    saveFailed:
      '無法確認 LINE 是否已儲存 Webhook 網址，請查看 LINE Developers Console。',
    testPassed: 'LINE Webhook 測試通過。',
    testFailed:
      'LINE Webhook 測試未通過。請確認閘道器與公開路由已啟動，再到 LINE Developers Console 驗證網址。',
  },
};

function webhookInstructions(
  locale: keyof typeof messages,
  path: string,
  url?: string,
) {
  const m = messages[locale];
  return `${url ? m.url(url) : m.path(path)}\n${m.console}`;
}

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
      const answer = await ctx.prompt({ text: m.confirm(name) });
      if (answer.trim().toLowerCase() !== 'yes')
        throw new SetupError(m.unconfirmed);
      const secretEnv = credentialKey(defaultSecretEnv, ctx.entry.id);
      const tokenEnv = credentialKey(defaultTokenEnv, ctx.entry.id);
      await ctx.writeEnv(secretEnv, secret);
      await ctx.writeEnv(tokenEnv, token);
      ctx.writeConfig({ entry: { secretEnv, tokenEnv } });
    },
  },
  {
    id: 'public-url',
    title: 'Choose the public webhook URL',
    localized: { 'zh-TW': '選擇公開的 Webhook 網址' },
    asks: [
      {
        text: 'Public HTTPS base URL (if none is configured, or skip)',
        localized: {
          'zh-TW': '公開的 HTTPS 基底網址（尚未設定時詢問，可略過）',
        },
      },
    ],
    async run(ctx) {
      if (webhookLocation(ctx).url) return;
      const m = messages[ctx.locale ?? 'en'];
      let question = m.askUrl;
      for (let attempt = 0; attempt < 2; attempt++) {
        const answer = (await ctx.prompt({ text: question })).trim();
        if (answer.toLowerCase() === 'skip') return;
        if (parseWebhookBaseUrl(answer)) {
          ctx.writeConfig({ entry: { publicUrl: answer } });
          return;
        }
        question = m.invalidUrl;
      }
      throw new SetupError(m.invalidUrl);
    },
  },
];

export const lineCompletion: SetupCompletion = {
  title: 'Check the webhook endpoint in LINE after saving',
  localized: { 'zh-TW': '儲存設定後檢查 LINE 的 Webhook 網址' },
  asks: [
    {
      text: 'Confirm setting and testing the endpoint if its URL is known and differs (yes/no)',
      localized: {
        'zh-TW': '已知網址且設定不同時，確認是否設定並測試 Webhook（yes/no）',
      },
    },
  ],
  async run(ctx) {
    const locale = ctx.locale ?? 'en';
    const m = messages[locale];
    const { path, url } = webhookLocation(ctx);
    const instructions = webhookInstructions(locale, path, url);
    if (!url) return instructions;
    const token = ctx.credential(lineCredentials(ctx.entry)[1]);
    if (!validToken(token)) return `${instructions}\n${m.unknown}`;
    const api = new LineApi(ctx.fetch, token);
    const signal = () =>
      AbortSignal.any([ctx.signal, AbortSignal.timeout(8000)]);
    let status: string;
    try {
      const current = await api.webhookEndpoint(signal());
      if (current?.endpoint === url) return `${instructions}\n${m.match}`;
      status = current ? m.mismatch : m.missing;
    } catch {
      ctx.signal.throwIfAborted();
      return `${instructions}\n${m.unknown}`;
    }
    const answer = await ctx.prompt({ text: m.confirmWebhook(status, url) });
    if (answer.trim().toLowerCase() !== 'yes')
      return `${instructions}\n${status}`;
    try {
      await api.setWebhookEndpoint(url, signal());
    } catch {
      ctx.signal.throwIfAborted();
      return `${instructions}\n${m.saveFailed}`;
    }
    let passed = false;
    try {
      // Test the new URL directly because LINE caches the configured endpoint.
      passed = await api.testWebhookEndpoint(url, signal());
    } catch {
      ctx.signal.throwIfAborted();
    }
    return `${instructions}\n${m.saved} ${passed ? m.testPassed : m.testFailed}`;
  },
};
