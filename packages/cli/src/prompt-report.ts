import type { Gateway } from '@tsugimori/core';

type PromptReport = ReturnType<Gateway['promptReport']>;

const number = (value: number | null) => value ?? '—';
const ratio = (value: number | null) =>
  value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const time = (value: number | null) =>
  value === null ? '—' : new Date(value).toISOString();

export function formatPromptReport(report: PromptReport) {
  const lines = ['Framework tools by platform (characters)'];
  if (!report.platforms.length) lines.push('No attached platforms.');
  for (const { platformId, variants } of report.platforms) {
    for (const { modes, tools, totals, toolsChars, toolsHash } of variants) {
      lines.push(
        '',
        `${JSON.stringify(platformId)} (${modes.join(', ')})`,
        'Tool\tDescription\tInput schema\tTotal',
        ...tools.map(
          ({ name, descriptionChars, inputSchemaChars, totalChars }) =>
            `${JSON.stringify(name)}\t${descriptionChars}\t${inputSchemaChars}\t${totalChars}`,
        ),
        `${tools.length} tools\t${totals.descriptionChars}\t${totals.inputSchemaChars}\t${totals.totalChars}`,
        `Serialized definitions ${toolsChars} chars, hash ${toolsHash}`,
      );
    }
  }

  const { enabled, maxChars } = report.carryOver;
  lines.push(
    '',
    `/new carry-over summary ${enabled ? `(limit ${maxChars} chars)` : 'disabled'}`,
    `Chat history (up to ${report.recentRunsPerChat} recent persisted runs per chat)`,
  );
  if (!report.chats.length) lines.push('No recorded chats.');
  for (const chat of report.chats) {
    const {
      adapterId,
      chatId,
      compactions,
      lastCompactionAt,
      lastResetAt,
      compactAt,
      carryOver,
      recentRuns,
    } = chat;
    lines.push(
      '',
      `${JSON.stringify(adapterId)} / ${JSON.stringify(chatId)}`,
      carryOver
        ? `Summary ${carryOver.chars} chars, ${carryOver.blockChars} serialized chars, ~${carryOver.estimatedTokens} tokens`
        : 'Summary —',
      `compactAt ${number(compactAt)}, compactions ${compactions}, last compaction ${time(lastCompactionAt)}, last reset ${time(lastResetAt)}`,
    );
    if (recentRuns.length)
      lines.push(
        'Time (UTC)\tTask\tInput tokens\tCached tokens\tHit ratio\tInstruction hash',
        ...recentRuns.map(
          (run) =>
            `${time(run.startedAt)}\t${JSON.stringify(run.taskId)}\t${number(run.inputTokens)}\t${number(run.cachedInputTokens)}\t${ratio(run.hitRatio)}\t${run.instructionsHash ?? '—'}`,
        ),
      );
  }
  lines.push(
    '',
    'Latest measured run per chat',
    'Metric\tChats\tp50\tp90\tMax',
  );
  for (const [metric, label, format] of [
    ['inputTokens', 'Input tokens', number],
    ['cachedInputTokens', 'Cached tokens', number],
    ['hitRatio', 'Hit ratio', ratio],
  ] as const) {
    const { chats, p50, p90, max } = report.distribution[metric];
    lines.push(
      `${label}\t${chats}\t${format(p50)}\t${format(p90)}\t${format(max)}`,
    );
  }
  return lines.join('\n');
}
