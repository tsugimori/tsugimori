# Telegram

The Telegram adapter receives Bot API updates by long polling. Each configured instance uses its own bot. Forum topics have separate history, agent sessions, and workdirs.

## Configuration

Add an entry under `platforms` in `tsugimori.json`.

```json
{
  "id": "telegram",
  "kind": "telegram",
  "enabled": true,
  "tokenEnv": "TELEGRAM_BOT_TOKEN"
}
```

`id` is unique among platform instances. `enabled` defaults to `true`. Enabled entries require `tokenEnv`, which names a credential in the process environment or workspace `.env`. `TELEGRAM_BOT_TOKEN` is a manual configuration example. The adapter defines no settings under `options`. Set the owner's numeric Telegram user ID in the top-level `owner` map or pair from a DM. [Owner configuration](../../README.md#workspace-and-conversations)

## Guided setup

Run `corepack pnpm exec tsugimori add platform telegram --dir ./ws` for the first bot, or `/add platform telegram [--id <id>]` from an existing owner chat.

Telegram shows inline buttons for guided setup and command choices, and owners can also type their answers.

1. Enter the bot token in the terminal's hidden prompt or reply directly to the bot's secret prompt in DM. Setup validates the token with `getMe` and saves it in `.env` as `TELEGRAM_BOT_TOKEN_<ID_HEX>`, where `ID_HEX` is the uppercase UTF-8 hex encoding of the instance ID.
2. Enter the numeric user ID of the owner. Setup checks the instance, then writes the platform entry and owner mapping to the workspace configuration. A running gateway attaches the bot on reload.

## Checks and status

`tsugimori doctor` uses `getMe` to check the bot token and Telegram connectivity. The gateway retries temporary startup failures with exponential backoff and honors Telegram's retry delays. An invalid token stops startup retries for that configuration. After five minutes of continuous retry, the gateway queues an outage notice and later sends a recovery notice. Notices use an available owner DM on a free-push adapter.

In `/status`, **System** shows the instance state, with retry or failure details when applicable. **This chat** reports the current conversation or forum topic. The Telegram command menu follows the workspace locale. Before ownership is established, it offers `/pair` in private chats. Once owned, the menu shows owner commands in the owner's DM and for that owner in groups the bot has seen.

## Delivery and limits

- Telegram's group privacy mode controls which group messages the bot receives. In a group, `/cmd@botusername` addresses a particular bot. Command and recipient matching are case-insensitive.
- Agent replies and scheduled agent output render supported Markdown as Telegram formatting. Fixed reminders preserve the source Markdown characters. Long text is split into messages of at most 4,096 UTF-16 code units. Reminders and approval prompts use a known `@username` where available and can link display names to native user IDs. Schedule callers can use `[name](tg://user?id=123)` to place a native mention.
- Telegram declares `free` outbound push. Bot API rate limits still apply. Use approval buttons or reply directly to the prompt. Where possible, the bot reacts to the original schedule request with 👀 when it asks for approval, 👍 on approval, or 👎 on denial, and clears its reaction on expiry.
- A Telegram group upgrade carries its allowlist, chat agent settings, histories, sessions, schedules, and pending approvals to the supergroup. The gateway reposts pending approval prompts and registers the command menu there. If the original message is no longer addressable, outcomes can arrive as standalone notices. A send that receives a migration response is retried once at the new chat ID. Unavailable command-menu scopes are retried when traffic from that chat returns.
- The adapter handles private chats, groups, and supergroups. Long polling needs outbound access to the Bot API. There is no inbound listener and no support for message deletion events.
