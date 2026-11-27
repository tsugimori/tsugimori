import type { AccessRole, VerifyAccess } from '@tsugimori/plugin-sdk';
import type { KeyObject } from 'node:crypto';

import { createPublicKey, verify } from 'node:crypto';

const maxAge = 300_000;
const refreshCooldown = 5_000;

interface KeyCache {
  fetchedAt: number;
  keys: ReadonlyMap<string, KeyObject>;
  refresh?: Promise<void>;
  retryAfter: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function segment(encoded: string | undefined) {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new Error('Invalid JWT segment');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded)
    throw new Error('Invalid JWT encoding');
  return bytes;
}

function decode(encoded: string | undefined) {
  return record(JSON.parse(segment(encoded).toString('utf8')));
}

export function createAccessVerifier({
  fetch = globalThis.fetch,
  now = Date.now,
}: { fetch?: typeof globalThis.fetch; now?: () => number } = {}): VerifyAccess {
  const cache = new Map<string, KeyCache>();

  async function refresh(issuer: string, entry: KeyCache) {
    const response = await fetch(issuer + '/cdn-cgi/access/certs', {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Could not fetch Access signing keys');
    const data = record(await response.json());
    if (!Array.isArray(data?.keys) || data.keys.length > 32)
      throw new Error('Invalid Access signing keys');
    const keys = new Map<string, KeyObject>();
    for (const item of data.keys) {
      const key = record(item);
      if (
        key?.kty !== 'RSA' ||
        key.alg !== 'RS256' ||
        (key.use !== undefined && key.use !== 'sig') ||
        typeof key.kid !== 'string' ||
        typeof key.n !== 'string' ||
        typeof key.e !== 'string' ||
        key.n.length > 1500 ||
        key.e.length > 12 ||
        keys.has(key.kid)
      )
        continue;
      const publicKey = createPublicKey({
        format: 'jwk',
        key: { kty: 'RSA', n: key.n, e: key.e },
      });
      if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048)
        keys.set(key.kid, publicKey);
    }
    entry.keys = keys;
    entry.fetchedAt = now();
  }

  async function keyFor(issuer: string, kid: string) {
    let entry = cache.get(issuer);
    if (!entry) {
      entry = { keys: new Map(), fetchedAt: -Infinity, retryAfter: -Infinity };
      cache.set(issuer, entry);
    }
    if (now() - entry.fetchedAt < maxAge && entry.keys.has(kid))
      return entry.keys.get(kid);
    if (!entry.refresh && now() >= entry.retryAfter) {
      entry.retryAfter = now() + refreshCooldown;
      const current = entry;
      entry.refresh = refresh(issuer, current).finally(() => {
        current.refresh = undefined;
      });
    }
    await entry.refresh;
    if (now() - entry.fetchedAt < maxAge) return entry.keys.get(kid);
  }

  return async (token, identity) => {
    if (
      !token ||
      token.length > 16_384 ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(identity.team) ||
      !identity.aud ||
      (!identity.ownerEmail && !identity.ownerSub)
    )
      return false;
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return false;
      const [header, body, signature] = parts;
      const headers = decode(header);
      const claims = decode(body);
      const sig = segment(signature);
      const issuer = `https://${identity.team}.cloudflareaccess.com`;
      const current = () => Math.floor(now() / 1000);
      if (
        headers?.alg !== 'RS256' ||
        typeof headers.kid !== 'string' ||
        headers.kid.length > 256 ||
        headers.crit !== undefined ||
        claims?.iss !== issuer ||
        // Service token JWTs carry a single audience string.
        !(Array.isArray(claims.aud)
          ? claims.aud.includes(identity.aud)
          : claims.aud === identity.aud) ||
        typeof claims.exp !== 'number' ||
        !Number.isSafeInteger(claims.exp) ||
        claims.exp <= current() ||
        (claims.nbf !== undefined &&
          (typeof claims.nbf !== 'number' ||
            !Number.isSafeInteger(claims.nbf) ||
            claims.nbf > current()))
      )
        return false;
      const { email } = claims;
      let role: AccessRole;
      if (
        (!identity.ownerEmail ||
          (typeof email === 'string' &&
            email.toLowerCase() === identity.ownerEmail.toLowerCase())) &&
        (!identity.ownerSub || claims.sub === identity.ownerSub)
      )
        role = 'owner';
      else if (
        typeof email === 'string' &&
        typeof claims.sub === 'string' &&
        claims.sub !== '' &&
        claims.common_name === undefined &&
        identity.viewerEmails?.some(
          (viewerEmail) => viewerEmail.toLowerCase() === email.toLowerCase(),
        )
      )
        role = 'viewer';
      // Access issues service token JWTs with the client ID in common_name
      // and no user identity.
      else if (
        typeof claims.common_name === 'string' &&
        claims.email === undefined &&
        (claims.sub === undefined || claims.sub === '') &&
        identity.viewerServiceTokens?.includes(claims.common_name)
      )
        role = 'viewer';
      else return false;
      const key = await keyFor(issuer, headers.kid);
      return key &&
        claims.exp > current() &&
        verify('RSA-SHA256', Buffer.from(`${header}.${body}`), key, sig)
        ? role
        : false;
    } catch {
      // Malformed tokens and unavailable verification keys both fail closed.
      return false;
    }
  };
}
