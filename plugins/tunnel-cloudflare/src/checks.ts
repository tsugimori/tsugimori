import { definePlugin } from '@tsugimori/plugin-sdk';

import { cloudflareApi, cloudflareToken } from './api.ts';
import { cloudflareWebhook } from './webhooks.ts';

export default definePlugin({
  name: 'tunnel-cloudflare',
  webhookProviders: [cloudflareWebhook],
  async checks({ credential, entry, fetch, runCommand }) {
    let cloudflared = false;
    try {
      cloudflared =
        (await runCommand(['cloudflared', '--version'])).exitCode === 0;
    } catch {
      // A missing or unusable binary only disables Quick Tunnels.
    }
    const items = [
      {
        id: 'cloudflared',
        title: 'Cloudflare Tunnel CLI',
        status: cloudflared ? 'ok' : 'fail',
        detail: cloudflared
          ? 'cloudflared is available.'
          : 'cloudflared is unavailable. Quick previews are disabled.',
        capabilities: ['preview.quick'],
        fix: cloudflared
          ? undefined
          : { hint: 'Install cloudflared from Cloudflare.' },
        localized: {
          'zh-TW': {
            title: 'Cloudflare Tunnel CLI',
            hint: '請從 Cloudflare 安裝 cloudflared。',
          },
        },
      },
    ] as const;
    const named = entry.options?.named as
      | {
          accessTeam?: string;
          listen?: string;
          ownerEmail?: string;
          ownerSub?: string;
          tokenEnv?: string;
          zoneId: string;
        }
      | undefined;
    if (!named) return items;
    const web = entry.options?.web as
      Pick<typeof named, 'accessTeam' | 'ownerEmail' | 'ownerSub'> | undefined;
    const token = cloudflareToken(credential, named.tokenEnv);
    let valid = false;
    if (token) {
      try {
        await cloudflareApi(
          token,
          fetch,
        )(`/zones/${named.zoneId}/dns_records?per_page=5`);
        valid = true;
      } catch {
        // Report only the state. Request details can contain credentials.
      }
    }
    const port = Number((named.listen ?? '127.0.0.1:8788').split(':').at(-1));
    const validPort = port >= 1 && port <= 65535;
    const access = Boolean(
      (named.accessTeam ?? web?.accessTeam) &&
      ((named.ownerEmail ?? web?.ownerEmail) ||
        (named.ownerSub ?? web?.ownerSub)),
    );
    return [
      ...items,
      {
        id: 'cloudflare-token',
        title: 'Cloudflare DNS credentials',
        status: valid && access && validPort ? 'ok' : 'fail',
        detail:
          valid && access && validPort
            ? 'The token can read zone DNS and Access is configured.'
            : !valid
              ? 'Configure a zone-scoped DNS token. Named previews are disabled.'
              : !access
                ? 'Configure the Cloudflare Access team and owner. Named previews are disabled.'
                : 'Configure a valid named preview router port.',
        localized: {
          'zh-TW': {
            title: 'Cloudflare DNS 憑證',
            hint: !valid
              ? '請設定有權存取此 DNS 區域的權杖。'
              : !access
                ? '請設定 Cloudflare Access 的團隊與主人身分。'
                : '請為具名預覽路由器設定有效的連接埠。',
          },
        },
        capabilities: ['preview.named'],
      },
    ];
  },
});
