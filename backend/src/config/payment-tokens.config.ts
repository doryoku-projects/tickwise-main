/**
 * PAYMENT TOKEN LOGIC — the accept-list parser and the USD⇄base-unit money
 * conversions for the native on-chain rail.
 *
 * The DATA (`PAYMENT_TOKEN_REGISTRY`, `PAYMENT_CHAIN_NAMES`, the `PaymentToken`
 * shape) lives in `chains.config.ts`, with the rest of the chain knowledge —
 * see the long note there for why it is a standalone map and not part of the
 * `CHAINS` record. This file is the payment-facing module: it holds the logic,
 * imports the data, and re-exports it so payment code has one import site.
 *
 * ── DECIMALS ARE NOT DECORATION ────────────────────────────────────────────
 *
 * USDC and USDT are **6 decimals**, not 18. Getting this wrong by 12 orders of
 * magnitude means a customer sends 19 USDC and we look for 19,000,000,000,000 —
 * so nothing ever matches and the payment is silently lost. Every accepted
 * token's decimals is checked against the chain at boot (`TokenVerificationService`),
 * because an address+decimals typed from memory is right until it isn't.
 */

import {
  PAYMENT_CHAIN_EXPLORERS,
  PAYMENT_CHAIN_NAMES,
  PAYMENT_TOKEN_REGISTRY,
  paymentChainName,
  paymentTxUrl,
  type PaymentToken,
} from './chains.config.js';

// Re-exported so payment code imports tokens from the payment module rather
// than reaching into the chain config. The definitions live in chains.config.
export { PAYMENT_CHAIN_EXPLORERS, PAYMENT_CHAIN_NAMES, PAYMENT_TOKEN_REGISTRY, paymentChainName, paymentTxUrl };
export type { PaymentToken };

/**
 * Parse `PAYMENT_ACCEPTED_TOKENS` into the tokens we will take.
 *
 * TWO FORMS, comma-separated, and the second is the answer to "any other token
 * I want":
 *
 *   `USDC:8453`                              — a registry entry, by symbol+chain
 *   `MYTOK:8453:0xabc…:18`                   — fully specified, not in the registry
 *   `MYTOK:8453:0xabc…:18:volatile`          — …and explicitly not a stablecoin
 *
 * A fully-specified entry must state its decimals, because there is no safe
 * default: guessing 18 for a 6-decimal token makes every payment invisible.
 * `stable` defaults TRUE for a custom entry only because every realistic
 * subscription token is a stablecoin — and the provider independently refuses a
 * non-stable one until a rate-locking path exists, so the default cannot
 * silently enable something unpriced.
 *
 * A malformed entry THROWS rather than being skipped. This list decides what we
 * accept as money; a typo silently dropping a payment method is the kind of
 * failure that is discovered by a customer, not by us.
 */
export function parseAcceptedTokens(raw: string): PaymentToken[] {
  const out: PaymentToken[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const parts = entry.split(':').map((p) => p.trim());
    const [symbol, chainRaw, address, decimalsRaw, volatility] = parts;

    if (!symbol || !chainRaw) {
      throw new Error(`PAYMENT_ACCEPTED_TOKENS: '${entry}' is not SYMBOL:chainId[:address:decimals]`);
    }
    const chainId = Number(chainRaw);
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new Error(`PAYMENT_ACCEPTED_TOKENS: '${entry}' has an invalid chain id '${chainRaw}'`);
    }

    let token: PaymentToken;
    if (parts.length === 2) {
      const found = PAYMENT_TOKEN_REGISTRY[`${symbol.toUpperCase()}:${chainId}`];
      if (!found) {
        throw new Error(
          `PAYMENT_ACCEPTED_TOKENS: '${entry}' is not in the registry. Either add it to ` +
            `payment-tokens.config.ts, or specify it in full as ${symbol}:${chainId}:0x<address>:<decimals>. ` +
            `Known: ${Object.keys(PAYMENT_TOKEN_REGISTRY).join(', ')}`,
        );
      }
      token = found;
    } else {
      if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new Error(`PAYMENT_ACCEPTED_TOKENS: '${entry}' needs a 0x-prefixed 20-byte contract address`);
      }
      const decimals = Number(decimalsRaw);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new Error(
          `PAYMENT_ACCEPTED_TOKENS: '${entry}' must state its decimals (0–36). There is no safe default — ` +
            'assuming 18 for a 6-decimal token makes every payment invisible.',
        );
      }
      token = {
        chainId,
        symbol: symbol.toUpperCase(),
        address: address.toLowerCase(),
        decimals,
        stable: volatility !== 'volatile',
      };
    }

    // One entry per (chain, contract). A duplicate is a config mistake, and
    // silently de-duping it hides which of the two the operator meant.
    const key = `${token.chainId}:${token.address}`;
    if (seen.has(key)) {
      throw new Error(`PAYMENT_ACCEPTED_TOKENS: '${entry}' duplicates another entry for the same contract`);
    }
    seen.add(key);
    out.push({ ...token, address: token.address.toLowerCase() });
  }

  return out;
}

/**
 * USD minor units (cents) → the token's own base units, as a BigInt.
 *
 * `amountMinor` is hundredths of a dollar and a stablecoin is $1, so the whole
 * conversion is a power-of-ten shift by `decimals - 2`. Done in BigInt from end
 * to end: a naive `amountMinor / 100 * 10 ** decimals` goes through a float and
 * an 18-decimal token overflows 2^53 immediately.
 *
 * `decimals < 2` (a 0- or 1-decimal token) divides instead of multiplying and
 * cannot represent a cent, so it is refused rather than rounded — silently
 * truncating a price is how you undercharge every single customer.
 */
export function usdMinorToTokenBaseUnits(amountMinor: number, decimals: number): bigint {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error(`Cannot convert a non-integer or negative amount (${amountMinor}) to base units`);
  }
  if (decimals < 2) {
    throw new Error(
      `A ${decimals}-decimal token cannot represent cents; refusing to round an invoice amount to fit it`,
    );
  }
  return BigInt(amountMinor) * 10n ** BigInt(decimals - 2);
}

/**
 * The token's base units → USD minor units (cents). The exact inverse of
 * `usdMinorToTokenBaseUnits` above.
 *
 * Lives here, beside its inverse, rather than in whichever watcher happens to
 * need it — it is a money conversion, and the two directions drifting apart is
 * how a settlement stops matching the amount it was quoted at. (It previously
 * sat in the deposit rail's watcher, which is also why it survived that rail's
 * deletion: the conversion is the rail-independent part.)
 *
 * TRUNCATES rather than rounds, deliberately: this figure is what the fold
 * compares against `amountDueMinor`, and rounding UP would let a payment a
 * fraction of a cent short read as exact. The `$1` underpay tolerance is the
 * intended, explicit forgiveness mechanism — not floating-point luck.
 */
export function baseUnitsToUsdMinor(baseUnits: bigint, decimals: number): number {
  // A 0- or 1-decimal token cannot express cents; `usdMinorToTokenBaseUnits`
  // refuses to quote one at all, so nothing should ever settle in one.
  if (decimals < 2) return 0;
  const minor = baseUnits / 10n ** BigInt(decimals - 2);
  // Minor units fit a JS number comfortably (a $10M payment is 1e9 cents).
  // Clamped so a hostile huge value cannot overflow into Infinity downstream.
  return minor > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(minor);
}

/** Base units → a human string like `19.00`. Display only; never compared. */
export function formatTokenAmount(baseUnits: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = baseUnits / divisor;
  const frac = baseUnits % divisor;
  if (frac === 0n) return whole.toString();
  const padded = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${padded}`;
}
