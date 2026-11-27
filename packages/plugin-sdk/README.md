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
