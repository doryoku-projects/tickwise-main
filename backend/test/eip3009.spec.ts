import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, hashTypedData, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AUTHORIZATION_STATE_SELECTOR,
  AUTHORIZATION_USED_TOPIC,
  DOMAIN_SEPARATOR_SELECTOR,
  NAME_SELECTOR,
  TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  TRANSFER_WITH_AUTHORIZATION_TYPE_STRING,
  SECP256K1_N,
  TRANSFER_WITH_AUTHORIZATION_VRS_SELECTOR,
  VERSION_SELECTOR,
  authorizationDomainSeparator,
  buildTransferAuthorizationTypedData,
  randomAuthorizationNonce,
  verifyAuthorizationSignature,
} from '../src/payments/providers/x402/eip3009.js';

/**
 * EIP-3009 authorization core.
 *
 * THE POINT OF THIS FILE is that almost nothing here compares the module against
 * its own output. This repo has already shipped a derivation bug that typechecked,
 * built, and returned a plausible-looking value — the compressed-vs-uncompressed
 * pubkey in `hd-address.service.ts`, which produced valid-looking addresses that
 * no key controlled. The lesson recorded from it was explicit: for derivation
 * code, only an EXTERNAL ground-truth vector catches a wrong-format bug.
 *
 * So the three things that could silently break every payment on this rail are
 * each pinned against something outside the module:
 *
 *  1. Every 4-byte selector and event topic is asserted against `keccak256` of
 *     its own canonical signature string — computed here, not copied from there.
 *     (This is not theoretical: it caught `0xe3ee160e`, the `(v,r,s)` overload,
 *     sitting where the `bytes signature` selector belonged.)
 *  2. The EIP-712 digest is derived a SECOND, INDEPENDENT WAY — by hand, from
 *     `0x1901 ‖ domainSeparator ‖ hashStruct` with an ABI-encoded struct — and
 *     asserted equal to what the types object produces. A wrong field order or a
 *     mistyped `uint256` in the types array changes one and not the other.
 *  3. Signature recovery is checked against a PUBLICLY KNOWN keypair (the
 *     standard anvil account 0, the same vector `hd-address.spec.ts` uses), so a
 *     recovery that "works" against our own signer cannot pass while being wrong.
 */

/** Anvil account 0 — a public, well-known test vector. Never used for funds. */
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** USDC on Base, and Circle's FiatToken domain values. Shape only, never signed for real. */
const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TREASURY = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const NONCE = '0x1111111111111111111111111111111111111111111111111111111111111111';

function fixture() {
  return buildTransferAuthorizationTypedData({
    tokenName: 'USD Coin',
    tokenVersion: '2',
    chainId: 8453,
    tokenAddress: TOKEN,
    from: ANVIL_ADDRESS,
    to: TREASURY,
    valueBaseUnits: 19_000_000n, // 19 USDC at 6 decimals
    validBefore: 1_800_000_000,
    nonce: NONCE,
  });
}

describe('EIP-3009 — selectors and topics against keccak ground truth', () => {
  const selector = (signature: string) => keccak256(toHex(signature)).slice(0, 10);

  it('uses the bytes-signature overload of transferWithAuthorization, NOT the (v,r,s) one', () => {
    // The bug this pins: the two overloads differ only in their tail arguments,
    // so the wrong selector is a call the token decodes as garbage.
    expect(TRANSFER_WITH_AUTHORIZATION_SELECTOR).toBe(
      selector('transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)'),
    );
    expect(TRANSFER_WITH_AUTHORIZATION_VRS_SELECTOR).toBe(
      selector(
        'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
      ),
    );
    expect(TRANSFER_WITH_AUTHORIZATION_SELECTOR).not.toBe(TRANSFER_WITH_AUTHORIZATION_VRS_SELECTOR);
  });

  it('pins the four view selectors the rail reads from the token', () => {
    expect(DOMAIN_SEPARATOR_SELECTOR).toBe(selector('DOMAIN_SEPARATOR()'));
    expect(VERSION_SELECTOR).toBe(selector('version()'));
    expect(NAME_SELECTOR).toBe(selector('name()'));
    expect(AUTHORIZATION_STATE_SELECTOR).toBe(selector('authorizationState(address,bytes32)'));
  });

  it('pins the AuthorizationUsed topic the watcher will filter on', () => {
    expect(AUTHORIZATION_USED_TOPIC).toBe(keccak256(toHex('AuthorizationUsed(address,bytes32)')));
  });

  it('never references receiveWithAuthorization — it would force the treasury key onto the server', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/payments/providers/x402/eip3009.ts', import.meta.url), 'utf8'),
    );
    // Mentioned in prose (the comment explaining why not), never as a selector.
    expect(source).not.toContain(selector('receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)'));
  });
});

