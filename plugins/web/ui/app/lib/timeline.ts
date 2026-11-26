import type { AdminTask, AdminToolCall } from '@tsugimori/plugin-sdk';

export function callAnchor(taskId: string, seq: number) {
  return 'call-' + (seq >= 0 ? seq : `${taskId}-${-seq}`);
}

export function toolOffset(ms: number) {
  const tenths = Math.round(Math.max(0, ms) / 100);
  if (tenths < 600) return `+${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(tenths / 10);
  return `+${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function taskLanes(task: AdminTask, start: number, end: number) {
  const wall = Math.max(0, end - start);
  const clamp = (at: number) => Math.min(wall, Math.max(0, at - start));
  const tools = task.tools
    .map((tool) => ({
      tool,
      from: clamp(tool.startedAt),
      to: clamp(tool.endedAt ?? end),
    }))
    .sort((a, b) => a.from - b.from);
  const model: { from: number; to: number }[] = [];
  let lastEnd = 0;
  for (const { from, to } of tools) {
    if (to <= from) continue;
    if (from > lastEnd) model.push({ from: lastEnd, to: from });
    lastEnd = Math.max(lastEnd, to);
  }
  if (lastEnd < wall) model.push({ from: lastEnd, to: wall });

  function percent(ms: number) {
    return wall ? (ms * 100) / wall : 0;
  }
  function position({ from, to }: { from: number; to: number }) {
    return { left: percent(from), width: percent(Math.max(0, to - from)) };
  }
  return {
    model: model.map(position),
    tools: tools.map((interval) => ({
      tool: interval.tool,
      ...position(interval),
    })),
  };
}

export function toolStatus(tool: AdminToolCall) {
  return tool.status ?? (tool.endedAt === null ? 'running' : null);
}
