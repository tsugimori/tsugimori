import type { Config, WorkspaceConfig } from '@tsugimori/config';
import type {
  CheckItem,
  SetupDependencies,
  WebhookConfig,
  WebhookIngress,
  WebhookProvider,
  WebhookStatus,
} from '@tsugimori/plugin-sdk';
import type { Tracer } from '@tsugimori/trace';

import { webhookListen } from '@tsugimori/config';
import {
  parseWebhookBaseUrl,
  SetupError,
  WebhookProviderError,
} from '@tsugimori/plugin-sdk';
import { isDeepStrictEqual } from 'node:util';

import type { Logger } from './hooks.ts';
import type { PluginRegistry } from './registry.ts';

import { systemMessages } from './system-messages.ts';
import { WebhookListener } from './webhook-listener.ts';

const manualProvider: WebhookProvider = {
  id: 'manual',
  async checks() {
    return [];
  },
  async ensure({ config }) {
    if (!config.publicBaseUrl)
      throw new Error('A public webhook URL is required');
    return { baseUrl: config.publicBaseUrl };
  },
  setupSteps: [
    {
      id: 'public-url',
      title: 'Public HTTPS base URL',
      localized: { 'zh-TW': '公開的 HTTPS 基底網址' },
      asks: [
        {
          text: 'Public HTTPS base URL',
          localized: { 'zh-TW': '公開的 HTTPS 基底網址' },
        },
      ],
      async run(ctx) {
        const m = systemMessages(ctx.locale ?? 'en').webhook;
        const value = (await ctx.prompt({ text: m.askUrl })).trim();
        if (!parseWebhookBaseUrl(value)) throw new SetupError(m.invalidUrl);
        ctx.writeConfig({ webhooks: { publicBaseUrl: value } });
      },
    },
  ],
};

const unavailable: WebhookStatus = { state: 'unconfigured' };

interface Dependencies extends Pick<SetupDependencies, 'fetch'> {
  log?: Logger;
  now?: () => number;
  onStatus?(): void;
  registry: PluginRegistry;
  timeout?: () => AbortSignal;
  trace?: Tracer;
  workspace: string;
}

export class Webhooks implements WebhookIngress {
  readonly #deps: Dependencies;
  readonly #listener: WebhookListener;
  readonly #stop = new AbortController();
  #revision = new AbortController();
  #status: WebhookStatus = unavailable;
  #snapshot?: WorkspaceConfig;
  #settings?: WebhookConfig;
  #lastState?: WebhookStatus['state'];
  #queue = Promise.resolve<WebhookStatus>(unavailable);
  #timer?: NodeJS.Timeout;
  #interval?: NodeJS.Timeout;

  constructor(deps: Dependencies) {
    this.#deps = deps;
    this.#listener = new WebhookListener(deps);
  }

  register(...args: Parameters<WebhookIngress['register']>) {
    return this.#listener.register(...args);
  }

  paths() {
    return this.#listener.paths();
  }

  status() {
    return { ...this.#status };
  }

  url(path: string) {
    if (
      this.#status.state === 'ok' &&
      this.#status.baseUrl &&
      this.#listener.isListening() &&
      this.#listener.has(path)
    )
      return this.#status.baseUrl + path;
  }

  provider(id: string) {
    return id === 'manual'
      ? manualProvider
      : this.#deps.registry.webhookProvider(id);
  }

  async configure(
    snapshot: WorkspaceConfig,
    running = false,
    verified?: WebhookStatus,
  ) {
    this.#snapshot = snapshot;
    const settings = snapshot.config.webhooks;
    const listen = webhookListen(snapshot.config);
    if (
      isDeepStrictEqual(settings, this.#settings) &&
      this.#listener.listen === listen
    ) {
      if (verified) this.#publish(verified);
      return;
    }
    this.#settings = settings;
    this.#revision.abort();
    this.#revision = new AbortController();
    clearTimeout(this.#timer);
    this.#publish(
      settings ? { state: 'checking', ...this.#label(settings) } : unavailable,
    );
    try {
      await this.#listener.configure(listen);
    } catch (error) {
      if (settings)
        this.#publish(
          this.#unreachable(settings, snapshot.config.locale, error),
        );
      return;
    }
    if (verified) this.#publish(verified);
    else if (running && settings) void this.check();
  }

  start() {
    this.#timer = setTimeout(() => void this.check(), 5_000).unref();
    this.#interval = setInterval(() => void this.check(), 30 * 60_000).unref();
  }

  check(ensure = false) {
    const revision = this.#revision.signal;
    const snapshot = this.#snapshot;
    const settings = this.#settings;
    return this.#enqueue(async () => {
      if (
        !settings ||
        !snapshot ||
        revision.aborted ||
        this.#stop.signal.aborted
      )
        return this.status();
      const signal = AbortSignal.any([revision, this.#stop.signal]);
      this.#publish({
        state: 'checking',
        ...this.#label(settings),
        checkedAt: this.#status.checkedAt,
      });
      const status = await this.#verify(settings, snapshot, signal, ensure);
      if (!signal.aborted) this.#publish(status);
      return this.status();
    });
  }

