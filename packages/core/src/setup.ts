import type { Config } from '@tsugimori/config';
import type {
  AgentInstanceConfig,
  SetupContext,
  SetupDependencies,
} from '@tsugimori/plugin-sdk';
import type { SetupRun, Store } from '@tsugimori/storage';

import {
  loadConfig,
  loadSettings,
  updateSettings,
  writeCredential,
} from '@tsugimori/config';
import { SetupError } from '@tsugimori/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginRegistry } from './registry.ts';

import { EnvironmentChecks, failureText } from './checks.ts';
import { systemMessages } from './system-messages.ts';

type Category = SetupRun['category'];

export interface SetupIO {
  locale?: Config['locale'];
  measure?<T>(step: string, run: () => Promise<T>): Promise<T>;
  prompt(options: Parameters<SetupContext['prompt']>[0]): Promise<string>;
  show(text: string): Promise<void>;
  signal: AbortSignal;
  waitForDetach?(id: string): Promise<void>;
}

export type SetupRequest =
  | { category: Category; id: string; kind: string; mode: 'add' }
  | { id: string; mode: 'login' };

const validId = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
const leaseLength = 30_000;

interface Dependencies extends SetupDependencies {
  registry: PluginRegistry;
  store: Store;
  workspace: string;
}

function entries(config: Config, category: Category) {
  return category === 'agent' ? config.agents : config.platforms;
}

export class GuidedSetup {
  readonly #deps: Dependencies;
  readonly #checks: EnvironmentChecks;

  constructor(deps: Dependencies) {
    this.#deps = deps;
    this.#checks = new EnvironmentChecks(deps, deps.workspace);
  }

