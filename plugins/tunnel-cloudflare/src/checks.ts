import { definePlugin } from '@tsugimori/plugin-sdk';

export default definePlugin({
  name: 'tunnel-cloudflare',
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
    const token = credential(named.tokenEnv ?? 'CLOUDFLARE_API_TOKEN');
    let valid = false;
    if (token) {
      try {
        const result = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${named.zoneId}/dns_records?per_page=5`,
          {
            headers: { authorization: `Bearer ${token}` },
            redirect: 'error',
            signal: AbortSignal.timeout(5_000),
          },
        );
        valid =
          result.ok &&
          ((await result.json()) as { success?: boolean }).success === true;
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
        capabilities: ['preview.named'],
      },
    ];
  },
});
