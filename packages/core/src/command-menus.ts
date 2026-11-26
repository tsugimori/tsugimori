import type {
  ChatMigration,
  InboundMessage,
  PlatformAdapter,
  PlatformCommand,
  PlatformCommandScope,
} from '@tsugimori/plugin-sdk';
import type { Store, TraceSpan } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import type { Logger } from './hooks.ts';
import type { Runtime } from './runtime.ts';

import { chatCommands } from './chat-commands.ts';
import { describeError } from './errors.ts';

interface Dependencies {
  log: Logger;
  onMigration(
    adapter: PlatformAdapter,
    chatId: string,
    newChatId: string,
  ): void;
  owner(adapterId: string): string | undefined;
  runtime: Runtime;
  store: Store;
  trace: Tracer;
}

interface MenuState {
  applied: Map<string, string>;
  groups: Set<string>;
  pending: Promise<void>;
  scoped: Map<string, Extract<PlatformCommandScope, { userId: string }>>;
  unavailable: Map<string, string[]>;
}

export class CommandMenus {
  readonly #deps: Dependencies;
  readonly #menus = new Map<PlatformAdapter | string, MenuState>();
  #stopping = false;

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  refresh() {
    const { log, runtime, store, trace } = this.#deps;
    const adapters = runtime.adapterIds.flatMap((id) => {
      const adapter = runtime.getAdapter(id);
      return adapter?.setCommands ? [adapter] : [];
    });
    if (!adapters.length) return;
    const menus = new Map(
      adapters.map((adapter) => [adapter.id, this.#menu(adapter)]),
    );
    try {
      trace.span('platform.commands.load_groups', {}, () => {
        for (const chat of store.listChats()) {
          const state = menus.get(chat.adapterId);
          if (!state || chat.kind === 'dm' || chat.migratedToChatId) continue;
          state.groups.add(store.deliveryAddress(chat)?.chatId ?? chat.chatId);
        }
      });
    } catch {
      log({ level: 'error', event: 'platform.command_groups_failed' });
    }
    for (const adapter of adapters) this.sync(adapter);
  }

  sync(adapter: PlatformAdapter) {
    if (
      !adapter.setCommands ||
      this.#deps.runtime.getAdapter(adapter.id) !== adapter
    )
      return;
    const state = this.#menu(adapter);
    this.#queue(adapter.id, state, async () => {
      const { owner, runtime } = this.#deps;
      const userId = owner(adapter.id);
      const commands = chatCommands(runtime.config.locale);
      for (const [key, scope] of state.scoped) {
        if (scope.userId === userId) continue;
        if (await this.#set(adapter, state, scope, [])) {
          state.scoped.delete(key);
          state.applied.delete(key);
        }
      }
      await this.#set(adapter, state, { type: 'default' }, []);
      await this.#set(adapter, state, { type: 'group-chats' }, []);
      await this.#set(
        adapter,
        state,
        { type: 'private-chats' },
        userId ? [] : commands.pair,
      );
      if (!userId) return;
      await this.#set(
        adapter,
        state,
        { type: 'private-chat', userId },
        commands.owner,
      );
      for (const chatId of state.groups)
        await this.#set(
          adapter,
          state,
          { chatId, type: 'chat-member', userId },
          commands.owner,
        );
    });
  }

  observeChat(
    adapter: PlatformAdapter,
    {
      chatId,
      chatKind,
      edited,
    }: Pick<InboundMessage, 'chatId' | 'chatKind' | 'edited'>,
  ) {
    if (
      !adapter.setCommands ||
      this.#deps.runtime.getAdapter(adapter.id) !== adapter
    )
      return;
    const { store } = this.#deps;
    const ref = { adapterId: adapter.id, chatId };
    const state = this.#menu(adapter);
    const discovered = chatKind !== 'dm' && !state.groups.has(chatId);
    if (discovered && store.getChat(ref)?.migratedToChatId) return;
    const recovered = !edited && state.unavailable.has(chatId);
    if (recovered) {
      store.clearUnavailableCommandScopes({
        ...ref,
        botId: adapter.botIdentity?.id ?? '',
      });
      state.unavailable.delete(chatId);
    }
    if (discovered) state.groups.add(chatId);
    if (recovered || discovered) this.sync(adapter);
  }

  migrateChat(
    adapter: PlatformAdapter,
    {
      chatId,
      newChatId,
      title,
    }: Pick<ChatMigration, 'chatId' | 'newChatId' | 'title'>,
  ) {
    if (this.#recordMigration(adapter, chatId, newChatId, title))
      this.sync(adapter);
  }

  async idle() {
    await Promise.all([...this.#menus.values()].map(({ pending }) => pending));
  }

  stop() {
    this.#stopping = true;
  }

  #menu(adapter: PlatformAdapter) {
    const { botIdentity, id, kind } = adapter;
    const key = botIdentity?.id
      ? JSON.stringify([kind, id, botIdentity.id])
      : adapter;
    const previous = this.#menus.get(key);
    if (previous) return previous;
    const unavailable = new Map<string, string[]>();
    for (const {
      chatId,
      scope,
    } of this.#deps.store.listUnavailableCommandScopes({
      adapterId: id,
      botId: botIdentity?.id ?? '',
    })) {
      const scopes = unavailable.get(chatId) ?? [];
      scopes.push(scope);
      unavailable.set(chatId, scopes);
    }
    const state: MenuState = {
      applied: new Map(),
      groups: new Set(),
      pending: Promise.resolve(),
      scoped: new Map(),
      unavailable,
    };
    this.#menus.set(key, state);
    return state;
  }

  #queue(adapterId: string, state: MenuState, run: () => Promise<void>) {
    const { log, trace } = this.#deps;
    state.pending = state.pending.then(async () => {
      const attrs: TraceSpan['attrs'] = { adapterId };
      const end = trace.begin('platform.commands.reconcile', attrs);
      try {
        await run();
        end();
      } catch (error) {
        attrs.error = describeError(error);
        end('error');
        log({ level: 'error', event: 'platform.commands_failed', ...attrs });
      }
    });
  }

  #recordMigration(
    adapter: PlatformAdapter,
    chatId: string,
    newChatId: string,
    title?: string,
  ) {
    const { store, trace } = this.#deps;
    const attrs = { adapterId: adapter.id, chatId, newChatId };
    const recorded = trace.span('platform.commands.migrate_chat', attrs, () =>
      store.migrateChat({ adapterId: adapter.id, chatId }, newChatId, title),
    );
    if (recorded && adapter.setCommands) {
      const state = this.#menu(adapter);
      state.groups.delete(chatId);
      state.groups.add(newChatId);
      for (const [key, scope] of state.scoped) {
        if (scope.type !== 'chat-member' || scope.chatId !== chatId) continue;
        state.scoped.delete(key);
        state.applied.delete(key);
      }
    }
    if (recorded) this.#deps.onMigration(adapter, chatId, newChatId);
    return recorded;
  }

  async #set(
    adapter: PlatformAdapter,
    state: MenuState,
    scope: PlatformCommandScope,
    commands: readonly PlatformCommand[],
  ) {
    const { log, runtime, store, trace } = this.#deps;
    const setCommands = adapter.setCommands;
    if (
      this.#stopping ||
      runtime.getAdapter(adapter.id) !== adapter ||
      !setCommands
    )
      return false;
    const key = JSON.stringify(scope);
    const value = JSON.stringify(commands);
    if (state.applied.get(key) === value) return true;
    const ref =
      'userId' in scope
        ? {
            adapterId: adapter.id,
            botId: adapter.botIdentity?.id ?? '',
            chatId: scope.type === 'chat-member' ? scope.chatId : scope.userId,
          }
        : undefined;
    if (ref && state.unavailable.get(ref.chatId)?.includes(key)) return false;
    if ('userId' in scope && commands.length) state.scoped.set(key, scope);
    const attrs: TraceSpan['attrs'] = {
      adapterId: adapter.id,
      scope: scope.type,
    };
    if (ref) attrs.chatId = ref.chatId;
    const end = trace.begin('platform.commands', attrs);
    try {
      await setCommands.call(adapter, commands, scope);
      end();
      state.applied.set(key, value);
      return true;
    } catch (error) {
      state.applied.delete(key);
      const details = adapter.describeCommandError?.(error);
      attrs.error = describeError(error);
      if (details?.code !== undefined) attrs.code = details.code;
      if (details?.migratedToChatId)
        attrs.migratedToChatId = details.migratedToChatId;
      if (details?.retryAfterMs !== undefined)
        attrs.retryAfterMs = details.retryAfterMs;
      end('error');
      log({ level: 'error', event: 'platform.commands_failed', ...attrs });
      if (
        scope.type === 'chat-member' &&
        details?.code === 400 &&
        details.migratedToChatId
      ) {
        this.#recordMigration(adapter, scope.chatId, details.migratedToChatId);
      } else if (ref && details?.scopeUnavailable) {
        store.markCommandScopeUnavailable(ref, key);
        state.unavailable.set(ref.chatId, [
          ...(state.unavailable.get(ref.chatId) ?? []),
          key,
        ]);
      }
      return false;
    }
  }
}