  async run(request: SetupRequest, io: SetupIO) {
    const { store, registry, workspace } = this.#deps;
    const m = systemMessages(io.locale ?? 'en').setup;
    const { id, mode } = request;
    if (!validId.test(id)) throw new SetupError(m.invalidId);
    const config = await loadSettings(workspace, registry);
    const category = mode === 'login' ? 'agent' : request.category;
    const existing = entries(config, category).find((item) => item.id === id);
    const kind = mode === 'login' ? existing?.kind : request.kind;
    if (!kind) throw new SetupError(m.agentMissing);
    const plugin = registry.forInstance(category, kind);
    const steps = (plugin?.setupSteps ?? []).filter(
      (step) => mode === 'add' || step.id === 'login' || step.runOnLogin,
    );
    if (!steps.length)
      throw new SetupError(m.noSteps(mode === 'login', category, kind));
    const key = JSON.stringify([mode, category, id]);
    const previous = store.getSetupRun(key);
    if (previous?.status === 'pending' && previous.draft.entry.kind !== kind)
      throw new SetupError(m.pendingId);
    if (
      mode === 'add' &&
      existing &&
      !(
        previous?.status === 'pending' &&
        previous.step === steps.length &&
        existing.kind === kind
      )
    )
      throw new SetupError(m.configuredId);
    const now = Date.now();
    const lease = randomUUID();
    const run = store.claimSetupRun(
      {
        id: key,
        category,
        mode,
        lease,
        leaseUntil: now + leaseLength,
        step: 0,
        status: 'pending',
        draft: { entry: existing ?? { id, kind, enabled: true } },
      },
      now,
    );
    if (!run) throw new SetupError(m.busy);
    const lost = new AbortController();
    const signal = AbortSignal.any([io.signal, lost.signal]);
    let checkpoint = structuredClone(run);
    const save = () => {
      signal.throwIfAborted();
      checkpoint.leaseUntil = Date.now() + leaseLength;
      if (!store.saveSetupRun(checkpoint, lease))
        throw new SetupError(m.leaseExpired);
    };
    const heartbeat = setInterval(() => {
      try {
        save();
      } catch (error) {
        lost.abort(error);
      }
    }, leaseLength / 3);
    heartbeat.unref();
    const snapshot = async () => {
      const { env } = await loadConfig(workspace, registry);
      return this.#checks.context(run.draft.entry, env);
    };
    const check = async () =>
      this.#checks.plugin(
        plugin,
        await snapshot(),
        `${category}/${id}`,
        category,
      );
    try {
      if (mode === 'login') {
        await updateSettings(workspace, registry, (config) => {
          const target = config.agents.find(
            (agent) => agent.id === id && agent.kind === kind,
          );
          if (!target) throw new SetupError(m.changedAgent);
          target.enabled = false;
        });
        await io.waitForDetach?.(id);
      }
      for (const step of steps.slice(run.step)) {
        const current = await snapshot();
        await io.show(
          (io.locale === 'zh-TW' && step.localized?.[io.locale]) || step.title,
        );
        const ctx: SetupContext = {
          ...current,
          get entry() {
            return run.draft.entry;
          },
          signal,
          locale: io.locale,
          show: io.show,
          prompt: (options) => {
            signal.throwIfAborted();
            return io.prompt(options);
          },
          writeConfig(patch) {
            signal.throwIfAborted();
            run.draft.entry = { ...run.draft.entry, ...patch.entry, id, kind };
            if (patch.ownerId !== undefined) run.draft.ownerId = patch.ownerId;
          },
          writeEnv: async (key, value) => {
            signal.throwIfAborted();
            await writeCredential(workspace, key, value);
          },
          runCheck: async (id) => {
            const item = (await check()).find((result) => result.id === id);
            if (!item) throw new SetupError(m.missingCheck(id));
            return item;
          },
          install: async () => {
            const version = await plugin?.install?.(await snapshot(), {
              upgrade: false,
              signal,
            });
            if (version) ctx.writeConfig({ entry: { version } });
          },
          testTurn: () =>
            this.#testTurn(run.draft.entry, current, signal, m.testFailed),
        };
        try {
          if (io.measure) await io.measure(step.id, async () => step.run(ctx));
          else await step.run(ctx);
        } catch (error) {
          if (step.retryFrom && !signal.aborted) {
            const retry = steps.findIndex(({ id }) => id === step.retryFrom);
            if (retry >= 0 && retry < run.step) {
              checkpoint.step = retry;
              save();
            }
          }
          throw error;
        }
        run.step++;
        checkpoint = structuredClone(run);
        save();
      }
      const failures = failureText(await check(), io.locale);
      if (failures) {
        run.step = 0;
        checkpoint = structuredClone(run);
        save();
        throw new SetupError(failures);
      }
      signal.throwIfAborted();
      await updateSettings(workspace, registry, (config) => {
        const list = entries(config, category);
        const index = list.findIndex((item) => item.id === id);
        if (index < 0 && mode === 'add') list.push(run.draft.entry);
        else if (index >= 0 && list[index]?.kind === kind)
          list[index] = run.draft.entry;
        else throw new SetupError(m.changedConfig);
        if (run.draft.ownerId !== undefined)
          Object.defineProperty(config.owner, id, {
            value: run.draft.ownerId,
            enumerable: true,
            configurable: true,
            writable: true,
          });
      });
      run.status = 'complete';
      checkpoint = structuredClone(run);
      save();
      return { category, id, enabled: run.draft.entry.enabled !== false };
    } finally {
      clearInterval(heartbeat);
      const current = store.getSetupRun(run.id);
      // Release the lease with the last checkpointed draft.
      if (current?.lease === lease)
        store.saveSetupRun({ ...current, lease: null, leaseUntil: 0 }, lease);
    }
  }

  async #testTurn(
    entry: AgentInstanceConfig,
    ctx: ReturnType<EnvironmentChecks['context']>,
    outerSignal: AbortSignal,
    errorMessage: string,
  ) {
    const { registry, workspace, testAgent } = this.#deps;
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(60_000)]);
    if (testAgent) return testAgent(entry, ctx, signal);
    const runtime = join(workspace, 'runtime');
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const workdir = await mkdtemp(join(runtime, 'test-turn-'));
    try {
      const agent = await registry.agent(entry.kind)(entry, ctx);
      try {
        const events = agent.run(
          {
            context: [
              {
                content: 'Reply with the word pong.',
                source: 'message',
                trust: 'owner',
              },
            ],
            model: typeof entry.model === 'string' ? entry.model : 'default',
            thinking:
              typeof entry.thinking === 'string' ? entry.thinking : undefined,
            purpose: 'summary',
            sandbox: {
              workdir,
              writable: [],
              denyRead: [join(workspace, '.env'), join(workspace, 'agents')],
              network: 'none',
            },
            signal,
            tools: [],
            toolsDisabled: true,
            workdir,
          },
          {
            requestApproval: async () => false,
            supplements: (async function* () {})(),
          },
        );
        let response = false;
        for await (const event of events) {
          if (event.type === 'error') throw event.error;
          if (event.type === 'text.final' && event.text.trim()) response = true;
        }
        if (!response) throw new Error('Empty test response');
      } finally {
        await agent.stop?.();
      }
    } catch {
      throw new SetupError(errorMessage);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}
