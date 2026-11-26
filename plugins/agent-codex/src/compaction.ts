import { nativeCompactionLimit } from '@tsugimori/plugin-sdk';

import { asRecord } from './app-server.ts';

type Inspect = (args: string[]) => Promise<string | undefined>;

export async function codexCompactionSupport(inspect: Inspect) {
  const features = (await inspect(['features', 'list'])) ?? '';
  const available = (name: string) =>
    features.split(/\r?\n/).some((line) => {
      const [feature, stage] = line.trim().split(/\s+/);
      return feature === name && stage !== 'removed';
    });
  // The app-server protocol's Config type omits some keys accepted by thread config.
  const postTurn = await inspect([
    'app-server',
    '--strict-config',
    '-c',
    'model_post_turn_compact_threshold_percent=1',
    '--print-startup-config',
  ]);
  return {
    async: available('async_compaction'),
    rootOnly: available('async_compaction_root_only'),
    postTurn: postTurn !== undefined,
  };
}

export type CodexCompactionSupport = Awaited<
  ReturnType<typeof codexCompactionSupport>
>;

export function compactionMode(
  support: CodexCompactionSupport,
  asyncCompaction: boolean,
) {
  if (asyncCompaction && support.async) return 'async';
  return support.postTurn ? 'post-turn' : 'unsupported';
}

export function contextWindow(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    return value;
}

export function codexCompactionConfig(
  support: CodexCompactionSupport,
  asyncCompaction: boolean,
  compactAt: number,
  window?: number,
) {
  const mode = compactionMode(support, asyncCompaction);
  const percent =
    window === undefined
      ? undefined
      : Math.min(100, Math.max(1, Math.round((compactAt / window) * 100)));
  const asyncEnabled = mode === 'async' && percent !== undefined;
  return {
    mode: percent === undefined ? ('unsupported' as const) : mode,
    config: {
      model_auto_compact_token_limit: nativeCompactionLimit(compactAt, window),
      ...(support.async
        ? {
            features: {
              async_compaction: asyncEnabled
                ? {
                    enabled: true,
                    model_async_compact_threshold_percent: percent,
                  }
                : false,
              ...(asyncEnabled && support.rootOnly
                ? { async_compaction_root_only: true }
                : {}),
            },
          }
        : {}),
      ...(support.postTurn
        ? {
            model_post_turn_compact_threshold_percent:
              mode === 'post-turn' ? (percent ?? 0) : 0,
          }
        : {}),
    },
  };
}

export async function bundledContextWindows(inspect: Inspect) {
  const windows = new Map<string, number>();
  const catalog = await inspect(['debug', 'models', '--bundled']);
  if (catalog === undefined) return windows;
  try {
    const { models } = asRecord(JSON.parse(catalog));
    for (const entry of Array.isArray(models) ? models : []) {
      const { slug, context_window, max_context_window } = asRecord(entry);
      const window =
        contextWindow(context_window) ?? contextWindow(max_context_window);
      if (typeof slug === 'string' && window !== undefined)
        windows.set(slug, window);
    }
  } catch {
    // Older binaries may not return a model catalog. Use app-server usage reports.
  }
  return windows;
}
