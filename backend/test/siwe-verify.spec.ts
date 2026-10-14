import 'reflect-metadata';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { SiweService, buildSiweMessage } from '../src/identity/siwe.service.js';

/**
 * Wallet sign-in (EIP-4361), against REAL secp256k1 signatures.
 *
 * Keys and signatures come from viem rather than a mock, because a mocked
 * verifier tests our branching and nothing else — the property under test is
 * that a signature over the SERVER'S message by the wallet the nonce was issued
 * to is the only thing that authenticates. Only Redis is faked (an in-memory
 * map with the same GETDEL semantics), so single-use and the expiry deadline are
 * still exercised for real.
 */

const DOMAIN = 'app.example.com';
const STATEMENT = 'Sign in to the Tickwise API portal.';
const PORTAL = 'https://app.example.com';

/** Minimal Redis: SET with EX, and the atomic read-and-delete `verify` needs. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    client: {
      set: async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      },
      getdel: async (key: string) => {
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      },
      on: () => undefined,
      quit: async () => 'OK',
    },
  };
}

function buildService(over: { walletLoginEnabled?: boolean } = {}) {
  const config = {
    redisUrl: 'redis://127.0.0.1:6379',
    walletLoginEnabled: over.walletLoginEnabled ?? true,
    siweDomain: DOMAIN,
    siweStatement: STATEMENT,
    portalBaseUrl: PORTAL,
  };
  const service = new SiweService(config as never);
  const redis = fakeRedis();
  // The constructor's client is lazyConnect and never used; swap in the fake
  // before the first command so nothing reaches a socket.
  Object.defineProperty(service, 'redis', { value: redis.client, writable: true });
  return { service, store: redis.store };
}

/** The stored record for a nonce, as `verify` will read it. */
function readRecord(store: Map<string, string>, nonce: string) {
  const raw = store.get(`sso:siwe:nonce:${nonce}`);
  return raw ? (JSON.parse(raw) as { message: string; expiresAt: string }) : undefined;
}

