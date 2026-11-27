# Teams Personal

The Teams platform connects a dedicated Microsoft personal account to Tsugimori
through Teams Free (`teams.live.com`). Use a separate personal account to
message it as the owner.

- From another connected platform, run `/add platform teams --id teams-home`.
  In a terminal, run `tsugimori add platform teams --id teams-home --dir <workspace>`.
- Open the Microsoft verification URL, enter the device code, and sign in as the
  account that Tsugimori should use. Confirm its display name and MRI when
  prompted. Then pair the owner through Teams using the usual pairing flow.
- Run `/login teams-home` from another platform or
  `tsugimori setup login teams-home --dir <workspace>` in a terminal to sign in
  again. The receiver stops during sign-in. A confirmed login restores the prior
  enabled state. If you cancel, rerun login to resume. Login from the target
  platform itself is refused because the setup conversation needs that receiver.
  An account change needs explicit confirmation.

The confirmed MRI is stored in `options.accountMri` in `tsugimori.json`. The
refresh credential lives at `data/platforms/<id>/home/refresh-token.json` in
the workspace. Keep that directory private. Changing accounts keeps the
platform ID and its existing framework configuration.

| Feature   | Teams Personal support                                                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text      | Direct and group chats, native mentions and quoted replies, inbound edits and deletes, and text menus with typed choices. The adapter can update its own text menus and delete its own messages.                              |
| Images    | JPEG, PNG, GIF, and WebP inline images up to 5 MiB each. Outbound images are limited to 25 million pixels and share a message with the reply caption. They display within 400 × 250 pixels with the original aspect ratio.    |
| Files     | AMS originals and OneDrive or SharePoint shares for downloads. Outbound files are uploaded as AMS originals. The adapter limits both directions to 15 MiB per file.                                                           |
| Reactions | Outbound 👍 ❤️ 😆 😮 😢 😠 👎 🙌 🔥 ✋ 👊 ✔️ 👀.                                                                                                                                                                              |
| Typing    | Sends a Teams typing control every four seconds during a reply.                                                                                                                                                               |
| Presence  | Publishes Available while connected, refreshes activity every 60 seconds, and republishes on reconnect. Graceful shutdown removes this instance's endpoint. Other signed-in clients can affect the account's combined status. |

OneDrive and SharePoint downloads use a separate Microsoft Graph token with the
`Files.ReadWrite` scope. A Graph permission error is reported on the attachment
download. The adapter restricts download hosts and rejects redirects.
It recognizes up to 20 attachments per inbound message.

On reconnect, the receiver can scan up to five recent history pages per observed
conversation. If a send's result is uncertain, the adapter checks for the
reserved client message ID in history and reports any remaining uncertainty.

The framework can send audio as an original file. It currently has no inbound
reaction event. Teams presence supports the framework's `online` and `offline`
states. The mappings for `idle`, `busy`, and status text are unverified.

Phase 2 is covered by offline tests. Live uploads and downloads, Graph consent
and share redemption, reaction rendering, typing visibility, menu edits, and
presence behavior across clients still need verification with a Teams Free
account. The plugin uses internal Teams web client endpoints that Microsoft can
change independently of Tsugimori.
