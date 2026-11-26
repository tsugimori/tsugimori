export const webhookBaseUrlPattern = String.raw`^[Hh][Tt][Tt][Pp][Ss]://[^/\s\\?#@]+(?:/[^\s\\?#]*)?$`;

export function parseWebhookBaseUrl(value: unknown): URL | undefined {
  if (
    typeof value !== 'string' ||
    /[\s\x00-\x1f\x7f]/u.test(value) ||
    !new RegExp(webhookBaseUrlPattern).test(value)
  )
    return;
  return URL.parse(value) ?? undefined;
}
