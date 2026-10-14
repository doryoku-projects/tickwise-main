import { randomBytes } from 'node:crypto';
import {
  getAddress,
  hashDomain,
  isAddress,
  recoverTypedDataAddress,
  type Hex,
  type TypedDataDomain,
} from 'viem';

/**
 * EIP-3009 `transferWithAuthorization` — the money math, as a PURE module.
 *
 * WHAT THIS RAIL IS. The customer signs an EIP-712 authorization off-chain
 * saying "move exactly `value` of this token from me to the treasury, once,
 * before `validBefore`". Anyone may then relay that signature to the TOKEN
 * CONTRACT, which verifies it and performs the transfer itself. So:
 *
 *  - There is NO contract to deploy. `transferWithAuthorization` is a function
 *    inside USDC (Circle's FiatToken) — audited, already live.
 *  - Funds land DIRECTLY in the treasury. No per-invoice address, no xpub, no
 *    sweep.
 *  - The relayer cannot steal: `from`, `to`, `value` and `nonce` are all inside
 *    the signed struct, so changing any of them invalidates the signature and
 *    the token reverts. A compromised relayer can waste its own gas and nothing
 *    else.
 *
 * ── THE SERVER COMPOSES THE MESSAGE, NEVER THE CLIENT ──────────────────────
 *
 * Exactly the rule `siwe.service.ts` already follows, and for the same reason:
 * we build the full typed data, store what we issued, and the client returns
 * only a signature. We never parse an attacker-supplied EIP-712 payload, which
 * removes the whole "the parser and the verifier disagreed" attack class.
 *
 * ── WHY THIS FILE IS PURE ──────────────────────────────────────────────────
 *
 * No Nest, no Mongo, no RPC. The digest either matches what the token computes
 * or every payment on this rail silently fails, so it must be exhaustively
 * testable from a plain object literal — and, critically, verifiable against
 * GROUND TRUTH OUTSIDE THIS CODEBASE. See `authorizationDigest`: the digest is
 * derived a second, independent way in the spec, because this repo has already
 * shipped a derivation bug that "returned a plausible value" and typechecked
 * (the compressed-vs-uncompressed pubkey in `hd-address.service.ts`). A test
 * that compares this module against its own output would prove nothing.
 */

/**
 * The EIP-3009 struct, verbatim from the standard.
 *
 * THE FIELD ORDER IS PART OF THE HASH. EIP-712 encodes the type as
 * `TransferWithAuthorization(address from,address to,uint256 value,uint256
 * validAfter,uint256 validBefore,bytes32 nonce)` — reorder these entries and
 * the typehash changes, the digest changes, and the token rejects every
 * signature with no explanation beyond a revert. Do not "tidy" this list.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * The canonical EIP-712 type string for the struct above.
 *
 * Exported so a test can `keccak256` it directly and assert the typehash our
 * types object produces — the independent check that the array above matches
 * the standard rather than merely matching itself.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPE_STRING =
  'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)';

export const TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE = 'TransferWithAuthorization' as const;

/**
 * `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)`
 * — the 4-byte selector the relayer calls.
 *
 * Deliberately the `bytes signature` overload, not the `(v, r, s)` one: passing
 * one opaque signature blob is what lets a future EIP-1271 contract-wallet
 * signature go through the same path unchanged, whereas splitting into v/r/s
 * bakes in an ECDSA-only assumption at the call site.
 *
 * THE TWO OVERLOADS ARE EASY TO CONFUSE AND THE SPEC IS PINNED IN A TEST for
 * that reason — the first draft of this file had `0xe3ee160e` here, which is the
 * `(v, r, s)` overload. Calling it with a packed 65-byte signature would have
 * been decoded as garbage `uint8`/`bytes32`/`bytes32` arguments and reverted (or
 * worse, been silently misread), and nothing in a typecheck or a unit test that
 * only compared this constant against itself would have noticed. Every selector
 * in this file is asserted against `keccak256` of its signature in
 * `eip3009.spec.ts`.
 *   bytes-signature overload : 0xcf092995  ← the one we use
 *   (v, r, s) overload       : 0xe3ee160e
 */
export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = '0xcf092995';

/**
 * The `(v, r, s)` overload's selector, exported ONLY so the spec can assert we
 * are not using it. Not called anywhere.
 */
export const TRANSFER_WITH_AUTHORIZATION_VRS_SELECTOR = '0xe3ee160e';

