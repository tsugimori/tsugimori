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

Build the [live admin console](plugins/web/README.md) with `corepack pnpm --filter @tsugimori/web build`.

## Workspace and conversations

| Path                            | Purpose                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsugimori.json`, `.env`        | Validated JSON configuration and plugin credentials. Process environment values take precedence over workspace credentials of the same name. |
| `data/tsugimori.db`             | Default SQLite database. `init` creates the directory and applies migrations.                                                                |
| `AGENTS.md`                     | Workspace rules and a map of guidelines to read by task.                                                                                     |
| `SOUL.md`                       | Agent identity and persona.                                                                                                                  |
| `WORDING.md`                    | Writing rules for every output.                                                                                                              |
| `MEMORY.md`                     | Long-term facts and preferences.                                                                                                             |
| `rules/global.md`               | Optional legacy workspace rules.                                                                                                             |
| `platforms/<kind>.md`           | Optional rules for the current platform.                                                                                                     |
| `writing/`                      | Task-specific Markdown guidelines read on demand with `guide.read`.                                                                          |
| `chats/<adapter-id>/<chat-id>/` | Per-chat working directory. It can contain `rules/*.md`, `skills/`, and `agents.json`. Directory names are encoded when needed.              |
| `agents/<id>/home`, `runtime/`  | Default per-agent login homes and managed runtime files.                                                                                     |

Keep the deployment workspace separate from the framework checkout. Chat rules take precedence over platform and global rules. Permissions come from the gateway. With Git available, the gateway records chat rule and skill changes under the initiating user's native ID. The `workspace.configure` agent tool can request owner approval for chat defaults for agent, model, and thinking. The gateway records approved settings in `agents.json` and SQLite.

The deployment workspace can be a Git checkout. Use its `.gitignore` to whitelist guideline files only. The `memory.propose` tool requests linked owner approval to add, replace, or remove a bullet in `MEMORY.md`. If the workspace checkout has an `origin`, the gateway commits and pushes the approved edit. The approval result reports any Git failure, and the file edit stays in place.

Telegram platform entries can set `richMessages` to `true` for native Markdown tables on supported clients. The default shows tables as bullet groups. The setting reloads while the gateway is running. [Telegram configuration](plugins/platform-telegram/README.md#configuration)

An agent can stay silent by returning `NO_REPLY: <short reason>` on a single line. A bare `NO_REPLY` also works. The console shows the reason, and any required approval notice still goes out.

### Execution records

Open a task in the owner console to inspect its trigger decision, resolved model, session, new input, transcript, output, delivery receipts, and stage timings. The context view loads referenced message and summary revisions and guideline files on demand. Git-tracked guidelines are read from their recorded commit. Modified or untracked guidelines in a Git workspace are saved by content hash. Guidelines in a workspace without Git have hash references only.

The console also shows raw Telegram and LINE message payloads when available. Private commands omit their raw payload. Agent text, visible reasoning, and tool details use secret redaction. Stored tool arguments and results are capped at 64 KiB per field, with a 4 KiB cap for web search results. Codex web search records include the item duration and any result data Codex exposes. `web.toolDetails.maxChars` controls how much the console displays.

`records.maxBytes` defaults to 2 GiB (2,147,483,648 bytes). The gateway checks usage one minute after startup and hourly thereafter. When usage exceeds the cap, it prunes the oldest transcripts and task input/output, then raw message payloads, then unreferenced guideline blobs and summary versions. It aims for 90% of the cap and keeps task outcomes, message text, and tool-call metadata. Records have no age limit.

The build writes `packages/core/dist/build-info.json` with the source commit, dirty state, and build time when Git metadata is available. The gateway reads it at startup and attaches the source revision to task context references.

Owners are identified by native platform user ID. Set `owner` by adapter ID or platform kind, with the adapter ID taking precedence. When an owner adds a platform from chat, the gateway sends its pairing code privately once the unowned platform attaches. An owner can also DM `/pair new <id>` to a bot they own to replace the code. For the first owner, run `corepack pnpm exec tsugimori pair ./ws --adapter <id>`. Send the resulting `/pair <code>` line to the new bot in a DM within 24 hours. Issuing a new code for the same adapter replaces the previous code. Pairing or configuring an owner invalidates any pending code. Owners trigger the agent in a DM or by mentioning the bot. In an allowlisted chat, members can trigger it by mentioning or replying to the bot. Ordinary messages can enter chat history even when they do not trigger a turn.

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

For Telegram and LINE, chat context includes attachment metadata and quoted
messages when available. Agents can use `attachment.get` with a message ID and
attachment index to download a file into the current chat workspace. Image
downloads made with this tool are removed when the task ends. With `ffmpeg` on
PATH, supported inbound images reach the model from memory. For LINE stickers
and stickers from named Telegram sets, later turns use a cached English
description when available. The agent can still load the original image with
`attachment.get`. The LINE content API serves attachments hosted by LINE.

Agents can send media in the current conversation using the tools supported by
its platform. `send.image`, `send.file`, and `send.audio` accept a chat workspace
path or `{ "attachment": { "messageId": "...", "index": 0 } }`. `send.image`
also accepts a public HTTP(S) URL, and `send.audio` accepts a public HTTPS URL,
in `url`. Specify one source per call. `send.audio` needs `ffmpeg` on PATH to
decode and convert the audio. Telegram sends a voice message by default and an
audio track with `music: true`. LINE sends an AAC/M4A audio message. When a final
reply contains a Markdown image, the gateway sends it after the text or leaves
its URL in the text if the download fails. Telegram sends media tools' uploads
immediately. LINE includes queued media with the final reply, even when it has
no text. [LINE delivery](plugins/platform-line/README.md#delivery-and-limits)

Telegram sticker sets are indexed in the background for `sticker.search`. The
index stores file IDs and descriptions without retaining image grids. The
default agent needs vision support and `ffmpeg` must be on PATH. Set
`stickers.model` in `tsugimori.json` to select a low-cost vision model for
that backend. The same model describes uncached stickers after a chat task.
By default the gateway uses the connector's economy model when available, then
the default agent's configured model. LINE searches its bundled official
sticker catalog.

## Chat commands

| Command                                          | Who                                                       | What it does                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/help`                                          | Owner or members of an allowlisted chat                   | Lists the commands you can use in this chat as plain text.                                                  |
| `/status`                                        | Owner                                                     | Shows gateway health, chat activity, incognito mode, and system state.                                      |
| `/model [provider] [model]`                      | Owner                                                     | Shows the current provider and model, then offers provider and model choices.                               |
| `/thinking [level]`                              | Owner                                                     | Shows or sets reasoning effort for this chat. Use `default` to clear the override.                          |
| `/fast [on\|off\|default]`                       | Owner                                                     | Shows or sets speed on a supported agent. `off` selects standard speed and `default` clears the override.   |
| `/sticker`                                       | Owner                                                     | Lists Telegram sets and block status, plus the number of cached single stickers.                            |
| `/sticker block <set>`, `/sticker unblock <set>` | Owner                                                     | Blocks or unblocks a set for indexing and search across the workspace.                                      |
| `/compact`                                       | Owner                                                     | Requests compaction of this chat's current agent session.                                                   |
| `/context`                                       | Owner or members of an allowlisted chat                   | Shows session counts, token usage, context and tool definition sizes, and incognito mode.                   |
| `/new`                                           | Owner or members of an allowlisted chat                   | Resets the agent session and ends incognito mode. Ignores trailing text.                                    |
| `/incognito [on\|off]`                           | Owner or members of an allowlisted chat                   | Toggles incognito mode. Use `on` or `off` to set it explicitly.                                             |
| `/btw <message>`                                 | Owner or members of an allowlisted chat                   | Answers on an ephemeral fork of the active Codex session, or in a fresh session when a fork is unavailable. |
| `/ask <message>`                                 | Owner or members of an allowlisted chat                   | Answers in a fresh one-off session with the chat's usual fresh-session context.                             |
| `/stop`                                          | Owner                                                     | Stops the active task and its execution processes. Queued tasks continue.                                   |
| `/allow`                                         | Owner                                                     | Lets members trigger the bot in this chat.                                                                  |
| `/deny`                                          | Owner                                                     | Removes this chat from the allowlist and cancels active approval waits here.                                |
| `/pair <code>`                                   | Pairing code holder, in a DM to an unowned bot            | Claims ownership using an unexpired code.                                                                   |
| `/pair new <adapterId>`                          | Owner, in a DM to a bot they own                          | Issues a fresh pairing code for an unowned platform.                                                        |
| `/add <agent\|platform> <kind> [--id <id>]`      | Owner                                                     | Runs guided setup for a plugin instance.                                                                    |
| `/login <agentId>`                               | Owner                                                     | Signs an existing agent in again.                                                                           |
| `/remove <platform\|agent> <id>`                 | Owner                                                     | Lists categories or IDs when omitted, and asks for confirmation before removal.                             |
| `/cancel`                                        | Owner in the originating chat or setup's secret-prompt DM | Cancels guided setup or a pending removal.                                                                  |
| `/previews`                                      | Owner                                                     | Lists open previews on this adapter.                                                                        |
| `/preview close <id>`                            | Owner                                                     | Closes a preview on this adapter.                                                                           |

On Telegram, tapping through command menus such as `/model` updates the same message, including when you tap **Previous** or **Next**. On LINE, each page or submenu arrives in a new quick-reply message.

Use `/model <agentId>` to list a provider's models, or `/model <agentId> <model>` to select both directly. With one argument, configured agent IDs take precedence over model names. Use `/model <model>` for other model names on the current provider. `/model <agentId> default` uses that provider's default model. `/model default` clears both chat overrides and restores the configured route. Switching providers starts a fresh session and reports any incompatible thinking or fast overrides it clears.

`/btw` and `/ask` questions and answers stay out of ordinary recent history, history tools, and summaries. An explicit reply can include them in its thread.

Incognito mode starts a fresh agent session. Recent history comes from the open window. With incognito on or off, an explicit reply can bring up to 20 messages and 12,000 characters from its thread into context, including messages and attachments from any incognito window. The quoted thread can also appear with the reply in later turns. Chat summaries, history tools, memory proposals, and tools that create or update schedules are unavailable while incognito is on. The mode survives restarts, model and agent changes, and compaction.

Turning incognito off starts another fresh session and restores ordinary history. Closed windows remain visible in the admin console and stay out of ordinary history and summaries. While chat work is pending, the bot keeps the current state.

`/status` uses the workspace locale and time zone. The header shows health, build information when available, and uptime. **This chat** shows the agent implementation and effective model, effort, and speed. When available, it adds context usage, session age, cached quota, last compaction and count, summary coverage, running or queued work, approvals, and schedules. **System** lists platform and agent states, the rich message setting for each Telegram instance, sandbox availability, and the count of failed environment checks. The card uses cached provider information and local state, and shows today's timestamps without a date.

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
| `webhooks`            | Shared webhook ingress configuration. [Webhook ingress](#webhook-ingress)                                                                                                                                  |
| `preview`             | Omit to disable, or use `{}` to enable Quick previews with a 60-minute TTL cap. A named router defaults to `127.0.0.1:8788`. [Cloudflare configuration](plugins/tunnel-cloudflare/README.md#configuration) |

The gateway watches `tsugimori.json` and `.env` and can attach or detach platforms and agents without restart. The database path and admin web server configuration take effect at startup. Give the admin web listener, named preview router, and webhook listener distinct addresses. `doctor` reports address conflicts and the gateway rejects conflicting configuration.

## Webhook ingress

The gateway shares one loopback listener for webhook platforms. The default is `127.0.0.1:8789`. Set `webhooks.listen` to another port on `127.0.0.1` or `[::1]` if needed.

- In an owner chat, use `/webhook` to see the current provider, URL, and verification result. Use `/webhook setup` to choose a provider and `/webhook check` to ensure its route and verify it again.
- **Cloudflare Tunnel** configures a dedicated hostname on a remotely managed tunnel and creates its proxied DNS record. See the [Cloudflare provider guide](plugins/tunnel-cloudflare/README.md#webhook-ingress).
- **Manual** uses a public HTTPS base URL that you route to the shared listener. Forward `/.well-known/tsugimori/probe/<nonce>` and platform paths such as `/line/<id>/` without an interactive login. If the public base URL includes a path prefix, strip that prefix before forwarding. For file-based configuration, set `"webhooks": { "provider": "manual", "publicBaseUrl": "https://hooks.example.com" }`.
- Guided setup saves the webhook section after the public probe reaches this gateway. The probe path returns 404 outside an active challenge. The gateway rechecks after startup, on webhook configuration changes, and every 30 minutes. The result appears in `/status`, `doctor`, and the admin overview.
- Adding LINE requires a successful ingress check. Existing instances stay configured during an ingress failure. A legacy workspace-level `webhooks.publicBaseUrl` without a provider selects Manual.

## Plugins

| Plugin                                                   | Purpose                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Telegram](plugins/platform-telegram/README.md)          | Telegram bots via long polling.                                                              |
| [LINE](plugins/platform-line/README.md)                  | LINE Messaging API via signed webhooks and metered push.                                     |
| [Codex](plugins/agent-codex/README.md)                   | Agent connector for Codex App Server.                                                        |
| [Claude Agent SDK](plugins/agent-claude-sdk/README.md)   | Agent connector for Claude through its bundled CLI.                                          |
| [Local sandbox](plugins/exec-local-sandbox/README.md)    | Linux command and file tools isolated per chat.                                              |
| [Cloudflare Tunnel](plugins/tunnel-cloudflare/README.md) | Time-limited Quick and named previews of chat services.                                      |
| [Admin web UI](plugins/web/README.md)                    | Read-only overview, chat timelines, redacted tool details, traces, approvals, and schedules. |

## Operations

- **Service**. Run `corepack pnpm exec tsugimori start /absolute/path/to/workspace` in the foreground from the repository, for example under systemd with the repository as `WorkingDirectory`. Use a service user with access to the workspace and Node.js on its PATH. SIGINT or SIGTERM stops the gateway and flushes traces.
- **Health checks**. `corepack pnpm exec tsugimori doctor [dir] [--json]` checks Node.js, the database path, Git, configured listener conflicts, and enabled plugin capabilities. It exits with status 1 on failure. Startup logs failed checks and disables affected capabilities where it can. Startup failure notices go to an owner DM when a free-push channel is available.
- **Logs**. Capture stderr for structured gateway events, and use `/status` or the admin UI for persisted task traces and chat state.
- **Backups**. For a file copy, stop the service first and back up the workspace, including `data/tsugimori.db` (or your configured path) and any SQLite sidecar files still present. Protect the backup as it can contain chat history, `.env`, and agent login homes.
- **Upgrades**. Stop the service and back up the workspace, update the checkout, run `corepack pnpm install`, then run `doctor` and restart. The gateway applies SQLite migrations when it opens the database. `corepack pnpm exec tsugimori setup [dir] [--yes] [--upgrade]` prints commands for missing system packages and runs them with `--yes`. Setup also installs managed Codex releases and records their pins. Use `--upgrade` to update those pins.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development commands, or [LICENSE](LICENSE) for license terms.
