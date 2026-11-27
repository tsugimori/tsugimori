import { join, resolve } from 'node:path';

import type {
  PlatformInstanceConfig,
  PluginFactoryContext,
  PluginInstanceConfig,
  RunResult,
} from './index.ts';
import type { WebhookConfig } from './webhooks.ts';

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
  configuredPlatforms?: readonly Readonly<PlatformInstanceConfig>[];
  entry: Readonly<PluginInstanceConfig>;
  fetch: typeof globalThis.fetch;
  platform: NodeJS.Platform;
  runCommand: CommandRunner;
  /** Startup checks can leave network probes to the adapter's start method. */
  startup?: boolean;
  webhooks?: Readonly<WebhookConfig>;
}

export interface CheckItem {
  capabilities?: readonly string[];
  detail: string;
  fix?: { command?: string[]; hint?: string; sudo?: boolean };
  id: string;
  localized?: { 'zh-TW'?: { detail?: string; hint: string; title: string } };
  login?: 'signed-in' | 'required';
  status: 'ok' | 'warn' | 'fail';
  title: string;
}

export interface SetupPatch {
  entry?: Partial<PluginInstanceConfig> & Record<string, unknown>;
  ownerId?: string;
  webhooks?: Partial<WebhookConfig>;
}

export interface PromptChoice {
  label: string;
  localized?: { 'zh-TW'?: string };
  value: string;
}

export interface SetupPrompt {
  choices?: readonly PromptChoice[];
  secret?: boolean;
  text: string;
}

export const yesNoChoices: readonly PromptChoice[] = [
  { value: 'yes', label: 'Yes', localized: { 'zh-TW': '是' } },
  { value: 'no', label: 'No', localized: { 'zh-TW': '否' } },
];

export interface SetupContext extends CheckContext {
  install(): Promise<void>;
  locale?: 'en' | 'zh-TW';
  prompt(
    options: SetupPrompt & {
      /** Override the plan's question count for a conditional path. */
      questions?: { maximum?: boolean; total: number };
    },
  ): Promise<string>;
  /** Report a credential saved by an external login command. Pass its name only. */
  recordCredential(name: string): void;
  runCheck(id: string): Promise<CheckItem>;
  show(text: string): Promise<void>;
  signal: AbortSignal;
  testTurn(): Promise<void>;
  writeConfig(patch: SetupPatch): void;
  writeEnv(key: string, value: string): Promise<void>;
}

interface SetupText {
  localized?: { 'zh-TW'?: string };
  text: string;
}

export interface SetupStep {
  /** Questions in plan order. An empty list declares an automatic step. */
  asks?: readonly (SetupText & { secret?: boolean })[];
  id: string;
  localized?: { 'zh-TW'?: string };
  retryFrom?: string;
  run(ctx: SetupContext): void | Promise<void>;
  runOnLogin?: boolean;
  saves?: SetupText;
  title: string;
}

export interface SetupCompletion extends Pick<
  SetupStep,
  'asks' | 'localized' | 'title'
> {
  /** Runs after the workspace configuration is saved and returns a setup summary. */
  run(
    ctx: CheckContext & Pick<SetupContext, 'locale' | 'prompt' | 'signal'>,
  ): string | Promise<string>;
}

export class SetupError extends Error {}

export function agentHome(workspace: string, id: string, override?: string) {
  return resolve(workspace, override ?? join('agents', id, 'home'));
}

export function platformHomes(workspace: string) {
  return resolve(workspace, 'data', 'platforms');
}

export function platformHome(workspace: string, id: string) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(id))
    throw new SetupError('Invalid platform instance ID');
  return join(platformHomes(workspace), id, 'home');
}

export function credentialKey(prefix: string, id: string) {
  return prefix + '_' + Buffer.from(id).toString('hex').toUpperCase();
}
