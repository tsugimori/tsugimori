# Tsugimori

Tsugimori is a self-hosted, speed-first chat agent framework. It keeps conversation history in SQLite, enforces approvals in the gateway, and records timings for each processing stage.

## Quick start

Use Node.js 24 or later with Corepack.

```sh
corepack pnpm install
corepack pnpm exec tsugimori init ./ws
```

A new workspace can run with no platforms or agents. Add the first Telegram bot in a terminal. The wizard hides the token and asks for the owner's numeric Telegram user ID.

```sh
corepack pnpm exec tsugimori add platform telegram --dir ./ws
corepack pnpm exec tsugimori add agent codex --dir ./ws
corepack pnpm exec tsugimori doctor ./ws
corepack pnpm exec tsugimori start ./ws
```

The gateway reloads validated configuration and credentials while running. Owners can run `/add <agent|platform> <kind> [--id <id>]` and `/login <agentId>`. Setup progress stays in the originating thread. Enter credentials by replying to the bot's linked prompt in the owner's direct message. Rerun the same command and ID to resume an interrupted setup. Press Ctrl+C or send SIGTERM to stop the gateway and flush traces.

For manual configuration, use the [example workspace](examples/workspace/tsugimori.json) and [JSON Schema](schema/tsugimori.schema.json). Set a native user ID by adapter ID or platform kind in `owner`, or run `tsugimori pair [dir] --adapter <id>` and send the printed command to the bot in a direct message within ten minutes. Owners can use `/allow`, `/deny`, `/agent <id>`, `/model <name>`, and `/status`.

## Environment checks and setup

- `tsugimori doctor [dir] [--json]` reports core and enabled-plugin checks and exits with status 1 on failure.
- `tsugimori setup [dir] [--yes] [--upgrade]` prints the package-manager command for missing system packages. `--yes` runs that command. Setup installs the full Codex release package for each enabled Codex instance, verifies published SHA-256 checksums, and saves each version in `agents[].version`. Use `--upgrade` to update those pins to the latest release.
- `tsugimori start [dir]` logs failed checks and disables the affected capabilities. The owner gets a direct message with failures when a platform and its owner are available. Use `/status` for the current state.

## Plugin configuration

### Telegram

Add a `platforms` entry with `kind: "telegram"`, a unique `id`, and a `tokenEnv` naming the bot token variable. Each entry runs a separate bot. Telegram forum topics have separate history, sessions, and workspace directories. Agent replies and scheduled agent output render Markdown as Telegram formatting. Fixed-text reminders preserve their original Markdown characters. Owners can decide an approval with its buttons or by replying directly to the prompt. Telegram's group privacy mode controls which group messages reach the bot.

When Telegram upgrades a group to a supergroup, Tsugimori carries over its routing, schedules, pending approvals, history, summary, and agent session. Pending approval prompts from the old group are posted again in the supergroup. If the requester's original message can no longer be addressed, approval outcomes appear as standalone notices. A send that receives Telegram's migration response is retried once at the new chat ID.

The gateway retries temporary platform startup failures with exponential backoff. `doctor` probes Telegram connectivity. After five minutes, the gateway sends the owner an outage notice and follows up on recovery. Notices use an available owner chat and wait if none is available. Telegram rate-limit responses can extend the retry delay. An invalid Telegram token stops retries and prompts the owner to check it.

The owner-only `/status` card follows the workspace locale (`en` or `zh-TW`) and time zone (`Asia/Taipei` by default). It shows the gateway version and uptime, the chat's agent and model settings, reported session usage and compaction, rolling summary coverage, running and queued work, pending approvals, and schedules targeting the chat. It also shows platform retries and availability, agent and sandbox state, and the latest environment check results. The card reads local state and makes no provider requests to gather it.

Telegram’s `/` menu shows `/pair` in private chats before the bot has an owner. Once an owner is configured or paired, owner commands appear in the owner’s private chat and for that owner in groups the bot has seen. Menu descriptions follow the workspace locale. In groups, you can use `/cmd@botusername` with optional arguments, for example `/compact@ExampleBot`. The bot matches the command and its username case-insensitively and ignores commands addressed to other bots.

