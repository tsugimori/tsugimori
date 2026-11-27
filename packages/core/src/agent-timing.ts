import type { AdminAgentTiming, AdminModelGap } from '@tsugimori/plugin-sdk';
import type { TraceSpan } from '@tsugimori/storage';

export function agentTiming(
  spans: readonly TraceSpan[],
  toolSeqs: ReadonlyMap<TraceSpan, number>,
): AdminAgentTiming | undefined {
  const ordered = spans
    .filter(({ attrs }) => !attrs.purpose)
    .sort((a, b) => a.startedAt - b.startedAt);
  const runs: { endedAt: number; startedAt: number }[] = [];
  for (const { name, startedAt, endedAt } of ordered) {
    if (name !== 'agent.run' || endedAt <= startedAt) continue;
    const previous = runs.at(-1);
    if (previous && previous.endedAt >= startedAt)
      previous.endedAt = Math.max(previous.endedAt, endedAt);
    else runs.push({ startedAt, endedAt });
  }
  if (!runs.length) return;

  const tools = ordered.filter(
    ({ name }) => name === 'agent.tool' || name === 'tool.run',
  );
  const usage = ordered.filter(({ name }) => name === 'agent.usage');
  const modelGaps: AdminModelGap[] = [];
  let agentMs = 0;
  let modelMs = 0;
  let usageIndex = 0;

  function addGap(startedAt: number, endedAt: number, nextToolSeq?: number) {
    const elapsed = endedAt - startedAt;
    modelMs += elapsed;
    // Keep short gaps in the total so the model and tool times reconcile.
    if (elapsed < 100) return;
    const gap: AdminModelGap = { startedAt, endedAt, nextToolSeq };
    for (; usageIndex < usage.length; usageIndex++) {
      const { attrs, startedAt: at } = usage[usageIndex]!;
      if (at > endedAt) break;
      if (at < startedAt) continue;
      // Some connectors report cumulative usage. Use the latest value per field.
      if (typeof attrs.inputTokens === 'number')
        gap.inputTokens = attrs.inputTokens;
      if (typeof attrs.outputTokens === 'number')
        gap.outputTokens = attrs.outputTokens;
    }
    modelGaps.push(gap);
  }

  for (const run of runs) {
    agentMs += run.endedAt - run.startedAt;
    let coveredUntil = run.startedAt;
    for (const tool of tools) {
      if (tool.startedAt >= run.endedAt) break;
      const toolEnd = Math.min(tool.endedAt, run.endedAt);
      if (toolEnd <= Math.max(coveredUntil, tool.startedAt)) continue;
      if (tool.startedAt > coveredUntil)
        addGap(coveredUntil, tool.startedAt, toolSeqs.get(tool));
      coveredUntil = toolEnd;
    }
    if (coveredUntil < run.endedAt) addGap(coveredUntil, run.endedAt);
  }

  return { agentMs, modelGaps, modelMs, toolMs: agentMs - modelMs };
}
