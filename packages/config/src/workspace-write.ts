import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config, PluginKinds } from './index.ts';

import {
  ConfigError,
  configFilename,
  envFilename,
  parseConfig,
  parseEnv,
} from './index.ts';

export async function updateSettings(
  workspace: string,
  kinds: PluginKinds,
  update: (config: Config) => void,
) {
  const path = join(workspace, configFilename);
  if (!(await lstat(path)).isFile())
    throw new ConfigError('Expected a regular workspace configuration file');
  const config = parseConfig(await readFile(path, 'utf8'), kinds);
  update(config);
  const text = JSON.stringify(config, null, 2) + '\n';
  parseConfig(text, kinds);
  await replace(path, text);
}

export async function writeCredential(
  workspace: string,
  key: string,
  value: string,
) {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new ConfigError('Invalid workspace credential name or value');
  const path = join(workspace, envFilename);
  let text = '';
  try {
    if (!(await lstat(path)).isFile())
      throw new ConfigError('Expected a regular workspace environment file');
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  parseEnv(text);
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const kept = text
    .split(/\r?\n/)
    .filter((line) => !assignment.test(line))
    .join('\n')
    .trimEnd();
  const next = `${kept ? kept + '\n' : ''}${key}=${JSON.stringify(value)}\n`;
  await replace(path, next);
}

async function replace(path: string, text: string) {
  const temporary = path + '.' + randomUUID();
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
