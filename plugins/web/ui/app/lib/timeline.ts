import type {
  AdminModelGap,
  AdminTask,
  AdminToolCall,
  TaskEvent,
} from '@tsugimori/plugin-sdk';

import { statusStyle } from './display.ts';

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
  function percent(ms: number) {
    return wall ? (ms * 100) / wall : 0;
  }
  function position(startedAt: number, endedAt: number) {
    const from = clamp(startedAt);
    return {
      at: percent(from),
      width: percent(Math.max(0, clamp(endedAt) - from)),
    };
  }
  return {
    model: (task.agentTiming?.modelGaps ?? []).map(
      ({ startedAt, endedAt }) => ({
        ...position(startedAt, endedAt),
        tone: 'model',
      }),
    ),
    tools: task.tools.map((tool) => ({
      ...position(tool.startedAt, tool.endedAt ?? end),
      tone: statusStyle(toolStatus(tool))[0],
    })),
  };
}

export function modelGapsByEvent(
  gaps: readonly AdminModelGap[],
  events: readonly TaskEvent[],
) {
  const tools = new Map(
    events.flatMap((event) =>
      event.kind === 'tool' ? [[event.data.toolSeq, event] as const] : [],
    ),
  );
  const texts = events.filter(({ kind }) => kind === 'text');
  const rows = new Map<number | undefined, AdminModelGap[]>();
  for (const gap of gaps) {
    const lastText =
      gap.nextToolSeq === undefined
        ? texts.findLast(({ at }) => at >= gap.startedAt && at <= gap.endedAt)
        : undefined;
    const event =
      (gap.nextToolSeq === undefined
        ? undefined
        : tools.get(gap.nextToolSeq)) ??
      // Long replies can span several recorded text chunks at the same time.
      (lastText && texts.find(({ at }) => at === lastText.at)) ??
      events.find(({ at, kind }) => at >= gap.endedAt && kind !== 'reasoning');
    const key = event?.seq;
    const group = rows.get(key);
    if (group) group.push(gap);
    else rows.set(key, [gap]);
  }
  return rows;
}

export function toolStatus(tool: AdminToolCall) {
  return tool.status ?? (tool.endedAt === null ? 'running' : null);
}
