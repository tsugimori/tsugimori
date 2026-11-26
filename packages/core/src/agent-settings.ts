import type { AgentConnector } from '@tsugimori/plugin-sdk';

export function acceptsServiceTier(agent: AgentConnector, tier: string) {
  const supported = agent.settings?.serviceTiers;
  return supported === true || supported?.includes(tier) === true;
}

export function resolveAgentSetting(
  override: string | null | undefined,
  workspace: string | undefined,
  configured: string | undefined,
) {
  const value = override ?? workspace ?? configured;
  const source =
    override != null || workspace !== undefined
      ? ('chat' as const)
      : value !== undefined
        ? ('agent' as const)
        : ('default' as const);
  return { value, source };
}

export function formatServiceTier(
  tier: string | null | undefined,
  labels: { fastOff: string; fastOn: string; unset: string },
) {
  switch (tier) {
    case undefined:
    case null:
    case '':
      return labels.unset;
    case 'fast':
    case 'priority':
      return labels.fastOn;
    case 'default':
      return labels.fastOff;
    default:
      return tier;
  }
}
