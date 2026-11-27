# Plugin SDK

## Platform adapter choice methods

- `send(message, options?)` delivers a prompt with `OutboundMessage.buttons` and returns the message ID the buttons belong to.
- `respondToApproval(feedback)` acknowledges button taps and displays the result of a choice where the platform supports feedback.
- `updateChoices(update, signal?)` optionally replaces the text and buttons on an existing bot message. `ChoiceUpdate` includes the native `chatId`, `messageId`, optional `threadId`, text, buttons, and the same optional text formatting as `OutboundMessage`. Resolve once the edit is applied. Throw if the edit cannot be applied, for example if the text needs more than one message. Adapters with no message editing can omit the method. The gateway then finishes the current menu and sends the next one as a new message.