When Telegram reports a group upgrade, tsugimori carries the group's allowlist and agent settings to the supergroup and registers its menu there. If Telegram reports that a chat or member is unavailable, menu registration for that scope resumes when the bot receives a new message from that chat.

Set the workspace `locale` to `zh-TW` for Traditional Chinese approval prompts and owner notices, including startup environment checks. The default is `en`. Telegram reminders and approval prompts use each recipient’s latest known `@username` when available, falling back to a native mention on the display name.

### Codex

Add an `agents` entry with `kind: "codex"`. Set `model` and `thinking` to override the Codex defaults. A pinned version uses the entrypoint in `runtime/codex/<version>/codex-package.json`, with `bin/codex` (`bin/codex.exe` on Windows) as the fallback within that release directory. Setup retains the package's helper executables and sandbox resources. If `doctor` reports a missing `codex-code-mode-host` in a managed install, run `tsugimori setup --upgrade` in the workspace.

An unpinned entry uses `options.command` or `codex` on PATH. The login home defaults to `agents/<id>/home`. Set `options.codexHome` to override it. Paths resolve from the workspace. Guided setup uses Codex device sign-in, asks the owner to confirm the reported ChatGPT account, then runs a test turn.

### Claude Agent SDK

Add an `agents` entry with `kind: "claude-sdk"` and optionally set `model` and `thinking`. The Agent SDK ships its own Claude Code CLI. Guided setup uses Claude sign-in or a token generated by `claude setup-token`, then runs a test turn. Each agent uses `agents/<id>/home` by default. Set `options.claudeHome` to override it, or configure API-key authentication with `ANTHROPIC_API_KEY` or `options.apiKeyEnv`. The SDK starts with local skills and settings disabled.

Set `defaultAgent` to an agent ID to route new conversations by default. With a platform and zero agents, the gateway records incoming messages and tells the owner when a triggered message has no agent attached.

### Session compaction

Set `agents[].compactAt` to a positive token count. The default is 250,000. Tsugimori normally compacts between turns and keeps native auto-compaction as a safety net for long turns. The native limit is the larger of `compactAt × 1.6` (rounded up) and `compactAt + 150,000`, capped at the model's context window when known. This limit is passed as `model_auto_compact_token_limit` for Codex and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for Claude Code. The CLIs can impose their own limits.

Codex uses its post-turn threshold on supported CLIs. Setting `agents[].options.asyncCompaction` to `true` opts into async compaction when the installed CLI exposes it. The option defaults to `false`. Codex derives its percentage threshold from the model context window and uses the native safety net alone while that size is unavailable. `tsugimori doctor` reports the supported timing mode for the configured CLI and options.

Claude starts `/compact` in the background when a completed turn's reported context exceeds `compactAt`. New messages for the same session wait for compaction and run in order. Owners can also run `/compact` to compact the current chat's existing agent session. Task traces report the trigger (`post-turn`, `async`, `manual`, or `native`) and include before and after token counts when available. The gateway's rolling conversation summaries are configured separately.

## Conversation summaries

The gateway updates rolling summaries in a background queue as older messages fall outside `context.recentMessages`. Set `context.summary.model` to a lower-cost model accepted by the conversation's connector, or set `context.summary.enabled` to `false`. Fresh agent sessions receive the stored summary and subsequent messages.

## Schedules

Agents can create fixed messages or agent tasks using `schedule.create` and manage them with `schedule.list`, `schedule.pause`, `schedule.update`, and `schedule.cancel`. Timing supports Unix-millisecond one-time dates, fixed minute intervals, and five-field cron in the workspace or schedule time zone. Cron handles repeated and skipped local times during daylight saving changes. Schedules stay due while their platform is unavailable. Once it starts, the latest missed occurrence is delivered with a delay note by default. Set the schedule's `missed` option to `skip` to discard missed deliveries.

