import { describe, expect, it } from 'vitest';
import {
  GRACE_MS,
  WARN_AFTER_MS,
  evaluate,
  licenceConfig,
  verifyToken,
  type LicenceConfig,
  type TokenPayload,
} from './licence';

function base64(bytes: ArrayBuffer | Uint8Array): string {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text);
}

/** Signs as the licence server does: ECDSA P-256, SHA-256, P1363 (WebCrypto's form). */
async function signer() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicKey = base64(await crypto.subtle.exportKey('spki', pair.publicKey));
  const sign = async (payload: object) => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      bytes,
    );
    return JSON.stringify({ payload: base64(bytes), signature: base64(signature) });
  };
  return { publicKey, sign };
}

const payload: TokenPayload = {
  licenceId: 'licence-1',
  product: 'cashgear-video',
  edition: 'pro',
  machine: 'machine-0001',
  issuedAt: '2026-10-30T10:00:00.000Z',
  expiresAt: null,
};
const issued = Date.parse(payload.issuedAt);
const config: LicenceConfig = { server: 'https://licensing.test', keys: ['k'], release: true };

describe('licence config', () => {
  it('takes the build settings, and test settings only outside releases', () => {
    const env = { VITE_CGV_LICENCE_SERVER: 'https://a.test/', VITE_CGV_LICENCE_KEYS: 'k1, k2' };
    const test = '?licenceServer=http%3A%2F%2F127.0.0.1%3A9&licenceKeys=t%2B1%3D';
    expect(licenceConfig(env, '')).toEqual({
      server: 'https://a.test',
      keys: ['k1', 'k2'],
      release: false,
    });
    expect(licenceConfig(env, test)).toEqual({
      server: 'http://127.0.0.1:9',
      keys: ['t+1='],
      release: false,
    });
    expect(licenceConfig({ ...env, VITE_CGV_RELEASE: '1' }, test)).toEqual({
      server: 'https://a.test',
      keys: ['k1', 'k2'],
      release: true,
    });
  });

  it('is Pro in development builds and free in releases without a server', () => {
    const empty = { server: null, keys: [] };
    expect(evaluate({ ...empty, release: false }, null, 'm', 0)).toMatchObject({
      edition: 'pro',
      state: 'development',
    });
    expect(evaluate({ ...empty, release: true }, payload, payload.machine, issued)).toMatchObject({
      edition: 'free',
      state: 'unavailable',
    });
  });
});

describe('licence tokens', () => {
  it('accepts only untouched tokens signed by a known key', async () => {
    const server = await signer();
    const token = await server.sign(payload);
    expect(await verifyToken(token, [server.publicKey])).toEqual(payload);
    expect(await verifyToken(token, [(await signer()).publicKey])).toBeNull();
    const forged = JSON.parse(token);
    forged.payload = btoa(JSON.stringify({ ...payload, edition: 'business' }));
    expect(await verifyToken(JSON.stringify(forged), [server.publicKey])).toBeNull();
    expect(await verifyToken('{', [server.publicKey])).toBeNull();
    expect(await verifyToken(await server.sign({ licenceId: 1 }), [server.publicKey])).toBeNull();
  });
});

describe('licence status', () => {
  it('is Pro until the grace period runs out without a refresh', () => {
    expect(evaluate(config, payload, payload.machine, issued + 1000)).toEqual({
      edition: 'pro',
      state: 'active',
      licenceId: 'licence-1',
      checkedAt: issued,
      graceUntil: issued + GRACE_MS,
      expiresAt: null,
    });
    expect(evaluate(config, payload, payload.machine, issued + WARN_AFTER_MS).state).toBe(
      'offline',
    );
    expect(evaluate(config, payload, payload.machine, issued + GRACE_MS)).toMatchObject({
      edition: 'free',
      state: 'lapsed',
    });
  });

  it('allows nothing on another machine, for another product, or after a subscription', () => {
    expect(evaluate(config, payload, 'machine-0002', issued).state).toBe('free');
    expect(
      evaluate(config, { ...payload, product: 'cashgear-backup' }, payload.machine, issued),
    ).toMatchObject({ edition: 'free', state: 'free' });
    const subscription = { ...payload, expiresAt: '2026-11-01T00:00:00.000Z' };
    expect(evaluate(config, subscription, payload.machine, issued).edition).toBe('pro');
    expect(
      evaluate(config, subscription, payload.machine, Date.parse('2026-11-01T00:00:00Z')),
    ).toMatchObject({ edition: 'free', state: 'expired' });
  });
});
