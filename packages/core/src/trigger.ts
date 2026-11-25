import type { InboundMessage } from '@tsugimori/plugin-sdk';

export function shouldTrigger(
  message: InboundMessage,
  owner: boolean,
  allowlisted: boolean,
) {
  return (
    (owner && (message.chatKind === 'dm' || message.mentionsBot === true)) ||
    (allowlisted &&
      (message.mentionsBot === true || message.repliesToBot === true))
  );
}