describe('EIP-3009 — the digest, derived independently', () => {
  it('matches a hand-built 0x1901 ‖ domainSeparator ‖ hashStruct digest', () => {
    const typedData = fixture();

    // ── Derivation A: what the module's types object produces (viem). ──
    const fromTypes = hashTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: {
        from: typedData.message.from,
        to: typedData.message.to,
        value: BigInt(typedData.message.value),
        validAfter: BigInt(typedData.message.validAfter),
        validBefore: BigInt(typedData.message.validBefore),
        nonce: typedData.message.nonce,
      },
    });

    // ── Derivation B: by hand, from the canonical type STRING in the standard.
    // This is the independent half: it never reads the types ARRAY, so a
    // reordered or mistyped field in that array makes the two disagree.
    const typeHash = keccak256(toHex(TRANSFER_WITH_AUTHORIZATION_TYPE_STRING));
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'address' },
          { type: 'address' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'bytes32' },
        ],
        [
          typeHash,
          typedData.message.from,
          typedData.message.to,
          BigInt(typedData.message.value),
          BigInt(typedData.message.validAfter),
          BigInt(typedData.message.validBefore),
          typedData.message.nonce,
        ],
      ),
    );
    const byHand = keccak256(
      `0x1901${authorizationDomainSeparator(typedData.domain).slice(2)}${structHash.slice(2)}` as Hex,
    );

    expect(fromTypes).toBe(byHand);
  });

  it('declares the six struct fields in the order the standard hashes them', () => {
    // The type string and the array must describe the same struct. Asserted
    // explicitly because a reorder is invisible at every other layer.
    const fields = TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization.map(
      (f) => `${f.type} ${f.name}`,
    ).join(',');
    expect(`${TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE}(${fields})`).toBe(
      TRANSFER_WITH_AUTHORIZATION_TYPE_STRING,
    );
  });

  it('pins the domain separator by VALUE, so the computation cannot drift silently', () => {
    // A REGRESSION guard, and deliberately not claimed as more than that: this
    // value came from this code, so it proves only that a refactor (a bigint
    // widening, a field reorder, an added `salt`) did not change the output.
    // Whether it is the separator USDC-on-Base *actually* uses is settled at
    // runtime by `Eip3009DomainService` against the token's own
    // DOMAIN_SEPARATOR() — that comparison is the correctness proof, this is the
    // change detector.
    expect(authorizationDomainSeparator(fixture().domain)).toBe(
      '0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f',
    );
  });

  it('changes the domain separator when the version changes (the bridged-token trap)', () => {
    const v2 = authorizationDomainSeparator(fixture().domain);
    const v1 = authorizationDomainSeparator({ ...fixture().domain, version: '1' });
    // Why this matters: a signature built on the wrong `version` is perfectly
    // well-formed and the token rejects it. Only an on-chain DOMAIN_SEPARATOR()
    // comparison catches it, which is what Eip3009DomainService exists to do.
    expect(v1).not.toBe(v2);
  });

  it('changes the digest when the treasury changes — a relayer cannot redirect funds', () => {
    const mine = hashTypedData({ ...fixture(), message: msg(fixture()) } as never);
    const attacker = buildTransferAuthorizationTypedData({
      tokenName: 'USD Coin',
      tokenVersion: '2',
      chainId: 8453,
      tokenAddress: TOKEN,
      from: ANVIL_ADDRESS,
      to: '0x000000000000000000000000000000000000dEaD',
      valueBaseUnits: 19_000_000n,
      validBefore: 1_800_000_000,
      nonce: NONCE,
    });
    expect(hashTypedData({ ...attacker, message: msg(attacker) } as never)).not.toBe(mine);
  });
});

