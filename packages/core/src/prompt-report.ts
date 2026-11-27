import type { ChatRef } from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';

import { renderContextLine, toolWireName } from '@tsugimori/plugin-sdk';

import type { Tasks } from './tasks.ts';

import { toolComposition } from './agent-run.ts';
import { summaryMaxChars } from './summary.ts';

const recentRunsPerChat = 10;

export function platformPromptSizes(
  platformId: string,
  inventories: ReturnType<Tasks['toolInventories']>,
) {
  const variants = new Map<string, ReturnType<typeof toolSizes>>();
  for (const { mode, definitions } of inventories) {
    const composition = toolComposition(definitions);
    const existing = variants.get(composition.toolsHash);
    if (existing) existing.modes.push(mode);
    else
      variants.set(
        composition.toolsHash,
        toolSizes(mode, definitions, composition),
      );
  }
  return { platformId, variants: [...variants.values()] };
}

function toolSizes(
  mode: string,
  definitions: Parameters<typeof toolComposition>[0],
  composition: ReturnType<typeof toolComposition>,
) {
  const tools = definitions
    .map(({ name, description, schema }) => {
      const descriptionChars = description.length;
      const inputSchemaChars = JSON.stringify(schema).length;
      return {
        name,
        wireName: toolWireName(name),
        descriptionChars,
        inputSchemaChars,
        totalChars: descriptionChars + inputSchemaChars,
      };
    })
    .sort(
      (a, b) => b.totalChars - a.totalChars || a.name.localeCompare(b.name),
    );
  const totals = tools.reduce(
    (total, tool) => ({
      descriptionChars: total.descriptionChars + tool.descriptionChars,
      inputSchemaChars: total.inputSchemaChars + tool.inputSchemaChars,
      totalChars: total.totalChars + tool.totalChars,
    }),
    { descriptionChars: 0, inputSchemaChars: 0, totalChars: 0 },
  );
  return { modes: [mode], ...composition, tools, totals };
}

function chatKey({ adapterId, chatId }: ChatRef) {
  return JSON.stringify([adapterId, chatId]);
}

function distribution(samples: readonly (number | null | undefined)[]) {
  const values = samples.filter((value) => value != null).sort((a, b) => a - b);
  const at = (percentile: number) =>
    values[Math.ceil(percentile * values.length) - 1] ?? null;
  return { chats: values.length, p50: at(0.5), p90: at(0.9), max: at(1) };
}

export function buildPromptReport(
  store: Store,
  platforms: ReturnType<typeof platformPromptSizes>[],
  summaryEnabled: boolean,
  compactAt: (chat: ChatRef) => number | null,
) {
  const history = store.listPromptHistory(recentRunsPerChat);
  const runsByChat = Map.groupBy(history.runs, chatKey);
  const sessionsByChat = Map.groupBy(history.sessions, (chat) =>
    chatKey(store.resolveChat(chat)),
  );
  const chats = history.sessions.flatMap(
    ({ adapterId, chatId, ...session }) => {
      const chat = { adapterId, chatId };
      const key = chatKey(chat);
      const related = sessionsByChat.get(key);
      if (!related) return [];
      const lastResetAt = related.reduce<number | null>(
        (latest, { lastResetAt }) =>
          lastResetAt !== null && (latest === null || lastResetAt > latest)
            ? lastResetAt
            : latest,
        null,
      );
      const summary = summaryEnabled ? store.getSummary(chat) : undefined;
      const text = summary?.text;
      const carryOver = text
        ? {
            revision: summary.revision,
            chars: text.length,
            blockChars: renderContextLine({
              content: text,
              source: 'summary',
              trust: 'untrusted',
            }).length,
            estimatedTokens: Math.ceil(Buffer.byteLength(text) / 4),
          }
        : null;
      const recentRuns = (runsByChat.get(key) ?? []).map(
        ({
          agentId,
          cachedInputTokens,
          inputTokens,
          instructionsHash,
          sessionScope,
          startedAt,
          taskId,
          toolsHash,
        }) => ({
          agentId,
          cachedInputTokens,
          inputTokens,
          instructionsHash,
          sessionScope,
          startedAt,
          taskId,
          toolsHash,
          hitRatio:
            inputTokens !== null &&
            inputTokens > 0 &&
            cachedInputTokens !== null
              ? cachedInputTokens / inputTokens
              : null,
        }),
      );
      return [
        {
          ...chat,
          ...session,
          lastResetAt,
          compactAt: compactAt(chat),
          carryOver,
          recentRuns,
        },
      ];
    },
  );
  const latest = chats.map(({ recentRuns }) =>
    recentRuns.find(({ inputTokens }) => inputTokens !== null),
  );
  return {
    platforms,
    carryOver: { enabled: summaryEnabled, maxChars: summaryMaxChars },
    recentRunsPerChat,
    chats,
    distribution: {
      inputTokens: distribution(latest.map((run) => run?.inputTokens)),
      cachedInputTokens: distribution(
        latest.map((run) => run?.cachedInputTokens),
      ),
      hitRatio: distribution(latest.map((run) => run?.hitRatio)),
    },
  };
}
