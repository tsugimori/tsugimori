import type { AgentDefaults } from '@tsugimori/plugin-sdk';

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function readCodexDefaults(home?: string): Promise<AgentDefaults> {
  const configPath = join(
    home || process.env.CODEX_HOME || join(homedir(), '.codex'),
    'config.toml',
  );
  let source: string;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return {};
    throw error;
  }

  // Ignore multiline strings so their contents cannot look like root settings or table headers.
  const stringsAndComments =
    /"""(?:\\[\s\S]|(?!""")[^\\])*"{3,5}|'''(?:(?!''')[\s\S])*'{3,5}|"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|#[^\r\n]*/gu;
  const root = source
    .replace(stringsAndComments, (token) =>
      token.startsWith('"""') || token.startsWith("'''") ? '""' : token,
    )
    .split(/^[ \t]*\[/mu, 1)[0]!;
  const assignments =
    /^[ \t]*("[\w-]+"|'[\w-]+'|[\w-]+)[ \t]*=[ \t]*("(?:\\["\\bfnrt]|\\u[\da-fA-F]{4}|[^"\\\r\n])*"|'[^'\r\n]*')[ \t]*(?:#[^\r\n]*)?$/gmu;
  const defaults: AgentDefaults = {};
  for (const [, key, quoted] of root.matchAll(assignments)) {
    const name = key!.replace(/["']/gu, '');
    if (name !== 'model' && name !== 'model_reasoning_effort') continue;
    const value: string = quoted!.startsWith("'")
      ? quoted!.slice(1, -1)
      : JSON.parse(quoted!);
    if (value) defaults[name === 'model' ? 'model' : 'effort'] = value;
  }
  return defaults;
}
