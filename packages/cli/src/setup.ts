import type { CheckReport, PluginRegistry, SetupIO } from '@tsugimori/core';
import type { SetupDependencies } from '@tsugimori/core';

import { loadConfig, updateSettings } from '@tsugimori/config';
import { EnvironmentChecks, systemInstallPlan } from '@tsugimori/core';
import { SetupError } from '@tsugimori/core';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export function doctorText(items: CheckReport[], locale?: 'en' | 'zh-TW') {
  return items
    .map(({ detail, fix, localized, status, target, title }) => {
      const translation = locale === 'zh-TW' ? localized?.[locale] : undefined;
      return [
        `[${status.toUpperCase()}] ${target} · ${translation?.title ?? title}: ${translation?.detail ?? detail}`,
        ...(fix?.command ? [`  ${fix.command.join(' ')}`] : []),
        ...(fix?.hint ? [`  ${translation?.hint ?? fix.hint}`] : []),
      ].join('\n');
    })
    .join('\n');
}

export async function runSetup(
  deps: SetupDependencies,
  workspace: string,
  registry: PluginRegistry,
  {
    yes,
    upgrade,
    print,
  }: { print(text: string): void; upgrade: boolean; yes: boolean },
) {
  const checks = new EnvironmentChecks(deps, workspace);
  const snapshot = await loadConfig(workspace, registry);
  const ctx = checks.context({ id: 'core', kind: 'core' }, snapshot.env);
  const reports = [
    ...(await checks.core(snapshot)),
    ...(await checks.features(snapshot, registry)),
  ];
  const { command, missing } = await systemInstallPlan(ctx, reports);
  let failed = false;
  if (command) {
    print(command.join(' '));
    if (yes) {
      try {
        failed =
          (
            await ctx.runCommand(command, {
              interactive: true,
              timeoutMs: 30 * 60_000,
            })
          ).exitCode !== 0;
      } catch {
        failed = true;
      }
      if (failed) print('System package installation failed.');
    }
  } else if (missing.length) {
    print(
      `Install these packages with your system package manager: ${missing.map(({ name }) => name).join(', ')}.`,
    );
    failed = yes;
  }
  for (const item of reports) {
    if (
      item.status === 'fail' &&
      !missing.some(
        ({ id, target }) => id === item.id && target === item.target,
      )
    )
      print(doctorText([item]));
  }
  for (const agent of snapshot.config.agents) {
    if (agent.enabled === false) continue;
    const plugin = registry.forInstance('agent', agent.kind);
    if (!plugin?.install) {
      const items = await checks.plugin(
        plugin,
        checks.context(agent, snapshot.env),
        `agent/${agent.id}`,
        'agent',
      );
      if (items.length) print(doctorText(items, snapshot.config.locale));
      continue;
    }
    try {
      const version = await plugin.install(
        checks.context(agent, snapshot.env),
        { upgrade },
      );
      if (!version) continue;
      if (agent.version !== version)
        await updateSettings(workspace, registry, (config) => {
          const current = config.agents.find(
            ({ id, kind }) => id === agent.id && kind === agent.kind,
          );
          if (!current || current.version !== agent.version)
            throw new SetupError(
              'The agent configuration changed during installation.',
            );
          current.version = version;
        });
      print(`${agent.id} CLI ready at version ${version}.`);
    } catch (error) {
      failed = true;
      print(
        `${agent.id}: ${error instanceof SetupError ? error.message : 'CLI installation failed.'}`,
      );
    }
  }
  return failed ? 1 : 0;
}

export function terminalIO() {
  const abort = new AbortController();
  const cancel = new AbortController();
  const signal = AbortSignal.any([abort.signal, cancel.signal]);
  let hidden = false;
  const isTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (hidden) callback();
      else process.stdout.write(chunk, callback);
    },
  });
  const terminal = createInterface({
    input: process.stdin,
    output,
    terminal: isTerminal,
  });
  terminal.on('SIGINT', () => cancel.abort());
  const handleCancel = (text: string) => {
    if (text.trim().toLowerCase() === '/cancel') cancel.abort();
  };
  terminal.on('line', handleCancel);
  terminal.once('close', () => abort.abort());
  return {
    signal: abort.signal,
    cancelSignal: cancel.signal,
    secretInput: 'terminal',
    show: async (text) => {
      console.log(text);
    },
    async prompt({ secret, text }) {
      if (secret && !isTerminal)
        throw new SetupError('Secret entry requires an interactive terminal.');
      hidden = secret === true;
      if (hidden) process.stdout.write(text + ' ');
      try {
        const answer = await terminal.question(hidden ? '' : text + ' ', {
          signal,
        });
        handleCancel(answer);
        signal.throwIfAborted();
        return answer;
      } finally {
        if (hidden) process.stdout.write('\n');
        hidden = false;
      }
    },
    close: () => terminal.close(),
  } satisfies SetupIO & { close(): void };
}
