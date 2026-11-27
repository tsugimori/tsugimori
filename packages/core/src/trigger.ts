import type { InboundMessage, TriggerDecision } from '@tsugimori/plugin-sdk';

type Decision = Pick<TriggerDecision, 'reason' | 'triggered'>;

export function shouldTrigger(
  message: InboundMessage,
  owner: boolean,
  allowlisted: boolean,
  ownerReplyTriggers = false,
): Decision {
  if (message.addressedToOther && !message.mentionsBot && !message.repliesToBot)
    return { triggered: false, reason: 'addressed-to-other' };
  if (owner && message.chatKind === 'dm')
    return { triggered: true, reason: 'dm-owner' };
  if (
    message.repliesToBot &&
    (allowlisted || (owner && (message.mentionsBot || ownerReplyTriggers)))
  )
    return { triggered: true, reason: 'reply-to-bot' };
  if (message.mentionsBot && (owner || allowlisted))
    return { triggered: true, reason: 'mention' };
  return {
    triggered: false,
    reason:
      message.mentionsBot || message.repliesToBot
        ? 'not-allowlisted'
        : 'not-addressed',
  };
}

export function canTrigger(
  message: InboundMessage,
  owner: boolean,
  allowlisted: boolean,
  ownerReplyTriggers?: boolean,
) {
  return shouldTrigger(message, owner, allowlisted, ownerReplyTriggers)
    .triggered;
}
