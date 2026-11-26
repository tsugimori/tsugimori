import type {
  CheckItem,
  SetupStep,
  WebhookProvider,
  WebhookProviderContext,
} from '@tsugimori/plugin-sdk';

import { SetupError, WebhookProviderError } from '@tsugimori/plugin-sdk';
import { isDeepStrictEqual } from 'node:util';

import {
  cloudflareApi,
  cloudflareId,
  cloudflareToken,
  cloudflareTunnelId,
  defaultCloudflareTokenEnv,
  record,
} from './api.ts';

const marker = 'tsugimori webhook';
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const dnsName =
  /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)+$/;
type Api = ReturnType<typeof cloudflareApi>;
type Locale = 'en' | 'zh-TW';

interface WebhookOptions {
  accountId: string;
  hostname: string;
  tokenEnv: string;
  tunnelId: string;
  zoneId: string;
}

const messages = {
  en: {
    token:
      'Enter a Cloudflare API token with Cloudflare Tunnel Edit, DNS Edit, and Zone Read permissions.',
    tokenInvalid: 'Cloudflare did not verify the API token.',
    hostname:
      'Enter the public webhook hostname (for example hooks.example.com).',
    hostnameInvalid: 'Enter a valid DNS hostname.',
    noZone: 'No Cloudflare zone matches that hostname.',
    tunnel: 'Choose a healthy Cloudflare Tunnel.',
    noTunnel: 'No usable Cloudflare Tunnel found.',
  },
  'zh-TW': {
    token:
      '請輸入具備 Cloudflare Tunnel Edit、DNS Edit 與 Zone Read 權限的 Cloudflare API 權杖。',
    tokenInvalid: 'Cloudflare 無法驗證這個 API 權杖。',
    hostname: '請輸入完整的 Webhook 網域名稱（例如 hooks.example.com）。',
    hostnameInvalid: '請輸入有效的 DNS 網域名稱。',
    noZone: '找不到符合這個網域名稱的 Cloudflare DNS 區域。',
    tunnel: '請選擇一條運作正常的 Cloudflare Tunnel。',
    noTunnel: '找不到可用的 Cloudflare Tunnel',
  },
};

function validHostname(hostname: unknown): hostname is string {
  return (
    typeof hostname === 'string' &&
    hostname.length <= 253 &&
    dnsName.test(hostname)
  );
}

function options(value: unknown): WebhookOptions {
  const {
    accountId,
    hostname,
    tokenEnv = defaultCloudflareTokenEnv,
    tunnelId,
    zoneId,
  } = record(value);
  if (
    !validHostname(hostname) ||
    typeof accountId !== 'string' ||
    !cloudflareId.test(accountId) ||
    typeof zoneId !== 'string' ||
    !cloudflareId.test(zoneId) ||
    typeof tunnelId !== 'string' ||
    !cloudflareTunnelId.test(tunnelId) ||
    typeof tokenEnv !== 'string' ||
    !envName.test(tokenEnv)
  )
    throw new WebhookProviderError(
      'cloudflare_config',
      'Cloudflare webhook settings are incomplete or invalid. Run /webhook setup.',
      'Cloudflare Webhook 設定不完整或無效。請執行 /webhook setup。',
    );
  return { accountId, hostname, tokenEnv, tunnelId, zoneId };
}

async function verifyToken(api: Api, signal: AbortSignal) {
  const data = await api('/user/tokens/verify', 'GET', undefined, signal);
  if (record(data.result).status !== 'active')
    throw new WebhookProviderError(
      'cloudflare_token',
      messages.en.tokenInvalid,
      messages['zh-TW'].tokenInvalid,
    );
}

async function list(
  api: Api,
  path: string,
  query: URLSearchParams,
  signal: AbortSignal,
) {
  const items: Record<string, unknown>[] = [];
  for (let page = 1; page <= 1000; page++) {
    query.set('page', String(page));
    const data = await api(path + '?' + query, 'GET', undefined, signal);
    if (!Array.isArray(data.result))
      throw new WebhookProviderError(
        'cloudflare_response',
        'Cloudflare returned an invalid listing.',
      );
    items.push(...data.result.map(record));
    const pages = record(data.result_info).total_pages;
    if (typeof pages !== 'number' || pages <= page) return items;
  }
  throw new WebhookProviderError(
    'cloudflare_response',
    'Cloudflare returned too many pages.',
  );
}

