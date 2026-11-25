import type {
  CheckContext,
  CheckItem,
  PluginInstanceConfig,
  SetupContext,
  SetupStep,
} from '@tsugimori/plugin-sdk';

import { agentHome, SetupError } from '@tsugimori/plugin-sdk';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { asRecord } from './app-server.ts';
import { codexBinary, hasCodexCodeModeHost, pinnedVersion } from './install.ts';

export function codexLocation(
  entry: PluginInstanceConfig,
  workspace: string,
  platform = process.platform,
) {
  const home = entry.options?.codexHome;
  const explicit = entry.options?.command;
  const version = pinnedVersion(entry);
  return {
    command: version
      ? codexBinary(workspace, version, platform)
      : typeof explicit === 'string'
        ? /[/\\]/.test(explicit)
          ? resolve(workspace, explicit)
          : explicit
        : 'codex',
    codexHome: agentHome(
      workspace,
      entry.id,
      typeof home === 'string' ? home : undefined,
    ),
  };
}

export function codexEnvironment(home?: string) {
  const names = [
    'HOME',
    'PATH',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'SystemRoot',
    'USERPROFILE',
    'CODEX_HOME',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_BASE_URL',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ] as const;
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  if (home) env.CODEX_HOME = home;
  return env;
}

function authContext(ctx: CheckContext) {
  const { command, codexHome } = codexLocation(
    ctx.entry,
    ctx.workspace,
    ctx.platform,
  );
  return {
    argv: command,
    cwd: ctx.workspace,
    env: { ...codexEnvironment(codexHome), NO_COLOR: '1' },
  };
}

async function loggedIn(ctx: CheckContext, signal?: AbortSignal) {
  const { argv, ...options } = authContext(ctx);
  try {
    return (
      (await ctx.runCommand([argv, 'login', 'status'], { ...options, signal }))
        .exitCode === 0
    );
  } catch {
    return false;
  }
}

export async function codexChecks(ctx: CheckContext): Promise<CheckItem[]> {
  const { argv, ...options } = authContext(ctx);
  const pinned = pinnedVersion(ctx.entry);
  const capabilities = ['agent'];
  const cli = { id: 'codex-cli', title: 'Codex CLI' };
  if (pinned && !(await hasCodexCodeModeHost(argv, ctx.platform)))
    return [
      {
        ...cli,
        status: 'fail',
        detail:
          'The managed Codex CLI is missing its codex-code-mode-host helper.',
        fix: { hint: 'Run tsugimori setup --upgrade' },
        capabilities,
      },
    ];
  let available = false;
  try {
    const result = await ctx.runCommand([argv, '--version'], options);
    available =
      result.exitCode === 0 &&
      (!pinned || result.stdout.trim().split(/\s+/).at(-1) === pinned);
  } catch {
    // Command output and errors are kept out of the report.
  }
  if (!available)
    return [
      {
        ...cli,
        status: 'fail',
        detail:
          'The configured Codex executable or pinned version is unavailable.',
        fix: { hint: 'Run tsugimori setup for this workspace.' },
        capabilities,
      },
    ];
  const login = await loggedIn(ctx);
  return [
    { ...cli, status: 'ok', detail: 'The Codex CLI is available.' },
    {
      id: 'codex-login',
      title: 'Codex login',
      status: login ? 'ok' : 'fail',
      detail: login
        ? 'Codex reports an active login.'
        : 'Codex has no login in this agent’s home.',
      fix: login
        ? undefined
        : { hint: `Ask the owner to run /login ${ctx.entry.id}.` },
      capabilities,
    },
  ];
}

async function codexAccount(ctx: SetupContext) {
  const { argv, ...options } = authContext(ctx);
  let email: unknown;
  const init = {
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'tsugimori', version: '0.0.0' } },
  };
  const read = {
    id: 2,
    method: 'account/read',
    params: { refreshToken: false },
  };
  await ctx.runCommand([argv, 'app-server', '--listen', 'stdio://'], {
    ...options,
    signal: ctx.signal,
    input: JSON.stringify(init) + '\n',
    keepInputOpen: true,
    onLine(line, io) {
      let frame;
      try {
        frame = asRecord(JSON.parse(line));
      } catch {
        return;
      }
      if (frame.id === 1 && frame.result)
        io.write(
          JSON.stringify({ method: 'initialized' }) +
            '\n' +
            JSON.stringify(read) +
            '\n',
        );
      if (frame.id === 2) {
        const account = asRecord(asRecord(frame.result).account);
        if (account.type === 'chatgpt') email = account.email;
        io.close();
      }
    },
  });
  return email;
}

async function login(ctx: SetupContext) {
  const check = await ctx.runCheck('codex-cli');
  if (check.status !== 'ok') throw new SetupError(check.detail);
  await mkdir(codexLocation(ctx.entry, ctx.workspace, ctx.platform).codexHome, {
    recursive: true,
    mode: 0o700,
  });
  const { argv, ...options } = authContext(ctx);
  const poll = new AbortController();
  const signal = AbortSignal.any([ctx.signal, poll.signal]);
  let sawUrl = false;
  let sawCode = false;
  const device = ctx
    .runCommand([argv, 'login', '--device-auth'], {
      ...options,
      signal: ctx.signal,
      timeoutMs: 16 * 60_000,
      async onLine(raw) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (
          !sawUrl &&
          /^https:\/\/auth\.openai\.com\/codex\/device$/.test(line)
        ) {
          sawUrl = true;
          await ctx.show(`Open ${line} and sign in to ChatGPT.`);
        } else if (
          sawUrl &&
          !sawCode &&
          /^[A-Z0-9]{3,6}-[A-Z0-9]{3,6}$/.test(line)
        ) {
          sawCode = true;
          await ctx.show(`Enter the one-time device code ${line}.`);
        }
      },
    })
    .finally(() => poll.abort());
  const status = async () => {
    try {
      while (!signal.aborted) {
        await delay(2_000, undefined, { signal });
        if (sawCode) await loggedIn(ctx, signal);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  };
  const [result] = await Promise.all([device, status()]);
  if (result.exitCode !== 0 || !(await loggedIn(ctx, ctx.signal)))
    throw new SetupError('Codex device login did not complete.');
  const email = await codexAccount(ctx);
  if (
    typeof email !== 'string' ||
    !/^[^\s@]{1,100}@[A-Za-z0-9.-]{1,100}\.[A-Za-z]{2,24}$/.test(email)
  )
    throw new SetupError('Codex did not report a ChatGPT account to confirm.');
  const answer = await ctx.prompt({
    text: `Codex signed in as ${email}. Reply yes to confirm this account.`,
  });
  if (answer.trim().toLowerCase() !== 'yes')
    throw new SetupError(
      'The Codex account was not confirmed. Rerun the command to sign in again.',
    );
}

export const codexSetup: SetupStep[] = [
  {
    id: 'install',
    title: 'Install the pinned Codex CLI',
    run: (ctx) => ctx.install(),
  },
  { id: 'login', title: 'Sign in to Codex', run: login },
  { id: 'test', title: 'Run a Codex test turn', run: (ctx) => ctx.testTurn() },
];
