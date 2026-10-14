import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.util.js';

describe('password.util', () => {
  it('verifies a correct password against its hash', () => {
    const stored = hashPassword('s3cret-pass');
    expect(stored).toContain(':');
    expect(verifyPassword('s3cret-pass', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('s3cret-pass');
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('returns false on malformed / empty stored values', () => {
    expect(verifyPassword('x', undefined)).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'no-colon')).toBe(false);
  });

  it('produces a unique salt per hash', () => {
    expect(hashPassword('same')).not.toEqual(hashPassword('same'));
  });
});
