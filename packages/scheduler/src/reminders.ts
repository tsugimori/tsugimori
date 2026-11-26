import type { TextRange } from '@tsugimori/plugin-sdk';
import type { ReminderMention } from '@tsugimori/storage';

import { userMentionLinks } from '@tsugimori/plugin-sdk';

export function prepareReminder(
  text: string,
  userIds: readonly string[],
  display: (userId: string) => string | undefined,
) {
  const users = new Map<string, ReminderMention>();
  const getUser = (userId: string, label?: string): ReminderMention => {
    const existing = users.get(userId);
    if (existing) return existing;
    const user = { userId, displayName: display(userId) || label, ranges: [] };
    users.set(userId, user);
    return user;
  };

  let plain = '';
  let end = 0;
  const occupied: TextRange[] = [];
  for (const { start, end: next, label, userId } of userMentionLinks(text)) {
    const before = text.slice(end, start);
    plain += before;
    const range = { offset: plain.length, length: label.length };
    getUser(userId, label).ranges.push(range);
    occupied.push(range);
    plain += label;
    end = next;
  }
  plain += text.slice(end);
  for (const id of userIds) getUser(id);

  const names = new Set<string>();
  const duplicates = new Set<string>();
  for (const { displayName } of users.values()) {
    if (!displayName) continue;
    if (names.has(displayName)) duplicates.add(displayName);
    names.add(displayName);
  }
  // Prefer longer names when a shorter name shares the same span.
  const candidates = [...users.values()].sort(
    (a, b) => (b.displayName?.length ?? 0) - (a.displayName?.length ?? 0),
  );
  for (const { displayName, ranges } of candidates) {
    if (!displayName || ranges.length || duplicates.has(displayName)) continue;
    for (let start = 0; start < plain.length;) {
      const found = plain.indexOf(displayName, start);
      if (found < 0) break;
      start = found + displayName.length;
      const word = /[a-z0-9_]/i;
      if (
        (word.test(displayName[0]!) && word.test(plain[found - 1] ?? '')) ||
        (word.test(displayName.at(-1)!) && word.test(plain[start] ?? ''))
      )
        continue;
      const offset = plain[found - 1] === '@' ? found - 1 : found;
      if (
        occupied.some(
          (range) =>
            offset < range.offset + range.length && start > range.offset,
        )
      )
        continue;
      const range = { offset, length: start - offset };
      ranges.push(range);
      occupied.push(range);
    }
  }
  const mentions = [...users.values()];
  return { text: plain, mentions };
}

export function reminderEntities(mentions: readonly ReminderMention[]) {
  return mentions
    .flatMap(({ ranges, userId }) =>
      ranges.map((range) => ({
        ...range,
        type: 'mention' as const,
        userId,
      })),
    )
    .sort((a, b) => a.offset - b.offset);
}

export function unlinkedText(
  text: string,
  mentions: readonly ReminderMention[],
) {
  let ordinary = '';
  let end = 0;
  for (const { offset, length } of reminderEntities(mentions)) {
    ordinary += text.slice(end, offset) + ' ';
    end = offset + length;
  }
  return ordinary + text.slice(end);
}
