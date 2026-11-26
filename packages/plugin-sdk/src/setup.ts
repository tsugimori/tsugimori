import { join, resolve } from 'node:path';

import type {
  PluginFactoryContext,
  PluginInstanceConfig,
  RunResult,
} from './index.ts';

interface CommandInput {
  close(): void;
  write(text: string): void;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  interactive?: boolean;
  keepInputOpen?: boolean;
  onChunk?(chunk: string, input: CommandInput): void | Promise<void>;
  onLine?(line: string, input: CommandInput): void | Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type CommandRunner = (
  command: readonly [string, ...string[]],
  options?: CommandOptions,
) => Promise<RunResult>;

export interface SetupDependencies {
  arch?: string;
  fetch?: typeof globalThis.fetch;
  platform?: NodeJS.Platform;
  runCommand?: CommandRunner;
  testAgent?(
    entry: PluginInstanceConfig,
    ctx: PluginFactoryContext,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface CheckContext extends PluginFactoryContext {
  arch: string;
  entry: Readonly<PluginInstanceConfig>;
  fetch: typeof globalThis.fetch;
  platform: NodeJS.Platform;
  runCommand: CommandRunner;
}

export interface CheckItem {
  capabilities?: readonly string[];
  detail: string;
  fix?: { command?: string[]; hint?: string; sudo?: boolean };
  id: string;
  localized?: { 'zh-TW'?: { hint: string; title: string } };
  status: 'ok' | 'warn' | 'fail';
  title: string;
}

export interface SetupPatch {
  entry?: Partial<PluginInstanceConfig> & Record<string, unknown>;
  ownerId?: string;
}

export interface SetupContext extends CheckContext {
  install(): Promise<void>;
  locale?: 'en' | 'zh-TW';
  prompt(options: { secret?: boolean; text: string }): Promise<string>;
  runCheck(id: string): Promise<CheckItem>;
  show(text: string): Promise<void>;
  signal: AbortSignal;
  testTurn(): Promise<void>;
  writeConfig(patch: SetupPatch): void;
  writeEnv(key: string, value: string): Promise<void>;
}

export interface SetupStep {
  id: string;
  localized?: { 'zh-TW'?: string };
  run(ctx: SetupContext): void | Promise<void>;
  title: string;
}

export class SetupError extends Error {}

export function agentHome(workspace: string, id: string, override?: string) {
  return resolve(workspace, override ?? join('agents', id, 'home'));
}

export function credentialKey(prefix: string, id: string) {
  return prefix + '_' + Buffer.from(id).toString('hex').toUpperCase();
}