async function discoverZone(api: Api, hostname: string, signal: AbortSignal) {
  const parts = hostname.split('.');
  for (let offset = 0; offset < parts.length - 1; offset++) {
    const name = parts.slice(offset).join('.');
    const zones = await list(
      api,
      '/zones',
      new URLSearchParams({ name }),
      signal,
    );
    const zone = zones.find((item) => item.name === name);
    const accountId = record(zone?.account).id;
    const zoneId = zone?.id;
    if (
      typeof accountId === 'string' &&
      cloudflareId.test(accountId) &&
      typeof zoneId === 'string' &&
      cloudflareId.test(zoneId)
    )
      return { zoneId, accountId };
  }
}

function tunnelPath({
  accountId,
  tunnelId,
}: Pick<WebhookOptions, 'accountId' | 'tunnelId'>) {
  return `/accounts/${accountId}/cfd_tunnel/${tunnelId}`;
}

async function remoteTunnel(
  api: Api,
  settings: Pick<WebhookOptions, 'accountId' | 'tunnelId'>,
  signal: AbortSignal,
) {
  const data = await api(tunnelPath(settings), 'GET', undefined, signal);
  const tunnel = record(data.result);
  if (tunnel.remote_config === false || tunnel.config_src === 'local')
    throw new WebhookProviderError(
      'cloudflare_local_tunnel',
      'This tunnel uses a local configuration file. Migrate it to remote management at https://one.dash.cloudflare.com/ → Networks → Tunnels → select the tunnel → Migrate.',
      '這條 tunnel 是用本機設定檔管理的，tsugimori 沒辦法改它的路由。請到 Cloudflare 把它遷移成遠端管理：https://one.dash.cloudflare.com/ → Networks → Tunnels → 選這條 tunnel → Migrate',
    );
  if (tunnel.remote_config !== true && tunnel.config_src !== 'cloudflare')
    throw new WebhookProviderError(
      'cloudflare_config',
      'Cloudflare did not identify the tunnel as remotely managed.',
      'Cloudflare 未確認這條 tunnel 採遠端管理。',
    );
  return tunnel;
}

function setupError(error: unknown, locale: Locale) {
  if (error instanceof WebhookProviderError)
    return new SetupError(
      locale === 'zh-TW' ? (error.zh ?? error.message) : error.message,
    );
  return error;
}

