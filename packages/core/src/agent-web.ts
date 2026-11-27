import type { Config } from '@tsugimori/config';
import type { AgentConnector, AgentWebPolicy } from '@tsugimori/plugin-sdk';

export function resolveAgentWeb(
  config: Pick<Config, 'agents' | 'agentWeb'>,
  agent: Pick<AgentConnector, 'capabilities' | 'id'>,
  disabled: boolean,
): AgentWebPolicy {
  if (disabled) return { fetch: false, search: false };
  const override = config.agents.find(({ id }) => id === agent.id)?.web;
  const search = override?.search ?? config.agentWeb?.search ?? true;
  return {
    fetch: override?.fetch ?? config.agentWeb?.fetch ?? true,
    // A connector without native search can use a future gateway web.search.
    search: search && agent.capabilities?.webSearch === 'native',
  };
}
