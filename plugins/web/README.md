# Admin web UI

The web plugin serves read-only pages and JSON for conversations, message history, task traces, approvals, and grants. It listens only on loopback.

## Configuration

Add the top-level `web` section in `tsugimori.json`.

```json
{
  "web": {
    "enabled": true,
    "listen": "127.0.0.1:8787",
    "accessTeam": "example-team",
    "accessAud": "replace-with-admin-application-audience",
    "ownerEmail": "owner@example.com",
    "ownerSub": "replace-with-owner-subject",
    "allowLocalWithoutAccess": false
  }
}
```

| Key                       | Default and behavior                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                 | Defaults to `true` when `web` is present. Omit `web` or set this to `false` to disable the listener.                                                |
| `listen`                  | Defaults to `127.0.0.1:8787`. Use `127.0.0.1` or `[::1]` and a port from 1–65,535. Assign a distinct address from LINE and named preview listeners. |
| `accessTeam`, `accessAud` | Cloudflare Access team slug and admin application audience. Both are required for Access authentication.                                            |
| `ownerEmail`, `ownerSub`  | Supply either the allowed email or JWT subject. If both are supplied, both must match. The email check is case-insensitive.                         |
| `allowLocalWithoutAccess` | Defaults to `false`. Set to `true` for direct loopback access using a local Host without recognized proxy headers.                                  |

Access settings are identifiers in JSON. The server requires no credential environment variables.

## Setup, checks, and status

For remote access, configure an HTTPS hostname on a named Cloudflare Tunnel that forwards to the loopback admin listener. Put an owner-only Access policy on that hostname. The plugin verifies the Access JWT against the team's signing keys, issuer, audience, validity time, and configured owner identity. For local development, use `allowLocalWithoutAccess: true` and open `http://127.0.0.1:8787/` with the default address. The listener and access settings take effect at startup. This plugin is configured in JSON.

There is no web-specific `doctor` probe or dedicated `/status` row for the listener. Core checks report duplicate configured listener addresses, and a failure to bind the web port stops startup. After starting, open the admin URL to check routing and access.

## Views

The home page lists chats. Follow a chat to view messages and trace links. The **Approvals and grants** page shows queued and decided approvals and recorded grants. These pages and the corresponding JSON endpoints use GET. Decisions are made through [chat approvals](../../README.md#approvals-and-schedules).
