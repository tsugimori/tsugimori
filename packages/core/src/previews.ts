import type { Auth } from '@tsugimori/auth';
import type {
  ChatRef,
  LocalEndpoint,
  PreviewCloseReason,
  ToolDefinition,
  TunnelProvider,
} from '@tsugimori/plugin-sdk';
import type { Store, StoredPreview } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import { ToolFailure } from '@tsugimori/plugin-sdk';

import type { HookRunner, Logger } from './hooks.ts';

export interface PreviewProviders {
  named?: TunnelProvider;
  quick: TunnelProvider;
}

interface PreviewDependencies {
  auth: Auth;
  available(kind: keyof PreviewProviders): boolean;
  endpoint(chat: ChatRef, port: number): Promise<LocalEndpoint>;
  hooks: HookRunner;
  log: Logger;
  maxTtlMinutes(): number;
  namedConfigured(): boolean;
  providers: PreviewProviders;
  store: Store;
  trace: Tracer;
}

interface ActivePreview {
  cleanup(): void;
  closing?: Promise<void>;
  provider: TunnelProvider;
  record: StoredPreview;
}

const id = { type: 'string', minLength: 1, maxLength: 128 };

export class Previews {
  readonly #deps: PreviewDependencies;
  readonly #live = new Map<string, ActivePreview>();
  readonly #ready = new Map<TunnelProvider, Promise<void>>();
  readonly #shutdown = new AbortController();

  constructor(deps: PreviewDependencies) {
    this.#deps = deps;
  }

