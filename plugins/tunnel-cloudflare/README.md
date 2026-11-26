# Cloudflare Tunnel

The tunnel plugin publishes time-limited previews of HTTP services started in a conversation's [local sandbox](../exec-local-sandbox/README.md). Quick Tunnels use a one-time URL token. Named previews for owners use Cloudflare Access.

## Configuration

Use `"preview": {}` in `tsugimori.json` for Quick Tunnels with the default 60-minute TTL cap. The following adds named previews.

```json
{
  "preview": {
    "maxTtlMinutes": 60,
    "named": {
      "zoneId": "0123456789abcdef0123456789abcdef",
      "tunnelId": "01234567-89ab-cdef-0123-456789abcdef",
      "domain": "example.com",
      "listen": "127.0.0.1:8788",
      "accessTeam": "example-team",
      "accessAud": "replace-with-preview-application-audience",
      "ownerEmail": "owner@example.com",
      "ownerSub": "replace-with-owner-subject",
      "tokenEnv": "CLOUDFLARE_API_TOKEN"
    }
  }
}
```

- `maxTtlMinutes` accepts 1–1,440 and defaults to 60.
- `named.zoneId`, `tunnelId`, `domain`, and `accessAud` identify the DNS zone, named tunnel, preview domain, and Access application. Replace the example values with your own.
- `named.listen` defaults to `127.0.0.1:8788` and accepts an IPv4 loopback port from 1–65,535. Give it a distinct address from enabled web and LINE listeners.
- Configure `accessTeam` and at least one of `ownerEmail` or `ownerSub`. If both identities are set, both must match. Absent team and identity fields inherit from `web` individually. The preview audience is configured explicitly.
- `tokenEnv` defaults to `CLOUDFLARE_API_TOKEN`. Put a zone-scoped DNS Edit token in the process environment or workspace `.env`. Quick Tunnels require no configured credentials.

## Setup, checks, and status

1. Install `cloudflared` on the gateway's PATH for Quick Tunnels.
2. For named previews, set up a running named tunnel and an Access application covering the generated `pv-*.example.com` hosts. Route preview hosts through a catch-all ingress to the loopback router and preserve the incoming Host. The gateway creates a proxied CNAME for each open preview and removes it on close. The router authenticates Access requests using the signed JWT and the configured identity.
3. Configure the preview section and run `tsugimori doctor`. The gateway reloads named configuration and workspace credentials while running. Replacing the named provider closes its existing previews.

Setup is manual. `doctor` checks whether `cloudflared --version` succeeds and, for named previews, whether the token can list zone DNS records and the Access identity and router port are configured. This probe checks DNS read access. Creating and removing records requires DNS edit access. `/status` counts failed environment checks in **System**. Use `/previews` to see active previews on the adapter or `corepack pnpm exec tsugimori previews [dir]` to list them locally.

## Opening and closing previews

Start an HTTP service in the chat sandbox with `exec.run` and `backgroundPort`, then call the `preview.open({port, ttl})` agent tool. `ttl` is an integer in minutes and the gateway caps it at `maxTtlMinutes`. Each chat can have up to eight open previews. Owners use named previews when configured. Other requests use Quick Tunnels. Access to named previews depends on the named provider when configured.

Quick Tunnels have a random public hostname. The first successful GET redeems the URL token, sets a host-only session cookie, and redirects to the URL without the token. Keep the initial URL private. The gateway stores and lists only the preview origin, so the list cannot recover a redemption token.

The opener or platform owner can close a preview in that same chat with `preview.close`. An owner can also run `/preview close <id>` for any preview on the adapter. Previews close when they expire, their execution service stops, or the gateway shuts down. Restart marks any retained open records as closed. The named router removes orphaned preview DNS records marked by Tsugimori during reconciliation. Opening and closing events are traced.
