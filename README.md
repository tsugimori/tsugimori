# Tsugimori

Tsugimori is a self-hosted chat agent framework. The gateway routes messages, enforces permissions, and records processing times. SQLite stores chat history, sessions, approvals, schedules, and traces. Platform, agent, execution, tunnel, and web plugins connect the gateway to external services and provide optional capabilities.

## Quick start

From this repository, use Node.js 24 or later and Corepack. Obtain a Telegram bot token and your numeric Telegram user ID, then follow the two terminal wizards. The Codex wizard downloads a managed release and opens a device sign-in flow. [Telegram setup](plugins/platform-telegram/README.md) · [Codex setup](plugins/agent-codex/README.md)

```sh
corepack pnpm install
corepack pnpm exec tsugimori init ./ws
corepack pnpm exec tsugimori add platform telegram --dir ./ws
corepack pnpm exec tsugimori add agent codex --dir ./ws
corepack pnpm exec tsugimori doctor ./ws
corepack pnpm exec tsugimori start ./ws
```

Send `/status` to the bot in a direct message, then send a message to start a conversation. A workspace can also start with zero platforms or zero agents. With a platform and zero agents, the gateway still records ordinary incoming messages and tells the owner when a triggered message has no agent.

## Workspace and conversations

| Path                                     | Purpose                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsugimori.json`, `.env`                 | Validated JSON configuration and plugin credentials. Process environment values take precedence over workspace credentials of the same name. |
| `data/tsugimori.db`                      | Default SQLite database. `init` creates the directory and applies migrations.                                                                |
| `rules/global.md`, `platforms/<kind>.md` | Optional global and platform rules.                                                                                                          |
| `chats/<adapter-id>/<chat-id>/`          | Per-chat working directory. It can contain `rules/*.md`, `skills/`, and `agents.json`. Directory names are encoded when needed.              |
| `agents/<id>/home`, `runtime/`           | Default per-agent login homes and managed runtime files.                                                                                     |

Keep the deployment workspace separate from the framework checkout. Chat rules take precedence over platform and global rules. Permissions come from the gateway. With Git available, the gateway records chat rule and skill changes under the initiating user's native ID. The `workspace.configure` agent tool can request owner approval for chat defaults for agent, model, and thinking. The gateway records approved settings in `agents.json` and SQLite.

Owners are identified by native platform user ID. Set `owner` by adapter ID or platform kind, with the adapter ID taking precedence. To pair an adapter that has no owner, run `corepack pnpm exec tsugimori pair ./ws --adapter <id>` and send the printed `/pair` command to its bot in a DM within ten minutes. Owners trigger the agent in a DM or by mentioning the bot. In an allowlisted chat, members can trigger it by mentioning or replying to the bot. Ordinary messages can enter chat history even when they do not trigger a turn.

The gateway resumes an existing agent session when possible, using new chat content since its previous turn. Chat overrides take precedence over approved chat workspace settings, then the agent entry, then provider defaults. Codex and Claude support changing model, thinking, and fast settings on the next turn of an existing session. Switching agents or changing an option that requires a fresh session rebuilds context from that chat's stored history.

### Context and summaries

A fresh session receives rules, any usable rolling summary, and recent raw messages. `context.recentMessages` defaults to 30. With summaries enabled and an applicable summary cursor, a fresh session can receive up to `recentMessages + 40` raw messages after that cursor, including when the summary text is still empty. Without an applicable cursor, the base limit applies. The database keeps raw messages without a retention limit.

| `context.summary` key | Default      | Behavior                                                                                                                                                      |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | `true`       | Set to `false` to disable summary generation and use.                                                                                                         |
| `minMessages`         | `20`         | Minimum unsummarized messages outside the recent window before a background update.                                                                           |
| `minIntervalMinutes`  | `15`         | Minimum time since the last saved update. If only the interval blocks a run, it is rechecked when the interval ends. Set to `0` to remove the delay.          |
| `maxMessages`         | `200`        | Maximum messages per batch. A full batch with another full batch waiting queues an immediate catch-up that skips the interval and still checks `minMessages`. |
| `maxMessageChars`     | `1000`       | Maximum characters per excerpt (minimum `100`). Long excerpts keep their beginning and end around an omission marker with the message number.                 |
| `maxBatchChars`       | `60000`      | Character budget for the previous summary and excerpts (minimum `1000`). A batch always includes at least one message.                                        |
| `model`               | Chat's model | Optional model override for summary turns.                                                                                                                    |
| `thinking`            | `low`        | Reasoning effort for summary turns.                                                                                                                           |
| `timeoutMs`           | `120000`     | Time limit in milliseconds for each summary turn.                                                                                                             |

The first summary can run as soon as the backlog reaches the threshold. When `maxBatchChars` cuts a batch and at least `minMessages` remain, the next batch skips the interval. The saved summary is capped at 4,000 characters. Summary settings reload while the gateway runs. Agent session compaction is separate and preserves space in the provider's session. [Codex compaction](plugins/agent-codex/README.md#compaction) · [Claude compaction](plugins/agent-claude-sdk/README.md#compaction)

Agents can use `history.search` to find matching text in the current conversation, including its topic when applicable. Search returns excerpts, newest first, and accepts a sender ID and an inclusive range of recording times in Unix milliseconds. `history.read` takes a message sequence number and an optional inclusive end sequence, and returns the original text. Both tools return at most 50 messages per page and provide a cursor when more are available. `history.read` pages through oversized messages to keep each response within 40,000 characters. Results show recording times in the workspace time zone when available.

## Chat commands

| Command                                     | Who                                                       | What it does                                                                                                |
| ------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/help`                                     | Owner                                                     | Lists owner commands.                                                                                       |
| `/status`                                   | Owner                                                     | Shows gateway health, chat activity, and system state.                                                      |
| `/agent <id>`                               | Owner                                                     | Switches this chat to an available agent and reports any incompatible thinking or fast overrides it clears. |
| `/model [name]`                             | Owner                                                     | Shows the current model and its source, or sets a chat override. Use `default` to clear it.                 |
| `/thinking [level]`                         | Owner                                                     | Shows or sets reasoning effort for this chat. Use `default` to clear the override.                          |
| `/fast [on\|off\|default]`                  | Owner                                                     | Shows or sets speed on a supported agent. `off` selects standard speed and `default` clears the override.   |
| `/compact`                                  | Owner                                                     | Requests compaction of this chat's current agent session.                                                   |
| `/allow`                                    | Owner                                                     | Lets members trigger the bot in this chat.                                                                  |
| `/deny`                                     | Owner                                                     | Removes this chat from the allowlist and cancels active approval waits here.                                |
| `/pair <code>`                              | Pairing code holder, in a DM to an unowned bot            | Claims ownership using an unexpired code.                                                                   |
| `/add <agent\|platform> <kind> [--id <id>]` | Owner                                                     | Runs guided setup for a plugin instance.                                                                    |
| `/login <agentId>`                          | Owner                                                     | Signs an existing agent in again.                                                                           |
| `/remove <platform\|agent> <id>`            | Owner                                                     | Lists the data for an instance and asks for confirmation before removal.                                    |
| `/cancel`                                   | Owner in the originating chat or setup's secret-prompt DM | Cancels guided setup or a pending removal.                                                                  |
| `/previews`                                 | Owner                                                     | Lists open previews on this adapter.                                                                        |
| `/preview close <id>`                       | Owner                                                     | Closes a preview on this adapter.                                                                           |

`/status` uses the workspace locale and time zone. The header shows health, build information when available, and uptime. **This chat** shows the agent implementation and effective model, effort, and speed. When available, it adds context usage, session age, cached quota, last compaction and count, summary coverage, running or queued work, approvals, and schedules. **System** lists platform and agent states, sandbox availability, and the count of failed environment checks. The card uses cached provider information and local state, and shows today's timestamps without a date.

### Approvals and schedules

The designated approver or platform owner can use **Approve** or **Deny** buttons where supported, or reply directly to the approval prompt with its displayed decision word. English replies also accept `allow once` and `always`. The requesting agent waits up to two minutes, and pending requests survive restart. Schedule approvals expire at the first eligible run or after 24 hours, whichever comes sooner. Other approvals expire after 24 hours. Where supported, expiry edits the prompt and removes its buttons. The gateway sends standalone follow-up notices only on free-push platforms. On metered platforms the owner can see the latest decision in `/status` when available, or check the [admin UI](plugins/web/README.md).

Ask the agent to create or manage a schedule in the conversation where it belongs. It uses `schedule.create`, `schedule.list`, `schedule.update`, `schedule.pause`, and `schedule.cancel`. The creator and platform owner can manage it from that conversation. Fixed messages send directly. Agent tasks run the supplied instructions when due.

- Use a `once` trigger with `at`, an `interval` trigger with `at` and `minutes`, or five-field `cron` with `expr` and optional `from`. Use Unix milliseconds for `at`, `from`, and an optional recurring `until`, which is inclusive. For cron, `from` must precede `until` when both are set. Cron uses the schedule's time zone (the workspace time zone by default), including daylight saving transitions.
- Self-delivery and untargeted one-time group delivery ordinarily proceed without approval. Other delivery scopes, frequent or high-cost jobs, cross-chat agent tasks, and jobs flagged by the agent can require approval. Recurring approval covers future runs and edits with the same approved delivery scope, subject to resource checks. Use native platform user IDs in `mentions`.
- Schedules persist in SQLite and stay due while their platform is unavailable. The default `missed: "latest"` delivers the latest missed occurrence with a delay note. Use `"skip"` to skip missed deliveries. Metered deliveries use quota and carry `push.metered=true` in traces. A reply-only platform cannot schedule delivery. Existing schedules fail on their next due run if the platform becomes reply-only.

## Guided setup

Run `/add <agent|platform> <kind> [--id <id>]` or `/login <agentId>` as an owner. In a terminal, use `corepack pnpm exec tsugimori add <agent|platform> <kind> [--id <id>] [--dir <dir>]` (also available as `tsugimori setup <agent|platform> <kind> ...`) or `corepack pnpm exec tsugimori setup login <agentId> [--dir <dir>]`. Without `--id`, setup first asks for an instance name. Reply `default` or `-` to accept the suggestion: a random six-character hex ID for platforms, and the plugin kind for agents (`<kind>-2` and up when taken).

The wizard begins with a plan showing the steps, what each asks for, and when it saves credentials and configuration. Follow numbered progress in the originating conversation and reply directly to each prompt. Secret prompts go to the owner's DM and identify the origin. The gateway excludes secret replies from message history and attempts deletion where supported. Enter secrets in an interactive terminal to hide input there.

Guided setup offers buttons for preset answers on supported platforms and displays typed choices on LINE and in the terminal.

Rerun the same command and ID to resume an interrupted attempt from its saved checkpoint. To cancel, send `/cancel` in the originating chat or in the DM with the pending secret prompt. In a terminal, enter `/cancel` or press Ctrl+C. Cancellation reports credentials saved and any agent it left disabled. An explicitly cancelled attempt starts again at step 1. Re-login temporarily disables an enabled agent. If cancelled, that agent stays disabled until sign-in succeeds again. Successful setup saves configuration for the running gateway to reload.

### Remove an instance

Run `/remove <platform|agent> <id>` and confirm within 10 minutes: press **Delete** on platforms with buttons, or reply to the plan with `yes`. **Cancel**, any other reply, or `/cancel` cancels. To remove the platform you are currently using, switch to another platform or run `corepack pnpm exec tsugimori remove <platform|agent> <id> [--dir <dir>] [--yes]`. The CLI prints the plan and prompts unless you pass `--yes`. Run it under the gateway's OS account when the gateway is running.

Cancel an active setup for that instance before removing it. To remove the default agent, first set `defaultAgent` to another enabled agent in `tsugimori.json`. Without an explicit setting, the first enabled agent is the default. Chats whose agent override is removed fall back to the workspace default.

The gateway detaches the instance without a restart. Removal keeps credentials and runtime directories that other configured instances use. It saves a SQLite snapshot, the removed settings and credential lines, and the moved directories under `data/backups/remove-<category>-<id>-<timestamp>/`. Configured homes must share the backup filesystem so removal can move them. The backup includes credentials and chat data, so keep it private. You can delete it once you are satisfied with the removal. If removal stops partway through, use the completed steps and backup path in its report to check what changed.

## Configuration

See the [JSON Schema](schema/tsugimori.schema.json) and an [example workspace](examples/workspace/tsugimori.json).

| Key                   | Purpose and defaults                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`             | Optional schema reference for editors.                                                                                                                                                                     |
| `owner`               | Native owner IDs keyed by adapter ID or kind. Defaults to an empty map.                                                                                                                                    |
| `timezone`, `locale`  | Time zone for display and new schedules, default `Asia/Taipei`. Locale is `en` (default) or `zh-TW`.                                                                                                       |
| `storage`             | SQLite storage. Relative paths resolve from the workspace. The default is `data/tsugimori.db`.                                                                                                             |
| `platforms`, `agents` | Plugin instances, both empty by default. Entries have an `id`, `kind`, and optional `enabled` (default `true`). See the plugin guides for additional fields.                                               |
| `defaultAgent`        | Default agent ID for chats with no selection. When omitted, the gateway normally uses the first available agent.                                                                                           |
| `context`             | Recent message window and background summary settings. [Context and summaries](#context-and-summaries)                                                                                                     |
| `scheduler`           | Approval thresholds and limits. `minIntervalMinutes` defaults to 15 (1–1,440), `maxActivePerUser` to 20 (1–1,000), and `highCostModels` to an empty list.                                                  |
| `exec`                | Omit to disable, or use `{}` to enable Linux local execution with the default read restrictions. [Local sandbox configuration](plugins/exec-local-sandbox/README.md#configuration)                         |
| `web`                 | Omit to disable, or add a section to enable the loopback admin UI by default at `127.0.0.1:8787`. Direct local access requires explicit opt-in. [Web configuration](plugins/web/README.md#configuration)   |
| `preview`             | Omit to disable, or use `{}` to enable Quick previews with a 60-minute TTL cap. A named router defaults to `127.0.0.1:8788`. [Cloudflare configuration](plugins/tunnel-cloudflare/README.md#configuration) |

The gateway watches `tsugimori.json` and `.env` and can attach or detach platforms and agents without restart. The database path and admin web server configuration take effect at startup. LINE instances can share one listener address. Assign the admin web listener and the named preview router addresses distinct from each other and from LINE. `doctor` reports such conflicts, and the gateway rejects a configuration that has one. `webhooks.publicBaseUrl` sets the public HTTPS base that setup and `doctor` use to show full webhook URLs.

## Plugins

| Plugin                                                   | Purpose                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| [Telegram](plugins/platform-telegram/README.md)          | Telegram bots via long polling.                                      |
| [LINE](plugins/platform-line/README.md)                  | LINE Messaging API via signed webhooks and metered push.             |
| [Codex](plugins/agent-codex/README.md)                   | Agent connector for Codex App Server.                                |
| [Claude Agent SDK](plugins/agent-claude-sdk/README.md)   | Agent connector for Claude through its bundled CLI.                  |
| [Local sandbox](plugins/exec-local-sandbox/README.md)    | Linux command and file tools isolated per chat.                      |
| [Cloudflare Tunnel](plugins/tunnel-cloudflare/README.md) | Time-limited Quick and named previews of chat services.              |
| [Admin web UI](plugins/web/README.md)                    | Read-only inspection of chat history, traces, approvals, and grants. |

## Operations

- **Service**. Run `corepack pnpm exec tsugimori start /absolute/path/to/workspace` in the foreground from the repository, for example under systemd with the repository as `WorkingDirectory`. Use a service user with access to the workspace and Node.js on its PATH. SIGINT or SIGTERM stops the gateway and flushes traces.
- **Health checks**. `corepack pnpm exec tsugimori doctor [dir] [--json]` checks Node.js, the database path, Git, configured listener conflicts, and enabled plugin capabilities. It exits with status 1 on failure. Startup logs failed checks and disables affected capabilities where it can. Startup failure notices go to an owner DM when a free-push channel is available.
- **Logs**. Capture stderr for structured gateway events, and use `/status` or the admin UI for persisted task traces and chat state.
- **Backups**. For a file copy, stop the service first and back up the workspace, including `data/tsugimori.db` (or your configured path) and any SQLite sidecar files still present. Protect the backup as it can contain chat history, `.env`, and agent login homes.
- **Upgrades**. Stop the service and back up the workspace, update the checkout, run `corepack pnpm install`, then run `doctor` and restart. The gateway applies SQLite migrations when it opens the database. `corepack pnpm exec tsugimori setup [dir] [--yes] [--upgrade]` prints commands for missing system packages and runs them with `--yes`. Setup also installs managed Codex releases and records their pins. Use `--upgrade` to update those pins.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development commands, or [LICENSE](LICENSE) for license terms.