  start() {
    const { store, trace } = this.#deps;
    for (const preview of store.closePreviewsOnRestart(Date.now()))
      trace.begin('preview.closed', this.#attributes(preview, 'restart'))();
    for (const kind of ['quick', 'named'] as const) {
      const provider = this.#deps.providers[kind];
      if (provider && this.#deps.available(kind)) void this.#prepare(provider);
    }
  }

  async configureNamed(provider: TunnelProvider | undefined) {
    const current = this.#deps.providers.named;
    if (current === provider) return;
    this.#deps.providers.named = undefined;
    if (current) {
      await Promise.allSettled(
        [...this.#live.values()]
          .filter((entry) => entry.provider === current)
          .map((entry) => this.#close(entry, 'provider-stopped')),
      );
      await this.#ready.get(current);
      this.#ready.delete(current);
      try {
        await current.stop?.();
      } catch {
        this.#deps.log({ level: 'warn', event: 'preview.stop_failed' });
      }
    }
    this.#deps.providers.named = provider;
    if (provider && this.#deps.available('named')) void this.#prepare(provider);
  }

  #prepare(provider: TunnelProvider) {
    let ready = this.#ready.get(provider);
    if (!ready) {
      ready = Promise.resolve()
        .then(() => provider.reconcile([]))
        .catch(() => {
          this.#deps.log({ level: 'error', event: 'preview.reconcile_failed' });
        });
      this.#ready.set(provider, ready);
    }
    return ready;
  }

  async stop() {
    this.#shutdown.abort();
    await Promise.allSettled(
      [...this.#live.values()].map((entry) => this.#close(entry, 'shutdown')),
    );
    await Promise.allSettled(this.#ready.values());
    const { quick, named } = this.#deps.providers;
    await Promise.allSettled([quick.stop?.(), named?.stop?.()]);
  }

  async detach(adapters: ReadonlySet<string>) {
    await Promise.allSettled(
      [...this.#live.values()]
        .filter(({ record }) => adapters.has(record.adapterId))
        .map((entry) => this.#close(entry, 'service-stopped')),
    );
  }

  list(adapterId: string) {
    return this.#deps.store.listPreviews(adapterId);
  }

  async ownerClose(adapterId: string, previewId: string) {
    const entry = this.#live.get(previewId);
    if (!entry || entry.record.adapterId !== adapterId) return false;
    await this.#close(entry, 'requested');
    return true;
  }

  #attributes(record: StoredPreview, reason?: PreviewCloseReason) {
    const {
      adapterId,
      chatId,
      openedBy,
      port,
      url,
      provider,
      id: previewId,
    } = record;
    return {
      adapterId,
      chatId,
      openedBy,
      port,
      url,
      provider,
      previewId,
      ...(reason ? { reason } : {}),
    };
  }

  #close(entry: ActivePreview, reason: PreviewCloseReason) {
    entry.closing ??= this.#finish(entry, reason);
    return entry.closing;
  }

  async #finish(entry: ActivePreview, reason: PreviewCloseReason) {
    const { hooks, log, store, trace } = this.#deps;
    const id = entry.record.id;
    entry.cleanup();
    try {
      await trace.span(
        'preview.closed',
        this.#attributes(entry.record, reason),
        () => entry.provider.close(id, reason),
      );
    } catch {
      log({ level: 'error', event: 'preview.close_failed' });
    } finally {
      store.closePreview(id, Date.now(), reason);
      this.#live.delete(id);
      await hooks.emit('preview.closed', { previewId: id });
    }
  }

  tools(): ToolDefinition[] {
    return [
      {
        name: 'preview.open',
        description:
          'Publish a service started with exec.run backgroundPort for this chat. ttl is in minutes, capped by the workspace preview limit.',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            port: { type: 'integer', minimum: 1, maximum: 65_535 },
            ttl: { type: 'integer', minimum: 1, maximum: 1440 },
          },
          required: ['port', 'ttl'],
        },
        run: async (args, task) => {
          const { port, ttl } = args as { port: number; ttl: number };
          const { chat, principal, taskId } = task;
          const { auth, hooks, log, providers, store, trace } = this.#deps;
          const signal = AbortSignal.any([task.signal, this.#shutdown.signal]);
          signal.throwIfAborted();
          const endpoint = await this.#deps.endpoint(chat, port);
          const kind =
            auth.isOwner(principal) && this.#deps.namedConfigured()
              ? 'named'
              : 'quick';
          const provider = providers[kind];
          if (!provider || !this.#deps.available(kind))
            throw new ToolFailure(
              `${kind === 'named' ? 'Named' : 'Quick'} previews are unavailable. Check /status.`,
            );
          await this.#prepare(provider);
          signal.throwIfAborted();
          endpoint.closed?.throwIfAborted();
          if (
            store
              .listPreviews(chat.adapterId)
              .filter((item) => item.chatId === chat.chatId).length >= 8
          )
            throw new ToolFailure('This chat already has eight open previews');
          let active: ActivePreview | undefined;
          let stopped: PreviewCloseReason | undefined;
          const onClose = (reason: PreviewCloseReason) => {
            stopped = reason;
            if (active)
              void this.#close(active, reason).catch(() =>
                log({ level: 'error', event: 'preview.close_failed' }),
              );
          };
          const preview = await trace.span(
            'preview.open',
            { ...chat, taskId, port, provider: provider.id },
            () =>
              provider.open({
                endpoint,
                openedBy: principal.userId,
                signal: endpoint.closed
                  ? AbortSignal.any([signal, endpoint.closed])
                  : signal,
                ttlMs: Math.min(ttl, this.#deps.maxTtlMinutes()) * 60_000,
                onClose,
              }),
          );
          try {
            signal.throwIfAborted();
            endpoint.closed?.throwIfAborted();
            if (stopped)
              throw new ToolFailure('The preview closed during startup');
            const { id, expiresAt } = preview;
            const url = new URL(preview.url).origin;
            const record: StoredPreview = {
              ...chat,
              id,
              port,
              url,
              provider: provider.id,
              openedBy: principal.userId,
              createdAt: Date.now(),
              expiresAt: expiresAt.getTime(),
              closedAt: null,
              closedReason: null,
            };
            store.openPreview(record);
            const serviceStopped = () => onClose('service-stopped');
            const timer = setTimeout(
              () => onClose('expired'),
              Math.max(0, record.expiresAt - Date.now()),
            );
            timer.unref();
            endpoint.closed?.addEventListener('abort', serviceStopped, {
              once: true,
            });
            active = {
              provider,
              record,
              cleanup: () => {
                clearTimeout(timer);
                endpoint.closed?.removeEventListener('abort', serviceStopped);
              },
            };
            this.#live.set(id, active);
            trace.begin('preview.opened', this.#attributes(record))();
            await hooks.emit('preview.opened', { previewId: id });
            return preview;
          } catch (error) {
            if (active) await this.#close(active, stopped ?? 'service-stopped');
            else await provider.close(preview.id, stopped ?? 'service-stopped');
            throw error;
          }
        },
      },
      {
        name: 'preview.close',
        description:
          'Close a preview in this chat that you opened. The adapter owner can close any preview in this chat.',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { id },
          required: ['id'],
        },
        run: async (args, { chat, principal, signal }) => {
          signal.throwIfAborted();
          const entry = this.#live.get((args as { id: string }).id);
          if (
            !entry ||
            entry.record.adapterId !== chat.adapterId ||
            entry.record.chatId !== chat.chatId ||
            !(
              entry.record.openedBy === principal.userId ||
              this.#deps.auth.isOwner(principal)
            )
          )
            throw new ToolFailure('Preview is unavailable in this chat');
          await this.#close(entry, 'requested');
          return { closed: entry.record.id };
        },
      },
    ];
  }
}
