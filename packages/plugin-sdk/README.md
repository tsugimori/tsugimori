# Plugin SDK

## Agent usage events

An agent's `usage` event reports `inputTokens` as total processed input, including tokens read from or written to the provider prompt cache. `cachedInputTokens` counts cache reads and `cacheWriteTokens` counts cache writes (Claude only). Divide `cachedInputTokens` by `inputTokens` when both are known and input is positive to get the prompt cache hit ratio. Leave unreported counters undefined and report zero when the provider supplies zero.

## Platform adapter choice methods

- `send(message, options?)` delivers a prompt with `OutboundMessage.buttons` and returns the message ID the buttons belong to.
- `respondToApproval(feedback)` acknowledges button taps and displays the result of a choice where the platform supports feedback.
- `updateChoices(update, signal?)` optionally replaces the text and buttons on an existing bot message. `ChoiceUpdate` includes the native `chatId`, `messageId`, optional `threadId`, text, buttons, and the same optional text formatting as `OutboundMessage`. Resolve once the edit is applied. Throw if the text cannot be edited, for example if it needs more than one message. Adapters without message editing can omit the method. The gateway then silently closes the current menu and sends the next one with `replyTo` set to the tapped menu's message ID.

## Platform presence

Declare `capabilities.presence` alongside `setPresence({ state, text? }, signal?)`.
The capability lists supported states from `online`, `idle`, `busy`, and
`offline`, plus a boolean for status text support. The gateway skips states
outside the list. It requests `online` after a successful start and `offline`
on graceful stop. It logs errors and gives the offline call up to one second.
Honor the call's abort signal. The adapter owns native state mapping, activity
refresh, and reapplying the requested state on reconnect. During graceful
shutdown the adapter's start-context signal may already be aborted when the
offline request runs.

## Queued images

Declare `images.queued` when `sendImage` prepares a handle for the next reply.
Resolve the handle when `send` receives it in `options.media`. Report its ID in
the delivered `SendPart.mediaId`, or report all the handle IDs in
`SendPart.mediaIds` when a single native message delivers several queued images.

## Adding a platform

Register an adapter factory in `definePlugin({ adapters: { … } })`. Set its
`label` for a display name in `/add` and `/status`. Declare
only the capabilities the adapter implements, with positive byte limits for
media. Use `sendImage`, `sendFile`, `sendAudio`, `sendReaction`, and
`sendSticker` for their corresponding capabilities. Stickers can be searched
natively or indexed from `getStickerSet`. Declare `deleteEvents` when the
adapter emits native inbound deletions. The gateway discovers outbound
`deleteMessage`, `updateChoices`, and `typing` through their methods. Stop
typing when its task signal aborts. For presence, advertise the supported
states and see [Platform presence](#platform-presence).

Set `factory.requires = ['webhook']` for inbound HTTPS routes, or
`['media-host']` if the platform fetches outbound media by URL. The latter
also requires public HTTPS webhook ingress and makes `ctx.mediaHost`
available. After startup, call
`mediaHost.publish(bytes, { mime, ttlMs }, signal)` for each file. It returns
`{ url, expires, release }`, where `expires` is an epoch timestamp in
milliseconds. Use `release()` when delivery is known to have failed. The
gateway retains publications for up to 14 days by default and evicts the
oldest as needed to keep each instance under 1 GiB and 4,096 files. It removes
expired files on startup and while the instance is attached.

Use `attachmentBytes` for bounded downloads, `attachmentMime` for the base
response media type, `attachmentSize` for non-negative integer metadata, and
`sniffImageMime` for JPEG, PNG, GIF, and WebP signatures. Keep provider
credentials, supported formats, dimension limits, and conversion rules in
the adapter.

Run `checkAdapterContract` from `@tsugimori/plugin-sdk/contract-test` in the
plugin's tests. Pass one `{ create, message, media, startupError }` object.
Have `create(scenario)` return a fresh adapter and its fake counters for
`normal`, `failed`, and `pending` startup. Add a `receive` hook to replay
native events and declare how the fixture handles its own echo. Teams Personal
suppresses its own echoes because the gateway records delivery from receipts.
Supply valid samples for advertised uploads and fake typing observations when
implemented.
Use `checkAgentContract` from the same entry point for connector lifecycle,
event shape, and provider failure checks.

LINE retains its existing `/line/<instance>/media/<token>` URLs and on-disk
metadata. Existing unexpired files remain available with the same instance
and public webhook URL, subject to the shared storage limits.
