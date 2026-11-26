import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PluginFactoryContext } from './index.ts';
import type { CheckItem, SetupStep } from './setup.ts';

export const webhookBaseUrlPattern = String.raw`^[Hh][Tt][Tt][Pp][Ss]://[^/\s\\?#@]+(?:/[^\s\\?#]*)?$`;

export function parseWebhookBaseUrl(value: unknown): URL | undefined {
  if (
    typeof value !== 'string' ||
    /[\s\x00-\x1f\x7f]/u.test(value) ||
    !new RegExp(webhookBaseUrlPattern).test(value)
  )
    return;
  return URL.parse(value) ?? undefined;
}

export const defaultWebhookListen = '127.0.0.1:8789';
export const webhookListenPattern =
  '^(127\\.0\\.0\\.1|\\[::1\\]):([0-9]{1,5})$';

export function parseWebhookListen(value: unknown = defaultWebhookListen) {
  const match =
    typeof value === 'string' && new RegExp(webhookListenPattern).exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return;
  return {
    host: match[1] === '[::1]' ? '::1' : '127.0.0.1',
    port: Number(match[2]),
  };
}

export interface WebhookStatus {
  baseUrl?: string;
  checkedAt?: string;
  provider?: string;
  reason?: string;
  reasonCode?: string;
  state: 'unconfigured' | 'checking' | 'ok' | 'failed';
}

export type WebhookRoute = (req: IncomingMessage, res: ServerResponse) => void;

export interface WebhookIngress {
  register(
    path: string,
    route: WebhookRoute,
    signal: AbortSignal,
  ): Promise<() => Promise<void>>;
  status(): WebhookStatus;
  url(path: string): string | undefined;
}

export interface WebhookConfig {
  cloudflare?: Readonly<Record<string, unknown>>;
  listen?: string;
  provider: 'cloudflare' | 'manual';
  publicBaseUrl?: string;
}

export interface WebhookProviderContext extends PluginFactoryContext {
  config: Readonly<WebhookConfig>;
  fetch: typeof globalThis.fetch;
  listen: string;
  signal: AbortSignal;
}

export interface WebhookProvider {
  baseUrl?(config: Readonly<WebhookConfig>): string;
  checks(ctx: WebhookProviderContext): Promise<readonly CheckItem[]>;
  ensure(ctx: WebhookProviderContext): Promise<{ baseUrl: string }>;
  id: string;
  setupSteps: readonly SetupStep[];
}

export class WebhookProviderError extends Error {
  readonly code: string;
  readonly zh?: string;

  constructor(code: string, message: string, zh?: string) {
    super(message);
    this.code = code;
    this.zh = zh;
  }
}