describe('EIP-3009 — signature verification against a public keypair', () => {
  it('recovers the KNOWN anvil address from a real signature over our typed data', async () => {
    const typedData = fixture();
    const account = privateKeyToAccount(ANVIL_KEY);
    // Ground truth: this key's address is publicly documented, so a recovery
    // that agreed with our own signer but was wrong cannot pass here.
    expect(account.address).toBe(ANVIL_ADDRESS);

    const signature = await account.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: msg(typedData),
    });

    const result = await verifyAuthorizationSignature({ typedData, signature });
    expect(result.valid).toBe(true);
    expect(result.recovered?.toLowerCase()).toBe(ANVIL_ADDRESS.toLowerCase());
  });

  it('REFUSES a signature over a different amount (the tampered-value case)', async () => {
    const issued = fixture();
    const account = privateKeyToAccount(ANVIL_KEY);
    // The customer signs for 1 USDC; we stored an authorization for 19.
    const cheaper = buildTransferAuthorizationTypedData({
      tokenName: 'USD Coin',
      tokenVersion: '2',
      chainId: 8453,
      tokenAddress: TOKEN,
      from: ANVIL_ADDRESS,
      to: TREASURY,
      valueBaseUnits: 1_000_000n,
      validBefore: 1_800_000_000,
      nonce: NONCE,
    });
    const signature = await account.signTypedData({
      domain: cheaper.domain,
      types: cheaper.types,
      primaryType: cheaper.primaryType,
      message: msg(cheaper),
    });

    const result = await verifyAuthorizationSignature({ typedData: issued, signature });
    expect(result.valid).toBe(false);
  });

  it('REFUSES a signature from a different wallet than the one the authorization names', async () => {
    const typedData = fixture(); // names the anvil address as `from`
    const other = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // anvil key 1
    );
    const signature = await other.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: msg(typedData),
    });

    const result = await verifyAuthorizationSignature({ typedData, signature });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not from the wallet/i);
  });

  it('REFUSES a MALLEATED (high-s) signature the token would reject on-chain', async () => {
    const typedData = fixture();
    const account = privateKeyToAccount(ANVIL_KEY);
    const signature = await account.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: msg(typedData),
    });

    // The genuine signature verifies…
    expect((await verifyAuthorizationSignature({ typedData, signature })).valid).toBe(true);

    // …and its malleated twin `(r, n - s)` recovers the SAME signer, so a naive
    // check accepts it — but OpenZeppelin's ECDSA (which Circle's FiatToken uses)
    // refuses the high half, so relaying it burns gas on a guaranteed revert.
    const r = signature.slice(2, 66);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = parseInt(signature.slice(130, 132), 16);
    const flipped = SECP256K1_N - s;
    const flippedV = v === 27 ? 28 : 27;
    const malleated = `0x${r}${flipped.toString(16).padStart(64, '0')}${flippedV.toString(16)}`;

    const result = await verifyAuthorizationSignature({ typedData, signature: malleated });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/high s/i);
  });

  it('pins the curve order against @noble/curves rather than my typing', async () => {
    // A hard-coded 32-byte constant is exactly the kind of value this repo has
    // been burned by, so it is checked against the library's own copy.
    const { secp256k1 } = await import('@noble/curves/secp256k1');
    expect(SECP256K1_N).toBe(secp256k1.CURVE.n);
  });

  it('REFUSES malformed signatures without throwing (ordinary caller input, not a 500)', async () => {
    const typedData = fixture();
    for (const bad of ['', '0x', 'not-hex', `0x${'ab'.repeat(64)}`]) {
      const result = await verifyAuthorizationSignature({ typedData, signature: bad });
      expect(result.valid).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });
});

