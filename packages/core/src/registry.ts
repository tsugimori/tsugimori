import type { PluginKinds } from '@tsugimori/config';
import type {
  AgentFactory,
  ExecBackend,
  PlatformFactory,
  PluginDefinition,
} from '@tsugimori/plugin-sdk';

export class PluginRegistry implements PluginKinds {
  readonly #platforms = new Map<string, PlatformFactory>();
  readonly #exec = new Map<string, ExecBackend>();
  readonly #agents = new Map<string, AgentFactory>();
  readonly plugins: readonly PluginDefinition[];

  constructor(plugins: readonly PluginDefinition[] = []) {
    this.plugins = [...plugins];
    for (const plugin of plugins) {
      for (const backend of plugin.execBackends ?? []) {
        if (this.#exec.has(backend.id))
          throw new Error(`Duplicate execution backend: ${backend.id}`);
        this.#exec.set(backend.id, backend);
      }
      for (const [kind, factory] of Object.entries(plugin.adapters ?? {})) {
        if (this.#platforms.has(kind))
          throw new Error(`Duplicate platform kind: ${kind}`);
        this.#platforms.set(kind, factory);
      }
      for (const [kind, factory] of Object.entries(plugin.agents ?? {})) {
        if (this.#agents.has(kind))
          throw new Error(`Duplicate agent kind: ${kind}`);
        this.#agents.set(kind, factory);
      }
    }
  }

  forInstance(category: 'agent' | 'platform', kind: string) {
    return this.plugins.find((plugin) =>
      Object.hasOwn(
        (category === 'agent' ? plugin.agents : plugin.adapters) ?? {},
        kind,
      ),
    );
  }

  forFeature(category: 'exec' | 'preview', id: string) {
    return this.plugins.find((plugin) =>
      category === 'exec'
        ? plugin.execBackends?.some((backend) => backend.id === id)
        : plugin.name === id,
    );
  }

  execution(id: string) {
    return this.#exec.get(id);
  }

  get platformKinds(): ReadonlySet<string> {
    return new Set(this.#platforms.keys());
  }

  get agentKinds(): ReadonlySet<string> {
    return new Set(this.#agents.keys());
  }

  platform(kind: string) {
    const factory = this.#platforms.get(kind);
    if (!factory) throw new Error(`Unregistered platform kind: ${kind}`);
    return factory;
  }

  agent(kind: string) {
    const factory = this.#agents.get(kind);
    if (!factory) throw new Error(`Unregistered agent kind: ${kind}`);
    return factory;
  }
}
