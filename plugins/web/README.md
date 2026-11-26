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
    "allowLocalWithoutAccess": false,
    "viewerServiceTokens": ["replace-with-client-id.access"]
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
| `viewerServiceTokens`     | Defaults to none. Lists Cloudflare Access service token client IDs that may open the console as read-only viewers. Up to 16 entries.                |

Access settings are identifiers in JSON. The server requires no credential environment variables.

## Setup, checks, and status

For remote access, configure an HTTPS hostname on a named Cloudflare Tunnel that forwards to the loopback admin listener. Put an owner-only Access policy on that hostname. The plugin verifies the Access JWT against the team's signing keys, issuer, audience, validity time, and configured owner identity. To let an automated maintainer read the console, create an Access service token, add a Service Auth policy for it on the admin application, and list its client ID in `viewerServiceTokens`. Access then forwards a JWT whose `common_name` is the client ID and that has no user email. The plugin accepts it as a viewer only when that ID is listed. Viewers can load every page and API that the console serves today; future write operations are reserved for the owner. Named previews accept only the owner. Revoke the token in Cloudflare to remove access. For local development, use `allowLocalWithoutAccess: true` and open `http://127.0.0.1:8787/` with the default address. The listener and access settings take effect at startup. This plugin is configured in JSON.

There is no web-specific `doctor` probe or dedicated `/status` row for the listener. Core checks report duplicate configured listener addresses, and a failure to bind the web port stops startup. After starting, open the admin URL to check routing and access.

## Build and development

Run `corepack pnpm --filter @tsugimori/web build` to generate the static Nuxt console in `dist/ui`. The workspace check includes Nuxt type checking, generation, and a CSP check on the served files. The gateway serves JSON when the UI build is absent.

For development, run the gateway on loopback with `allowLocalWithoutAccess: true`, then run `corepack pnpm --filter @tsugimori/web dev`. The Nuxt dev server proxies `/api`, including the live event stream, to `http://127.0.0.1:8787`. Set `TSUGIMORI_UI_GATEWAY` to use a different loopback address. After building, `corepack pnpm --filter @tsugimori/web preview` serves fixtures through the web plugin on `127.0.0.1:8788`. Set `TSUGIMORI_PREVIEW_PORT` to change the port or add `--empty` to exercise empty states.

## Views

- **Overview** (`/`) shows agent state, sign-in, model and activity, recent tasks, webhook status, record usage and chat summaries.
- **Tasks** (`/tasks`) filters tasks by status, agent, chat, platform, date and trigger text. **Task details** (`/task/:taskId`) shows the timing, context, transcript, tool calls, final output and trace waterfall.
- **Chat** (`/chat/:adapter/:chatId[/:topic]`) opens the latest message window and can load older messages. The task timeline expands active tasks and refreshes them over Server-Sent Events. The Tasks tab and the details panel show related tasks, routing, summaries, approvals and schedules. Plain chat history also works with JavaScript disabled.
- **Approvals and schedules** (`/ops`) shows pending and recently handled requests, grants and schedules. [Decisions go through the chat platform](../../README.md#approvals-and-schedules).

The header offers System, Light and Dark. System follows the device preference. Existing bookmarks for agents, traces, chat queries, approvals and schedules redirect to the corresponding views.

## Task list API

`GET /api/tasks` returns `{ tasks, nextCursor }` to authorized owners and viewers. Results are ordered by creation time, newest first, with task ID as the tie-breaker. Use the returned `nextCursor` with the same filters to load the next page. The default limit is 25, and the maximum is 100.

| Parameter         | Meaning                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `status`          | Stored task status, such as `running`, `sent`, or `failed`.                                              |
| `agent`           | Agent instance ID.                                                                                       |
| `chat`            | JSON array of adapter instance ID and chat ID, matching each row’s `chatKey`.                            |
| `platform`        | Platform kind, such as `telegram` or `line`.                                                             |
| `since`, `before` | Inclusive start and exclusive end by task creation time. Use ISO timestamps with an offset or UTC dates. |
| `q`               | Literal substring of the source message. SQLite folds ASCII case.                                        |
| `cursor`, `limit` | Opaque continuation cursor and page size.                                                                |

## Tool details

The gateway stores each framework or supported agent tool call's name, ID when supplied, timing, status, arguments, and result or error in the workspace database. The console shows these details. They stay out of agent context and summaries.

`web.toolDetails.maxChars` defaults to 4,000 per field and accepts a minimum of 200. Longer fields retain the beginning and end with an omitted-length marker. Before writing tool details, the gateway replaces known workspace secret values, process environment values referenced by configuration, common token patterns, and fields named like tokens, passwords, secrets, API keys, or authorization with `[redacted]`. Setup secret prompts are outside this recording path.

Set `web.toolDetails.enabled` to `false` to stop recording new tool details. Existing trace timing and stored details remain visible. `/remove` includes affected tool detail rows in the removal plan and database backup, and deletes them from the live database.
