import type { Config } from '@tsugimori/config';
import type {
  AgentInstanceConfig,
  SetupContext,
  SetupDependencies,
  SetupPrompt,
  SetupStep,
  WebhookConfig,
  WebhookIngress,
  WebhookStatus,
} from '@tsugimori/plugin-sdk';
import type { SetupRun, Store } from '@tsugimori/storage';

import {
  configuredOwner,
  loadConfig,
  loadSettings,
  updateSettings,
  webhookListen,
  writeCredential,
} from '@tsugimori/config';
import { platformHomes, SetupError } from '@tsugimori/plugin-sdk';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { PluginRegistry } from './registry.ts';
import type { Webhooks } from './webhooks.ts';

import { untilAborted } from './abort.ts';
import { EnvironmentChecks, failureText, listenerConflicts } from './checks.ts';
import { systemMessages } from './system-messages.ts';

type Category = SetupRun['category'];

export interface SetupIO {
  cancelSignal?: AbortSignal;
  locale?: Config['locale'];
  measure?<T>(step: string, run: () => Promise<T>): Promise<T>;
  originAdapterId?: string;
  prompt(options: SetupPrompt, progress: string): Promise<string>;
  secretInput?: 'terminal';
  show(text: string): Promise<void>;
  signal: AbortSignal;
  waitForAttach?(id: string): Promise<void>;
  waitForDetach?(id: string, category: 'agent' | 'platform'): Promise<void>;
  webhookStatus?(): Promise<WebhookStatus>;
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
  webhookIngress?: WebhookIngress;
  webhooks?: Webhooks;
  workspace: string;
}

function entries(config: Config, category: Category) {
  return category === 'agent'
    ? config.agents
    : category === 'platform'
      ? config.platforms
      : [];
}

