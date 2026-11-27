import { setTimeout as delay } from 'node:timers/promises';

import type { SavedLogin } from './credentials.ts';

import { credentialStore } from './credentials.ts';
import { json, mri, object, readJson, request, string } from './wire.ts';

const authority = 'https://login.microsoftonline.com';
const origin = 'https://teams.live.com';
const clientId = '8ec6bc83-69c8-4392-8f08-b3c986009232';
const scope =
  'service::api.fl.spaces.skype.com::MBI_SSL openid profile offline_access';

export interface ChatToken {
  account: string;
  expiresAt: number;
  region?: string;
  token: string;
}

export class LoginRequired extends Error {
  constructor() {
    super('Teams sign-in required');
  }
}

class RefreshRejected extends LoginRequired {}

function claims(token: unknown) {
  const payload = string(token)?.split('.')[1];
  if (!payload || payload.length > 32_768) return {};
  try {
    return json(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    // The OAuth access token can be opaque. Teams supplies identity in its Skype token.
    return {};
  }
}

function seconds(value: unknown, fallback: number) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : fallback;
}

function displayName(...values: unknown[]) {
  for (const value of values) {
    const name = string(value)
      ?.replace(/[\s\p{Cc}]+/gu, ' ')
      .trim()
      .slice(0, 200);
    if (name) return name;
  }
}

export function microsoftAuth(
  fetch: typeof globalThis.fetch,
  now = Date.now,
  wait = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }),
) {
  async function exchange(
    path: string,
    fields: Record<string, string>,
    signal: AbortSignal,
    isToken = true,
  ) {
    const send = async (includeOrigin: boolean) => {
      const response = await request(
        fetch,
        authority + path,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...(includeOrigin && { Origin: origin }),
          },
          body: new URLSearchParams({ client_id: clientId, ...fields }),
        },
        signal,
      );
      return { response, data: await readJson(response) };
    };
    let { response, data } = await send(false);
    if (
      isToken &&
      !response.ok &&
      string(data.error_description)?.includes('AADSTS9002327')
    )
      ({ response, data } = await send(true));
    const error = string(data.error);
    if (
      fields.grant_type === 'refresh_token' &&
      [
        'invalid_grant',
        'interaction_required',
        'login_required',
        'consent_required',
      ].some((code) => code === error)
    )
      throw new RefreshRejected();
    if (
      isToken &&
      fields.code &&
      (error === 'authorization_pending' || error === 'slow_down')
    )
      return data;
    if (!response.ok || error)
      throw new Error(`Microsoft sign-in failed (HTTP ${response.status})`);
    return data;
  }

  const refresh = (refreshToken: string, signal: AbortSignal) =>
    exchange(
      '/consumers/oauth2/v2.0/token',
      { grant_type: 'refresh_token', refresh_token: refreshToken, scope },
      signal,
    );

  async function authorize(
    grant: Awaited<ReturnType<typeof refresh>>,
    signal: AbortSignal,
  ) {
    const accessToken = string(grant.access_token);
    if (!accessToken)
      throw new Error('Microsoft did not return an access token');
    const response = await request(
      fetch,
      origin + '/api/auth/v1.0/authz/consumer',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Origin: origin,
          Accept: 'application/json; ver=1.0',
        },
      },
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new LoginRequired();
      throw new Error(`Teams authorization failed (HTTP ${response.status})`);
    }
    const result = await readJson(response);
    const tokens = object(result.tokens);
    const skype = tokens?.skypeToken ?? result.skypeToken;
    const skypeObject = object(skype);
    const token = string(skype) ?? string(skypeObject?.skypetoken);
    if (!token) throw new Error('Teams did not return a chat token');
    const identity = claims(token);
    const skypeId = string(identity.skypeid);
    const account = mri(
      skypeId?.startsWith('8:') ? skypeId : skypeId && `8:${skypeId}`,
    );
    if (!account)
      throw new Error('Teams did not identify the signed-in account');
    const expiry =
      now() +
      seconds(
        tokens?.expiresIn ?? skypeObject?.expiresIn ?? result.expiresIn,
        3600,
      ) *
        1000;
    const claimExpiry = Number(identity.exp) * 1000;
    const expiresAt = claimExpiry > 0 ? Math.min(expiry, claimExpiry) : expiry;
    if (expiresAt <= now() + 45_000)
      throw new Error('Teams returned an expiring chat token');
    const profile = object(result.profile);
    return {
      chat: {
        account,
        expiresAt,
        region: string(result.region),
        token,
      } satisfies ChatToken,
      name: displayName(
        profile?.displayName,
        result.displayName,
        identity.displayName,
        identity.displayname,
        identity.name,
        claims(grant.id_token).name,
        claims(accessToken).name,
      ),
    };
  }

  return {
    authorize,
    refresh,
    async signIn(
      show: (url: URL, code: string) => Promise<void>,
      signal: AbortSignal,
    ): Promise<SavedLogin> {
      const device = await exchange(
        '/common/oauth2/devicecode',
        { resource: 'https://api.spaces.skype.com' },
        signal,
        false,
      );
      const code = string(device.user_code);
      const deviceCode = string(device.device_code);
      const rawUrl =
        string(device.verification_uri) ?? string(device.verification_url);
      const url = rawUrl && URL.canParse(rawUrl) ? new URL(rawUrl) : undefined;
      if (
        !deviceCode ||
        !code ||
        !/^[\w-]{4,32}$/u.test(code) ||
        !url ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        ![
          'microsoft.com',
          'www.microsoft.com',
          'microsoftonline.com',
          'login.microsoftonline.com',
          'login.live.com',
        ].includes(url.hostname)
      )
        throw new Error('Microsoft returned invalid device sign-in details');
      const expiresAt = now() + seconds(device.expires_in, 900) * 1000;
      let interval = Math.max(5, seconds(device.interval, 5)) * 1000;
      await show(url, code);
      while (now() + interval < expiresAt) {
        await wait(interval, signal);
        const grant = await exchange(
          '/common/oauth2/token',
          {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            code: deviceCode,
          },
          signal,
        );
        if (grant.error === 'authorization_pending') continue;
        if (grant.error === 'slow_down') {
          interval += 5000;
          continue;
        }
        const initial = string(grant.refresh_token);
        if (!initial)
          throw new Error('Microsoft did not return a refresh token');
        const refreshed = await refresh(initial, signal);
        const { chat, name } = await authorize(refreshed, signal);
        const label =
          name ??
          displayName(
            claims(grant.id_token).name,
            claims(grant.access_token).name,
          ) ??
          (await profileName(chat, signal));
        return {
          account: chat.account,
          displayName: label,
          refreshToken: string(refreshed.refresh_token) ?? initial,
        };
      }
      throw new Error('Teams device code expired');
    },
  };

  async function profileName(chat: ChatToken, signal: AbortSignal) {
    const response = await request(
      fetch,
      'https://api.skype.com/users/self/profile',
      {
        headers: { 'X-Skypetoken': chat.token },
      },
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Teams did not return the signed-in display name');
    }
    const profile = await readJson(response);
    const fullName = [string(profile.firstname), string(profile.lastname)]
      .filter(Boolean)
      .join(' ');
    const name = displayName(
      profile.displayname,
      profile.displayName,
      fullName,
    );
    if (!name)
      throw new Error('Teams did not return the signed-in display name');
    return name;
  }
}