describe('SIWE challenge', () => {
  it('issues a message bound to the requested wallet, and stores the exact string it will verify', async () => {
    const { service, store } = buildService();
    const account = privateKeyToAccount(generatePrivateKey());

    const challenge = await service.createChallenge({ address: account.address.toLowerCase() });

    // The message the wallet renders IS the message the server kept.
    expect(readRecord(store, challenge.nonce)?.message).toBe(challenge.message);
    expect(challenge.address).toBe(account.address); // EIP-55 checksummed
    expect(challenge.chainId).toBe(1);
    // The domain binding is what stops a signature collected elsewhere.
    expect(challenge.message.startsWith(`${DOMAIN} wants you to sign in`)).toBe(true);
    expect(challenge.message).toContain(`\n${account.address}\n`);
    expect(challenge.message).toContain(`Nonce: ${challenge.nonce}`);
    expect(challenge.message).toContain(`URI: ${PORTAL}`);
  });

  it('refuses a malformed address before writing anything', async () => {
    const { service, store } = buildService();

    await expect(service.createChallenge({ address: '0xnot-an-address' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(store.size).toBe(0);
  });

  it('refuses entirely when wallet login is switched off', async () => {
    const { service } = buildService({ walletLoginEnabled: false });
    const account = privateKeyToAccount(generatePrivateKey());

    await expect(service.createChallenge({ address: account.address })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.verify({ nonce: 'deadbeef00000000', signature: '0x00' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('SIWE verification', () => {
  it('accepts a real signature over the server-stored message', async () => {
    const { service } = buildService();
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = await service.createChallenge({ address: account.address });

    const signature = await account.signMessage({ message: challenge.message });
    const verified = await service.verify({ nonce: challenge.nonce, signature });

    // LOWERCASED — this is what becomes `Identity.subject` for provider 'wallet'.
    expect(verified.address).toBe(account.address.toLowerCase());
    expect(verified.checksumAddress).toBe(account.address);
    expect(verified.chainId).toBe(1);
  });

  it('REJECTS a signature from a different key than the address the nonce was issued to', async () => {
    // Without the address binding, anyone holding a live nonce could complete
    // the challenge with their own wallet — `verify` only ever learns the nonce.
    const { service } = buildService();
    const victim = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const challenge = await service.createChallenge({ address: victim.address });

    // A perfectly valid signature — over the right message, by the wrong key.
    const signature = await attacker.signMessage({ message: challenge.message });

    await expect(service.verify({ nonce: challenge.nonce, signature })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('is SINGLE USE: a replayed nonce and signature fail the second time', async () => {
    const { service } = buildService();
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = await service.createChallenge({ address: account.address });
    const signature = await account.signMessage({ message: challenge.message });

    await expect(service.verify({ nonce: challenge.nonce, signature })).resolves.toMatchObject({
      address: account.address.toLowerCase(),
    });
    // Same bytes, replayed — a captured signature is worth exactly one login.
    await expect(service.verify({ nonce: challenge.nonce, signature })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('burns the nonce even on a FAILED attempt, so one challenge cannot be ground', async () => {
    const { service, store } = buildService();
    const account = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const challenge = await service.createChallenge({ address: account.address });

    await expect(
      service.verify({
        nonce: challenge.nonce,
        signature: await attacker.signMessage({ message: challenge.message }),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(store.size).toBe(0);
    // Even the RIGHT signature is too late now.
    await expect(
      service.verify({
        nonce: challenge.nonce,
        signature: await account.signMessage({ message: challenge.message }),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an EXPIRED challenge even if the key survived its TTL', async () => {
    // The Redis TTL is the primary bound; the stored deadline is the belt to its
    // braces, and it is the only one a clock skew or a restored snapshot leaves.
    const { service, store } = buildService();
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = await service.createChallenge({ address: account.address });
    const key = `sso:siwe:nonce:${challenge.nonce}`;
    const record = JSON.parse(store.get(key) as string) as { expiresAt: string };
    store.set(key, JSON.stringify({ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() }));

    await expect(
      service.verify({
        nonce: challenge.nonce,
        signature: await account.signMessage({ message: challenge.message }),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('IGNORES any client-supplied message — a substituted one cannot be verified against', async () => {
    // The whole SIWE parser-mismatch attack class lives in accepting a message
    // from the client. There is exactly one message string, the server wrote it,
    // and a body carrying another is not even read (the DTO rejects it too).
    const { service } = buildService();
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = await service.createChallenge({ address: account.address });

    const forged = challenge.message.replace(DOMAIN, 'evil.example');
    expect(forged).not.toBe(challenge.message);
    const signature = await account.signMessage({ message: forged });

    await expect(
      // Passing `message` explicitly: it is not part of the signature, and the
      // service reads its own copy regardless.
      service.verify({ nonce: challenge.nonce, signature, message: forged } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a garbage nonce and a garbage signature without a Redis round trip', async () => {
    const { service } = buildService();

    await expect(service.verify({ nonce: 'not-a-nonce', signature: '0xabcd' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      service.verify({ nonce: 'deadbeefdeadbeef', signature: 'not-a-signature' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('buildSiweMessage', () => {
  it('lays the EIP-4361 fields out in spec order and cannot be split by the statement', async () => {
    // A newline in the operator-configured statement would forge extra header
    // lines (a second `URI:` is the classic one), so whitespace is collapsed.
    const message = buildSiweMessage({
      domain: DOMAIN,
      address: '0x0000000000000000000000000000000000000001',
      statement: 'Sign in.\nURI: https://evil.example',
      uri: PORTAL,
      chainId: 1,
      nonce: 'abc123',
      issuedAt: '2026-01-01T00:00:00.000Z',
      expirationTime: '2026-01-01T00:05:00.000Z',
    });

    expect(message.split('\n')).toEqual([
      `${DOMAIN} wants you to sign in with your Ethereum account:`,
      '0x0000000000000000000000000000000000000001',
      '',
      'Sign in. URI: https://evil.example',
      '',
      `URI: ${PORTAL}`,
      'Version: 1',
      'Chain ID: 1',
      'Nonce: abc123',
      'Issued At: 2026-01-01T00:00:00.000Z',
      'Expiration Time: 2026-01-01T00:05:00.000Z',
    ]);
    // Exactly one line the verifier would read as the URI field.
    expect(message.split('\n').filter((line) => line.startsWith('URI: '))).toHaveLength(1);
  });
});
