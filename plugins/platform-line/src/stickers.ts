import type { StickerChoice } from '@tsugimori/plugin-sdk';

import catalog from './stickers.json' with { type: 'json' };

const keywords: Readonly<Record<string, string>> = catalog.keywords;

export const lineStickers = new Map(
  Object.entries(catalog.packs).flatMap(([packageId, pack]) =>
    pack.ids.map((id): [string, StickerChoice] => {
      const fileId = String(id);
      return [
        fileId,
        {
          fileId,
          packageId,
          description: [keywords[fileId], pack.keywords]
            .filter(Boolean)
            .join(' · '),
        },
      ];
    }),
  ),
);

export function searchLineStickers(query: string, limit: number) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return [...lineStickers.values()]
    .flatMap((entry) => {
      const text = `${entry.fileId} ${entry.packageId} ${entry.description}`;
      if (!terms.every((term) => text.includes(term))) return [];
      return [
        {
          entry,
          score: terms.filter((term) => keywords[entry.fileId]?.includes(term))
            .length,
        },
      ];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
}