export function teamsSession(
  auth: ReturnType<typeof microsoftAuth>,
  credentials: ReturnType<typeof credentialStore>,
  account: string | undefined,
  signal: AbortSignal,
  now = Date.now,
) {
  let current: (ChatToken & { displayName: string }) | undefined;
  let refreshing: Promise<NonNullable<typeof current>> | undefined;
  let required = false;

  async function refresh() {
    const saved = await credentials.read();
    if (!saved || saved.account !== account) throw new LoginRequired();
    let grant;
    try {
      grant = await auth.refresh(saved.refreshToken, signal);
    } catch (error) {
      if (error instanceof RefreshRejected) {
        required = true;
        await credentials.clear();
      }
      throw error;
    }
    const refreshToken = string(grant.refresh_token);
    if (refreshToken && refreshToken !== saved.refreshToken)
      await credentials.save({ ...saved, refreshToken });
    const { chat } = await auth.authorize(grant, signal);
    if (chat.account !== account) throw new LoginRequired();
    return { ...chat, displayName: saved.displayName };
  }

  return {
    get required() {
      return required;
    },
    invalidate(token: string) {
      if (current?.token === token) current = undefined;
    },
    get() {
      signal.throwIfAborted();
      if (required) return Promise.reject(new LoginRequired());
      if (current && current.expiresAt - now() > 120_000)
        return Promise.resolve(current);
      refreshing ??= refresh()
        .then((token) => {
          current = token;
          return token;
        })
        .catch((error: unknown) => {
          if (error instanceof LoginRequired) required = true;
          throw error;
        })
        .finally(() => {
          refreshing = undefined;
        });
      return refreshing;
    },
    async stop() {
      // The adapter aborts its signal before waiting for any pending token rotation.
      await refreshing?.catch(() => undefined);
    },
  };
}
