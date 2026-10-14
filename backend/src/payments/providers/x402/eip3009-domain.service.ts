import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { decodeAbiParameters, type Hex } from 'viem';
import { AppConfigService } from '../../../config/app-config.service.js';
import { can } from '../../../common/process-role.js';
import type { PaymentToken } from '../../../config/payment-tokens.config.js';
import { EvmRpcClient } from './evm-rpc.client.js';
import {
  AUTHORIZATION_STATE_SELECTOR,
  DOMAIN_SEPARATOR_SELECTOR,
  NAME_SELECTOR,
  VERSION_SELECTOR,
  authorizationDomainSeparator,
} from './eip3009.js';

/**
 * How long a failed support probe is honoured before it is retried.
 *
 * Short enough that a node outage self-heals within a couple of minutes, long
 * enough that an accept-list containing a genuinely unsupported token does not
 * put an RPC timeout in front of every checkout.
 */
const PROBE_BACKOFF_MS = 60_000;

/** A token's verified EIP-712 domain — everything needed to compose an authorization. */
export interface Eip3009Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Hex;
}

/**
 * Reads each accepted token's EIP-712 domain FROM THE CHAIN, and proves it.
 *
 * ── WHY THIS SERVICE EXISTS AT ALL ─────────────────────────────────────────
 *
 * An EIP-3009 authorization is only spendable if our EIP-712 domain matches the
 * token's byte for byte. The domain contains a `name` and a `version` string,
 * and both are per-deployment facts we cannot know: USDC is `("USD Coin", "2")`
 * on its native deployments, but a BRIDGED USDC.e is a different contract with a
 * different name and often version `"1"` — and some deployments differ from the
 * flagship in ways no amount of reading documentation settles.
 *
 * Get it wrong and the failure is SILENT AND TOTAL: we hand the customer a
 * perfectly well-formed message, their wallet signs it happily, and the token
 * rejects the relay because the digest it computes is not the one that was
 * signed. Nothing in a typecheck, a unit test or a code review catches that.
 *
 * ── SO THE DOMAIN IS NEVER GUESSED, AND NEVER MERELY READ ───────────────────
 *
 * We read `name()` and `version()`, compute the domain separator ourselves, and
 * then compare it against the token's own `DOMAIN_SEPARATOR()` view. That
 * comparison is EXTERNAL GROUND TRUTH — the one kind of check that catches a
 * wrong-format derivation, which is the lesson this repo paid for in
 * `hd-address.service.ts` (a compressed public key produced plausible,
 * checksummed, completely unspendable addresses; only an outside vector caught
 * it). If our separator and the token's disagree, the token is NOT OFFERED. A
 * rail that cannot be paid must not be advertised.
 *
 * We additionally probe `authorizationState(address,bytes32)`. A token that does
 * not implement EIP-3009 has no such function and the call reverts, so this is
 * the cheap "does this token support the standard at all" gate — without it we
 * would happily offer a signing flow for USDT, where `transferWithAuthorization`
 * does not exist and every payment would fail at the last step.
 *
 * FAIL CLOSED, but distinguish the two failures. A DEFINITIVE mismatch (both
 * sides read, separators differ) marks the token permanently unsupported. An
 * RPC failure marks nothing — it is retried on the next call — because an
 * unreachable node must not permanently disable a payment method.
 */
@Injectable()
export class Eip3009DomainService implements OnModuleInit {
  private readonly logger = new Logger(Eip3009DomainService.name);