describe('EIP-3009 — issuance guards', () => {
  it('mints 32-byte random nonces, distinct across calls', () => {
    const a = randomAuthorizationNonce();
    const b = randomAuthorizationNonce();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('normalises addresses to checksum form so the stored and signed objects match byte-for-byte', () => {
    const typedData = buildTransferAuthorizationTypedData({
      tokenName: 'USD Coin',
      tokenVersion: '2',
      chainId: 8453,
      tokenAddress: TOKEN.toLowerCase(),
      from: ANVIL_ADDRESS.toLowerCase(),
      to: TREASURY.toLowerCase(),
      valueBaseUnits: 19_000_000n,
      validBefore: 1_800_000_000,
      nonce: NONCE.toUpperCase().replace('0X', '0x'),
    });
    expect(typedData.message.from).toBe(ANVIL_ADDRESS);
    expect(typedData.domain.verifyingContract).toBe(TOKEN);
    // Money stays a decimal STRING: it crosses to the browser as JSON, where a
    // bigint cannot serialise and a number loses the low digits past 2^53.
    expect(typedData.message.value).toBe('19000000');
    expect(typeof typedData.message.value).toBe('string');
  });

  it('refuses a domain name or version it was not given — never guesses them', () => {
    const base = {
      chainId: 8453,
      tokenAddress: TOKEN,
      from: ANVIL_ADDRESS,
      to: TREASURY,
      valueBaseUnits: 19_000_000n,
      validBefore: 1_800_000_000,
      nonce: NONCE,
    };
    expect(() => buildTransferAuthorizationTypedData({ ...base, tokenName: '', tokenVersion: '2' })).toThrow(
      /domain name/i,
    );
    expect(() =>
      buildTransferAuthorizationTypedData({ ...base, tokenName: 'USD Coin', tokenVersion: '' }),
    ).toThrow(/domain version/i);
  });

  it('refuses a zero amount, a bad address, a short nonce and an expired window', () => {
    const base = {
      tokenName: 'USD Coin',
      tokenVersion: '2',
      chainId: 8453,
      tokenAddress: TOKEN,
      from: ANVIL_ADDRESS,
      to: TREASURY,
      valueBaseUnits: 19_000_000n,
      validBefore: 1_800_000_000,
      nonce: NONCE,
    };
    expect(() => buildTransferAuthorizationTypedData({ ...base, valueBaseUnits: 0n })).toThrow(/positive/i);
    expect(() => buildTransferAuthorizationTypedData({ ...base, to: '0xnope' })).toThrow(/valid EVM address/i);
    expect(() => buildTransferAuthorizationTypedData({ ...base, nonce: '0xabcd' })).toThrow(/32 bytes/i);
    expect(() =>
      buildTransferAuthorizationTypedData({ ...base, validAfter: 200, validBefore: 100 }),
    ).toThrow(/validBefore/i);
    expect(() => buildTransferAuthorizationTypedData({ ...base, chainId: 0 })).toThrow(/chainId/i);
  });
});

/** The message with `uint256`s widened back to bigint, as viem's signer wants. */
function msg(typedData: ReturnType<typeof fixture>) {
  return {
    from: typedData.message.from,
    to: typedData.message.to,
    value: BigInt(typedData.message.value),
    validAfter: BigInt(typedData.message.validAfter),
    validBefore: BigInt(typedData.message.validBefore),
    nonce: typedData.message.nonce,
  };
}
