import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

// The signed JSON envelope of CashGear's licence servers, as CashGear Backup reads
// it: {"payload": base64, "signature": base64}, where the signature is ECDSA P-256
// with SHA-256 over the payload's bytes, in IEEE P1363 form (r and s, 32 bytes
// each), the form WebCrypto gives and takes. Public keys are SubjectPublicKeyInfo
// DER in base64; the private key never leaves the server.

export interface KeyPair {
  /** PKCS #8, PEM. */
  privatePem: string;
  /** SubjectPublicKeyInfo DER, base64: what the apps build in. */
  publicKey: string;
}

export function generateKeys(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKeyOf(publicKey),
  };
}

/** The signing key from its PEM. Throws for anything but a P-256 private key. */
export function loadPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('The signing key must be an ECDSA P-256 private key.');
  }
  return key;
}

/** The public key, as the apps build it in. */
export function publicKeyOf(key: KeyObject): string {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function signEnvelope(payload: object, key: KeyObject): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' });
  return JSON.stringify({
    payload: bytes.toString('base64'),
    signature: signature.toString('base64'),
  });
}

/** The payload when one of `publicKeys` signed the envelope; null for anything else. */
export function verifyEnvelope(envelope: string, publicKeys: string[]): unknown {
  try {
    const { payload, signature } = JSON.parse(envelope) as Record<string, unknown>;
    if (typeof payload !== 'string' || typeof signature !== 'string') return null;
    const bytes = Buffer.from(payload, 'base64');
    const signed = Buffer.from(signature, 'base64');
    for (const publicKey of publicKeys) {
      const key = createPublicKey({
        key: Buffer.from(publicKey, 'base64'),
        format: 'der',
        type: 'spki',
      });
      if (verify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, signed)) {
        return JSON.parse(bytes.toString('utf8'));
      }
    }
    return null;
  } catch {
    return null;
  }
}
