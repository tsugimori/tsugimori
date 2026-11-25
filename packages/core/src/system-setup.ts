import type { CheckContext } from '@tsugimori/plugin-sdk';

import type { CheckReport } from './checks.ts';

const packageManagers = [
  { executable: 'apt-get', install: ['install', '-y'], sudo: true },
  { executable: 'dnf', install: ['install', '-y'], sudo: true },
  {
    executable: 'pacman',
    install: ['-S', '--needed', '--noconfirm'],
    sudo: true,
  },
  { executable: 'brew', install: ['install'], sudo: false },
] as const;

const packages = [
  { id: 'git', target: 'core', name: 'git' },
  { id: 'bubblewrap', target: 'exec/local-sandbox', name: 'bubblewrap' },
];

export async function systemInstallPlan(
  ctx: CheckContext,
  reports: CheckReport[],
) {
  const missing = packages.filter(
    ({ id, target, name }) =>
      (name !== 'bubblewrap' || ctx.platform === 'linux') &&
      reports.some(
        (item) =>
          item.id === id && item.target === target && item.status === 'fail',
      ),
  );
  if (!missing.length) return { missing: [] };
  for (const manager of packageManagers) {
    try {
      if (
        (await ctx.runCommand([manager.executable, '--version'])).exitCode !== 0
      )
        continue;
    } catch {
      continue;
    }
    const sudo = manager.sudo && process.getuid?.() !== 0;
    const prefix: [string, ...string[]] = sudo
      ? ['sudo', manager.executable]
      : [manager.executable];
    const command: [string, ...string[]] = [
      ...prefix,
      ...manager.install,
      ...missing.map(({ name }) => name),
    ];
    for (const entry of missing) {
      const item = reports.find(
        ({ id, target }) => id === entry.id && target === entry.target,
      );
      if (item)
        item.fix = {
          ...item.fix,
          command: [...prefix, ...manager.install, entry.name],
          sudo,
        };
    }
    return { command, missing };
  }
  return { missing };
}
