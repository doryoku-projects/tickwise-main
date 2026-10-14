import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Per-chain token record (`{chainId}_tokens`) — the single home for a token's
 * structured GoPlus security signals AND its current USD price (last-known-good).
 * Sharded by chain via `CollectionResolver.tokenModel` (security + price are
 * protocol-agnostic), mirroring positions/prices. NEVER `@InjectModel` this.
 *
 * There is NO `verified` boolean: spam is computed at read-time from the raw
 * signals (see `TokensRepository.findSpamAddresses` / `isSpamSignals`) so the
 * rule is tunable without a re-sweep and no denormalized verdict can drift.
 */
@Schema({ timestamps: false })
export class Token {
  @Prop({ type: Number, required: true })
  chainId: number;

  @Prop({ type: String, required: true, lowercase: true })
  address: string;

  // ─── Current price (last-known-good; written by the pricing layer) ───
  /** Current USD price. Live (current-only), sourced from
   * external aggregators + trust gates, not raw derivedETH. Persisted only for
   * NON-pool-derived (trusted) quotes, so it's safe to serve as last-known. */
  @Prop({ type: Number, default: 0 }) priceUsd: number;
  /** When `priceUsd` was last written (freshness window for last-known-good). */
  @Prop({ type: Date }) pricedAt?: Date;
  /** Cross-source confidence for `priceUsd`: `external-verified` (≥2 sources
   * agreed = consensus) | `external-unverified` (single/discordant source). */
  @Prop({ type: String }) priceConfidence?: string;
  /** Provider names that backed `priceUsd` (the agreeing cluster). */
  @Prop({ type: [String] }) priceSources?: string[];
  /** Best 24h DEX volume (USD) seen across the token's DexScreener pairs, from
   * the consensus sweep. The activity signal for the active-market gate. */
  @Prop({ type: Number }) dexVolume24h?: number;
  /** Counter-side (quote-token) reserve of the deepest DEX pair, in USD, from
   * the consensus sweep. The wash-resistant activity signal — GPCG holds $9.52
   * of USDC vs RPC's $10,980. Absent = UNKNOWN (no DEX source supplied it), NOT
   * zero. Gated by `DEX_MARKET_MIN_COUNTER_LIQUIDITY_USD`. */
  @Prop({ type: Number }) dexCounterLiquidity?: number;
  /** The active-market verdict baked at sweep time: a DEX source priced it AND
   * `dexVolume24h >= DEX_MARKET_MIN_VOLUME_USD` AND (counter UNKNOWN OR
   * `dexCounterLiquidity >= DEX_MARKET_MIN_COUNTER_LIQUIDITY_USD`). true = real
   * active market (RPC), false = no DEX pair OR dead/seeded pool (BT77/GOLDX/
   * GPCG). Read by the value gate (normalize) + the leaderboard no-market
   * exclusion (read-time). */
  @Prop({ type: Boolean }) dexActive?: boolean;
  /*
   * External-price miss ledger (`PRICE_MISS_LEDGER=on`, `pricing/price-ledger.ts`).
   * `priceMissStreak` consecutive healthy "no price" answers from every
   * external aggregator, the latest at `priceMissAt`; the token is not re-asked
   * until `priceMissAt + ladder(streak)` (30 min → 1 h → 2 h → 6 h). Both are
   * `$unset` the moment any provider prices it. DECLARED because Mongoose
   * strict mode silently drops an undeclared path from `$set`/`$inc` — an
   * undeclared streak would read 0 forever and the ladder would never climb.
   * Absent = no entry (asked as today). Never read for `subgraph-current` /
   * pool-ratio pricing.
   */
  @Prop({ type: Date }) priceMissAt?: Date;
  @Prop({ type: Number }) priceMissStreak?: number;

  // ─── Quote provenance + guard evidence (2026-10-05, `pricing/token-trust.ts`) ───
  // Written ONLY when `PRICE_QUOTE_GUARD=on`, `TOKEN_TRUST_SHADOW=on` or
  // `TOKEN_TRUST_MODE=earned` / `combined` (off by default = today's writes,
  // byte for byte).
  // DECLARED because Mongoose strict mode silently drops undeclared paths.
  /** Provider that supplied `priceUsd` on the hot path (`dia`, `defillama`, …) — the sweep writes its cluster in `priceSources`. */
  @Prop({ type: String }) priceQuoteSource?: string;
  /** When the PROVIDER dated the quote behind `priceUsd` (DIA `Time`, DeFiLlama `timestamp`); absent = a live, undated answer. */
  @Prop({ type: Date }) priceQuotedAt?: Date;
  /** Sweep: providers whose quote the guard rejects / would reject (`dia:stale`, `dia:thin`, `defillama:stale`). */
  @Prop({ type: [String], default: undefined }) priceQuoteRejected?: string[];
  /** Sweep: the consensus price over ONLY the quotes the guard accepts (0 = none would remain). Shadow evidence for the impact report. */
  @Prop({ type: Number }) priceGuardUsd?: number;
  /**
   * Sweep: ≥ 2 quotes the guard accepts were positive and did NOT agree within
   * 10% (the stored price is their conservative MIN). Under the guard such a
   * listed token is not upgraded to `external-verified` on its listing — a
   * token with ONE source is not a disagreement and keeps today's upgrade.
   * Re-derived by every evidence sweep; NOT erased by a hot-path price write
   * (it is a verdict on the token's sources, not provenance of one write).
   */
  @Prop({ type: Boolean }) priceSourcesDisagreed?: boolean;
  /**
   * The `pricedAt` of the write that carried the provenance / guard fields
   * above (`priceQuoteSource`, `priceQuotedAt`, `priceQuoteRejected`,
   * `priceGuardUsd` — a write carrying any of them unsets the others). Those fields describe the CURRENT price only while this equals
   * `pricedAt`: a later price write that carries none (flags switched back off)
   * leaves them describing an older price, and readers (the purge script, the
   * impact report) must then ignore them.
   */
  @Prop({ type: Date }) priceEvidenceAt?: Date;
  /** Set when the guard cleared a saved price that only a rejected quote supported (sweep or `scripts/purge-stale-prices.mjs`). */
  @Prop({ type: Date }) pricePurgedAt?: Date;
  @Prop({ type: String }) pricePurgedReason?: string;

