import type { AgentQuota, AgentQuotaWindow } from '@tsugimori/plugin-sdk';

import { asRecord } from './app-server.ts';

export function mergeQuota(
  previous: AgentQuota | undefined,
  update: unknown,
): AgentQuota | undefined {
  if (update === null || typeof update !== 'object' || Array.isArray(update))
    return previous;
  const record = asRecord(update);
  const { primary, secondary, limitName, planType, rateLimitReachedType } =
    record;
  // Rolling updates can omit values or represent them with null.
  return {
    primary: mergeWindow(previous?.primary, primary),
    secondary: mergeWindow(previous?.secondary, secondary),
    limitName: textValue(limitName) ?? previous?.limitName,
    planType: textValue(planType) ?? previous?.planType,
    // An explicit null clears the flag so a recovered limit is not shown as reached.
    rateLimitReachedType: Object.hasOwn(record, 'rateLimitReachedType')
      ? textValue(rateLimitReachedType)
      : previous?.rateLimitReachedType,
  };
}

function mergeWindow(
  previous: AgentQuotaWindow | undefined,
  update: unknown,
): AgentQuotaWindow | undefined {
  if (update === null || typeof update !== 'object' || Array.isArray(update))
    return previous;
  const { usedPercent, windowDurationMins, resetsAt } = asRecord(update);
  return {
    usedPercent: numericValue(usedPercent) ?? previous?.usedPercent,
    windowDurationMins:
      numericValue(windowDurationMins) ?? previous?.windowDurationMins,
    resetsAt: numericValue(resetsAt) ?? previous?.resetsAt,
  };
}

function numericValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
}

function textValue(value: unknown) {
  if (typeof value === 'string' && value) return value;
}