/**
 * `receiveWithAuthorization` is DELIBERATELY NOT USED, and this comment is the
 * guard against somebody adding it.
 *
 * It is the same transfer with one extra rule: `msg.sender` must equal `to`.
 * That would force the TREASURY key onto whatever machine relays the
 * transaction — i.e. put a fund-controlling key on the API server, destroying
 * the entire custody argument for this rail. `transferWithAuthorization` lets a
 * throwaway gas-only account submit on the treasury's behalf. If you ever find
 * yourself reaching for `receiveWithAuthorization`, the answer is no.
 */
export const RECEIVE_WITH_AUTHORIZATION_IS_FORBIDDEN = true;

/** `DOMAIN_SEPARATOR()` — read from the token to prove our domain is right. */
export const DOMAIN_SEPARATOR_SELECTOR = '0x3644e515';
/** `version()` — the EIP-712 domain version, read from the token, never guessed. */
export const VERSION_SELECTOR = '0x54fd4d50';
/** `name()` — the EIP-712 domain name, read from the token, never guessed. */
export const NAME_SELECTOR = '0x06fdde03';
/** `authorizationState(address,bytes32)` — has this nonce already been spent. */
export const AUTHORIZATION_STATE_SELECTOR = '0xe94a0102';
/** `balanceOf(address)` — checked BEFORE a customer is asked to sign. */
export const BALANCE_OF_SELECTOR = '0x70a08231';

/**
 * The EIP-712 domain's own type list.
 *
 * MUST BE SENT TO THE WALLET. `eth_signTypedData_v4` takes a raw JSON payload and
 * the spec requires `types` to declare `EIP712Domain` — the wallet uses it to know
 * WHICH domain fields to hash and in what order. Omit it and the wallet has to
 * guess: some refuse, and some sign a digest built from a domain shape of their
 * own choosing, which produces a perfectly valid signature over the WRONG message.
 * Recovery then yields an address that is not the signer's and verification fails
 * with nothing to point at.
 *
 * It does NOT change the digest on our side — `hashTypedData` derives the domain
 * type from the domain object either way, verified by probe — so including it is
 * free and removes the ambiguity. `viem`'s own `signTypedData` inserts this for
 * exactly the same reason; we hit it because the browser calls the raw RPC method.
 */
export const EIP712_DOMAIN_TYPE = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
} as const;

/**
 * `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` —
 * `keccak256` of the event signature.
 *
 * The watcher's topic0. NOTE for whoever writes that watcher: this event alone
 * is NOT sufficient to settle an invoice. An EIP-3009 nonce is unique only PER
 * AUTHORIZER (`authorizationState[authorizer][nonce]`), so a customer can spend
 * the same nonce value from a second wallet of their own. Settlement MUST also
 * check the paired `Transfer` in the same transaction for `to == treasury`,
 * `from == authorizer` and the exact expected `value`. See
 * `PaymentAuthorization.expectedBaseUnits`.
 */
export const AUTHORIZATION_USED_TOPIC =
  '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';

/** One issued authorization, as the typed data a wallet is asked to sign. */
export interface AuthorizationTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Hex;
  };
  /** Includes `EIP712Domain` — required by `eth_signTypedData_v4`. See the constant. */
  types: typeof EIP712_DOMAIN_TYPE & typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
  primaryType: typeof TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE;
  message: {
    from: Hex;
    to: Hex;
    /**
     * DECIMAL STRING, not a number or a bigint.
     *
     * This crosses to the browser as JSON, and `JSON.stringify` cannot serialise
     * a bigint at all while a `number` silently loses the low digits of an
     * 18-decimal amount past 2^53. The same rule the rest of this subsystem
     * follows for chain amounts. `viem` accepts a decimal string for a
     * `uint256`, and the verifier below re-parses it with `BigInt`.
     */
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
}

export interface BuildAuthorizationArgs {
  /** EIP-712 domain name, READ FROM THE TOKEN. Never a hardcoded guess. */
  tokenName: string;
  /** EIP-712 domain version, READ FROM THE TOKEN. USDC is `'2'`; others differ. */
  tokenVersion: string;
  chainId: number;
  /** The token contract — the EIP-712 `verifyingContract`. */
  tokenAddress: string;
  /** The payer's wallet. */
  from: string;
  /** The treasury. Inside the signed struct, which is why a relayer is harmless. */
  to: string;
  /** Money. The token's own base units. */
  valueBaseUnits: bigint;
  /** Unix SECONDS. Not before this. `0` = immediately valid. */
  validAfter?: number;
  /** Unix SECONDS. The authorization dies here. */
  validBefore: number;
  /**
   * Unix SECONDS, optional. When supplied, a `validBefore` already in the PAST is
   * refused.
   *
   * Optional so the module stays pure and every spec can exercise the arithmetic
   * without a clock, and CHECKED rather than clamped because a caller composing a
   * payload that is dead on arrival has a bug upstream — silently extending it
   * would hide that, and refusing is free. The issuing service always passes it.
   */
  nowSeconds?: number;
  /** 32-byte hex from `randomAuthorizationNonce()`. */
  nonce: string;
}

