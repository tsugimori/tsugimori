import type { CheckContext, CheckItem, SetupStep } from '@tsugimori/plugin-sdk';

import { platformHome, SetupError, yesNoChoices } from '@tsugimori/plugin-sdk';

import { microsoftAuth } from './auth.ts';
import { credentialName, credentialStore } from './credentials.ts';

export function loginCheck(id: string, signedIn = false): CheckItem {
  return {
    id: 'teams-personal-login',
    title: 'Teams Personal sign-in',
    detail: signedIn
      ? 'Teams Personal sign-in is saved.'
      : 'Teams Personal sign-in required.',
    login: signedIn ? 'signed-in' : 'required',
    status: signedIn ? 'ok' : 'fail',
    capabilities: ['platform'],
    fix: signedIn
      ? undefined
      : { hint: `Run /login ${id} from another platform or the terminal.` },
    localized: {
      'zh-TW': {
        title: 'Teams 個人版登入',
        detail: signedIn
          ? 'Teams 個人版登入已儲存。'
          : '需要登入 Teams 個人版。',
        hint: signedIn
          ? 'Teams 個人版登入已儲存。'
          : `請從另一個平台或終端機執行 /login ${id}。`,
      },
    },
  };
}

export async function checks({ entry, workspace }: CheckContext) {
  const store = credentialStore(workspace, platformHome(workspace, entry.id));
  try {
    const saved = await store.read();
    return [
      loginCheck(
        entry.id,
        Boolean(saved && saved.account === entry.options?.accountMri),
      ),
    ];
  } catch {
    return [
      {
        ...loginCheck(entry.id),
        detail:
          'The saved Teams Personal login could not be read. Sign in again.',
      },
    ];
  }
}

export function teamsPersonalLogin(wait?: Parameters<typeof microsoftAuth>[2]) {
  return {
    id: 'login',
    title: 'Sign in to Teams Personal',
    localized: { 'zh-TW': '登入 Teams 個人版' },
    asks: [
      {
        text: 'Confirm the Teams Personal account',
        localized: { 'zh-TW': '確認 Teams 個人版帳號' },
      },
    ],
    saves: {
      text: 'Teams Personal sign-in in the platform home',
      localized: { 'zh-TW': '將 Teams 個人版登入資料儲存到平台主目錄' },
    },
    async run(ctx) {
      const { entry, fetch, locale, signal, workspace } = ctx;
      const zh = locale === 'zh-TW';
      const signedIn = await microsoftAuth(fetch, Date.now, wait).signIn(
        (url, code) =>
          ctx.show(
            zh
              ? `請開啟 ${url.href} 並輸入代碼 ${code}。`
              : `Open ${url.href} and enter code ${code}.`,
          ),
        signal,
      );
      const existing = entry.options?.accountMri;
      const switching =
        typeof existing === 'string' && existing !== signedIn.account;
      const identity = `${signedIn.displayName} (${signedIn.account})`;
      const answer = await ctx.prompt({
        choices: yesNoChoices,
        text: switching
          ? zh
            ? `已登入 ${identity}。要將 Teams 個人版從 ${existing} 改為此帳號嗎？`
            : `Signed in as ${identity}. Switch Teams Personal from ${existing} to this account?`
          : zh
            ? `已登入 ${identity}。要確認此 Teams 個人版帳號嗎？`
            : `Signed in as ${identity}. Confirm this Teams Personal account?`,
      });
      if (answer.trim().toLowerCase() !== 'yes')
        throw new SetupError(
          zh
            ? '未確認 Teams 個人版帳號。請重新執行設定以登入。'
            : 'Teams Personal account was declined. Run setup again to sign in.',
        );
      signal.throwIfAborted();
      const store = credentialStore(
        workspace,
        platformHome(workspace, entry.id),
      );
      await store.save(signedIn);
      ctx.recordCredential(credentialName);
      ctx.writeConfig({
        entry: { options: { ...entry.options, accountMri: signedIn.account } },
      });
    },
  } satisfies SetupStep;
}