  async verifySetup(
    config: WebhookConfig,
    snapshot: WorkspaceConfig,
    signal: AbortSignal,
    save: (verified: WebhookConfig) => Promise<void>,
  ) {
    const combined = AbortSignal.any([
      signal,
      this.#stop.signal,
      this.#revision.signal,
    ]);
    return this.#enqueue(async () => {
      combined.throwIfAborted();
      if (
        this.#listener.listen !==
        webhookListen({ ...snapshot.config, webhooks: config })
      )
        throw new SetupError(
          systemMessages(snapshot.config.locale).webhook.changed,
        );
      const status = await this.#verify(config, snapshot, combined, true);
      combined.throwIfAborted();
      if (status.state === 'ok') {
        const verified = { ...config, publicBaseUrl: status.baseUrl };
        await save(verified);
        await this.configure(
          { ...snapshot, config: { ...snapshot.config, webhooks: verified } },
          false,
          status,
        );
      }
      return status;
    });
  }

  async providerChecks(
    snapshot: WorkspaceConfig,
  ): Promise<readonly CheckItem[]> {
    const config = snapshot.config.webhooks;
    if (!config) return [];
    const provider = this.provider(config.provider);
    if (!provider) return [];
    try {
      return await provider.checks(
        this.#context(config, snapshot, this.#stop.signal),
      );
    } catch (error) {
      return [
        {
          id: 'webhook-provider',
          title: 'Webhook provider',
          status: 'fail',
          detail:
            error instanceof WebhookProviderError
              ? error.message
              : 'Webhook provider checks failed.',
        },
      ];
    }
  }

  #enqueue(run: () => Promise<WebhookStatus>) {
    const work = this.#queue.then(run);
    this.#queue = work.catch(() => this.status());
    return work;
  }

  #context(
    config: WebhookConfig,
    snapshot: WorkspaceConfig,
    signal: AbortSignal,
  ) {
    return {
      config,
      signal,
      listen: webhookListen({ ...snapshot.config, webhooks: config }),
      workspace: this.#deps.workspace,
      credential: (name: string) => process.env[name] ?? snapshot.env.get(name),
      fetch: this.#deps.fetch ?? globalThis.fetch,
    };
  }

  #label(config: WebhookConfig) {
    const baseUrl = normalizedBaseUrl(config.publicBaseUrl);
    return { provider: config.provider, baseUrl };
  }

  #failure(
    config: WebhookConfig,
    reason: string,
    reasonCode: string,
    baseUrl = this.#label(config).baseUrl,
  ): WebhookStatus {
    return {
      ...this.#label(config),
      baseUrl,
      checkedAt: new Date().toISOString(),
      reason,
      reasonCode,
      state: 'failed',
    };
  }

  #unreachable(
    config: WebhookConfig,
    locale: Config['locale'],
    error: unknown,
    baseUrl?: string,
  ) {
    const code = shortError(error);
    return this.#failure(
      config,
      systemMessages(locale).webhook.unreachable(code),
      code === 'EADDRINUSE' ? 'listen_in_use' : 'unreachable',
      baseUrl,
    );
  }

  async #verify(
    config: WebhookConfig,
    snapshot: WorkspaceConfig,
    signal: AbortSignal,
    ensure: boolean,
  ) {
    const { locale } = snapshot.config;
    const m = systemMessages(locale).webhook;
    let { baseUrl } = this.#label(config);
    let result: WebhookStatus | undefined;
    const attrs = { provider: config.provider, ensure, reasonCode: '' };
    const finish = this.#deps.trace?.begin('webhook.check', attrs);
    try {
      const provider = this.provider(config.provider);
      if (!provider) {
        result = this.#failure(
          config,
          m.missingProvider(config.provider),
          'provider_missing',
        );
      } else if (ensure) {
        const route = await provider.ensure(
          this.#context(config, snapshot, signal),
        );
        baseUrl = normalizedBaseUrl(route.baseUrl);
      } else if (provider.baseUrl) {
        baseUrl = normalizedBaseUrl(provider.baseUrl(config));
      }
      if (result) return result;
      if (!baseUrl)
        return (result = this.#failure(config, m.invalidUrl, 'invalid_url'));
      const context = this.#context(config, snapshot, signal);
      const timeout = this.#deps.timeout?.() ?? AbortSignal.timeout(10_000);
      const probe = await this.#listener.probe(
        baseUrl,
        context.fetch,
        AbortSignal.any([signal, timeout]),
      );
      result = probe.ok
        ? {
            baseUrl,
            checkedAt: new Date().toISOString(),
            provider: config.provider,
            state: 'ok',
          }
        : this.#failure(
            config,
            m.wrongTarget(probe.status),
            'wrong_target',
            baseUrl,
          );
      return result;
    } catch (error) {
      result =
        error instanceof WebhookProviderError
          ? this.#failure(
              config,
              locale === 'zh-TW' ? (error.zh ?? error.message) : error.message,
              error.code,
              baseUrl,
            )
          : this.#unreachable(config, locale, error, baseUrl);
      return result;
    } finally {
      attrs.reasonCode = result?.reasonCode ?? '';
      finish?.(result?.state === 'ok' && !signal.aborted ? 'ok' : 'error');
    }
  }

  #publish(status: WebhookStatus) {
    if (isDeepStrictEqual(status, this.#status)) return;
    if (status.state === 'failed')
      this.#deps.log?.({
        level: 'warn',
        event: 'webhook.check_failed',
        reasonCode: status.reasonCode,
      });
    if (status.state === 'ok' && this.#lastState !== 'ok')
      this.#deps.log?.({ level: 'info', event: 'webhook.check_ok' });
    if (status.state !== 'checking') this.#lastState = status.state;
    this.#status = status;
    this.#deps.onStatus?.();
  }

  async stop() {
    clearTimeout(this.#timer);
    clearInterval(this.#interval);
    this.#stop.abort();
    await this.#queue;
    await this.#listener.stop();
  }
}

function normalizedBaseUrl(value: unknown) {
  const parsed = parseWebhookBaseUrl(value);
  return parsed?.href.replace(/\/+$/, '');
}

function shortError(error: unknown) {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  const cause = error instanceof Error ? (error.cause ?? error) : undefined;
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? cause.code
      : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)
    ? code
    : 'connection failed';
}

export function webhookHealth(status: WebhookStatus, locale: Config['locale']) {
  const m = systemMessages(locale).webhook;
  return status.reason ?? m.states[status.state];
}

export function webhookCheckItem(status: WebhookStatus): CheckItem {
  const en = webhookHealth(status, 'en');
  const zh = webhookHealth(status, 'zh-TW');
  return {
    id: 'webhook-ingress',
    title: 'Webhook ingress',
    status:
      status.state === 'ok'
        ? 'ok'
        : status.state === 'failed'
          ? 'fail'
          : 'warn',
    detail: en,
    localized: { 'zh-TW': { title: 'Webhook', detail: zh, hint: zh } },
  };
}
