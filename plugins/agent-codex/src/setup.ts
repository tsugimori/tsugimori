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
import { codexCompactionSupport, compactionMode } from './compaction.ts';
import { codexBinary, hasCodexCodeModeHost, pinnedVersion } from './install.ts';

const loginMessages = {
  en: {
    open: (url: string) => `Open ${url} and sign in to ChatGPT.`,
    code: (code: string) => `Enter the one-time device code ${code}.`,
    incomplete: 'Codex device login did not complete.',
    missingAccount: 'Codex did not report a ChatGPT account to confirm.',
    confirm: (email: string) =>
      `Codex signed in as ${email}. Reply yes to confirm this account.`,
    unconfirmed:
      'The Codex account was not confirmed. Rerun the command to sign in again.',
  },
  'zh-TW': {
    installFailed:
      '無法安裝 Codex CLI。請檢查網路連線，並在工作區執行 tsugimori setup 查看詳細資訊。',
    open: (url: string) => `請開啟 ${url} 並登入 ChatGPT。`,
    code: (code: string) => `請輸入一次性裝置驗證碼 ${code}。`,
    incomplete: 'Codex 裝置登入未完成。',
    missingAccount: 'Codex 未回報可供確認的 ChatGPT 帳號。',
    confirm: (email: string) =>
      `Codex 已使用 ${email} 登入。請回覆 yes 確認此帳號。`,
    unconfirmed: 'Codex 帳號尚未確認。請重新執行指令登入。',
  },
};

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

const compactionMessages = {
  async: {
    en: 'Async compaction is active.',
    'zh-TW': '已啟用非同步壓縮。',
  },
  'post-turn': {
    en: 'Post-turn compaction is active.',
    'zh-TW': '已啟用回合後壓縮。',
  },
  unsupported: {
    en: 'This Codex CLI does not support configurable compaction timing.',
    'zh-TW': '此版本的 Codex CLI 不支援設定壓縮時機。',
  },
};

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
        localized: {
          'zh-TW': {
            title: cli.title,
            hint: '請執行 tsugimori setup --upgrade。',
          },
        },
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
        localized: {
          'zh-TW': {
            title: cli.title,
            hint: '請在此工作區執行 tsugimori setup。',
          },
        },
        capabilities,
      },
    ];
  const login = await loggedIn(ctx);
  const support = await codexCompactionSupport(async (args) => {
    try {
      const result = await ctx.runCommand([argv, ...args], options);
      if (result.exitCode === 0) return result.stdout;
    } catch {
      // Report unsupported timing without exposing CLI output.
    }
  });
  const mode = compactionMode(
    support,
    ctx.entry.options?.asyncCompaction === true,
  );
  const compaction = compactionMessages[mode];
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
      localized: {
        'zh-TW': {
          title: 'Codex 登入',
          hint: `請主人執行 /login ${ctx.entry.id}。`,
        },
      },
      capabilities,
    },
    {
      id: 'codex-compaction',
      title: 'Codex context compaction',
      status: mode === 'unsupported' ? 'warn' : 'ok',
      detail: compaction.en,
      fix:
        mode === 'unsupported'
          ? { hint: 'Upgrade the configured Codex CLI.' }
          : undefined,
      localized: {
        'zh-TW': {
          title: 'Codex 上下文壓縮',
          detail: compaction['zh-TW'],
          hint: '請更新設定使用的 Codex CLI。',
        },
      },
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
  const m = loginMessages[ctx.locale ?? 'en'];
  const check = await ctx.runCheck('codex-cli');
  if (check.status !== 'ok')
    throw new SetupError(
      (ctx.locale === 'zh-TW' && check.localized?.[ctx.locale]?.hint) ||
        check.detail,
    );
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
          await ctx.show(m.open(line));
        } else if (
          sawUrl &&
          !sawCode &&
          /^[A-Z0-9]{3,6}-[A-Z0-9]{3,6}$/.test(line)
        ) {
          sawCode = true;
          await ctx.show(m.code(line));
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
  if (result.exitCode === 0)
    ctx.recordCredential(
      ctx.locale === 'zh-TW'
        ? 'Codex 裝置登入憑證（代理程式主目錄）'
        : 'Codex device login (agent home)',
    );
  if (result.exitCode !== 0 || !(await loggedIn(ctx, ctx.signal)))
    throw new SetupError(m.incomplete);
  const email = await codexAccount(ctx);
  if (
    typeof email !== 'string' ||
    !/^[^\s@]{1,100}@[A-Za-z0-9.-]{1,100}\.[A-Za-z]{2,24}$/.test(email)
  )
    throw new SetupError(m.missingAccount);
  const answer = await ctx.prompt({
    text: m.confirm(email),
  });
  if (answer.trim().toLowerCase() !== 'yes')
    throw new SetupError(m.unconfirmed);
}

export const codexSetup: SetupStep[] = [
  {
    id: 'install',
    title: 'Install the pinned Codex CLI',
    localized: { 'zh-TW': '安裝指定版本的 Codex CLI' },
    asks: [],
    saves: {
      text: 'installs the CLI into the workspace runtime',
      localized: { 'zh-TW': '將 CLI 安裝至工作區的 runtime 目錄' },
    },
    async run(ctx) {
      try {
        await ctx.install();
      } catch (error) {
        if (ctx.locale !== 'zh-TW' || ctx.signal.aborted) throw error;
        throw new SetupError(loginMessages[ctx.locale].installFailed, {
          cause: error,
        });
      }
    },
  },
  {
    id: 'login',
    title: 'Sign in to Codex',
    localized: { 'zh-TW': '登入 Codex' },
    asks: [
      {
        text: 'Use the device code in your browser, then confirm the account (yes/no)',
        localized: { 'zh-TW': '在瀏覽器輸入裝置驗證碼，再確認帳號（yes/no）' },
      },
    ],
    saves: {
      text: 'saves device sign-in in the agent home before account confirmation',
      localized: { 'zh-TW': '在確認帳號前將裝置登入憑證儲存到代理程式主目錄' },
    },
    run: login,
  },
  {
    id: 'test',
    title: 'Run a Codex test turn',
    asks: [],
    localized: { 'zh-TW': '執行 Codex 測試回合' },
    run: (ctx) => ctx.testTurn(),
  },
];