const setupSteps: SetupStep[] = [
  {
    id: 'cloudflare-token',
    title: 'Verify the Cloudflare API token',
    localized: { 'zh-TW': '驗證 Cloudflare API 權杖' },
    asks: [
      {
        text: 'Cloudflare API token',
        localized: { 'zh-TW': 'Cloudflare API 權杖' },
        secret: true,
      },
    ],
    saves: {
      text: 'writes the verified API token to .env',
      localized: { 'zh-TW': '將通過驗證的 API 權杖寫入 .env' },
    },
    async run(ctx) {
      const locale = ctx.locale ?? 'en';
      const m = messages[locale];
      const token = (await ctx.prompt({ text: m.token, secret: true })).trim();
      if (!/^[!-~]+$/.test(token)) throw new SetupError(m.tokenInvalid);
      const current = ctx.webhooks?.cloudflare?.tokenEnv;
      const tokenEnv =
        typeof current === 'string' && envName.test(current)
          ? current
          : defaultCloudflareTokenEnv;
      try {
        await verifyToken(cloudflareApi(token, ctx.fetch), ctx.signal);
      } catch (error) {
        ctx.signal.throwIfAborted();
        throw setupError(error, locale);
      }
      await ctx.writeEnv(tokenEnv, token);
      ctx.writeConfig({ webhooks: { cloudflare: { tokenEnv } } });
    },
  },
  {
    id: 'cloudflare-hostname',
    title: 'Choose the public hostname',
    localized: { 'zh-TW': '選擇公開的網域名稱' },
    asks: [
      { text: 'Public hostname', localized: { 'zh-TW': '公開的網域名稱' } },
    ],
    async run(ctx) {
      const m = messages[ctx.locale ?? 'en'];
      const hostname = (await ctx.prompt({ text: m.hostname }))
        .trim()
        .toLowerCase();
      if (!validHostname(hostname)) throw new SetupError(m.hostnameInvalid);
      ctx.writeConfig({
        webhooks: { cloudflare: { ...ctx.webhooks?.cloudflare, hostname } },
      });
    },
  },
  {
    id: 'cloudflare-tunnel',
    title: 'Discover the DNS zone and choose a remotely managed tunnel',
    localized: { 'zh-TW': '尋找 DNS 區域並選擇遠端管理的 tunnel' },
    asks: [
      {
        text: 'Choose a tunnel if several are healthy',
        localized: { 'zh-TW': '有多條運作正常的 tunnel 時選擇一條' },
      },
    ],
    retryFrom: 'cloudflare-hostname',
    async run(ctx) {
      const locale = ctx.locale ?? 'en';
      const m = messages[locale];
      const { hostname, tokenEnv } = record(ctx.webhooks?.cloudflare);
      if (!validHostname(hostname)) throw new SetupError(m.hostnameInvalid);
      const token = cloudflareToken(
        ctx.credential,
        typeof tokenEnv === 'string' ? tokenEnv : undefined,
      );
      if (!token) throw new SetupError(m.tokenInvalid);
      const api = cloudflareApi(token, ctx.fetch);
      try {
        const zone = await discoverZone(api, hostname, ctx.signal);
        if (!zone) throw new SetupError(m.noZone);
        const tunnels = (
          await list(
            api,
            `/accounts/${zone.accountId}/cfd_tunnel`,
            new URLSearchParams({ is_deleted: 'false' }),
            ctx.signal,
          )
        ).filter(
          ({ id, name, status, deleted_at }) =>
            typeof id === 'string' &&
            cloudflareTunnelId.test(id) &&
            typeof name === 'string' &&
            status === 'healthy' &&
            !deleted_at,
        );
        if (!tunnels.length) throw new SetupError(m.noTunnel);
        const choices = tunnels.map(({ id, name }) => ({
          value: id as string,
          label: String(name).replace(/\s+/gu, ' ').slice(0, 100),
        }));
        const tunnelId =
          choices.length === 1
            ? choices[0]!.value
            : (await ctx.prompt({ text: m.tunnel, choices }))
                .trim()
                .toLowerCase();
        if (
          !choices.some(
            ({ value }) => value.toLowerCase() === tunnelId.toLowerCase(),
          )
        )
          throw new SetupError(m.noTunnel);
        await remoteTunnel(api, { ...zone, tunnelId }, ctx.signal);
        ctx.writeConfig({
          webhooks: {
            cloudflare: { ...ctx.webhooks?.cloudflare, ...zone, tunnelId },
          },
        });
      } catch (error) {
        ctx.signal.throwIfAborted();
        throw setupError(error, locale);
      }
    },
  },
];

function context(ctx: WebhookProviderContext) {
  const settings = options(ctx.config.cloudflare);
  const token = cloudflareToken(ctx.credential, settings.tokenEnv);
  if (!token)
    throw new WebhookProviderError(
      'cloudflare_token',
      messages.en.tokenInvalid,
      messages['zh-TW'].tokenInvalid,
    );
  return {
    settings,
    api: cloudflareApi(token, ctx.fetch),
    service: 'http://' + ctx.listen,
    signal: ctx.signal,
  };
}

function matchingRule(rule: Record<string, unknown>, hostname: string) {
  return (
    typeof rule.hostname === 'string' &&
    rule.hostname.toLowerCase() === hostname &&
    !rule.path
  );
}

function shadows(rule: Record<string, unknown>, hostname: string) {
  const host =
    typeof rule.hostname === 'string' ? rule.hostname.toLowerCase() : '';
  return !host || (host.startsWith('*.') && hostname.endsWith(host.slice(1)));
}

function upsert(
  ingress: readonly Record<string, unknown>[],
  hostname: string,
  service: string,
) {
  const rule = { hostname, service };
  const others = ingress.filter((item) => !matchingRule(item, hostname));
  const catchAll = others.findIndex((item) => !item.hostname && !item.path);
  const fallback =
    catchAll >= 0
      ? others.splice(catchAll, 1)[0]!
      : { service: 'http_status:404' };
  const existing = ingress.findIndex((item) => matchingRule(item, hostname));
  const shadow = others.findIndex((item) => shadows(item, hostname));
  const insert = Math.min(
    existing === -1 ? others.length : existing,
    shadow === -1 ? others.length : shadow,
  );
  others.splice(insert, 0, rule);
  return [...others, fallback];
}

async function readIngress(api: Api, path: string, signal: AbortSignal) {
  const data = await api(path, 'GET', undefined, signal);
  const config = record(record(data.result).config);
  const rows = config.ingress;
  if (
    rows !== undefined &&
    (!Array.isArray(rows) ||
      rows.some((item) => typeof record(item).service !== 'string'))
  )
    throw new WebhookProviderError(
      'cloudflare_response',
      'Cloudflare returned invalid tunnel ingress rules.',
    );
  return { config, ingress: Array.isArray(rows) ? rows.map(record) : [] };
}

