# LINE

The LINE adapter receives signed Messaging API webhooks for direct messages, groups, and rooms. It sends plain text and uses LINE reply tokens when available. Other sends use metered push.

## Configuration

Add an entry under `platforms` in `tsugimori.json`.

```json
{
  "id": "main",
  "kind": "line",
  "enabled": true,
  "secretEnv": "LINE_CHANNEL_SECRET",
  "tokenEnv": "LINE_CHANNEL_ACCESS_TOKEN",
  "listen": "127.0.0.1:8789",
  "replyTokenTtlMs": 50000
}
```

The example shows the defaults for all optional fields. `id` must be unique among platform entries. Set the channel secret and access token under the named variables in the process environment or workspace `.env`. Use separate credential names and listener addresses for multiple instances. `listen` accepts only `127.0.0.1` or `[::1]` with a valid port. Use a fixed port for proxy routing. `replyTokenTtlMs` accepts 1–60,000 milliseconds. All options shown are on the entry itself.

## Guided setup and webhook

1. Create a LINE Messaging API channel. Run `corepack pnpm exec tsugimori add platform line --id main --dir ./ws`, or use `/add platform line --id main` from an existing owner chat.
2. Enter the channel secret and long-lived channel access token at the secret prompts. Setup checks the access token against the bot info endpoint. Type `yes` to confirm the bot name. Setup saves the credentials to `.env` using the names above with an appended `_<ID_HEX>` suffix (the uppercase UTF-8 hex encoding of the instance ID), then prints the webhook path. The first signed webhook verifies that the channel secret matches.
3. Route public HTTPS at `/line/<id>/` to the same path on the configured loopback listener using a reverse proxy or named Cloudflare Tunnel. For `main`, a public URL is `https://webhooks.example.com/line/main/`. The endpoint must be reachable by LINE without interactive login. Use the path printed by setup if the instance ID needs URL encoding.
4. In the LINE Developers Console, set the Webhook URL, verify it, and enable **Use webhook**. To receive group and room messages, also enable **Allow bot to join group chats**. Set the LINE owner's native user ID in `owner` by adapter ID or platform kind, or pair in a DM once the webhook is live. [Owner configuration](../../README.md#workspace-and-conversations)

## Checks and status

`tsugimori doctor` checks for the channel secret, probes bot info with the access token, and temporarily binds the configured loopback listener. Run it while that listener is stopped. The core checks for duplicate configured addresses across enabled LINE entries, admin web, and named previews. The gateway rejects conflicts on startup and reload. The doctor probe checks local binding and credentials. Verify public routing and the channel secret with the LINE Developers Console.

In `/status`, **System** shows the LINE instance state and any retry or failure details. In **This chat**, the card can show the latest approval decision because LINE uses metered push. The card does not show LINE account quota.

## Delivery and limits

- The listener accepts signed POSTs at `/line/<id>`, `/line/<id>/`, and `/line/<id>/webhook`. It ignores query strings and limits bodies to 1 MiB.
- The first batch can use the latest reply token for that chat when the outbound message replies to the matching inbound message and the token is fresh. Later batches, messages without a usable token, and replies rejected for an invalid reply token use metered push. Push counts against the LINE account's messaging quota, including scheduled messages.
- The adapter sends text in chunks of at most 5,000 UTF-16 code units, with up to five messages per API request. Non-text inbound messages appear as type placeholders. Standby messages and messages without a sender ID are ignored.
- Quote the approval prompt and reply with the displayed approval or denial word. The adapter has no inline approval buttons, reactions, polls, or deletion events. See the [gateway approval and scheduling rules](../../README.md#approvals-and-schedules).