export function loginTarget(
  config: Config,
  id: string,
  locale: Config['locale'],
) {
  const agent = config.agents.find((entry) => entry.id === id);
  const platform = config.platforms.find((entry) => entry.id === id);
  const m = systemMessages(locale).setup;
  if (!validId.test(id)) throw new SetupError(m.invalidId);
  if (agent && platform) throw new SetupError(m.ambiguousLogin);
  if (agent) return { category: 'agent' as const, kind: agent.kind };
  if (platform) return { category: 'platform' as const, kind: platform.kind };
  throw new SetupError(m.loginMissing);
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
  disabledCategory: 'agent' | 'platform' | undefined,
  secretInput?: SetupIO['secretInput'],
) {
  const m = systemMessages(locale).setup;
  const lines = [m.plan];
  const saves = disabledCategory ? [m.disablesForLogin(disabledCategory)] : [];
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
    this.#checks = new EnvironmentChecks(
      deps,
      deps.workspace,
      deps.webhooks ?? deps.webhookIngress,
    );
  }

  async run(request: SetupRequest, io: SetupIO) {
    const { store, registry, workspace, webhooks } = this.#deps;
    const { mode } = request;
    let config = await loadSettings(workspace, registry);
    const locale = io.locale ?? config.locale;
    const m = systemMessages(locale).setup;
    const prompt: SetupIO['prompt'] = (options, progress) => {
      const { choices, secret, text } = options;
      const values = systemMessages(locale).choices.values;
      return io.prompt(
        io.secretInput === 'terminal' && !secret && choices?.length
          ? {
              ...options,
              text: `${text}\n${values(choices.map(({ value }) => value).join(' / '))}`,
            }
          : options,
        progress,
      );
    };
    let id = request.id;
    if (id !== undefined && !validId.test(id))
      throw new SetupError(m.invalidId);
    const { category, kind } =
      mode === 'login' ? loginTarget(config, request.id, locale) : request;
    const webhook = category === 'webhook';
    if (webhook) id = 'webhooks';
    const provider = webhook ? webhooks?.provider(kind) : undefined;
    const plugin = webhook ? undefined : registry.forInstance(category, kind);
    const steps = (provider?.setupSteps ?? plugin?.setupSteps ?? []).filter(
      (step) => mode === 'add' || step.id === 'login' || step.runOnLogin,
    );
    if (!steps.length)
      throw new SetupError(m.noSteps(mode === 'login', category, kind));
    if (
      mode === 'login' &&
      category === 'platform' &&
      id === io.originAdapterId
    )
      throw new SetupError(m.loginFromAnotherPlatform);
    const requiresWebhook =
      category === 'platform' && registry.requiresWebhook(kind);
    const webhookMessage = systemMessages(locale).webhook;
    const requireWebhook = async () => {
      if (!requiresWebhook) return;
      const status = webhooks?.status() ??
        (await io.webhookStatus?.()) ?? { state: 'unconfigured' };
      if (status.state !== 'ok') {
        const reason = status.reason
          ? webhookMessage.failed(status.reason)
          : webhookMessage.states[status.state];
        throw new SetupError(
          webhookMessage.blocked(kind === 'line' ? 'LINE' : kind, reason),
        );
      }
    };
    await requireWebhook();
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
      ...(webhook ? [{ title: webhookMessage.verify, asks: [] }] : []),
    ];
    const inputSignal = io.cancelSignal
      ? AbortSignal.any([io.signal, io.cancelSignal])
      : io.signal;
    const showPlan = (
      signal: AbortSignal,
      start: number,
      disabledCategory: 'agent' | 'platform' | undefined,
    ) =>
      untilAborted(signal, () =>
        io.show(
          planText(plan, start, locale, disabledCategory, io.secretInput),
        ),
      );
    if (id === undefined) {
      try {
        await showPlan(inputSignal, 0, undefined);
        const suggested = suggestedId(config, category, kind);
        const progress = m.progress(1, plan.length);
        let reason: string | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const question = m.askName(suggested);
          const ask = () =>
            untilAborted(inputSignal, () =>
              prompt(
                {
                  choices: [{ value: 'default', label: suggested }],
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
    if (
      !webhook &&
      previous?.status === 'pending' &&
      previous.draft.entry.kind !== kind
    )
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
    const draft = {
      entry,
      ...(webhook
        ? {
            webhooks: {
              ...(config.webhooks?.provider === kind
                ? config.webhooks
                : undefined),
              provider: kind as WebhookConfig['provider'],
              listen: webhookListen(config),
            },
          }
        : {}),
    };
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
      if (webhook) ctx.webhooks = run.draft.webhooks;
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
      webhook
        ? []
        : (
            await this.#checks.plugin(
              plugin,
              await snapshot(),
              `${category}/${id}`,
              category,
            )
          ).filter(
            (item) =>
              !requiresWebhook || !item.capabilities?.includes('webhook'),
          );
    try {
      const disabledCategory =
        mode === 'login' &&
        category !== 'webhook' &&
        existing?.enabled !== false
          ? category
          : undefined;
      if (!nameQuestion) await showPlan(signal, run.step, disabledCategory);
      if (mode === 'add' && !existing) {
        const current = await loadSettings(workspace, registry);
        if (entries(current, category).some((item) => item.id === id))
          throw new SetupError(m.configuredId);
      }
      if (mode === 'login' && category !== 'webhook') {
        if (disabledCategory) {
          await updateSettings(workspace, registry, (config) => {
            signal.throwIfAborted();
            const current = loginTarget(config, id, locale);
            const target = entries(config, category).find(
              (entry) => entry.id === id,
            );
            if (
              !target ||
              current.category !== category ||
              current.kind !== kind
            )
              throw new SetupError(m.changedConfig);
            target.enabled = false;
          });
          disabledId = id;
        }
        const waitForDetach = io.waitForDetach;
        if (waitForDetach)
          await untilAborted(signal, () => waitForDetach(id, category));
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
          get webhooks() {
            return webhook ? run.draft.webhooks : current.webhooks;
          },
          signal,
          locale,
          show,
          prompt: ({ choices, questions, secret, text }) => {
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
              prompt(
                {
                  choices: secret ? undefined : choices,
                  secret,
                  text: message,
                },
                progress,
              ),
            );
          },
          recordCredential(name) {
            credentials.add(name);
          },
          writeConfig(patch) {
            signal.throwIfAborted();
            run.draft.entry = { ...run.draft.entry, ...patch.entry, id, kind };
            if (webhook && run.draft.webhooks && patch.webhooks)
              run.draft.webhooks = { ...run.draft.webhooks, ...patch.webhooks };
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
      if (webhook && webhooks && run.draft.webhooks) {
        const initial = await loadConfig(workspace, registry);
        const candidate = {
          ...run.draft.webhooks,
          listen: webhookListen(initial.config),
        };
        const checkAddress = (config: Config) => {
          const conflicts = failureText(listenerConflicts(config), locale);
          if (conflicts) throw new SetupError(conflicts);
        };
        checkAddress({ ...initial.config, webhooks: candidate });
        const verify = () =>
          webhooks.verifySetup(candidate, initial, signal, (verified) =>
            updateSettings(workspace, registry, (current) => {
              signal.throwIfAborted();
              if (
                !isDeepStrictEqual(current.webhooks, initial.config.webhooks) ||
                webhookListen(current) !== verified.listen
              )
                throw new SetupError(webhookMessage.changed);
              current.webhooks = verified;
              checkAddress(current);
            }),
          );
        const progress = m.progress(plan.length, plan.length);
        await untilAborted(signal, () =>
          io.show(m.stepMessage(progress, webhookMessage.verify)),
        );
        const status = await (io.measure
          ? io.measure('webhook-check', verify)
          : verify());
        signal.throwIfAborted();
        if (status.state !== 'ok') {
          run.step = 0;
          run.draft = structuredClone(draft);
          run.status = 'cancelled';
          checkpoint = structuredClone(run);
          save();
          throw new SetupError(
            status.reason ?? webhookMessage.states[status.state],
          );
        }
        run.status = 'complete';
        checkpoint = structuredClone(run);
        save();
        return { category, id, enabled: true, summary: webhookMessage.saved };
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
      await requireWebhook();
      let ownedPlatform = false;
      await updateSettings(workspace, registry, (config) => {
        signal.throwIfAborted();
        if (mode === 'login') {
          const current = loginTarget(config, id, locale);
          if (current.category !== category || current.kind !== kind)
            throw new SetupError(m.changedConfig);
        }
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
        if (run.draft.ownerId !== undefined)
          Object.defineProperty(config.owner, id, {
            value: run.draft.ownerId,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        ownedPlatform =
          category === 'platform' &&
          configuredOwner(config, id, kind) !== undefined;
      });
      if (ownedPlatform) store.deletePairingCode(id);
      run.status = 'complete';
      checkpoint = structuredClone(run);
      save();
      let summary: string | undefined;
      if (completion) {
        if (requiresWebhook && io.waitForAttach)
          await untilAborted(signal, () => io.waitForAttach!(id));
        const progress = m.progress(plan.length, plan.length);
        const complete = async () =>
          completion.run({
            ...(await snapshot()),
            signal,
            locale,
            prompt: ({ choices, secret, text }) =>
              untilAborted(signal, () =>
                prompt(
                  {
                    choices: secret ? undefined : choices,
                    secret,
                    text: m.stepMessage(progress, text),
                  },
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
        summaryOnly: requiresWebhook && !!completion,
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
              denyRead: [
                join(workspace, '.env'),
                join(workspace, 'agents'),
                platformHomes(workspace),
              ],
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
