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
  "replyTokenTtlMs": 50000
}
```

The example shows the defaults for the optional fields. `id` must be unique among platform entries. Set the channel secret and access token in the process environment or workspace `.env` under the named variables. Use separate credential names for multiple instances. `replyTokenTtlMs` accepts 1–60,000 milliseconds.

## Guided setup and webhook

1. Set up and verify [gateway webhook ingress](../../README.md#webhook-ingress). Create a LINE Messaging API channel, then run `/add platform line` in an owner chat. Without `--id`, setup suggests a random six-character hex instance ID.
2. Enter the channel secret and long-lived channel access token at the secret prompts. Confirm the bot name reported by LINE. Setup saves verified credentials to `.env` with the uppercase UTF-8 hex instance ID appended to the variable names.
3. Setup gets the URL from the gateway, for example `https://hooks.example.com/line/main/`. It sets an empty LINE endpoint automatically and asks before replacing a different endpoint. Setup runs a LINE webhook test and reports the connection only if that test passes. If the test fails, see the reason and verify the endpoint in the LINE Developers Console.
4. Enable **Use webhook** in the LINE Developers Console when prompted. To receive group and room messages, also enable **Allow bot to join group chats**. Set the owner's native user ID in `owner` by adapter ID or platform kind, or pair in a DM once the webhook is live. See [owner configuration](../../README.md#workspace-and-conversations).

Terminal setup with `corepack pnpm exec tsugimori add platform line --dir ./ws` also requires verified ingress. If the gateway is stopped, set and verify the LINE endpoint in the LINE Developers Console after the gateway starts.

## Checks and status

`tsugimori doctor` checks the channel secret and access token, reads the gateway's ingress status, and compares LINE's configured endpoint with the gateway URL when ingress is healthy. `/status` shows gateway ingress and LINE attachment status in **System**. In **This chat**, the card can show the latest approval decision because LINE uses metered push.

## Delivery and limits

- The listener accepts signed POSTs at `/line/<id>`, `/line/<id>/`, and `/line/<id>/webhook`. It ignores query strings and limits bodies to 1 MiB.
- The first batch can use the latest reply token for that chat when the outbound message replies to the matching inbound message and the token is fresh. Later batches, messages without a usable token, and replies rejected for an invalid reply token use metered push. Push counts against the LINE account's messaging quota, including scheduled messages.
- The adapter sends text in chunks of at most 5,000 UTF-16 code units, with up to five messages per API request. Non-text inbound messages appear as type placeholders. Standby messages and messages without a sender ID are ignored.
- Quote the approval prompt and reply with the displayed approval or denial word. The adapter has no inline approval buttons, reactions, polls, or deletion events. See the [gateway approval and scheduling rules](../../README.md#approvals-and-schedules).
