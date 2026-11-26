import { WebhookProviderError } from '@tsugimori/plugin-sdk';

export const defaultCloudflareTokenEnv = 'CLOUDFLARE_API_TOKEN';
export const cloudflareId = /^[\da-f]{32}$/i;
export const cloudflareTunnelId =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function record(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function cloudflareToken(
  credential: (name: string) => string | undefined,
  name = defaultCloudflareTokenEnv,
) {
  return credential(name);
}

export function cloudflareApi(
  token: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
) {
  return async (
    path: string,
    method = 'GET',
    body?: object,
    signal?: AbortSignal,
  ) => {
    const timeout = AbortSignal.timeout(8_000);
    let response: Response;
    try {
      response = await fetch('https://api.cloudflare.com/client/v4' + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      signal?.throwIfAborted();
      throw new WebhookProviderError(
        'cloudflare_unreachable',
        'Could not reach the Cloudflare API.',
        '無法連線到 Cloudflare API。',
      );
    }
    if (method === 'DELETE' && response.status === 404) return {};
    let data: Record<string, unknown>;
    try {
      data = record(await response.json());
    } catch {
      throw apiError(response.status);
    }
    if (!response.ok || data.success !== true)
      throw apiError(response.status, data.errors, token);
    return data;
  };
}

function apiError(status: number, errors?: unknown, token?: string) {
  const first = record(Array.isArray(errors) ? errors[0] : undefined);
  const code =
    typeof first.code === 'number' ? String(first.code) : 'HTTP ' + status;
  const message =
    typeof first.message === 'string' && token
      ? first.message
          .split(token)
          .join('[redacted]')
          .replace(/\s+/gu, ' ')
          .slice(0, 200)
      : '';
  const detail = [code, message].filter(Boolean).join(' ');
  return new WebhookProviderError(
    'cloudflare_api',
    `Cloudflare API error (${detail}).`,
    `Cloudflare API 錯誤（${detail}）。`,
  );
}
