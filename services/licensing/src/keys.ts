import { createHash, randomBytes } from 'node:crypto';

// Licence keys: 25 characters of Crockford's base32 (125 random bits) in groups of
// five, such as `7M2QK-9XW4D-...`. People type them, so reading one forgives case,
// spaces, missing dashes and the letters base32 leaves out (O for 0, I and L for 1).
// The store keeps only a key's SHA-256, so a copy of it gives no keys away.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 25;

export function newLicenceKey(): string {
  const bytes = randomBytes(LENGTH);
  let key = '';
  for (let i = 0; i < LENGTH; i++) {
    if (i > 0 && i % 5 === 0) key += '-';
    key += ALPHABET[bytes[i] & 31];
  }
  return key;
}

/** The key's 25 characters, or null when the text cannot be a key. */
export function normaliseKey(text: string): string | null {
  const key = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (key.length !== LENGTH) return null;
  for (const char of key) if (!ALPHABET.includes(char)) return null;
  return key;
}

/** What the store keeps of a key. */
export function keyHash(normalised: string): string {
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}