  /** Verified domains, by `chainId:tokenAddress`. Only ever holds PROVEN entries. */
  private readonly verified = new Map<string, Eip3009Domain>();
  /** Tokens proven NOT usable — a definitive mismatch, never a transport error. */
  private readonly rejected = new Map<string, string>();
  /** One RPC client per chain. See `clientFor`. */
  private readonly clients = new Map<number, EvmRpcClient>();
  /** Short backoff after a failed support probe, by cache key. NOT a rejection. */
  private readonly probeFailedUntil = new Map<string, number>();

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  /**
   * Verify every accepted token at boot, so a misconfiguration is a startup log
   * and not a customer's failed payment.
   *
   * Gated on `x402PaymentsConfigured` rather than on `PAYMENTS_PROVIDER === 'x402'`
   * — the same correction the on-chain rail already needed. A deployment running
   * another rail as its default while x402 is also configured (a migration, a
   * renewal on an older subscription) would otherwise settle authorizations
   * against a never-verified domain.
   *
   * Never throws: a boot that fails because an RPC endpoint was briefly down is
   * a worse outcome than a rail that verifies lazily on first use.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config.x402PaymentsConfigured) return;
    // P2.1: the boot verification runs where payments are offered or settled
    // (all, api, sync). A fee / feeder process never quotes nor settles, so it
    // skips the boot RPC reads; `resolve` still verifies lazily on first use.
    if (!can('token-verification')) return;
    const accepted = this.config.acceptedPaymentTokens;
    // Say WHAT is accepted and WHERE it came from. The list is normally DERIVED
    // from `EVM_RPC_URLS` × the token registry, so an operator who adds an
    // endpoint should be able to see the consequence in one line rather than infer
    // it from which payments start working.
    this.logger.log(
      `x402 accepting ${accepted.map((t) => `${t.symbol}:${t.chainId}`).join(', ') || 'nothing'} ` +
        `(${this.config.acceptedTokensAreDerived ? 'derived from EVM_RPC_URLS × token registry' : 'explicit PAYMENT_ACCEPTED_TOKENS'})`,
    );
    for (const token of accepted) {
      try {
        await this.resolve(token);
        this.logger.log(`EIP-3009 domain verified for ${token.symbol} on chain ${token.chainId}`);
      } catch (err) {
        this.logger.warn(
          `[alert] x402.domain_unverified ${token.symbol} chain ${token.chainId} — ` +
            `${(err as Error).message}. This token will not be offered until it verifies.`,
        );
      }
    }
  }

  /** Whether a token is usable on this rail right now. Never throws. */
  async isSupported(token: PaymentToken): Promise<boolean> {
    try {
      await this.resolve(token);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The token's proven domain, verifying on first use.
   *
   * THROWS rather than returning null, and the two throw reasons are different
   * on purpose: a definitive mismatch is permanent (the cached rejection is
   * re-thrown without another RPC round trip), while a transport failure is not
   * cached at all so the next checkout retries.
   */
  async resolve(token: PaymentToken): Promise<Eip3009Domain> {
    const key = cacheKey(token);
    const cached = this.verified.get(key);
    if (cached) return cached;

    const priorRejection = this.rejected.get(key);
    if (priorRejection) {
      throw new Error(`${token.symbol} on chain ${token.chainId} is not usable: ${priorRejection}`);
    }

    const rpc = this.clientFor(token.chainId);
    if (!rpc) {
      // Not cached as a rejection: an operator adding the endpoint should not
      // have to restart to clear a permanent mark.
      throw new Error(`no EVM_RPC_URLS entry for chain ${token.chainId}`);
    }

    // A recent probe failure is honoured WITHOUT another RPC round trip. Not a
    // permanent rejection — see below — but not a free 10-second timeout on
    // every checkout either: with a token that does not implement EIP-3009
    // (USDT) in the accept-list, `selectToken` walks the list SEQUENTIALLY, so
    // an uncached failure put a full RPC timeout per unusable token in front of
    // every single checkout request.
    const backoffUntil = this.probeFailedUntil.get(key) ?? 0;
    if (backoffUntil > Date.now()) {
      throw new Error(
        `${token.symbol} on chain ${token.chainId} failed its EIP-3009 probe recently; ` +
          'not retried yet',
      );
    }

    // The EIP-3009 support probe FIRST — cheapest way to reject a token that
    // simply does not implement the standard, before we care about its domain.
    // `authorizationState(0x0…0, 0x0…0)` is a view returning a bool; on a token
    // without it, the call reverts.
    try {
      await rpc.ethCall(token.address, `${AUTHORIZATION_STATE_SELECTOR}${'0'.repeat(128)}`);
    } catch (err) {
      // NEVER cached as permanent — a token cannot be disabled forever because a
      // node hiccuped. But the two failure kinds ARE distinguishable, and the
      // distinction decides whether we back off at all:
      //
      //  - A REVERT comes back as a JSON-RPC error response, which
      //    `EvmRpcClient` surfaces with an `rpc error:` prefix. That means the
      //    node answered and the function is not there — the token genuinely does
      //    not implement EIP-3009 (USDT). Worth a short backoff, because
      //    `selectToken` walks the accept-list SEQUENTIALLY and an uncached
      //    failure puts a full 10-second RPC timeout in front of every checkout.
      //  - A TRANSPORT failure (connection refused, DNS, timeout) never reaches
      //    the node's JSON-RPC layer. NO backoff: the next checkout must retry
      //    immediately, or a 30-second blip becomes a 90-second payment outage of
      //    our own making.
      if (looksLikeRevert(err)) {
        this.probeFailedUntil.set(key, Date.now() + PROBE_BACKOFF_MS);
      }
      throw new Error(
        `${token.symbol} did not answer authorizationState() — it may not implement EIP-3009 ` +
          `(or the node is unreachable): ${(err as Error).message}`,
      );
    }
    this.probeFailedUntil.delete(key);

    const [nameRaw, versionRaw, onChainSeparator] = await Promise.all([
      rpc.ethCall(token.address, NAME_SELECTOR),
      rpc.ethCall(token.address, VERSION_SELECTOR),
      rpc.ethCall(token.address, DOMAIN_SEPARATOR_SELECTOR),
    ]);

    const name = decodeString(nameRaw);
    const version = decodeString(versionRaw);
    if (!name || !version) {
      throw new Error(`${token.symbol} returned an unreadable name()/version()`);
    }

    const domain: Eip3009Domain = {
      name,
      version,
      chainId: token.chainId,
      verifyingContract: token.address as Hex,
    };

    // ── THE GROUND-TRUTH CHECK. ──
    const ours = authorizationDomainSeparator(domain).toLowerCase();
    const theirs = normaliseBytes32(onChainSeparator);
    if (!theirs) {
      throw new Error(`${token.symbol} returned an unreadable DOMAIN_SEPARATOR()`);
    }
    if (ours !== theirs) {
      // DEFINITIVE: both sides were read and they disagree. Cached permanently —
      // no retry can fix a domain we compute differently from the token, and
      // continuing to offer it would produce signatures nobody can spend.
      const reason =
        `computed EIP-712 domain separator ${ours} does not match the token's own ${theirs} ` +
        `(name='${name}', version='${version}') — signatures would be unspendable`;
      this.rejected.set(key, reason);
      this.logger.error(`[alert] x402.domain_mismatch ${token.symbol} chain ${token.chainId} — ${reason}`);
      throw new Error(reason);
    }

    this.verified.set(key, domain);
    return domain;
  }

  /**
   * The RPC client for a chain, or `undefined` when none is configured.
   *
   * A method rather than an inline `new EvmRpcClient(...)` for the same reason
   * `X402PaymentProvider.clientFor` is one: it is the seam a spec overrides to
   * drive this service against scripted `eth_call` responses. Without it the
   * domain-mismatch refusal — the whole point of this file — could only be
   * tested against a live chain, which means it would not be tested.
   */
  private clientFor(chainId: number): EvmRpcClient | undefined {
    const cached = this.clients.get(chainId);
    if (cached) return cached;
    const url = this.config.evmRpcUrls.get(chainId);
    if (!url) return undefined;
    const client = new EvmRpcClient(chainId, url);
    this.clients.set(chainId, client);
    return client;
  }
}

function cacheKey(token: PaymentToken): string {
  return `${token.chainId}:${token.address.toLowerCase()}`;
}

/**
 * Whether a probe failure came from the NODE (a revert) rather than from the
 * network never reaching it.
 *
 * `EvmRpcClient` throws `<method> rpc error: <message>` for a JSON-RPC error
 * response and lets transport errors (undici's ECONNREFUSED / DNS / abort)
 * propagate with their own messages, so the prefix is the discriminator. Erring
 * toward "transport" is the safe direction: it only costs a retry, whereas
 * mislabelling an outage as a revert delays a real payment.
 */
function looksLikeRevert(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  return message.includes('rpc error') || message.includes('revert');
}

/** ABI-decode a `string` return value. Returns '' when unreadable. */
function decodeString(raw: string): string {
  try {
    const [value] = decodeAbiParameters([{ type: 'string' }], raw as Hex);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** A 32-byte return value, lowercased and 0x-prefixed. '' when unreadable. */
function normaliseBytes32(raw: string): string {
  const clean = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return /^0x[0-9a-f]{64}$/.test(clean) ? clean : '';
}