  // ─── Earned trust (`TOKEN_TRUST_MODE=earned` / `combined`; stored in shadow too) ───
  /** The sweep's earned-trust verdict (all four criteria held). Re-derived every sweep; ages out after `PRICE_QUOTE_MAX_AGE_MS`. */
  @Prop({ type: Boolean }) trustEarned?: boolean;
  /** `earned` | the first failed criterion: `stale-quote` | `single-source` | `no-dex-market` | `single-pool`. */
  @Prop({ type: String }) trustReason?: string;
  @Prop({ type: Date }) trustEvaluatedAt?: Date;
  /** Fresh sources that agreed (criterion a). */
  @Prop({ type: [String], default: undefined }) trustSources?: string[];
  /** Criterion (c): DEX pools that count (counter side ≥ the per-pool floor and balanced), their counter-side USD outside the deepest pool, the deepest pool's counter USD / share / id. */
  @Prop({ type: Number }) dexPoolCount?: number;
  @Prop({ type: Number }) dexOutsideLiquidityUsd?: number;
  @Prop({ type: Number }) dexTopCounterUsd?: number;
  @Prop({ type: Number }) dexTopCounterShare?: number;
  @Prop({ type: String }) dexTopPoolId?: string;
  /**
   * EMERGENCY DENY, set by hand (`db['1_tokens'].updateOne({address}, {$set:{trustDenied:true}})`):
   * never trusted, excluded from ranked lists — in `TOKEN_TRUST_MODE=earned` /
   * `combined` only (the modes in which every trust reader loads this
   * document — `usesStoredVerdicts`). In `allowlist` mode use
   * `TOKEN_TRUST_DENY` (env), which works in every mode.
   */
  @Prop({ type: Boolean }) trustDenied?: boolean;

  /** Token metadata (from the pricing/sync layer). */
  @Prop({ type: String }) symbol?: string;
  @Prop({ type: Number }) decimals?: number;

  // ─── Structured GoPlus signals (decoded from the '1'/'0' string flags) ───
  // The hard scam flags that drive the read-time spam rule (four, plus `fakeToken`):
  @Prop({ type: Boolean, default: false }) isHoneypot: boolean;
  @Prop({ type: Boolean, default: false }) isBlacklisted: boolean;
  @Prop({ type: Boolean, default: false }) cannotSellAll: boolean;
  @Prop({ type: Boolean, default: false }) personalSlippageModifiable: boolean;
  /**
   * GoPlus `fake_token.value === 1` (2026-10-06): GoPlus itself names a
   * different contract as the real token — a fake USDT on chain 1
   * (0x3173…f752) carries `true_token_address` = Tether's and nothing else.
   * Part of the read-time spam rule (`isSpamSignals`). DECLARED because
   * Mongoose strict mode silently drops an undeclared path from `$set`.
   * Rows the sweep wrote before this field existed read `false` until their
   * 7-day GoPlus cache expires and the sweep re-checks them.
   */
  @Prop({ type: Boolean, default: false }) fakeToken: boolean;
  // Extra risk/quality signals (stored for the UI + future rule tuning):
  @Prop({ type: Boolean, default: false }) cannotBuy: boolean;
  @Prop({ type: Boolean, default: false }) honeypotWithSameCreator: boolean;
  @Prop({ type: Boolean, default: false }) trustList: boolean; // GoPlus's own allowlist
  @Prop({ type: Boolean, default: false }) isOpenSource: boolean;
  @Prop({ type: Boolean, default: false }) isProxy: boolean;
  @Prop({ type: Number, default: 0 }) buyTax: number; // fraction, e.g. 0.05 = 5%
  @Prop({ type: Number, default: 0 }) sellTax: number;
  @Prop({ type: Number, default: 0 }) holderCount: number;
  @Prop({ type: Number, default: 0 }) creatorPercent: number; // fraction of supply
  @Prop({ type: String }) tokenName?: string;
  @Prop({ type: String }) tokenSymbol?: string;

  /** When the GoPlus security check last ran (distinct from `pricedAt`). */
  @Prop({ type: Date }) lastCheckedAt?: Date;
}

export type TokenDocument = HydratedDocument<Token>;
export const TokenSchema = SchemaFactory.createForClass(Token);

// Per-chain collection → `address` alone is unique within it.
TokenSchema.index({ chainId: 1, address: 1 }, { unique: true });
