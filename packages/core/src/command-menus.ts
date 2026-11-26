import type {
  PlatformAdapter,
  PlatformCommand,
  PlatformCommandScope,
} from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';

import type { Logger } from './hooks.ts';
import type { Runtime } from './runtime.ts';

import { chatCommands } from './chat-commands.ts';

interface Dependencies {
  log: Logger;
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
          if (!state || chat.kind === 'dm') continue;
          const address = store.deliveryAddress(chat);
          if (address) state.groups.add(address.chatId);
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

  observeGroup(adapter: PlatformAdapter, chatId: string) {
    if (
      !adapter.setCommands ||
      this.#deps.runtime.getAdapter(adapter.id) !== adapter
    )
      return;
    const state = this.#menu(adapter);
    if (state.groups.has(chatId)) return;
    state.groups.add(chatId);
    this.#queue(adapter.id, state, async () => {
      const { owner, runtime } = this.#deps;
      const userId = owner(adapter.id);
      if (!userId) return;
      const commands = chatCommands(runtime.config.locale);
      await this.#set(
        adapter,
        state,
        { chatId, type: 'chat-member', userId },
        commands.owner,
      );
    });
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
    const state: MenuState = {
      applied: new Map(),
      groups: new Set(),
      pending: Promise.resolve(),
      scoped: new Map(),
    };
    this.#menus.set(key, state);
    return state;
  }

  #queue(adapterId: string, state: MenuState, run: () => Promise<void>) {
    const { log, trace } = this.#deps;
    const attrs = { adapterId };
    state.pending = state.pending
      .then(() => trace.span('platform.commands.reconcile', attrs, run))
      .catch(() => {
        log({ level: 'error', event: 'platform.commands_failed', ...attrs });
      });
  }

  async #set(
    adapter: PlatformAdapter,
    state: MenuState,
    scope: PlatformCommandScope,
    commands: readonly PlatformCommand[],
  ) {
    const { log, runtime, trace } = this.#deps;
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
    if ('userId' in scope && commands.length) state.scoped.set(key, scope);
    const attrs = { adapterId: adapter.id, scope: scope.type };
    try {
      await trace.span('platform.commands', attrs, () =>
        setCommands.call(adapter, commands, scope),
      );
      state.applied.set(key, value);
      return true;
    } catch {
      state.applied.delete(key);
      log({ level: 'error', event: 'platform.commands_failed', ...attrs });
      return false;
    }
  }
}