/**
 * Compose the typed data for one authorization.
 *
 * Every value is normalised on the way in — addresses to checksum form, amounts
 * to decimal strings — so the object stored at issue time and the object the
 * browser signs are byte-identical. If they diverge by so much as an address's
 * casing the recovered signer will not match and the payment is refused.
 */
export function buildTransferAuthorizationTypedData(
  args: BuildAuthorizationArgs,
): AuthorizationTypedData {
  if (!args.tokenName) throw new Error('EIP-712 domain name is required (read it from the token)');
  if (!args.tokenVersion) {
    throw new Error('EIP-712 domain version is required (read it from the token)');
  }
  if (!Number.isInteger(args.chainId) || args.chainId <= 0) {
    throw new Error(`Invalid chainId '${args.chainId}' for an EIP-3009 authorization`);
  }
  if (args.valueBaseUnits <= 0n) {
    throw new Error('An authorization must be for a positive amount');
  }
  const validAfter = Math.max(0, Math.floor(args.validAfter ?? 0));
  const validBefore = Math.floor(args.validBefore);
  if (!Number.isFinite(validBefore) || validBefore <= validAfter) {
    throw new Error('validBefore must be a finite time after validAfter');
  }
  if (args.nowSeconds !== undefined && validBefore <= args.nowSeconds) {
    throw new Error('validBefore is already in the past — the authorization would be unspendable');
  }

  return {
    domain: {
      name: args.tokenName,
      version: args.tokenVersion,
      chainId: args.chainId,
      verifyingContract: requireAddress(args.tokenAddress, 'tokenAddress'),
    },
    types: { ...EIP712_DOMAIN_TYPE, ...TRANSFER_WITH_AUTHORIZATION_TYPES },
    primaryType: TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
    message: {
      from: requireAddress(args.from, 'from'),
      to: requireAddress(args.to, 'to'),
      value: args.valueBaseUnits.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce: requireNonce(args.nonce),
    },
  };
}

/**
 * The EIP-712 domain separator for a token's domain.
 *
 * THE POINT OF THIS FUNCTION IS TO BE CHECKED AGAINST THE CHAIN. The token
 * exposes `DOMAIN_SEPARATOR()`; comparing our computed value against that one
 * is the external ground truth that catches a wrong `name`, a wrong `version`
 * (USDC is `'2'`, and a bridged deployment may not be), or the wrong chain id —
 * every one of which yields a perfectly well-formed signature that the contract
 * then rejects. `Eip3009DomainService` performs that comparison at boot and
 * refuses to offer the rail if it fails.
 */
export function authorizationDomainSeparator(domain: AuthorizationTypedData['domain']): Hex {
  return hashDomain({
    // Passed CONCRETELY, not widened to `TypedDataDomain`: viem infers the
    // required domain fields from the `types` below, and the widened type makes
    // `name` optional, which no longer satisfies it.
    //
    // `chainId` is widened to a bigint because that is what viem's inference
    // demands for a `uint256`. Numerically and in ABI encoding this is identical
    // — `8453` and `8453n` encode to the same 32 bytes — and the separator is
    // pinned by value in `eip3009.spec.ts` so a change here cannot pass quietly.
    domain: { ...domain, chainId: BigInt(domain.chainId) },
    // `types` is REQUIRED by viem here, and the four fields must be listed in
    // this order: the domain separator is `keccak256` over the ABI-encoded
    // struct, so the order is part of the hash exactly as it is for the
    // authorization itself. Circle's FiatToken domain has no `salt`, so listing
    // one would compute a separator the token never produces.
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  });
}

/**
 * Recover the signer of an authorization and confirm it is the expected wallet.
 *
 * ECDSA ONLY, and that limit is stated rather than hidden: a Safe or ERC-4337
 * account signs per EIP-1271, whose validity can only be settled by an
 * on-chain `isValidSignature` call, so those wallets are refused here rather
 * than silently mis-verified. `siwe.service.ts` has exactly the same limitation
 * today. When contract wallets are supported, the fallback belongs in the
 * service that has RPC access — not here, because this module must stay pure.
 *
 * Never throws on a malformed signature: a bad signature is ordinary caller
 * input on an authenticated route, and a throw would turn it into a 500.
 */
