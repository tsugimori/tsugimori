# LINE

The LINE adapter receives signed Messaging API webhooks for direct messages, groups, and rooms. It sends text, stickers, images, and MP4 video. It uses LINE reply tokens when available. Other sends use metered push.

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
- The adapter sends text in chunks of at most 5,000 UTF-16 code units. Stickers, images, video, and audio are queued with the turn's text and sent in batches of up to five. A turn with only media still uses the reply token when available.
- `send.image` accepts JPEG or PNG up to 10 MiB. Web GIF and WebP images up to 10 MiB are converted to a still JPEG with `ffmpeg`. `send.file` accepts MP4 video up to 200 MiB. Video and JPEG or PNG images over 1 MiB need `ffmpeg` to make a preview.
- `send.audio` uses `ffmpeg` to encode AAC in M4A and measure the duration. The source and encoded audio are each capped at 20 MiB, within LINE's 200 MB audio limit. [LINE audio message reference](https://developers.line.biz/en/reference/messaging-api/#audio-message)
- Web JPEG and PNG images use the final URL after redirects when it is HTTPS and at most 2,000 characters. LINE uses the same URL for the preview when the image is at most 1 MiB. Larger images use a hosted preview.
- Hosted images, videos, audio, and previews use `/line/<id>/media/<token>` on the existing HTTPS ingress. Each hosted part has its own 192-bit random token and supports repeated GET and HEAD requests. Media survives restarts in the workspace under `data/platform-line/adapter-<encoded-id>/`. The default retention is 14 days, with a 1 GiB cap per adapter that evicts the oldest files first. Logs record direct delivery and served or missed requests without URLs or tokens.
- `sticker.search` uses the bundled catalog of 456 official stickers, with package keywords and action keywords for common stickers. The catalog was fetched on 2026-11-27. [LINE Messaging API sticker list](https://developers.line.biz/en/docs/messaging-api/sticker-list/)
- The adapter fetches static PNGs for received stickers from LINE's unofficial sticker CDN (`stickershop.line-scdn.net`), without channel credentials. If an image is unavailable, the agent still receives the sticker placeholder and any keywords from LINE.
- Non-text inbound messages appear as type placeholders. Standby messages and messages without a sender ID are ignored.
- Quote the approval prompt and reply with the displayed approval or denial word. The adapter has no inline approval buttons, reactions, polls, or deletion events. See the [gateway approval and scheduling rules](../../README.md#approvals-and-schedules).
