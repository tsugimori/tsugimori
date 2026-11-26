# Admin web UI

The web plugin serves a read-only admin console and JSON on loopback. The console uses the workspace locale and time zone and displays the optional top-level `name` in the header.

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

- **Overview** (`/`) shows today's task and failure totals, pending approvals, and chat cards with activity, routing, and summary progress. **Chats** (`/chats`) opens the chat list directly.
- **Chat** shows the message and task timeline, recorded token usage, tool calls, and links to full traces.
- **Trace** shows elapsed time by span, expandable attributes, and any recorded tool details.
- **Approvals** lists pending requests, the 50 latest handled requests, and grants. [Decisions go through the chat platform](../../README.md#approvals-and-schedules).
- **Schedules** lists scheduled work, its status, and its next run.

## Tool details

The gateway stores each framework or supported agent tool call's name, ID when supplied, timing, status, arguments, and result or error in the workspace database. The console shows these details. They stay out of agent context and summaries.

`web.toolDetails.maxChars` defaults to 4,000 per field and accepts a minimum of 200. Longer fields retain the beginning and end with an omitted-length marker. Before writing tool details, the gateway replaces known workspace secret values, process environment values referenced by configuration, common token patterns, and fields named like tokens, passwords, secrets, API keys, or authorization with `[redacted]`. Setup secret prompts are outside this recording path.

Set `web.toolDetails.enabled` to `false` to stop recording new tool details. Existing trace timing and stored details remain visible. `/remove` includes affected tool detail rows in the removal plan and database backup, and deletes them from the live database.
