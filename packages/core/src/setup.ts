import type { Config } from '@tsugimori/config';
import type {
  AgentInstanceConfig,
  SetupContext,
  SetupDependencies,
  SetupStep,
} from '@tsugimori/plugin-sdk';
import type { SetupRun, Store } from '@tsugimori/storage';

import {
  loadConfig,
  loadSettings,
  updateSettings,
  writeCredential,
} from '@tsugimori/config';
import { SetupError } from '@tsugimori/plugin-sdk';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginRegistry } from './registry.ts';

import { untilAborted } from './abort.ts';
import { EnvironmentChecks, failureText, listenerConflicts } from './checks.ts';
import { systemMessages } from './system-messages.ts';

type Category = SetupRun['category'];

export interface SetupIO {
  cancelSignal?: AbortSignal;
  locale?: Config['locale'];
  measure?<T>(step: string, run: () => Promise<T>): Promise<T>;
  prompt(
    options: { secret?: boolean; text: string },
    progress: string,
  ): Promise<string>;
  secretInput?: 'terminal';
  show(text: string): Promise<void>;
  signal: AbortSignal;
  waitForDetach?(id: string): Promise<void>;
}

export class SetupCancelled extends SetupError {}

export type SetupRequest =
  | { category: Category; id?: string; kind: string; mode: 'add' }
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

function suggestedId(config: Config, category: Category, kind: string) {
  const used = new Set(entries(config, category).map(({ id }) => id));
  if (category === 'platform') {
    let id: string;
    do id = randomBytes(3).toString('hex');
    while (used.has(id));
    return id;
  }
  if (!used.has(kind)) return kind;
  let suffix = 2;
  while (used.has(`${kind}-${suffix}`)) suffix++;
  return `${kind}-${suffix}`;
}