Schedules are scoped to the conversation they were created in. Self-delivery and untargeted one-time group delivery can proceed immediately. Other delivery and resource-intensive jobs require linked approval. Configure `scheduler.minIntervalMinutes` (default 15), `scheduler.maxActivePerUser` (default 20), and `scheduler.highCostModels` in the workspace.

Approval prompts offer **Approve** and **Deny**. Reply directly to the prompt with `approve` or `deny` to decide by text. Older replies such as `allow once` and `always` also approve the request. Approving a recurring schedule covers its future fires and edits that preserve the approved delivery scope. Resource checks can still require fresh owner approval.

The requesting agent waits up to two minutes. If approval is still pending, the gateway ends the turn and keeps any answer the agent already produced. Telegram marks the original request with 👀 as soon as the approval prompt is sent, replaces it with 👍 on approval or 👎 on denial, and clears it on expiry. Reactions are best-effort. Adapters without reactions send a one-line pending notice when the wait ends.

Pending approvals survive a reload or restart, and the gateway reports later outcomes in the requesting conversation, including the schedule reference when it creates a schedule. Schedule requests expire at the first scheduled trigger or 24 hours after the request was created, whichever comes first. Other requests expire after 24 hours. On expiry, the prompt shows **Expired**, its buttons are removed, and the requester is notified in the original conversation.

Pass native platform user IDs in the schedule's `mentions` array to notify specific recipients. Telegram also renders `[name](tg://user?id=123)` as a user mention and preserves `@username` in the message text.

## Chat workspaces and execution

Each chat has a workdir under `chats/<adapter-id>/<chat-id>/`. With Git available, the gateway records edits to `rules/` and `skills/` under the initiating member’s native ID. Use `workspace.configure` to request owner approval for default agent, model, and thinking settings. Approved settings are recorded in `agents.json`.

On Linux, add `"exec": {}` to enable the local sandbox, install bubblewrap (`bwrap`) and enable unprivileged user namespaces to use `exec.run`, `exec.read`, `exec.write`, and `exec.stop`. Commands run with a clean environment, an isolated network, and only the chat workdir available for persistent writes. Add deployment-specific read restrictions with `exec.denyRead`. When bubblewrap or unprivileged namespaces are unavailable, chat continues with shell and file tools disabled. The sandbox denies reads of the workspace environment file and the agents’ login homes.

## Admin web UI

Add a `web` section to enable the loopback-only admin server. It defaults to `127.0.0.1:8787`. The interface shows conversations and message logs, task traces, approvals, and grants. Configure `web.accessTeam`, `web.accessAud`, and `web.ownerEmail` or `web.ownerSub` for an owner-only Cloudflare Access application. Set `web.allowLocalWithoutAccess` to `true` for direct loopback development access.

## Preview tunnels

Add `"preview": {}` to enable Quick Tunnels. Start an HTTP service with `exec.run`, pass its internal loopback port as `backgroundPort`, then call `preview.open({port, ttl})`. TTL is in minutes and capped by `preview.maxTtlMinutes` (default 60). Previews close when their execution service exits, their TTL expires, or an authorized user closes them. Owners can use `/previews` and `/preview close <id>`. The local CLI also lists active previews with `tsugimori previews [dir]`.

Quick previews require `cloudflared` on PATH. The first visit redeems the URL token and receives a host-only session cookie. The gateway records preview origins and lifecycle events.

To enable named previews for owners, configure `preview.named` with `zoneId`, `tunnelId`, `domain`, and `accessAud`. Set the Access team and owner email or subject there or in `web`. Supply the zone-scoped DNS Edit token through `tokenEnv`, which defaults to `CLOUDFLARE_API_TOKEN`. Route Cloudflare Tunnel's preview catch-all to `127.0.0.1:8788` (or `preview.named.listen`), preserve the incoming Host, and protect preview hosts with the configured Access application. The gateway creates and removes per-preview DNS records. The gateway reloads named preview configuration and credentials while running. The admin web listener is configured at startup. [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
