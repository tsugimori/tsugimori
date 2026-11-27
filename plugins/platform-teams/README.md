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

Phase 1 supports direct and group text, native mentions and quoted replies,
inbound edits and deletes, and deleting messages the signed-in account sent.
Text choices use the framework's reply-based menus. On reconnect, the receiver
can scan up to five recent history pages per observed conversation. If a send's
result is uncertain, the adapter looks for the reserved client message ID in
history and reports uncertainty if it cannot verify delivery.

Media, reactions, typing, and presence are planned for phase 2. The plugin uses
internal Teams web client endpoints. Microsoft can change them independently of
Tsugimori.