export async function verifyAuthorizationSignature(args: {
  typedData: AuthorizationTypedData;
  signature: string;
}): Promise<{ valid: boolean; recovered?: string; reason?: string }> {
  const signature = typeof args.signature === 'string' ? args.signature.trim() : '';
  // 65 bytes — r (32) + s (32) + v (1). Checked before recovery so a truncated
  // value is a clean refusal rather than a library throw.
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { valid: false, reason: 'signature is not a 65-byte hex string' };
  }
  // ── Reject a MALLEATED (high-s) signature here rather than at the relay. ──
  //
  // For any valid ECDSA signature `(r, s)`, `(r, n - s)` recovers the same
  // signer, so a third party can mutate a signature in flight and it still
  // "verifies". OpenZeppelin's ECDSA — which Circle's FiatToken uses — refuses
  // the high half, so a malleated signature passes our recovery and then REVERTS
  // at the token. Accepting it would mean telling the customer their payment is
  // authorized, spending gas on a relay that cannot succeed, and leaving an
  // invoice stuck `authorized` with nothing to diagnose. Cheaper and clearer to
  // refuse it at the door and ask them to sign again.
  if (isHighS(signature)) {
    return { valid: false, reason: 'signature has a high s value and would be rejected on-chain' };
  }

  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      // Passed CONCRETELY with `chainId` widened to a bigint, for the same reason
      // as `authorizationDomainSeparator`: now that `types` declares
      // `EIP712Domain`, viem infers the domain's field types from it and wants a
      // bigint for the `uint256`. Numerically and in ABI encoding this is
      // identical — proven by probe — so the digest is unchanged.
      domain: { ...args.typedData.domain, chainId: BigInt(args.typedData.domain.chainId) },
      types: args.typedData.types,
      primaryType: args.typedData.primaryType,
      // `viem` wants a bigint for a uint256; the stored form is a decimal string
      // precisely so it can survive JSON, so it is re-widened here.
      message: {
        from: args.typedData.message.from,
        to: args.typedData.message.to,
        value: BigInt(args.typedData.message.value),
        validAfter: BigInt(args.typedData.message.validAfter),
        validBefore: BigInt(args.typedData.message.validBefore),
        nonce: args.typedData.message.nonce,
      },
      signature: signature as Hex,
    });
  } catch (err) {
    return { valid: false, reason: `signature could not be recovered: ${(err as Error).message}` };
  }

  // Case-insensitive by construction: both sides go through `getAddress`, so a
  // wallet returning a lowercase address is not a mismatch.
  const expected = getAddress(args.typedData.message.from);
  if (getAddress(recovered) !== expected) {
    return { valid: false, recovered, reason: 'signature is not from the wallet it claims' };
  }
  return { valid: true, recovered };
}

/**
 * A fresh authorization nonce: 32 random bytes.
 *
 * RANDOM, NOT SEQUENTIAL. EIP-3009 nonces are an arbitrary 32-byte value the
 * token marks as spent, not a counter — so randomness costs nothing and removes
 * any chance of two invoices being issued the same nonce by a racing counter.
 * `randomBytes`, never `Math.random`: this value is what links a payment to an
 * invoice, and a guessable one lets somebody front-run an authorization we have
 * not issued yet.
 */
export function randomAuthorizationNonce(): Hex {
  return `0x${randomBytes(32).toString('hex')}`;
}

/**
 * secp256k1's group order `n`, and the half above which `s` is "high".
 *
 * Hard-coded because it is a mathematical constant of the curve, not a
 * configuration value — and asserted in the spec against `@noble/curves`'
 * own `secp256k1.CURVE.n`, so it is pinned to an external source rather than to
 * my typing.
 */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

/** Whether a 65-byte signature's `s` lies in the upper half of the curve order. */
function isHighS(signature: string): boolean {
  // Bytes 32..64 are `s`: 2 chars for `0x`, then 64 chars of `r`.
  const s = BigInt(`0x${signature.slice(2 + 64, 2 + 128)}`);
  return s > SECP256K1_HALF_N;
}

function requireAddress(value: string, field: string): Hex {
  if (typeof value !== 'string' || !isAddress(value.trim(), { strict: false })) {
    throw new Error(`'${field}' is not a valid EVM address`);
  }
  return getAddress(value.trim());
}

function requireNonce(value: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.trim())) {
    throw new Error('An EIP-3009 nonce must be 32 bytes of hex');
  }
  return value.trim().toLowerCase() as Hex;
}
