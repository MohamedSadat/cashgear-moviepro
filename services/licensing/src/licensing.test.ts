import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeys, loadPrivateKey, signEnvelope, verifyEnvelope } from './envelope.ts';
import { keyHash, newLicenceKey, normaliseKey } from './keys.ts';
import { Licensing, type TokenPayload } from './licensing.ts';
import { createLicenceServer } from './server.ts';
import { Store } from './store.ts';

const keys = generateKeys();
const signingKey = loadPrivateKey(keys.privatePem);
let folder: string;
let store: Store;
let clock: Date;
let licensing: Licensing;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'cgv-licensing-'));
  store = new Store(join(folder, 'licences.json'));
  clock = new Date('2026-10-30T10:00:00Z');
  licensing = new Licensing(store, signingKey, () => clock);
});

afterEach(() => rm(folder, { recursive: true, force: true }));

function payloadOf(answer: unknown): TokenPayload {
  const { token, code } = answer as { token?: string; code?: string };
  if (!token) throw new Error(`refused: ${code}`);
  return verifyEnvelope(token, [keys.publicKey]) as TokenPayload;
}

describe('envelope', () => {
  it('verifies only untouched payloads signed by a known key', () => {
    const envelope = signEnvelope({ a: 1 }, signingKey);
    expect(verifyEnvelope(envelope, [keys.publicKey])).toEqual({ a: 1 });
    expect(verifyEnvelope(envelope, [generateKeys().publicKey])).toBeNull();
    const parsed = JSON.parse(envelope);
    parsed.payload = Buffer.from('{"a":2}').toString('base64');
    expect(verifyEnvelope(JSON.stringify(parsed), [keys.publicKey])).toBeNull();
    expect(verifyEnvelope('not json', [keys.publicKey])).toBeNull();
  });

  it('signs in the form WebCrypto verifies, as the apps do', async () => {
    const envelope = JSON.parse(signEnvelope({ licenceId: 'x' }, signingKey));
    const key = await crypto.subtle.importKey(
      'spki',
      Buffer.from(keys.publicKey, 'base64'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      Buffer.from(envelope.signature, 'base64'),
      Buffer.from(envelope.payload, 'base64'),
    );
    expect(ok).toBe(true);
  });
});

describe('keys', () => {
  it('reads keys as people type them', () => {
    const key = newLicenceKey();
    expect(key).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){4}[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(normaliseKey(` ${key.toLowerCase().replace(/-/g, ' ')} `)).toBe(key.replace(/-/g, ''));
    expect(normaliseKey('OIL00-00000-00000-00000-00000')).toBe('0110000000000000000000000');
    expect(normaliseKey('ABCDE-ABCDE')).toBeNull();
    expect(normaliseKey('UUUUU-UUUUU-UUUUU-UUUUU-UUUUU')).toBeNull();
    expect(keyHash('A')).toHaveLength(64);
  });
});

describe('licensing', () => {
  const machine = 'machine-0001';

  async function issue(options: { machines?: number; expiresAt?: string } = {}) {
    return licensing.issue({
      product: 'cashgear-video',
      edition: 'pro',
      machines: options.machines ?? 2,
      licensee: 'Test',
      expiresAt: options.expiresAt ?? null,
    });
  }

  it('activates a key for a machine and signs what it allows', async () => {
    const { licence, key } = await issue();
    const answer = await licensing.activate({
      key: key.toLowerCase(),
      machine,
      product: 'cashgear-video',
      version: '1.0.0',
    });
    expect(payloadOf(answer)).toEqual({
      licenceId: licence.id,
      product: 'cashgear-video',
      edition: 'pro',
      machine,
      issuedAt: '2026-10-30T10:00:00.000Z',
      expiresAt: null,
    });
    const stored = (await store.read()).licences[0];
    expect(stored.keyHash).not.toContain(key);
    expect(JSON.stringify(stored)).not.toContain(key.replace(/-/g, ''));
    expect(stored.activations).toMatchObject([{ machine, version: '1.0.0' }]);
  });

  it('refuses wrong keys, other products and bad requests', async () => {
    const { key } = await issue();
    const request = { key, machine, product: 'cashgear-video', version: '1' };
    expect(await licensing.activate({ ...request, key: newLicenceKey() })).toMatchObject({
      status: 403,
      code: 'invalid-key',
    });
    expect(await licensing.activate({ ...request, product: 'cashgear-backup' })).toMatchObject({
      code: 'wrong-product',
    });
    expect(await licensing.activate({ ...request, machine: 'a b' })).toMatchObject({
      status: 400,
      code: 'bad-request',
    });
    expect(await licensing.activate({ ...request, key: 42 })).toMatchObject({
      code: 'bad-request',
    });
  });

  it('holds a licence to its number of machines, and deactivating frees a place', async () => {
    const { licence, key } = await issue({ machines: 2 });
    const activate = (id: string) =>
      licensing.activate({ key, machine: id, product: 'cashgear-video', version: '1' });
    payloadOf(await activate('machine-0001'));
    payloadOf(await activate('machine-0002'));
    // The same machine again keeps its place.
    payloadOf(await activate('machine-0001'));
    expect(await activate('machine-0003')).toMatchObject({ code: 'machine-limit' });
    expect(await licensing.deactivate({ licenceId: licence.id, machine: 'machine-0002' })).toEqual({
      ok: true,
    });
    payloadOf(await activate('machine-0003'));
    expect(
      await licensing.refresh({ licenceId: licence.id, machine: 'machine-0002' }),
    ).toMatchObject({ code: 'not-activated' });
  });

  it('refreshes with a new date until the licence is revoked', async () => {
    const { licence, key } = await issue();
    payloadOf(await licensing.activate({ key, machine, product: 'cashgear-video', version: '1' }));
    clock = new Date('2026-11-05T10:00:00Z');
    const refreshed = payloadOf(await licensing.refresh({ licenceId: licence.id, machine }));
    expect(refreshed.issuedAt).toBe('2026-11-05T10:00:00.000Z');
    expect(await licensing.revoke(licence.id)).toBe(true);
    expect(await licensing.refresh({ licenceId: licence.id, machine })).toMatchObject({
      code: 'revoked',
      revoked: true,
    });
    expect(
      await licensing.activate({ key, machine, product: 'cashgear-video', version: '1' }),
    ).toMatchObject({ code: 'revoked' });
  });

  it('ends a subscription on its date', async () => {
    const { licence, key } = await issue({ expiresAt: '2026-12-01T00:00:00.000Z' });
    expect(
      payloadOf(await licensing.activate({ key, machine, product: 'cashgear-video', version: '1' }))
        .expiresAt,
    ).toBe('2026-12-01T00:00:00.000Z');
    clock = new Date('2026-12-01T00:00:00Z');
    expect(await licensing.refresh({ licenceId: licence.id, machine })).toMatchObject({
      code: 'expired',
    });
  });

  it('keeps every change when many arrive together', async () => {
    const { key } = await issue({ machines: 20 });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        licensing.activate({
          key,
          machine: `machine-${String(i).padStart(4, '0')}`,
          product: 'cashgear-video',
          version: '1',
        }),
      ),
    );
    expect((await store.read()).licences[0].activations).toHaveLength(20);
  });
});

describe('server', () => {
  it('answers over HTTP to any origin', async () => {
    const { key } = await licensing.issue({
      product: 'cashgear-video',
      edition: 'pro',
      machines: 1,
    });
    const server = createLicenceServer(licensing, { publicKey: keys.publicKey });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/licensing`;
    try {
      const preflight = await fetch(`${base}/activate`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      const post = (route: string, body: unknown) =>
        fetch(`${base}/${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
      const activated = await post('activate', {
        key,
        machine: 'machine-0001',
        product: 'cashgear-video',
        version: '1',
      });
      expect(activated.status).toBe(200);
      expect(payloadOf(await activated.json()).machine).toBe('machine-0001');
      const refused = await post('activate', {
        key,
        machine: 'machine-0002',
        product: 'cashgear-video',
        version: '1',
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'machine-limit', revoked: false });
      expect((await post('activate', '{')).status).toBe(400);
      expect((await post('activate', 'x'.repeat(5000))).status).toBe(400);
      expect((await fetch(`${base}/activate`)).status).toBe(405);
      expect(await (await fetch(`${base}/health`)).json()).toEqual({
        ok: true,
        publicKey: keys.publicKey,
      });
    } finally {
      server.close();
    }
  });
});
