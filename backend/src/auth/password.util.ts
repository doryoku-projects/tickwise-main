import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

/**
 * Hash a password with node:crypto scrypt (no native dep). Returns a
 * self-describing `salt:hash` hex string suitable for direct storage.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEYLEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Constant-time verify of a password against a stored `salt:hash` string.
 * Returns false on any malformed input rather than throwing.
 */
export function verifyPassword(password: string, stored: string | undefined | null): boolean {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEYLEN) return false;
  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), KEYLEN);
  return timingSafeEqual(expected, derived);
}