async function dnsRecords(
  api: Api,
  { hostname, zoneId }: WebhookOptions,
  signal: AbortSignal,
) {
  const path = `/zones/${zoneId}/dns_records`;
  const records = await list(
    api,
    path,
    new URLSearchParams({ 'name.exact': hostname }),
    signal,
  );
  return { path, records: records.filter((item) => item.name === hostname) };
}

function matchesDns(item: Record<string, unknown>, content: string) {
  return (
    item.type === 'CNAME' &&
    typeof item.content === 'string' &&
    item.content.toLowerCase().replace(/\.$/, '') === content &&
    item.proxied === true
  );
}

function dnsUpdate(
  records: readonly Record<string, unknown>[],
  hostname: string,
  content: string,
) {
  if (records.length === 1 && matchesDns(records[0]!, content)) return;
  const fields = {
    type: 'CNAME',
    name: hostname,
    content,
    proxied: true,
    ttl: 1,
    comment: marker,
  };
  if (!records.length) return { path: '', method: 'POST', fields };
  const [item] = records;
  if (
    records.length === 1 &&
    item?.comment === marker &&
    typeof item.id === 'string' &&
    cloudflareId.test(item.id)
  )
    return { path: '/' + item.id, method: 'PATCH', fields };
  throw new WebhookProviderError(
    'dns_conflict',
    `${hostname} already has another DNS record. It was left in place.`,
    `${hostname} 已經有其他 DNS 紀錄，沒有覆寫`,
  );
}

async function checked(
  id: string,
  title: string,
  run: () => Promise<boolean>,
): Promise<CheckItem> {
  try {
    const ok = await run();
    return {
      id,
      title,
      status: ok ? 'ok' : 'fail',
      detail: ok
        ? title + ' verified.'
        : title + ' is unavailable or differs from the configuration.',
    };
  } catch (error) {
    return {
      id,
      title,
      status: 'fail',
      detail:
        error instanceof WebhookProviderError
          ? error.message
          : title + ' check failed.',
    };
  }
}

export const cloudflareWebhook: WebhookProvider = {
  id: 'cloudflare',
  baseUrl: (config) => 'https://' + options(config.cloudflare).hostname,
  setupSteps,
  async ensure(ctx) {
    const { api, service, settings, signal } = context(ctx);
    await remoteTunnel(api, settings, signal);
    const { hostname, tunnelId } = settings;
    const content = tunnelId.toLowerCase() + '.cfargotunnel.com';
    const dns = await dnsRecords(api, settings, signal);
    const update = dnsUpdate(dns.records, hostname, content);
    const path = tunnelPath(settings) + '/configurations';
    const { config, ingress } = await readIngress(api, path, signal);
    const next = upsert(ingress, hostname, service);
    if (!isDeepStrictEqual(next, ingress))
      await api(path, 'PUT', { config: { ...config, ingress: next } }, signal);
    if (update)
      await api(dns.path + update.path, update.method, update.fields, signal);
    return { baseUrl: 'https://' + hostname };
  },
  async checks(ctx) {
    const { api, service, settings, signal } = context(ctx);
    return [
      await checked(
        'webhook-cloudflare-token',
        'Cloudflare API token',
        async () => {
          await verifyToken(api, signal);
          return true;
        },
      ),
      await checked(
        'webhook-cloudflare-tunnel',
        'Cloudflare Tunnel health',
        async () =>
          (await remoteTunnel(api, settings, signal)).status === 'healthy',
      ),
      await checked(
        'webhook-cloudflare-ingress',
        'Cloudflare Tunnel ingress rule',
        async () => {
          const { ingress } = await readIngress(
            api,
            tunnelPath(settings) + '/configurations',
            signal,
          );
          return ingress.some(
            (rule) =>
              matchingRule(rule, settings.hostname) && rule.service === service,
          );
        },
      ),
      await checked(
        'webhook-cloudflare-dns',
        'Cloudflare DNS record',
        async () => {
          const { records } = await dnsRecords(api, settings, signal);
          return records.some((item) =>
            matchesDns(
              item,
              settings.tunnelId.toLowerCase() + '.cfargotunnel.com',
            ),
          );
        },
      ),
    ];
  },
};
