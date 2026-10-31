// Licences, apart from React. A Pro licence key is activated with the CashGear
// licence server (services/licensing), which answers with a token for this machine:
// a signed envelope that the app checks offline with the public keys it was built
// with. The token is refreshed while the app is online; without a refresh Pro keeps
// working for 14 days after the last one, and then the app is the free edition
// until a refresh succeeds. A build without a licence server has every feature.

export const PRODUCT = 'cashgear-video';
/** A token older than this is refreshed when the server can be reached. */
export const REFRESH_AFTER_MS = 12 * 3600_000;
/** After this long without a refresh, the licence dialog asks to go online. */
export const WARN_AFTER_MS = 7 * 86400_000;
export const GRACE_MS = 14 * 86400_000;

/** Where licences are checked. */
export interface LicenceConfig {
  /** The licence server's address, without a trailing slash. */
  server: string | null;
  /** Public keys (SubjectPublicKeyInfo, base64) that tokens may be signed with. */
  keys: string[];
  /** A release build: it takes no server or keys from the page's address. */
  release: boolean;
}

/**
 * The build's licence settings. Builds that are not releases also take a server and
 * keys from the page's address (`?licenceServer=`, `?licenceKeys=`), for tests.
 */
export function licenceConfig(env: Partial<Record<string, string>>, search: string): LicenceConfig {
  const release = env.VITE_CGV_RELEASE === '1';
  const params = new URLSearchParams(search);
  const list = (text: string | null | undefined) =>
    (text ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
  const server = (!release && params.get('licenceServer')) || env.VITE_CGV_LICENCE_SERVER || '';
  const keys =
    !release && params.get('licenceKeys')
      ? list(params.get('licenceKeys'))
      : list(env.VITE_CGV_LICENCE_KEYS);
  return { server: server.replace(/\/+$/, '') || null, keys, release };
}

/** What a token says (services/licensing's `TokenPayload`). */
export interface TokenPayload {
  licenceId: string;
  product: string;
  edition: string;
  machine: string;
  issuedAt: string;
  expiresAt: string | null;
}

function bytes(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** The token's payload when one of `keys` signed it; null for anything else. */
export async function verifyToken(token: string, keys: string[]): Promise<TokenPayload | null> {
  try {
    const envelope = JSON.parse(token) as { payload?: unknown; signature?: unknown };
    if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
      return null;
    }
    const payload = bytes(envelope.payload);
    const signature = bytes(envelope.signature);
    for (const key of keys) {
      const publicKey = await crypto.subtle.importKey(
        'spki',
        bytes(key),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      const signed = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        signature,
        payload,
      );
      if (!signed) continue;
      const parsed = JSON.parse(new TextDecoder().decode(payload)) as Partial<TokenPayload>;
      const valid =
        typeof parsed.licenceId === 'string' &&
        typeof parsed.product === 'string' &&
        typeof parsed.edition === 'string' &&
        typeof parsed.machine === 'string' &&
        typeof parsed.issuedAt === 'string' &&
        (parsed.expiresAt == null || typeof parsed.expiresAt === 'string');
      return valid ? ({ ...parsed, expiresAt: parsed.expiresAt ?? null } as TokenPayload) : null;
    }
    return null;
  } catch {
    return null;
  }
}

export type Edition = 'free' | 'pro';

export type LicenceState =
  /** A build that is not a release, with no licence server: every feature is on. */
  | 'development'
  /** A release built without a licence server: every feature is included. */
  | 'included'
  | 'free'
  | 'active'
  /** Pro, but not refreshed for over a week: the grace period is running out. */
  | 'offline'
  /** Not refreshed within the grace period: free until a refresh succeeds. */
  | 'lapsed'
  /** A subscription that has ended. */
  | 'expired';

export interface LicenceStatus {
  edition: Edition;
  state: LicenceState;
  licenceId: string | null;
  /** When the server last vouched for the licence (ms). */
  checkedAt: number | null;
  /** When Pro stops without a refresh (ms). */
  graceUntil: number | null;
  /** When a subscription ends (ms). */
  expiresAt: number | null;
}

const none = { licenceId: null, checkedAt: null, graceUntil: null, expiresAt: null };

/** The status before any token is read. */
export function baseStatus(config: LicenceConfig): LicenceStatus {
  if (config.server && config.keys.length) return { edition: 'free', state: 'free', ...none };
  return { edition: 'pro', state: config.release ? 'included' : 'development', ...none };
}

/**
 * What a verified token allows on `machine` at `now`. A token for another product or
 * another machine allows nothing.
 */
export function evaluate(
  config: LicenceConfig,
  payload: TokenPayload | null,
  machine: string,
  now: number,
): LicenceStatus {
  const base = baseStatus(config);
  if (base.state !== 'free' || !payload) return base;
  if (payload.product !== PRODUCT || payload.machine !== machine) return base;
  if (payload.edition !== 'pro' && payload.edition !== 'business') return base;
  const checkedAt = Date.parse(payload.issuedAt);
  const expiresAt = payload.expiresAt ? Date.parse(payload.expiresAt) : null;
  if (!Number.isFinite(checkedAt)) return base;
  const graceUntil = checkedAt + GRACE_MS;
  const known = { licenceId: payload.licenceId, checkedAt, graceUntil, expiresAt };
  if (expiresAt !== null && expiresAt <= now)
    return { edition: 'free', state: 'expired', ...known };
  if (now >= graceUntil) return { edition: 'free', state: 'lapsed', ...known };
  const state = now - checkedAt >= WARN_AFTER_MS ? 'offline' : 'active';
  return { edition: 'pro', state, ...known };
}
