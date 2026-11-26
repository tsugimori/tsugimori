import type { AgentConnector } from '@tsugimori/plugin-sdk';

import type { Logger } from './hooks.ts';

import { untilAborted } from './abort.ts';

export function acceptsServiceTier(agent: AgentConnector, tier: string) {
  const supported = agent.settings?.serviceTiers;
  return supported === true || supported?.includes(tier) === true;
}

export async function modelThinkingLevels(
  agent: AgentConnector | undefined,
  model: string | undefined,
  log: Logger,
  signal?: AbortSignal,
) {
  if (!agent?.thinkingLevels) return;
  const timeout = AbortSignal.timeout(2_000);
  try {
    return await untilAborted(
      signal ? AbortSignal.any([signal, timeout]) : timeout,
      () => agent.thinkingLevels!(model),
    );
  } catch {
    signal?.throwIfAborted();
    log({
      level: 'warn',
      event: 'agent.thinking_levels_unavailable',
      target: agent.id,
    });
    return undefined;
  }
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