function planText(
  steps: readonly Pick<SetupStep, 'asks' | 'localized' | 'saves' | 'title'>[],
  start: number,
  locale: Config['locale'],
  disableAgent: boolean,
  secretInput?: SetupIO['secretInput'],
) {
  const m = systemMessages(locale).setup;
  const lines = [m.plan];
  const saves = disableAgent ? [m.disablesAgent] : [];
  const privateInput = secretInput === 'terminal' ? m.hiddenInput : m.private;
  for (const [index, step] of steps.entries()) {
    if (index < start) continue;
    const title =
      locale === 'zh-TW'
        ? (step.localized?.[locale] ?? step.title)
        : step.title;
    const asks = step.asks?.map(
      ({ text, localized, secret }) =>
        (locale === 'zh-TW' ? (localized?.[locale] ?? text) : text) +
        (secret ? privateInput : ''),
    );
    lines.push(
      `${index + 1}. ${title} · ${asks?.join(' / ') || (asks ? m.automatic : m.unspecified)}`,
    );
    if (step.saves)
      saves.push(
        m.savesAfter(
          index + 1,
          locale === 'zh-TW'
            ? (step.saves.localized?.[locale] ?? step.saves.text)
            : step.saves.text,
        ),
      );
  }
  return [...lines, m.saving([...saves, m.savesConfig]), m.canCancel].join(
    '\n',
  );
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
    const { mode } = request;
    let config = await loadSettings(workspace, registry);
    const locale = io.locale ?? config.locale;
    const m = systemMessages(locale).setup;
    let id = request.id;
    if (id !== undefined && !validId.test(id))
      throw new SetupError(m.invalidId);
    const category = mode === 'login' ? 'agent' : request.category;
    const kind =
      mode === 'login'
        ? config.agents.find((item) => item.id === id)?.kind
        : request.kind;
    if (!kind) throw new SetupError(m.agentMissing);
    const plugin = registry.forInstance(category, kind);
    const steps = (plugin?.setupSteps ?? []).filter(
      (step) => mode === 'add' || step.id === 'login' || step.runOnLogin,
    );
    if (!steps.length)
      throw new SetupError(m.noSteps(mode === 'login', category, kind));
    const completion = mode === 'add' ? plugin?.setupComplete : undefined;
    const nameQuestion = id === undefined;
    const nameOffset = nameQuestion ? 1 : 0;
    const plan = [
      ...(nameQuestion
        ? [
            {
              title: m.nameTitle,
              asks: [
                {
                  text:
                    category === 'platform' && kind === 'line'
                      ? m.lineNameQuestion
                      : m.nameQuestion,
                },
              ],
            },
          ]
        : []),
      ...steps,
      ...(completion ? [completion] : []),
    ];
    const inputSignal = io.cancelSignal
      ? AbortSignal.any([io.signal, io.cancelSignal])
      : io.signal;
    const showPlan = (
      signal: AbortSignal,
      start: number,
      disableAgent: boolean,
    ) =>
      untilAborted(signal, () =>
        io.show(planText(plan, start, locale, disableAgent, io.secretInput)),
      );
    if (id === undefined) {
      try {
        await showPlan(inputSignal, 0, false);
        const suggested = suggestedId(config, category, kind);
        const progress = m.progress(1, plan.length);
        let reason: string | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const question = m.askName(suggested);
          const ask = () =>
            untilAborted(inputSignal, () =>
              io.prompt(
                {
                  text: m.stepMessage(
                    progress,
                    reason ? `${reason} ${question}` : question,
                  ),
                },
                progress,
              ),
            );
          const answer = (
            await (io.measure ? io.measure('instance-name', ask) : ask())
          ).trim();
          const candidate =
            !answer || answer === '-' || answer.toLowerCase() === 'default'
              ? suggested
              : answer;
          config = await loadSettings(workspace, registry);
          inputSignal.throwIfAborted();
          reason = !validId.test(candidate)
            ? m.invalidId
            : entries(config, category).some((item) => item.id === candidate)
              ? m.configuredId
              : undefined;
          if (!reason) {
            id = candidate;
            break;
          }
        }
        if (id === undefined) throw new SetupError(reason ?? m.invalidId);
      } catch (error) {
        if (io.cancelSignal?.aborted) throw new SetupCancelled(m.cancelled([]));
        throw error;
      }
    }
    const existing = entries(config, category).find((item) => item.id === id);
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
    const entry = { ...(existing ?? { id, kind, enabled: true }) };
    if (
      mode === 'login' &&
      entry.enabled === false &&
      previous?.status === 'cancelled' &&
      previous.draft.entry.kind === kind
    )
      entry.enabled = previous.draft.entry.enabled;
    const draft = { entry };
    const run = store.claimSetupRun(
      {
        id: key,
        category,
        mode,
        lease,
        leaseUntil: now + leaseLength,
        step: 0,
        status: 'pending',
        draft: structuredClone(draft),
      },
      now,
    );
    if (!run) throw new SetupError(m.busy);
    const lost = new AbortController();
    const signal = AbortSignal.any([
      io.signal,
      lost.signal,
      ...(io.cancelSignal ? [io.cancelSignal] : []),
    ]);
    const credentials = new Set<string>();
    let disabledId: string | undefined;
    let checkpoint = structuredClone(run);
    const save = () => {
      checkpoint.leaseUntil = Date.now() + leaseLength;
      if (!store.saveSetupRun(checkpoint, lease))
        throw new SetupError(m.leaseExpired);
    };
    const heartbeat = setInterval(() => {
      try {
        if (!signal.aborted) save();
      } catch (error) {
        lost.abort(error);
      }
    }, leaseLength / 3);
    heartbeat.unref();
    const snapshot = async () => {
      signal.throwIfAborted();
      const { config, env } = await loadConfig(workspace, registry);
      signal.throwIfAborted();
      const ctx = this.#checks.context(run.draft.entry, env, config);
      return {
        ...ctx,
        fetch: (input, init) => {
          const caller =
            init?.signal ??
            (input instanceof Request ? input.signal : undefined);
          return ctx.fetch(input, {
            ...init,
            signal: caller ? AbortSignal.any([signal, caller]) : signal,
          });
        },
        runCommand: (command, options) =>
          ctx.runCommand(command, {
            ...options,
            signal: options?.signal
              ? AbortSignal.any([signal, options.signal])
              : signal,
          }),
      } satisfies ReturnType<EnvironmentChecks['context']>;
    };
    const check = async () =>
      this.#checks.plugin(
        plugin,
        await snapshot(),
        `${category}/${id}`,
        category,
      );
    try {
      const disableAgent = mode === 'login' && existing?.enabled !== false;
      if (!nameQuestion) await showPlan(signal, run.step, disableAgent);
      if (mode === 'add' && !existing) {
        const current = await loadSettings(workspace, registry);
        if (entries(current, category).some((item) => item.id === id))
          throw new SetupError(m.configuredId);
      }
      if (mode === 'login') {
        if (disableAgent) {
          await updateSettings(workspace, registry, (config) => {
            signal.throwIfAborted();
            const target = config.agents.find(
              (agent) => agent.id === id && agent.kind === kind,
            );
            if (!target) throw new SetupError(m.changedAgent);
            target.enabled = false;
          });
          disabledId = id;
        }
        const waitForDetach = io.waitForDetach;
        if (waitForDetach) await untilAborted(signal, () => waitForDetach(id));
      }
      for (const step of steps.slice(run.step)) {
        const current = await snapshot();
        const progress = m.progress(nameOffset + run.step + 1, plan.length);
        const show = (text: string) =>
          untilAborted(signal, () => io.show(m.stepMessage(progress, text)));
        await show(
          (locale === 'zh-TW' && step.localized?.[locale]) || step.title,
        );
        let questionNumber = 0;
        const ctx: SetupContext = {
          ...current,
          get entry() {
            return run.draft.entry;
          },
          signal,
          locale,
          show,
          prompt: ({ questions, secret, text }) => {
            questionNumber++;
            const total = questions?.total ?? step.asks?.length ?? 0;
            const message =
              total > 1
                ? m.question(
                    progress,
                    questionNumber,
                    total,
                    text,
                    questions?.maximum,
                  )
                : m.stepMessage(progress, text);
            return untilAborted(signal, () =>
              io.prompt({ secret, text: message }, progress),
            );
          },
          recordCredential(name) {
            credentials.add(name);
          },
          writeConfig(patch) {
            signal.throwIfAborted();
            run.draft.entry = { ...run.draft.entry, ...patch.entry, id, kind };
            if (patch.ownerId !== undefined) run.draft.ownerId = patch.ownerId;
          },
          writeEnv: async (key, value) => {
            signal.throwIfAborted();
            await writeCredential(workspace, key, value);
            credentials.add(key);
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
        signal.throwIfAborted();
        run.step++;
        checkpoint = structuredClone(run);
        save();
      }
      const failures = failureText(await check(), locale);
      signal.throwIfAborted();
      if (failures) {
        run.step = 0;
        checkpoint = structuredClone(run);
        save();
        throw new SetupError(failures);
      }
      signal.throwIfAborted();
      await updateSettings(workspace, registry, (config) => {
        signal.throwIfAborted();
        const list = entries(config, category);
        const index = list.findIndex((item) => item.id === id);
        if (index < 0 && mode === 'add') list.push(run.draft.entry);
        else if (
          index >= 0 &&
          list[index]?.kind === kind &&
          (mode === 'login' || existing)
        )
          list[index] = run.draft.entry;
        else throw new SetupError(m.changedConfig);
        if (mode === 'add' && category === 'platform' && kind === 'line') {
          const conflicts = failureText(listenerConflicts(config), locale);
          if (conflicts) throw new SetupError(conflicts);
        }
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
      let summary: string | undefined;
      if (completion) {
        const progress = m.progress(plan.length, plan.length);
        const complete = async () =>
          completion.run({
            ...(await snapshot()),
            signal,
            locale,
            prompt: ({ secret, text }) =>
              untilAborted(signal, () =>
                io.prompt(
                  { secret, text: m.stepMessage(progress, text) },
                  progress,
                ),
              ),
          });
        summary = await (io.measure
          ? io.measure('setup-complete', complete)
          : complete());
      }
      return {
        category,
        id,
        enabled: run.draft.entry.enabled !== false,
        summary,
      };
    } catch (error) {
      if (run.status === 'complete') {
        if (io.cancelSignal?.aborted)
          throw new SetupCancelled(m.completeCancelled(id));
        throw new SetupError(m.completeFailed(id), { cause: error });
      }
      if (!io.cancelSignal?.aborted) throw error;
      // A cancelled login stays detached until a later login is confirmed.
      if (mode === 'login') draft.entry.enabled = run.draft.entry.enabled;
      if (
        !store.saveSetupRun(
          {
            ...run,
            draft,
            status: 'cancelled',
            step: 0,
            lease: null,
            leaseUntil: 0,
          },
          lease,
        )
      )
        throw new SetupError(m.leaseExpired);
      throw new SetupCancelled(m.cancelled([...credentials], disabledId));
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
            serviceTier: entry.serviceTier,
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
