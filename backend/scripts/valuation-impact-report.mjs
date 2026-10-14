#!/usr/bin/env node
// Valuation impact report — a READ-ONLY dry run of the valuation flags from
// docs/spam-and-pool-mismatch-2026-10-05.md (fixes 1–4) against the data
// already stored, for EVERY open position and EVERY pool on every chain (not
// just the landing view's top 150). Run it, read summary.md, and only then
// switch a flag on.
//
//   Fix 2  HONEYPOT_FEE_FILTER=on — open positions in a pool whose static fee
//          is ≥ 50,000 pips (5%) and is not v4's dynamic-fee flag (0x800000)
//          leave every ranked list and count. EXACT: read off the row's own
//          stored `fee`, the same clause positions.repository.ts adds.
//          HONEYPOT_FEE_ANCHOR_EXEMPT=on keeps a pool whose BOTH legs are config
//          anchors (`isAnchorPair` / `anchorAddresses`, src/common/pool-fee.ts):
//          the report counts what it keeps — open rows (exact, the clause's
//          `$in` branch on the stored addresses) and anchor/anchor pools the
//          pools sync would stop marking risky (re-valued through the
//          `evaluatePoolTvl` mirror). The env value (default off) also decides
//          which rule the fix 2 counts and the "after" columns apply.
//   Fix 3  POSITION_AMOUNTS_SOURCE=tickmath — each OPEN row's amounts from its
//          liquidity + tickLower/tickUpper + the pool's current price, with the
//          REAL `getAmountsForLiquidity` (src/pricing/tick-math.ts) behind the
//          adapter's own guards. The price comes from the stored pool row
//          (`{chain}_{protocol}_pools.sqrtPriceX96`, refreshed by every pools
//          sync), else the row's own stored sqrtPriceX96, else its stored tick;
//          the summary counts each, and how many rows the two stored prices
//          disagree on by > 1%. Amounts are EXACT for the price used; the value
//          is re-priced at the leg prices the row serves today, on the basis
//          its stored value was built on (`valuationBasis`), and a row whose
//          value does not reconcile with amounts × prices is scaled and counted.
//   Fix 1  PRICE_QUOTE_GUARD=on — tokens whose SAVED price the guard rejects:
//          definite from the evidence the guarded / shadow sweep stores
//          (`priceQuoteRejected` + `priceGuardUsd` + `priceQuotedAt`, written by
//          `PricingService.guardEvidence`; the hot path's `priceQuoteSource` +
//          `priceQuotedAt`), or with `--probe-dia` (asks DIA's public API for
//          the top-exposure DIA-backed tokens and compares its `Time` / volume
//          with the saved price). Without either, each DIA-only / single-source
//          saved price is a CANDIDATE, reported with the open value riding on
//          it. Plus the both-legs-allowlisted cross-check, run through the REAL
//          `enforcePoolConsistency` and the REAL `crossCheckAllowlistedPair`
//          (src/pricing/pool-consistency.ts), fed the per-leg evidence the
//          pricing layer attaches (`legCorroboration`).
//   Fix 4  TOKEN_TRUST_MODE=earned — per token, the REAL `resolveTokenTrust`
//          (src/pricing/token-trust.ts) in both modes over the verdict the
//          consensus sweep stores (`trustEarned` / `trustReason` /
//          `trustEvaluatedAt`; written with TOKEN_TRUST_SHADOW=on). Reports tokens
//          that gain / lose trust (with the failing criterion), pools that would
//          newly appear on / disappear from the default Pools page ($10K TVL
//          floor, risky off), and open positions that would fall into the
//          no-real-market exclusion once the allowlist exemption becomes an
//          earned one. A token with NO stored verdict is UNDETERMINED (it would
//          read untrusted until the first earned sweep), never guessed — except
//          a pool leg no open position holds: the sweep only evaluates
//          `distinctActiveTokenAddresses`, so that leg can never earn trust and
//          its pool is counted as a definite loss ("never swept"). A
//          verdict older than PRICE_QUOTE_MAX_AGE_MS is used AS OF its sweep and
//          counted as stale (flipping now would revoke it).
//          TOKEN_TRUST_MODE=combined (anchor || allowlisted || earned, with the
//          pools sync's 10% pool-price cross-check on every non-anchor leg) is
//          projected the same way, through the same real `resolveTokenTrust`,
//          as a third column next to today and earned: tokens, Pools page,
//          the no-real-market exclusion and the landing view. A combined leg
//          no sweep evaluates keeps exactly its allowlist trust.
//   Coverage — per chain, tokens by the number of independent sources behind
//          their stored price (0 / 1 / 2 / 3+; DEX-only vs with a non-DEX
//          aggregator) and the stored `trustReason` distribution, with the
//          share of tokens that have no verdict or a stale one ("unknown").
//          Verdicts stored by a build without the definite-only rule (a
//          single-source / stale-quote failure is stored only when every
//          provider answered for the token, and a token a capped DexScreener
//          answer left out gets no verdict) may be artefacts of a skipped or
//          capped provider, not evidence.
//   --probe-dexscreener[=N] (off by default) asks DexScreener's public API
//          (no key) for up to N (60) of each chain's swept tokens through
//          BOTH batch endpoints (`/latest/dex/tokens`, today; `/tokens/v1/
//          {chain}`, DEXSCREENER_BATCH_ENDPOINT=per-chain), 30 a request, at
//          most one request a second, and prints how many each one covers.
//
// SAFE ON AN M10 WITH MILLIONS OF ROWS. Every read is a keyset page (an
// indexed range: `bg_active_walk` for open positions, the unique `positionId`,
// `poolId` and `{chainId,address}` indexes; closed rows on
// `{chainId,protocol,isActive,tokenId}` with `isActive: false` equality) of
// `--page-size` rows with `maxTimeMS`, read from a SECONDARY by default
// (`--read-preference`), with `--pace-ms` between pages AND a documents-per-
// second ceiling (`--docs-per-sec`, default and maximum 5,000 — the repo's own
// ceiling for background scans on these secondaries, READ_MODELS_SCAN_DOCS_PER_SEC)
// charged with every document each read fetches. Nothing is joined in memory: the pools a page of
// positions needs come in ONE `$in` per page (bounded cache); tokens are a
// compact per-chain map.
//
// READ-ONLY, ASSERTED TWICE. The script only ever holds a wrapper exposing
// `find`, `aggregate` (refusing `$out` / `$merge`), `listIndexes` and
// `listCollections` — there is no write method to call. And the driver's
// command monitor aborts the run (exit 70) on any command outside
// find / getMore / aggregate / listIndexes / listCollections / killCursors and
// the handshake. It writes ONLY local files under `--out`.
//
// RUN IT WITH tsx (a devDependency) from backend/: the decision rules are
// imported from `src/` so the report runs the REAL code (the reason
// `diagnose-pricing.mjs` imports its rules too). The few rules that live in
// Nest-heavy modules are mirrored here and pinned to the originals by
// test/impact-report/parity.spec.ts.
//
//   MONGODB_URI=… npx tsx scripts/valuation-impact-report.mjs
//   npx tsx scripts/valuation-impact-report.mjs --env-file=~/tickwise-prod.env
//   …--chain=1,4663                     (only these chains)
//   …--probe-dia --probe-limit=200      (verify the top DIA-backed saved prices)
//   …--probe-dexscreener=120            (both DexScreener batch endpoints, 120 tokens a chain)
//   …--include-closed                   (also count closed rows fix 2 would hide)
//   …--docs-per-sec=2000                (slower than the 5,000/s default and maximum)
//   …--out=./impact-2026-10-05          (default ./valuation-impact-<stamp>)
//
// Thresholds come from the same env the flags read (PRICE_QUOTE_MAX_AGE_MS,
// PRICE_DIA_MIN_VOLUME_USD, TOKEN_TRUST_DENY, TOKEN_TRUST_MIN_POOLS,
// HONEYPOT_FEE_ANCHOR_EXEMPT, …), else the code's defaults; the summary prints
// every value used. MONGODB_URI is never printed (only its host).

import { createWriteStream, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── The real decision rules, from src/ ─────────────────────────────────────

async function loadRules() {
  try {
    const [chains, policy, allowlist, tickMath, consistency, consensus, trust, poolFee] = await Promise.all([
      import('../src/config/chains.config.ts'),
      import('../src/pricing/pricing-policy.ts'),
      import('../src/pricing/token-allowlist.ts'),
      import('../src/pricing/tick-math.ts'),
      import('../src/pricing/pool-consistency.ts'),
      import('../src/pricing/quote-consensus.ts'),
      import('../src/pricing/token-trust.ts'),
      import('../src/common/pool-fee.ts'),
    ]);
    return {
      getChainConfig: chains.getChainConfig,
      isAnchorTokenStandalone: policy.isAnchorTokenStandalone,
      isAllowlisted: allowlist.isAllowlisted,
      getAmountsForLiquidity: tickMath.getAmountsForLiquidity,
      getSqrtRatioAtTick: tickMath.getSqrtRatioAtTick,
      poolRatio: consistency.poolRatio,
      enforcePoolConsistency: consistency.enforcePoolConsistency,
      crossCheckAllowlistedPair: consistency.crossCheckAllowlistedPair,
      meetsMarketBackingFloor: consistency.meetsMarketBackingFloor,
      maxPoolPriceDivergence: consistency.MAX_POOL_PRICE_DIVERGENCE,
      isDexBacked: consensus.isDexBacked,
      dexMarketSources: consensus.DEX_MARKET_SOURCES,
      resolveTokenTrust: trust.resolveTokenTrust,
      trustPolicyOf: trust.trustPolicyOf,
      isDenied: trust.isDenied,
      quoteRejection: trust.quoteRejection,
      poolPriceAgrees: trust.poolPriceAgrees,
      // Fix 2 + HONEYPOT_FEE_ANCHOR_EXEMPT: the pools sync's predicates and the
      // anchor list the positions clause's `$in` branch carries.
      isHoneypotStaticFee: poolFee.isHoneypotStaticFee,
      isAnchorPair: poolFee.isAnchorPair,
      anchorAddresses: poolFee.anchorAddresses,
    };
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|Cannot find module|ERR_MODULE_NOT_FOUND|strip|\.ts/i.test(msg)) {
      throw new Error(
        'valuation-impact-report imports its rules from src/*.ts — run it with tsx from backend/: ' +
          '`npx tsx scripts/valuation-impact-report.mjs …`. Original error: ' +
          msg,
      );
    }
    throw err;
  }
}

export const RULES = await loadRules();

// ─── Constants mirrored from Nest-heavy modules (parity-specced) ────────────

/** common/pool-fee.ts `HONEYPOT_FEE_MIN_PIPS` (the floor of `isHoneypotStaticFee`, which the pools sync and the positions filter both read). */
export const HONEYPOT_MIN_FEE_PIPS = 50_000;
/** positions.repository.ts `DYNAMIC_FEE_FLAG` / pools-sync `DYNAMIC_FEE_SENTINEL`. */
export const DYNAMIC_FEE_FLAG = 0x800000;
/** pools-sync.service.ts `TVL_CEILING_USD`. */
export const TVL_CEILING_USD = 5e10;
/** pools-sync.service.ts `TRUSTED_TVL_CONFIDENCES`. */
export const TRUSTED_TVL_CONFIDENCES = new Set(['anchor', 'external-verified']);
/** pools-sync.service.ts `UNTRUSTED_TVL_MAX_SHARE`. */
export const UNTRUSTED_TVL_MAX_SHARE = 0.2;
/** PoolsDashboard.tsx default `minTvlUsd` — the default Pools page floor. */
export const DEFAULT_POOLS_MIN_TVL_USD = 10_000;
/** The landing view (PositionsDashboard): open, in range, value ≥ $500, risky toggle ON. */
export const DEFAULT_LANDING_MIN_VALUE_USD = 500;
/** PositionsDashboard.tsx sends `minPoolTvl: 1000` on the Open tab. */
export const DEFAULT_LANDING_MIN_POOL_TVL_USD = 1000;
/** dia.provider.ts `DIA_CHAIN` — the chains DIA is asked for. */
export const DIA_CHAIN = Object.freeze({ 1: 'Ethereum', 43114: 'Avalanche', 42161: 'Arbitrum' });
export const DIA_BASE_URL = 'https://api.diadata.org/v1';
/** dexscreener.provider.ts `DEXSCREENER_CHAIN` — DexScreener's `chainId` strings. */
export const DEXSCREENER_CHAIN = Object.freeze({ 1: 'ethereum', 43114: 'avalanche', 42161: 'arbitrum', 4663: 'robinhood' });
/** dexscreener.provider.ts: `DEXSCREENER_BATCH_ENDPOINT=latest` (today) and `=per-chain`. */
export const DEXSCREENER_LATEST_URL = 'https://api.dexscreener.com/latest/dex/tokens';
export const DEXSCREENER_PER_CHAIN_URL = 'https://api.dexscreener.com/tokens/v1';
/** dexscreener.provider.ts `DEXSCREENER_RESPONSE_PAIR_CAP` (pairs a whole answer holds at most) and `MAX_BATCH` (addresses a request). */
export const DEXSCREENER_PAIR_CAP = 30;
export const DEXSCREENER_BATCH = 30;
/** Provider names that are pool-derived, never an independent consensus vote. */
const POOL_DERIVED_SOURCE = /^subgraph/;

export const DEFAULTS = Object.freeze({
  pageSize: 1000,
  paceMs: 25,
  /** The repo's hard ceiling for a background scan of the user-read secondaries (READ_MODELS_SCAN_DOCS_PER_SEC). */
  docsPerSec: 5000,
  maxDocsPerSec: 5000,
  maxTimeMs: 60_000,
  readPreference: 'secondary',
  top: 25,
  landingTop: 150,
  csvMinDeltaUsd: 1,
  probeLimit: 200,
  probeConcurrency: 2,
  /** `--probe-dexscreener` without `=N`: tokens a chain. */
  dexProbeLimit: 60,
  /** `--probe-dexscreener=N` ceiling: 100 batches × 2 endpoints ≈ 3.5 min a chain at one request a second. */
  maxDexProbeLimit: 3000,
  /** DexScreener allows 300 req/min; the probe stays at one a second, both endpoints together. */
  dexProbeIntervalMs: 1000,
  /** After a 429 / 5xx the probe waits this long before its next request (it never retries one). */
  dexProbeBackoffMs: 10_000,
  poolsMinTvlUsd: DEFAULT_POOLS_MIN_TVL_USD,
  landingMinValueUsd: DEFAULT_LANDING_MIN_VALUE_USD,
  landingMinPoolTvlUsd: DEFAULT_LANDING_MIN_POOL_TVL_USD,
  minRealMarketBackingUsd: 1000,
  poolCacheMax: 50_000,
});

export const KNOWN_FLAGS = Object.freeze([
  '--env-file=', '--chain=', '--protocol=', '--out=', '--db=', '--read-preference=',
  '--page-size=', '--pace-ms=', '--docs-per-sec=', '--max-time-ms=', '--top=', '--csv-min-delta=',
  '--probe-dia', '--probe-limit=', '--probe-dexscreener', '--probe-dexscreener=', '--include-closed',
  '--quote-max-age-ms=', '--dia-min-volume=', '--trust-min-pools=', '--trust-min-outside-liquidity=', '--deny=',
  '--pools-min-tvl=', '--landing-min-value=', '--landing-min-pool-tvl=', '--help',
]);

const READ_PREFERENCES = new Set(['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest']);

function numberFlag(name, raw, { integer = false, allowZero = false } = {}) {
  const value = Number(raw);
  const ok = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && (!integer || Number.isInteger(value));
  if (!ok) throw new Error(`${name} expects a ${integer ? 'whole ' : ''}number${allowZero ? ' ≥ 0' : ' > 0'}, got "${raw}"`);
  return value;
}

/**
 * Strict flag parser: an unknown or malformed flag is an ERROR, never "the
 * default" — a typo that silently reported on the wrong chain or threshold is
 * how somebody switches a flag on believing a check covered it.
 */
export function parseArgs(argv) {
  const flags = {
    envFile: undefined, chains: [], protocol: undefined, out: undefined, db: undefined,
    readPreference: DEFAULTS.readPreference, pageSize: DEFAULTS.pageSize, paceMs: DEFAULTS.paceMs, docsPerSec: DEFAULTS.docsPerSec,
    maxTimeMs: DEFAULTS.maxTimeMs, top: DEFAULTS.top, csvMinDeltaUsd: DEFAULTS.csvMinDeltaUsd,
    probeDia: false, probeLimit: DEFAULTS.probeLimit, probeDexscreener: false, probeDexscreenerLimit: DEFAULTS.dexProbeLimit, includeClosed: false,
    quoteMaxAgeMs: undefined, diaMinVolumeUsd: undefined, trustMinPools: undefined, trustMinOutsideLiquidityUsd: undefined,
    deny: [], poolsMinTvlUsd: DEFAULTS.poolsMinTvlUsd, landingMinValueUsd: DEFAULTS.landingMinValueUsd,
    landingMinPoolTvlUsd: DEFAULTS.landingMinPoolTvlUsd, help: false,
  };
  const unknown = [];
  const value = (arg, prefix) => {
    const v = arg.slice(prefix.length);
    if (!v) throw new Error(`${prefix}<value> needs a value`);
    return v;
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--probe-dia') flags.probeDia = true;
    else if (arg === '--probe-dexscreener') flags.probeDexscreener = true;
    else if (arg.startsWith('--probe-dexscreener=')) {
      // `=N` both turns the probe on and sets its size; `--probe-dexscreener=` (no N) is an error, never "the default".
      const n = numberFlag('--probe-dexscreener', value(arg, '--probe-dexscreener='), { integer: true });
      if (n > DEFAULTS.maxDexProbeLimit) {
        throw new Error(`--probe-dexscreener may not exceed ${DEFAULTS.maxDexProbeLimit} tokens a chain (one request a second, two endpoints), got ${n}`);
      }
      flags.probeDexscreener = true;
      flags.probeDexscreenerLimit = n;
    } else if (arg === '--include-closed') flags.includeClosed = true;
    else if (arg.startsWith('--env-file=')) flags.envFile = value(arg, '--env-file=');
    else if (arg.startsWith('--chain=')) {
      for (const part of value(arg, '--chain=').split(',')) {
        if (!/^\d+$/.test(part)) throw new Error(`--chain expects numeric chainIds (e.g. --chain=1,4663), got "${part}"`);
        flags.chains.push(Number(part));
      }
    } else if (arg.startsWith('--protocol=')) flags.protocol = value(arg, '--protocol=');
    else if (arg.startsWith('--out=')) flags.out = value(arg, '--out=');
    else if (arg.startsWith('--db=')) flags.db = value(arg, '--db=');
    else if (arg.startsWith('--read-preference=')) {
      const rp = value(arg, '--read-preference=');
      if (!READ_PREFERENCES.has(rp)) throw new Error(`--read-preference must be one of ${[...READ_PREFERENCES].join(', ')}`);
      flags.readPreference = rp;
    } else if (arg.startsWith('--page-size=')) flags.pageSize = numberFlag('--page-size', value(arg, '--page-size='), { integer: true });
    else if (arg.startsWith('--pace-ms=')) flags.paceMs = numberFlag('--pace-ms', value(arg, '--pace-ms='), { integer: true, allowZero: true });
    else if (arg.startsWith('--docs-per-sec=')) {
      flags.docsPerSec = numberFlag('--docs-per-sec', value(arg, '--docs-per-sec='), { integer: true });
      if (flags.docsPerSec > DEFAULTS.maxDocsPerSec) {
        throw new Error(`--docs-per-sec may not exceed ${DEFAULTS.maxDocsPerSec} (the background-scan ceiling for the secondaries that serve user reads), got ${flags.docsPerSec}`);
      }
    }
    else if (arg.startsWith('--max-time-ms=')) flags.maxTimeMs = numberFlag('--max-time-ms', value(arg, '--max-time-ms='), { integer: true });
    else if (arg.startsWith('--top=')) flags.top = numberFlag('--top', value(arg, '--top='), { integer: true });
    else if (arg.startsWith('--csv-min-delta=')) flags.csvMinDeltaUsd = numberFlag('--csv-min-delta', value(arg, '--csv-min-delta='), { allowZero: true });
    else if (arg.startsWith('--probe-limit=')) flags.probeLimit = numberFlag('--probe-limit', value(arg, '--probe-limit='), { integer: true });
    else if (arg.startsWith('--quote-max-age-ms=')) flags.quoteMaxAgeMs = numberFlag('--quote-max-age-ms', value(arg, '--quote-max-age-ms='), { integer: true });
    else if (arg.startsWith('--dia-min-volume=')) flags.diaMinVolumeUsd = numberFlag('--dia-min-volume', value(arg, '--dia-min-volume='), { allowZero: true });
    else if (arg.startsWith('--trust-min-pools=')) flags.trustMinPools = numberFlag('--trust-min-pools', value(arg, '--trust-min-pools='), { integer: true });
    else if (arg.startsWith('--trust-min-outside-liquidity=')) flags.trustMinOutsideLiquidityUsd = numberFlag('--trust-min-outside-liquidity', value(arg, '--trust-min-outside-liquidity='), { allowZero: true });
    else if (arg.startsWith('--deny=')) {
      for (const part of value(arg, '--deny=').split(',')) {
        if (!/^(\d+:)?0x[0-9a-fA-F]{40}$/.test(part)) throw new Error(`--deny expects 0x addresses (optionally chainId:0x…), got "${part}"`);
        flags.deny.push(part.toLowerCase());
      }
    } else if (arg.startsWith('--pools-min-tvl=')) flags.poolsMinTvlUsd = numberFlag('--pools-min-tvl', value(arg, '--pools-min-tvl='), { allowZero: true });
    else if (arg.startsWith('--landing-min-value=')) flags.landingMinValueUsd = numberFlag('--landing-min-value', value(arg, '--landing-min-value='), { allowZero: true });
    else if (arg.startsWith('--landing-min-pool-tvl=')) flags.landingMinPoolTvlUsd = numberFlag('--landing-min-pool-tvl', value(arg, '--landing-min-pool-tvl='), { allowZero: true });
    else unknown.push(arg);
  }
  if (unknown.length > 0) throw new Error(`unrecognized argument(s): ${unknown.join(' ')} — known flags are ${KNOWN_FLAGS.join(' ')}`);
  return flags;
}

/**
 * The trust / guard policy in BOTH modes, built by the real `trustPolicyOf`
 * from a config-shaped object read off the env (+ flag overrides) — so the
 * report applies exactly the thresholds the deployment would.
 */
export function resolveThresholds(flags, env = process.env) {
  const envDeny = String(env.TOKEN_TRUST_DENY ?? '');
  const cfg = {
    priceQuoteGuard: 'on',
    priceQuoteMaxAgeMs: flags.quoteMaxAgeMs ?? env.PRICE_QUOTE_MAX_AGE_MS,
    // Both spellings: the getter is `priceDiaMinVolumeUsd` (PRICE_DIA_MIN_VOLUME_USD).
    priceDiaMinVolumeUsd: flags.diaMinVolumeUsd ?? env.PRICE_DIA_MIN_VOLUME_USD ?? env.DIA_MIN_VOLUME_USD,
    diaMinVolumeUsd: flags.diaMinVolumeUsd ?? env.PRICE_DIA_MIN_VOLUME_USD ?? env.DIA_MIN_VOLUME_USD,
    tokenTrustDeny: [envDeny, ...flags.deny].filter(Boolean).join(','),
    tokenTrustMinPools: flags.trustMinPools ?? env.TOKEN_TRUST_MIN_POOLS,
    tokenTrustMinOutsideLiquidityUsd: flags.trustMinOutsideLiquidityUsd ?? env.TOKEN_TRUST_MIN_OUTSIDE_LIQUIDITY_USD,
    tokenTrustDeepPoolLiquidityUsd: env.TOKEN_TRUST_DEEP_POOL_LIQUIDITY_USD,
    tokenTrustMinPoolLiquidityUsd: env.TOKEN_TRUST_MIN_POOL_LIQUIDITY_USD,
    dexMarketMinCounterLiquidityUsd: env.DEX_MARKET_MIN_COUNTER_LIQUIDITY_USD,
  };
  const allowlist = RULES.trustPolicyOf({ ...cfg, tokenTrustMode: 'allowlist' });
  const earned = RULES.trustPolicyOf({ ...cfg, tokenTrustMode: 'earned' });
  const combined = RULES.trustPolicyOf({ ...cfg, tokenTrustMode: 'combined' });
  const rawBacking = env.MIN_REAL_MARKET_BACKING_USD;
  const backing = rawBacking === undefined || rawBacking === '' ? NaN : Number(rawBacking);
  return {
    allowlist,
    earned,
    combined,
    honeypotAnchorExempt: honeypotAnchorExemptOf(env),
    quoteMaxAgeMs: earned.quoteMaxAgeMs,
    diaMinVolumeUsd: earned.priceDiaMinVolumeUsd ?? earned.diaMinVolumeUsd,
    minRealMarketBackingUsd: Number.isFinite(backing) ? Math.max(0, backing) : DEFAULTS.minRealMarketBackingUsd,
    poolsMinTvlUsd: flags.poolsMinTvlUsd,
    landingMinValueUsd: flags.landingMinValueUsd,
    landingMinPoolTvlUsd: flags.landingMinPoolTvlUsd ?? DEFAULTS.landingMinPoolTvlUsd,
  };
}

/**
 * `HONEYPOT_FEE_ANCHOR_EXEMPT` the way the backend's Zod entry reads it
 * (blank = unset = off, any case, trimmed; `off` | `on` only). Anything else
 * makes the backend refuse to boot, so the report refuses too rather than
 * describe a deployment that cannot exist.
 */
export function honeypotAnchorExemptOf(env = process.env) {
  const raw = String(env.HONEYPOT_FEE_ANCHOR_EXEMPT ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return false;
  if (raw === 'on') return true;
  throw new Error(`HONEYPOT_FEE_ANCHOR_EXEMPT must be off or on (the backend refuses to boot otherwise), got "${env.HONEYPOT_FEE_ANCHOR_EXEMPT}"`);
}

/** The thresholds as printable JSON (sets → arrays). */
function printableThresholds(th) {
  const p = (pol) => (pol ? { ...pol, deny: [...pol.deny] } : pol);
  return { ...th, allowlist: p(th.allowlist), earned: p(th.earned), combined: p(th.combined) };
}

// ─── Read-only access ───────────────────────────────────────────────────────

/** Every command this script may send. Anything else trips the monitor. */
export const READ_ONLY_COMMANDS = Object.freeze(
  new Set(['find', 'getMore', 'aggregate', 'listIndexes', 'listCollections', 'killCursors', 'endSessions', 'hello', 'isMaster', 'ismaster', 'ping', 'buildInfo']),
);

const WRITE_STAGES = new Set(['$out', '$merge']);

/** Throws on any aggregation stage that writes. */
export function assertReadOnlyPipeline(pipeline) {
  if (!Array.isArray(pipeline)) throw new Error('aggregate pipeline must be an array');
  for (const stage of pipeline) {
    for (const key of Object.keys(stage ?? {})) {
      if (WRITE_STAGES.has(key)) throw new Error(`read-only report refuses a ${key} stage`);
    }
  }
}

/**
 * The ONLY database handle the report holds: `find`, a write-free `aggregate`,
 * `listIndexes`, and `listCollections` on the db. There is no insert / update /
 * delete / index / drop method to call by mistake.
 */
export function readOnlyDb(db) {
  return Object.freeze({
    listCollections: (filter = {}, options = {}) => db.listCollections(filter, { nameOnly: true, ...options }),
    collection(name) {
      const coll = db.collection(name);
      return Object.freeze({
        name,
        find: (filter, options) => coll.find(filter, options),
        aggregate: (pipeline, options) => {
          assertReadOnlyPipeline(pipeline);
          return coll.aggregate(pipeline, options);
        },
        listIndexes: () => coll.listIndexes(),
      });
    },
  });
}

/** Second line of defence: any command outside `READ_ONLY_COMMANDS` calls `onViolation` (main: exit 70). */
export function attachWriteTripwire(client, onViolation) {
  client.on('commandStarted', (event) => {
    if (!READ_ONLY_COMMANDS.has(event.commandName)) onViolation(event.commandName);
  });
}

/** `mongodb+srv://user:pass@host/db?x` → `mongodb+srv://host/db` (never print credentials or options). */
export function redactUri(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname && u.pathname !== '/' ? u.pathname : ''}`;
  } catch {
    return '(unparseable MONGODB_URI)';
  }
}

// ─── Shards ─────────────────────────────────────────────────────────────────

const POSITIONS_SHARD = /^(\d+)_([a-z0-9_]+)_positions$/;

/** Positions shards → `{chainId, protocol, positions, pools, tokens}`, filtered by --chain / --protocol. */
export function discoverShards(collectionNames, { chains = [], protocol } = {}) {
  const names = new Set(collectionNames);
  const protocolKey = protocol ? protocol.replace(/-/g, '_') : undefined;
  const out = [];
  for (const name of collectionNames) {
    const m = POSITIONS_SHARD.exec(name);
    if (!m) continue;
    const chainId = Number(m[1]);
    if (chains.length > 0 && !chains.includes(chainId)) continue;
    if (protocolKey && m[2] !== protocolKey) continue;
    const pools = `${chainId}_${m[2]}_pools`;
    const tokens = `${chainId}_tokens`;
    out.push({
      chainId,
      protocolKey: m[2],
      protocol: m[2].replace(/_/g, '-'),
      positions: name,
      pools: names.has(pools) ? pools : undefined,
      tokens: names.has(tokens) ? tokens : undefined,
    });
  }
  return out.sort((a, b) => a.chainId - b.chainId || a.protocolKey.localeCompare(b.protocolKey));
}

// ─── Pure decision helpers ──────────────────────────────────────────────────

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const asDate = (v) => {
  if (v === undefined || v === null) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : undefined;
};

/**
 * Fix 2: would `honeypotFeeClause()` (positions.repository.ts) DROP this row?
 * The clause KEEPS `fee < 50,000`, `fee ≥ 0x800000` and `fee: null` (null or
 * missing) — with MongoDB's type-bracketed comparisons, so anything else
 * (a numeric fee in [50,000, 0x800000), but also NaN or a non-number, which
 * the Number-typed schema never stores) is dropped.
 *
 * `exemption` = `honeypotFeeClause(chainId, anchorExempt)`'s fourth branch
 * (`HONEYPOT_FEE_ANCHOR_EXEMPT=on`): a row whose STORED token0 AND token1
 * addresses are both in `anchorAddresses(chainId)` is kept whatever its fee.
 * Omitted / `anchorExempt: false` = today's three-branch clause.
 */
export function isHoneypotFee(fee, exemption) {
  if (exemption?.anchorExempt === true && isStoredAnchorPair(exemption.chainId, exemption.token0, exemption.token1)) return false;
  if (fee === null || fee === undefined) return false;
  if (typeof fee !== 'number' || Number.isNaN(fee)) return true;
  return fee >= HONEYPOT_MIN_FEE_PIPS && fee < DYNAMIC_FEE_FLAG;
}

/**
 * The exemption branch of `honeypotFeeClause`, as MongoDB evaluates it on a
 * stored row: `{'token0.address': {$in: A}, 'token1.address': {$in: A}}` with
 * A = the real `anchorAddresses(chainId)` (lowercased). `$in` is an exact,
 * type-bracketed match, so only a string equal to a member counts — a missing
 * or null address, or one stored in another case, never does. An unknown
 * chain has no anchors.
 */
export function isStoredAnchorPair(chainId, token0, token1) {
  if (typeof token0 !== 'string' || typeof token1 !== 'string') return false;
  const anchors = RULES.anchorAddresses(Number(chainId));
  return anchors.includes(token0) && anchors.includes(token1);
}

/**
 * The dashboard's pool-TVL floor (`minPoolTvl`, 1000 on the Open tab), as
 * `buildLeaderboardFilter` (positions.repository.ts) writes it:
 * `{$or: [{'poolStats.tvlUsd': {$gte: floor}}, {'poolStats.tvlUsd': {$lte: 0}}]}`
 * — a KNOWN TVL in (0, floor) is hidden, 0 / negative ("unknown") passes. With
 * MongoDB's type-bracketed comparisons a missing, null or NaN TVL matches
 * neither branch (the schema defaults the field to 0, so stored rows have
 * one). A floor ≤ 0 writes no clause.
 */
export function passesPoolTvlFloor(tvl, floor) {
  if (!(floor > 0)) return true;
  if (typeof tvl !== 'number' || Number.isNaN(tvl)) return false;
  return tvl >= floor || tvl <= 0;
}

/** The landing view (PositionsDashboard, Open tab): in range, value ≥ the floor, pool TVL floor, neither leg excluded. */
export function landingVisible({ inRange, value, poolTvl, excluded0, excluded1 }, th) {
  return inRange === true && value >= th.landingMinValueUsd && passesPoolTvlFloor(poolTvl, th.landingMinPoolTvlUsd) && !excluded0 && !excluded1;
}

/** Fix 3: the adapter's `positionOpen` — still holds liquidity, not closed. */
export function isPositionOpen(row) {
  let liq = 0n;
  try {
    liq = BigInt(row.liquidity || '0');
  } catch {
    liq = 0n;
  }
  return row.isActive !== false && liq > 0n && !row.closedAtTimestamp;
}

const usableSqrt = (s) => typeof s === 'string' && /^\d+$/.test(s) && s !== '0';

/** Fix 3: the pool price the tick math uses — stored pool row first, then the row's own snapshot, then its tick. */
export function choosePoolState(pool, position) {
  if (pool && usableSqrt(pool.sqrtPriceX96)) return { sqrtPriceX96: pool.sqrtPriceX96, currentTick: num(pool.currentTick), source: 'pool' };
  if (usableSqrt(position.sqrtPriceX96)) return { sqrtPriceX96: position.sqrtPriceX96, currentTick: num(position.currentTick), source: 'position' };
  if (position.currentTick !== undefined && position.currentTick !== null && Number.isFinite(Number(position.currentTick))) {
    return { sqrtPriceX96: undefined, currentTick: Number(position.currentTick), source: 'tick' };
  }
  return { sqrtPriceX96: undefined, currentTick: undefined, source: 'none' };
}

/**
 * Fix 3: envio.adapter.ts `tickMathAmounts` (its guards) over
 * `PricingService.positionAmounts` (its body) — both parity-specced. Null =
 * the adapter keeps the indexer's amounts.
 */
export function tickMathAmounts({ liquidity, tickLower, tickUpper, sqrtPriceX96, currentTick, decimals0, decimals1 }) {
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower >= tickUpper) return null;
  let out;
  try {
    out = positionAmounts({ liquidity, tickLower, tickUpper, sqrtPriceX96, currentTick, decimals0, decimals1 });
  } catch {
    return null;
  }
  if (!out || !Number.isFinite(out.amount0) || !Number.isFinite(out.amount1) || out.amount0 < 0 || out.amount1 < 0) return null;
  return out;
}

function positionAmounts(input) {
  let liq;
  try {
    liq = BigInt(input.liquidity || '0');
  } catch {
    return null;
  }
  let sqrt = null;
  try {
    if (input.sqrtPriceX96) sqrt = BigInt(input.sqrtPriceX96);
  } catch {
    sqrt = null;
  }
  if (!sqrt && input.currentTick != null && Number.isFinite(input.currentTick)) {
    try {
      sqrt = RULES.getSqrtRatioAtTick(Math.trunc(input.currentTick));
    } catch {
      sqrt = null;
    }
  }
  if (!sqrt) return null;
  const { amount0, amount1 } = RULES.getAmountsForLiquidity(sqrt, input.tickLower, input.tickUpper, liq);
  return { amount0: Number(amount0) / Math.pow(10, input.decimals0), amount1: Number(amount1) / Math.pow(10, input.decimals1) };
}

const RECONCILE_TOLERANCE = 0.01;
const close = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b)) * RECONCILE_TOLERANCE;
const relClose = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * RECONCILE_TOLERANCE;

/**
 * How the stored `underlyingValueUsd` relates to amounts × the served leg
 * prices, so a tick-math amount change can be re-valued the same way:
 * `linear` (both legs count), `leg0` / `leg1` (one leg was gated to $0),
 * `zero` (the row is valued $0 — stays $0), `unreconciled` (a cut we cannot
 * reproduce — scaled by the amount ratio and counted separately).
 */
export function valuationBasis({ value, a0, a1, p0, p1 }) {
  const v = num(value);
  const l0 = num(a0) * num(p0);
  const l1 = num(a1) * num(p1);
  if (v <= 0) return 'zero';
  if (close(l0 + l1, v)) return 'linear';
  if (l0 > 0 && close(l0, v)) return 'leg0';
  if (l1 > 0 && close(l1, v)) return 'leg1';
  return 'unreconciled';
}

/** Re-value a row's tick-math amounts on the basis its stored value was built on. */
export function projectValue(basis, { value, a0, a1, p0, p1, tm0, tm1 }) {
  const v = num(value);
  switch (basis) {
    case 'zero':
      return 0;
    case 'linear':
      return tm0 * num(p0) + tm1 * num(p1);
    case 'leg0':
      return tm0 * num(p0);
    case 'leg1':
      return tm1 * num(p1);
    default: {
      const before = num(a0) * num(p0) + num(a1) * num(p1);
      const after = tm0 * num(p0) + tm1 * num(p1);
      return before > 0 ? v * (after / before) : v;
    }
  }
}

/** Value change when a row's leg prices move from (p0, p1) to (vp0, vp1), on the basis its stored value was built on. */
export function repriceDelta(basis, { value, a0, a1, p0, p1, vp0, vp1 }) {
  const d0 = num(a0) * (num(vp0) - num(p0));
  const d1 = num(a1) * (num(vp1) - num(p1));
  switch (basis) {
    case 'zero':
      return 0;
    case 'linear':
      return d0 + d1;
    case 'leg0':
      return d0;
    case 'leg1':
      return d1;
    default: {
      const before = num(a0) * num(p0) + num(a1) * num(p1);
      return before > 0 ? num(value) * ((before + d0 + d1) / before - 1) : 0;
    }
  }
}

/** token.repository.ts `isSpamSignals` (the GoPlus hard-flag rule). */
export function isSpamToken(t) {
  return Boolean(t?.isHoneypot || t?.cannotSellAll || t?.personalSlippageModifiable || t?.isBlacklisted);
}

/** token.repository.ts `storedTrustOf`: the trust fields of a lean row, type-checked. */
export function storedTrustOf(r) {
  const out = {};
  if (typeof r?.trustEarned === 'boolean') out.trustEarned = r.trustEarned;
  if (typeof r?.trustReason === 'string') out.trustReason = r.trustReason;
  // `trustEvaluatedAt` (the field's name since 2026-10-05; `trustCheckedAt` read too, for a row an earlier build wrote).
  const at = r?.trustEvaluatedAt instanceof Date ? r.trustEvaluatedAt : r?.trustCheckedAt instanceof Date ? r.trustCheckedAt : undefined;
  if (at) out.trustEvaluatedAt = at;
  if (r?.trustDenied === true) out.trustDenied = true;
  return out;
}

/**
 * token.repository.ts `findNoRealMarketAddresses` for ONE token doc under a
 * policy: the Mongo pre-filter, the anchor exemption, the deny rule, the trust
 * exemption (`resolveTokenTrust`, or `trustFn` for an as-of-sweep reading),
 * then the no-market test. Env-denied addresses with no row are handled by
 * `isEnvDenied`.
 */
export function isNoRealMarket(chainId, t, policy, now, trustFn) {
  if (!t) return false;
  // The Mongo pre-filter, exactly: `{dexActive: {$ne: true}, $or: [{dexActive: false}, {priceUsd: {$gt: 0}},
  // {pricePurgedAt: {$exists: true}}]}` OR `{trustDenied: true}` (a purged price stays as excluded as it was).
  const prefilter =
    (t.dexActive !== true && (t.dexActive === false || num(t.priceUsd) > 0 || t.pricePurgedAt !== undefined)) || t.trustDenied === true;
  if (!prefilter) return false;
  const addr = String(t.address).toLowerCase();
  if (RULES.isAnchorTokenStandalone(chainId, addr)) return false;
  const stored = storedTrustOf(t);
  if (RULES.isDenied(policy, chainId, addr, stored)) return true;
  const verdict = trustFn ? trustFn(addr, t, policy) : RULES.resolveTokenTrust(chainId, addr, stored, policy, now);
  if (verdict.trusted) return false;
  return t.dexActive === false || !RULES.isDexBacked(t.priceSources);
}

/** An env-denied address (TOKEN_TRUST_DENY) is excluded even with no token row (anchors never). */
export function isEnvDenied(chainId, address, policy) {
  const a = String(address).toLowerCase();
  if (RULES.isAnchorTokenStandalone(chainId, a)) return false;
  return policy.deny.has(`${chainId}:${a}`) || policy.deny.has(`*:${a}`);
}

/**
 * Fix 4: a token's trust in each mode. `earned` is the real verdict NOW; when
 * that verdict is only `stale-verdict`, `earnedAsOf` reads the same stored
 * verdict at its own sweep time (what the next sweep most likely re-derives) —
 * the projection uses `earnedAsOf` so a paused sweep does not read as
 * "everything loses trust", and the staleness is counted separately.
 */
export function tokenTrust(chainId, address, t, th, now) {
  const a = String(address).toLowerCase();
  const stored = storedTrustOf(t ?? {});
  const today = RULES.resolveTokenTrust(chainId, a, stored, th.allowlist, now);
  const earned = RULES.resolveTokenTrust(chainId, a, stored, th.earned, now);
  let earnedAsOf = earned;
  if (earned.reason === 'stale-verdict' && stored.trustEvaluatedAt) {
    earnedAsOf = RULES.resolveTokenTrust(chainId, a, stored, th.earned, stored.trustEvaluatedAt.getTime());
  }
  // `combined` (anchor || allowlisted || earned), read the same two ways. A
  // stale verdict only matters for a token the allowlist does not carry (a
  // listed one stays trusted either way — the real rule decides).
  const combined = RULES.resolveTokenTrust(chainId, a, stored, th.combined, now);
  let combinedAsOf = combined;
  if (combined.reason === 'stale-verdict' && stored.trustEvaluatedAt) {
    combinedAsOf = RULES.resolveTokenTrust(chainId, a, stored, th.combined, stored.trustEvaluatedAt.getTime());
  }
  // A leg no sweep evaluates (`poolProjection`'s never-swept case): its verdict
  // is gone for good or ages out, so combined trust is whatever the rule says
  // with NO verdict — anchor or allowlisted — while a hand-set deny flag,
  // which no sweep writes or clears, still counts.
  const combinedUnswept = RULES.resolveTokenTrust(chainId, a, stored.trustDenied === true ? { trustDenied: true } : undefined, th.combined, now);
  // No stored verdict yet: predict only the failures the stored evidence
  // already decides — earned trust REQUIRES (b) a real DEX market and (a) a
  // fresh consensus, so a token the sweep baked `dexActive: false`, or whose
  // saved price is a non-consensus quote, cannot earn it at the next sweep.
  // Everything else (criteria c and d) needs the sweep's own evidence → null.
  let predicted = null;
  if (earnedAsOf.reason === 'no-evidence') {
    if (t?.dexActive === false) predicted = { trusted: false, reason: 'no-dex-market', mode: 'earned' };
    else if (typeof t?.priceConfidence === 'string' && t.priceConfidence !== 'external-verified') predicted = { trusted: false, reason: 'single-source', mode: 'earned' };
    else if (t?.priceConfidence === 'external-verified' && onlyDexSources(t)) predicted = { trusted: false, reason: 'single-source', mode: 'earned' };
  }
  return {
    today, earned, earnedAsOf, combined, combinedAsOf, combinedUnswept, predicted,
    stale: earned.reason === 'stale-verdict',
    combinedStale: combined.reason === 'stale-verdict',
    hasVerdict: typeof stored.trustEarned === 'boolean',
  };
}

/**
 * A projected mode's answer for a leg: the stored verdict (as of its sweep),
 * else a failure the stored evidence already decides (`predicted` — in
 * combined mode a no-evidence answer only ever comes from a token the
 * allowlist does not carry, i.e. exactly earned's no-evidence case), else
 * null — no verdict yet.
 */
export function projectedTrusted(trust, mode) {
  const asOf = mode === 'combined' ? trust.combinedAsOf : trust.earnedAsOf;
  if (asOf.reason === 'stale-verdict') return null;
  if (asOf.reason === 'no-evidence') return trust.predicted ? trust.predicted.trusted : null;
  return asOf.trusted;
}

/** Why `projectedTrusted` answered what it did. */
export function projectedReason(trust, mode) {
  const asOf = mode === 'combined' ? trust.combinedAsOf : trust.earnedAsOf;
  if (asOf.reason === 'no-evidence' && trust.predicted) return `${trust.predicted.reason} (predicted)`;
  return asOf.reason;
}

/**
 * The earned projection's answer for a leg: the stored verdict (as of its
 * sweep), else a failure the stored evidence already decides (`predicted`),
 * else null — no verdict yet.
 */
export function earnedTrusted(trust) {
  return projectedTrusted(trust, 'earned');
}

/** Why `earnedTrusted` answered what it did. */
export function earnedReason(trust) {
  return projectedReason(trust, 'earned');
}

/** Today → a projected answer: `lose` / `gain` / `no-verdict` (undecided, non-anchor) / `none`. */
export function trustChange(before, after, anchor) {
  if (before && after === false) return 'lose';
  if (!before && after === true) return 'gain';
  if (after === null && !anchor) return 'no-verdict';
  return 'none';
}

/**
 * Earned trust (a) needs a non-DEX aggregator among the agreeing sources:
 * DexScreener + GeckoTerminal read the SAME on-chain pools, so their agreement
 * alone is one source (`evaluateEarnedTrust`). True when every independent
 * source behind a stored consensus is a DEX source.
 */
export function onlyDexSources(t) {
  const sources = independentSources(t);
  return sources.length > 0 && sources.every((s) => RULES.dexMarketSources.has(s));
}

/** Independent (non pool-derived) sources that backed the saved price. */
export function independentSources(t) {
  return [...new Set((Array.isArray(t?.priceSources) ? t.priceSources : []).filter((s) => !POOL_DERIVED_SOURCE.test(s)))];
}

/** Coverage buckets: independent sources behind a token's stored price. */
export const SOURCE_BUCKETS = Object.freeze(['0', '1', '2', '3+']);

/**
 * A token's source coverage, from what the sweep stored: the bucket of its
 * independent `priceSources` (pool-derived `subgraph-*` never count) and
 * whether every one of them is a DEX source — DexScreener and GeckoTerminal
 * read the same on-chain pools, so DEX-only is one market, not two
 * (earned trust (a) requires a non-DEX aggregator among the agreeing sources).
 */
export function sourceCoverage(t) {
  const n = independentSources(t).length;
  const bucket = n >= 3 ? '3+' : String(n);
  return { bucket, sources: n, dexOnly: n > 0 && onlyDexSources(t), withAggregator: n > 0 && !onlyDexSources(t) };
}

/** The stored `trustReason` buckets the coverage section reports (`other` = a value this build never writes). */
export const VERDICT_BUCKETS = Object.freeze(['earned', 'single-source', 'stale-quote', 'no-dex-market', 'single-pool', 'other', 'no-verdict', 'stale-verdict']);
const STORED_FAILURES = new Set(['single-source', 'stale-quote', 'no-dex-market', 'single-pool']);

/**
 * What the consensus sweep stored for a token, as the trust rule reads its
 * age: `no-verdict` (no boolean `trustEarned`), `stale-verdict` (older than
 * PRICE_QUOTE_MAX_AGE_MS, or no evaluation date — the rule revokes it), else
 * the stored outcome (`earned` or the failed criterion; an unknown string is
 * `other`, reported as stored rather than as the rule's `single-source`
 * fallback). Freshness is the rule's own (`resolveTokenTrust`, earned mode —
 * pinned by the parity spec); read directly here so an anchor or a denied
 * token, which the rule answers before looking, is still counted by what it
 * has stored.
 */
export function storedVerdictBucket(t, th, now) {
  const s = storedTrustOf(t ?? {});
  if (typeof s.trustEarned !== 'boolean') return 'no-verdict';
  const at = s.trustEvaluatedAt ? s.trustEvaluatedAt.getTime() : NaN;
  if (!Number.isFinite(at) || now - at > th.earned.quoteMaxAgeMs) return 'stale-verdict';
  if (s.trustEarned) return 'earned';
  return STORED_FAILURES.has(s.trustReason) ? s.trustReason : 'other';
}

/**
 * Fix 1 for a token's SAVED price:
 *  - `rejected` — definite: the guarded / shadow sweep found no accepted quote
 *    (`priceGuardUsd: 0` with rejections), or the hot-path quote behind the
 *    saved price was dated older than the max age (`priceQuotedAt`, measured at
 *    `pricedAt`);
 *  - `repriced` — the sweep's accepted-only consensus (`priceGuardUsd`) differs
 *    from the saved price by more than 1% (`guardUsd` carries it);
 *  - `purged` — already cleared (`pricePurgedAt`, price now 0);
 *  - `ok`, `candidate` (DIA-only / single-source, no evidence — run
 *    `--probe-dia`), or `n/a` (no saved price).
 */
export function savedQuoteVerdict(t, th) {
  const price = num(t?.priceUsd);
  if (!(price > 0)) return t?.pricePurgedAt ? { status: 'purged', reason: t.pricePurgedReason } : { status: 'n/a' };
  // The provenance / guard fields describe the SAVED price only when the write
  // that wrote `pricedAt` wrote them too (`priceEvidenceAt`, token.repository.ts
  // `priceEvidenceIsCurrent`): a later flag-off price write leaves them
  // describing an older price, and they are then ignored (→ candidate rules).
  const current = evidenceIsCurrent(t);
  // `priceQuoteRejected` is the field the sweep writes (token.schema.ts,
  // `PricingService.guardEvidence`); `priceGuardRejected` is read only as a
  // fallback for a row an earlier build of this report's fixtures described.
  const rawRejections = t?.priceQuoteRejected ?? t?.priceGuardRejected;
  const rejections = Array.isArray(rawRejections) ? rawRejections : undefined;
  if (current && rejections && typeof t.priceGuardUsd === 'number') {
    // Sweep evidence: the guard comparison decides, alone (purge-stale-prices.mjs `classifyStoredRow`).
    if (rejections.length === 0) return { status: 'ok', reason: 'guard-evidence' };
    if (t.priceGuardUsd === 0) return { status: 'rejected', reason: rejections.join('+'), guardUsd: 0 };
    if (t.priceGuardUsd > 0 && !relClose(t.priceGuardUsd, price)) return { status: 'repriced', reason: rejections.join('+'), guardUsd: t.priceGuardUsd };
    return { status: 'ok', reason: 'guard-evidence' };
  }
  const quotedAt = current ? asDate(t?.priceQuotedAt) : undefined;
  if (t?.priceQuoteSource && quotedAt) {
    const at = asDate(t?.pricedAt)?.getTime() ?? quotedAt.getTime();
    // Staleness only: the hot path does not store the quote's volume.
    const rejection = RULES.quoteRejection({ quotedAtMs: quotedAt.getTime(), volume24hUsd: Number.MAX_VALUE }, t.priceQuoteSource, th.earned, at);
    if (rejection) return { status: 'rejected', reason: `${t.priceQuoteSource}:${rejection}`, guardUsd: 0 };
    if (t.priceQuoteSource !== 'dia') return { status: 'ok', reason: 'dated-fresh' };
  }
  const sources = independentSources(t);
  if (t?.priceConfidence === 'external-verified' && sources.length >= 2) return { status: 'ok', reason: 'consensus' };
  if (t?.priceQuoteSource === 'dia' || (sources.length === 1 && sources[0] === 'dia')) return { status: 'candidate', reason: 'dia-only' };
  return { status: 'candidate', reason: sources.length === 0 ? 'no-sources' : 'single-source' };
}

/** token.repository.ts `priceEvidenceIsCurrent`: the evidence was written by the write that wrote `pricedAt` (± 1 s). */
export function evidenceIsCurrent(t) {
  const at = asDate(t?.priceEvidenceAt)?.getTime();
  const priced = asDate(t?.pricedAt)?.getTime();
  return Number.isFinite(at) && Number.isFinite(priced) && Math.abs(at - priced) <= 1_000;
}

/** A saved price DIA could have supplied (the hot path's dated source, or DIA among the sweep's sources) — the only ones worth asking DIA about. */
export function isDiaBacked(t) {
  return t?.priceQuoteSource === 'dia' || independentSources(t).includes('dia');
}

/** `--probe-dia`: does DIA's answer prove the saved price is a quote the guard rejects (real `quoteRejection`)? */
export function diaProbeVerdict(dia, storedPrice, th, nowMs) {
  if (!dia || !(num(dia.Price) > 0)) return { status: 'no-dia-quote' };
  const at = asDate(dia.Time);
  const volumeUsd = num(dia.VolumeYesterdayUSD);
  const rejection = RULES.quoteRejection({ quotedAtMs: at?.getTime(), volume24hUsd: volumeUsd }, 'dia', th.earned, nowMs);
  const matches = Math.abs(num(dia.Price) / num(storedPrice) - 1) <= 1e-6;
  const status = rejection ? (matches ? 'rejected' : 'dia-rejected-not-saved') : matches ? 'ok' : 'dia-fresh-not-saved';
  return { status, reason: rejection ?? undefined, ageMs: at ? nowMs - at.getTime() : undefined, volumeUsd, diaPrice: num(dia.Price) };
}

/** `--probe-dexscreener`: the request an endpoint sends for `addresses` — the provider's own URL (lowercased, comma-joined). */
export function dexProbeUrl(endpoint, chainId, addresses) {
  const list = addresses.map((a) => String(a).toLowerCase()).join(',');
  return endpoint === 'per-chain' ? `${DEXSCREENER_PER_CHAIN_URL}/${DEXSCREENER_CHAIN[chainId]}/${list}` : `${DEXSCREENER_LATEST_URL}/${list}`;
}

/**
 * Which requested addresses one DexScreener answer covers, read the way
 * `DexScreenerProvider.getCurrentBatch` reads it (pinned by the parity spec):
 * a pair on this chain whose BASE token is the address with a positive USD
 * price. latest: `{pairs}` (absent / null = no pairs); per-chain: a JSON
 * array — anything else is an error (`ok: false`). `capped` = the answer
 * holds the 30-pair cap, so a token missing from it may just have been
 * crowded out (what made latest mode's absentees read as "no market").
 */
export function dexProbeCoverage(body, endpoint, chainId, addresses) {
  const dexChain = DEXSCREENER_CHAIN[chainId];
  let pairs = null;
  if (endpoint === 'per-chain') pairs = Array.isArray(body) ? body : null;
  else if (body) pairs = body.pairs ?? [];
  if (!Array.isArray(pairs)) return { ok: false, covered: new Set(), pairs: 0, capped: false };
  const wanted = new Set(addresses.map((a) => String(a).toLowerCase()));
  const covered = new Set();
  for (const p of pairs) {
    if (!p || p.chainId !== dexChain) continue;
    const base = p.baseToken?.address;
    const price = Number(p.priceUsd);
    if (typeof base !== 'string' || !base || !Number.isFinite(price) || price <= 0) continue;
    const addr = base.toLowerCase();
    if (wanted.has(addr)) covered.add(addr);
  }
  return { ok: true, covered, pairs: pairs.length, capped: pairs.length >= DEXSCREENER_PAIR_CAP };
}

const DEX_ENDPOINTS = Object.freeze(['latest', 'per-chain']);

/**
 * `--probe-dexscreener`: ask DexScreener's public API (no key) about the
 * same tokens through BOTH batch endpoints, 30 addresses a request, one
 * request at a time with at least `intervalMs` (≥ 1 s) between two of them
 * (`backoffMs` after a 429 / 5xx; a failed request is never retried — its
 * tokens count as not answered). Per chain and endpoint: requests, tokens
 * answered (in a healthy answer), tokens covered, pairs, capped answers. The
 * both / only latest / only per-chain / neither split compares only tokens
 * BOTH endpoints answered: a token one of them did not answer (a 429, a
 * failure) is `unansweredByOne` — a transport failure is not a coverage
 * difference between the endpoints, and the comparison is the probe's point.
 */
export async function probeDexscreener(targets, { fetchImpl, wait = sleep, intervalMs = DEFAULTS.dexProbeIntervalMs, backoffMs = DEFAULTS.dexProbeBackoffMs, log = () => {} } = {}) {
  const out = { requests: 0, errors: 0, rateLimited: 0, chains: [] };
  let nextWait = null;
  for (const target of targets) {
    const endpointStats = () => ({ requests: 0, answered: 0, covered: 0, pairs: 0, cappedAnswers: 0, errors: 0, rateLimited: 0 });
    const chain = {
      chainId: target.chainId, dexChain: DEXSCREENER_CHAIN[target.chainId], swept: target.swept ?? target.addresses.length, asked: target.addresses.length, batches: 0,
      latest: endpointStats(), perChain: endpointStats(), both: 0, onlyLatest: 0, onlyPerChain: 0, neither: 0, unansweredByOne: 0,
    };
    const covered = { latest: new Set(), 'per-chain': new Set() };
    // The addresses each endpoint answered in a HEALTHY answer (lowercased).
    const answered = { latest: new Set(), 'per-chain': new Set() };
    log(`probing DexScreener (both batch endpoints) for ${chain.asked} of chain ${chain.chainId}'s ${chain.swept} swept tokens…`);
    for (let i = 0; i < target.addresses.length; i += DEXSCREENER_BATCH) {
      const batch = target.addresses.slice(i, i + DEXSCREENER_BATCH);
      chain.batches += 1;
      for (const endpoint of DEX_ENDPOINTS) {
        if (nextWait !== null) await wait(nextWait);
        nextWait = intervalMs;
        const stats = endpoint === 'latest' ? chain.latest : chain.perChain;
        stats.requests += 1;
        out.requests += 1;
        try {
          const res = await fetchImpl(dexProbeUrl(endpoint, target.chainId, batch), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
          const status = Number(res?.status ?? (res?.ok ? 200 : 0));
          if (status === 429 || status >= 500) {
            stats.rateLimited += 1;
            out.rateLimited += 1;
            nextWait = Math.max(intervalMs, backoffMs);
            continue;
          }
          if (!res?.ok) throw new Error(`HTTP ${status}`);
          const cov = dexProbeCoverage(await res.json(), endpoint, target.chainId, batch);
          if (!cov.ok) throw new Error('unexpected answer shape');
          stats.answered += batch.length;
          stats.pairs += cov.pairs;
          if (cov.capped) stats.cappedAnswers += 1;
          for (const a of batch) answered[endpoint].add(String(a).toLowerCase());
          for (const a of cov.covered) covered[endpoint].add(a);
        } catch {
          stats.errors += 1;
          out.errors += 1;
        }
      }
    }
    chain.latest.covered = covered.latest.size;
    chain.perChain.covered = covered['per-chain'].size;
    for (const raw of target.addresses) {
      const a = String(raw).toLowerCase();
      if (!answered.latest.has(a) || !answered['per-chain'].has(a)) {
        chain.unansweredByOne += 1;
        continue;
      }
      const l = covered.latest.has(a);
      const c = covered['per-chain'].has(a);
      if (l && c) chain.both += 1;
      else if (l) chain.onlyLatest += 1;
      else if (c) chain.onlyPerChain += 1;
      else chain.neither += 1;
    }
    out.chains.push(chain);
  }
  return out;
}

/**
 * `crossCheckAllowlistedPair` — the REAL rule (src/pricing/pool-consistency.ts,
 * where it moved from envio.adapter.ts): two `verified` legs, each leg that is
 * explicitly single-source checked against the pool ratio (lowered when it sits
 * > MAX_POOL_PRICE_DIVERGENCE above) and, on open rows with known reserves,
 * against the other leg's backing floor. Kept under this name for the specs.
 */
export function crossCheckAllowlistedPair(input) {
  return RULES.crossCheckAllowlistedPair(input);
}

/**
 * The quote-guard evidence `PricingService.pricePool` attaches per leg
 * (`token{0,1}Corroborated`), from the stored token row exactly as
 * `TokensRepository.findMarketState` reads it: sources that DISAGREED → false;
 * a sweep consensus (`priceConfidence: external-verified` with recorded
 * sources) → true; a sweep single-source verdict (`external-unverified`) →
 * false; nothing recorded → undefined (no evidence).
 */
export function legCorroboration(t) {
  if (t?.priceSourcesDisagreed === true) return false;
  if (!Array.isArray(t?.priceSources) || t.priceSources.length === 0) return undefined;
  if (t.priceConfidence === 'external-verified') return true;
  if (t.priceConfidence === 'external-unverified') return false;
  return undefined;
}

/**
 * Fix 1 (second half) for one open row: what the allowlisted-pair handling
 * does to its leg prices under PRICE_QUOTE_GUARD. A non-anchor allowlisted leg
 * whose sweep recorded DISAGREEING sources is no longer upgraded to `verified`
 * (→ `unverified`, through the REAL `enforcePoolConsistency`); a leg the
 * pricing layer marks single-source (`token{0,1}Corroborated: false`) stays
 * `verified` and goes through the REAL `crossCheckAllowlistedPair`. Null when
 * the row is out of scope (not two allowlisted / anchor legs).
 *
 * `corroboration`:
 *  - `built` (default) — exactly what the code does: `legCorroboration`, and a
 *    leg with NO evidence (never swept) is left alone (envio.adapter.ts reads
 *    `token{0,1}Corroborated !== false`);
 *  - `all-swept` — the same, but a leg with no evidence counts as
 *    single-source: what the check does once the sweep has a verdict for
 *    every held token (an upper bound).
 */
export function allowlistCrossCheck(chainId, row, tokens, poolState, reserves, th, { corroboration = 'built' } = {}) {
  const a0 = String(row.token0?.address ?? '').toLowerCase();
  const a1 = String(row.token1?.address ?? '').toLowerCase();
  if (!a0 || !a1) return null;
  const anchor0 = RULES.isAnchorTokenStandalone(chainId, a0);
  const anchor1 = RULES.isAnchorTokenStandalone(chainId, a1);
  if (!(anchor0 || RULES.isAllowlisted(chainId, a0)) || !(anchor1 || RULES.isAllowlisted(chainId, a1))) return null;
  if (anchor0 && anchor1) return null;
  const t0 = tokens.get(a0);
  const t1 = tokens.get(a1);
  const after0 = anchor0 ? 'anchor' : t0?.priceSourcesDisagreed === true ? 'unverified' : 'verified';
  const after1 = anchor1 ? 'anchor' : t1?.priceSourcesDisagreed === true ? 'unverified' : 'verified';
  const c0 = legCorroboration(t0);
  const c1 = legCorroboration(t1);
  const p0 = num(row.token0?.priceUsd);
  const p1 = num(row.token1?.priceUsd);
  const sqrt = poolState?.sqrtPriceX96 ?? (Number.isFinite(poolState?.currentTick) ? safeSqrtAtTick(poolState.currentTick) : undefined);
  const ratio = sqrt ? RULES.poolRatio(sqrt, num(row.token0?.decimals), num(row.token1?.decimals)) : Number.NaN;
  let { vp0, vp1 } = RULES.enforcePoolConsistency(p0, p1, after0, after1, ratio);
  const corroborated = (c) => (corroboration === 'all-swept' ? c === true : c !== false);
  const checked = crossCheckAllowlistedPair({
    vp0,
    vp1,
    trust0: after0,
    trust1: after1,
    ratio,
    corroborated0: corroborated(c0),
    corroborated1: corroborated(c1),
    open: isPositionOpen(row),
    reserve0: reserves?.reserve0,
    reserve1: reserves?.reserve1,
    floorUsd: th.minRealMarketBackingUsd,
  });
  vp0 = checked.vp0;
  vp1 = checked.vp1;
  const a0n = num(row.amounts?.amount0);
  const a1n = num(row.amounts?.amount1);
  const value = num(row.metrics?.underlyingValueUsd);
  const basis = valuationBasis({ value, a0: a0n, a1: a1n, p0, p1 });
  const deltaUsd = Math.max(-value, repriceDelta(basis, { value, a0: a0n, a1: a1n, p0, p1, vp0, vp1 }));
  return { changed: Math.abs(deltaUsd) > 0, deltaUsd, vp0, vp1, trust0: after0, trust1: after1 };
}

function safeSqrtAtTick(tick) {
  try {
    return RULES.getSqrtRatioAtTick(Math.trunc(tick)).toString();
  } catch {
    return undefined;
  }
}

/**
 * pools-sync.service.ts `evaluatePoolTvl` (parity-specced): clamped reserves ×
 * trusted-leg prices, risky on a fabricated headline / honeypot fee /
 * negative reserve. `honeypotExempt` (the pools sync passes
 * `HONEYPOT_FEE_ANCHOR_EXEMPT=on && isAnchorPair(…)`) stops the fee alone from
 * flagging the pool; the fee rule itself is the real `isHoneypotStaticFee`.
 */
export function evaluatePoolTvl(input) {
  const fin = (v) => (Number.isFinite(v) ? v : 0);
  const reserveCorrupt = fin(input.reserve0) < 0 || fin(input.reserve1) < 0;
  const tvlToken0 = Math.max(0, fin(input.reserve0));
  const tvlToken1 = Math.max(0, fin(input.reserve1));
  const trusted0 = TRUSTED_TVL_CONFIDENCES.has(input.confidence0 ?? '');
  const trusted1 = TRUSTED_TVL_CONFIDENCES.has(input.confidence1 ?? '');
  const legUsd0 = tvlToken0 * fin(input.price0);
  const legUsd1 = tvlToken1 * fin(input.price1);
  const trustedTvl = (trusted0 ? legUsd0 : 0) + (trusted1 ? legUsd1 : 0);
  const untrustedUsd = (trusted0 ? 0 : Math.max(0, legUsd0)) + (trusted1 ? 0 : Math.max(0, legUsd1));
  const materiallyFabricated = untrustedUsd > Math.max(1, trustedTvl) * UNTRUSTED_TVL_MAX_SHARE;
  const honeypotFee = input.honeypotExempt !== true && RULES.isHoneypotStaticFee(input.feeTier);
  const risky = materiallyFabricated || honeypotFee || reserveCorrupt;
  return { tvlUsd: risky ? 0 : trustedTvl, tvlToken0, tvlToken1, risky, reserveCorrupt };
}

/** A token's USD price for pool-TVL projection: the stored price, else the native price for native / wrapped-native. */
function tokenUsd(chainId, address, tokens, nativeUsd) {
  const t = tokens.get(address);
  if (num(t?.priceUsd) > 0) return num(t.priceUsd);
  const chain = RULES.getChainConfig(chainId);
  const native = [chain?.nativeToken?.address, chain?.wrappedNativeToken?.address].map((a) => String(a ?? '').toLowerCase());
  if (native.includes(address) && nativeUsd > 0) return nativeUsd;
  return 0;
}

/**
 * Fix 4 for one pool row — visible on the default Pools page today (stored)
 * vs under earned trust (projected the way pools-sync values it):
 *  - legs keep their trust → stored TVL, but earned mode's pool-vs-consensus
 *    check (`poolPriceAgrees`, 10%) may now mark a non-anchor leg untrusted;
 *  - a leg loses trust → pools-sync writes a risky stub (tvl 0, fallback);
 *  - both legs trusted today and after, but the pool unpriced today → no
 *    change (`risky-today`): it is risky for a reason the mode does not touch;
 *  - newly priceable (a leg untrusted today is trusted after) → reserves ×
 *    stored leg prices through `evaluatePoolTvl`;
 *  - a leg with no stored verdict → `undetermined` (stored state kept) —
 *    UNLESS no open position holds it (`ctx.held`): the price / trust sweep
 *    evaluates only `distinctActiveTokenAddresses`, so such a leg never gets
 *    a verdict (and a stale one is never renewed) and earned mode reads it
 *    `no-evidence` for good → a definite loss (`neverSwept`).
 * `mode` = `combined` projects TOKEN_TRUST_MODE=combined the same way: the
 * pool-price check applies there too (every mode that reads stored verdicts
 * runs it, listed legs included), and a never-swept leg keeps exactly what
 * the rule gives it with no verdict (`combinedUnswept`: anchor or listed).
 * `ctx.th.honeypotAnchorExempt` (HONEYPOT_FEE_ANCHOR_EXEMPT) reaches
 * `evaluatePoolTvl` as the pools sync passes it.
 */
export function poolProjection(chainId, pool, ctx, mode = 'earned') {
  const combinedMode = mode === 'combined';
  const a0 = String(pool.token0?.address ?? '').toLowerCase();
  const a1 = String(pool.token1?.address ?? '').toLowerCase();
  const tvlToday = num(pool.metrics?.tvlUsd);
  const pricedToday = pool.pricing?.source !== 'none' && pool.pricing?.usedFallback !== true;
  const visible = (tvl, priced, ex0, ex1) => priced && tvl >= ctx.th.poolsMinTvlUsd && tvl <= TVL_CEILING_USD && !ex0 && !ex1;
  const visibleToday = visible(tvlToday, pricedToday, ctx.excludedToday(a0), ctx.excludedToday(a1));
  const t0 = ctx.trustOf(a0);
  const t1 = ctx.trustOf(a1);
  const before0 = t0.today.trusted;
  const before1 = t1.today.trusted;
  // A non-anchor leg no open position holds: no sweep evaluates it, so it has
  // no verdict for good, or one that ages out within PRICE_QUOTE_MAX_AGE_MS.
  const neverSwept = (addr) => Boolean(ctx.held) && !ctx.held.has(addr) && !RULES.isAnchorTokenStandalone(chainId, addr);
  const never0 = neverSwept(a0);
  const never1 = neverSwept(a1);
  const unswept = (tr) => (combinedMode ? tr.combinedUnswept.trusted : false);
  const after0 = never0 ? unswept(t0) : projectedTrusted(t0, mode);
  const after1 = never1 ? unswept(t1) : projectedTrusted(t1, mode);
  const why = (tr, never) => {
    if (!never) return projectedReason(tr, mode);
    if (combinedMode && tr.combinedUnswept.reason === 'denied') return 'denied';
    if (!tr.hasVerdict) return 'no-evidence (never swept)';
    return tr.stale ? 'stale-verdict (never re-swept)' : 'verdict-expires (never re-swept)';
  };
  const excludedAfter = combinedMode ? ctx.excludedCombined : ctx.excludedEarned;
  const ex0 = excludedAfter(a0);
  const ex1 = excludedAfter(a1);
  const honeypotExempt = ctx.th.honeypotAnchorExempt === true && RULES.isAnchorPair(chainId, a0, a1);
  const base = { poolId: pool.poolId, a0, a1, fee: num(pool.fee), tvlToday, visibleToday };
  if (after0 === false || after1 === false) {
    const lost0 = after0 === false;
    return {
      ...base,
      change: pricedToday ? 'lose' : 'none',
      tvlAfter: 0,
      visibleAfter: false,
      neverSwept: lost0 ? never0 : never1,
      reason: lost0 ? `token0-${why(t0, never0)}` : `token1-${why(t1, never1)}`,
    };
  }
  if (after0 === null || after1 === null) {
    const visibleAfter = visible(tvlToday, pricedToday, ex0, ex1);
    const reason = visibleToday && !visibleAfter ? `${ex0 ? 'token0' : 'token1'}-excluded` : 'no-verdict';
    return { ...base, change: before0 && before1 ? 'undetermined' : 'none', tvlAfter: tvlToday, visibleAfter, reason };
  }
  // Both legs trusted under the projected mode.
  const r0 = pool.metrics?.tvlToken0;
  const r1 = pool.metrics?.tvlToken1;
  const p0 = tokenUsd(chainId, a0, ctx.tokens, ctx.nativeUsd);
  const p1 = tokenUsd(chainId, a1, ctx.tokens, ctx.nativeUsd);
  const ratio = usableSqrt(pool.sqrtPriceX96) ? RULES.poolRatio(pool.sqrtPriceX96, num(pool.token0?.decimals), num(pool.token1?.decimals)) : 0;
  const agrees = RULES.poolPriceAgrees(p0, p1, ratio);
  const anchor0 = t0.today.reason === 'anchor';
  const anchor1 = t1.today.reason === 'anchor';
  const conf = (anchor, ok) => (anchor ? 'anchor' : ok ? 'external-verified' : 'external-unverified');
  if (pricedToday && before0 && before1) {
    const kept = () => {
      const visibleAfter = visible(tvlToday, true, ex0, ex1);
      return { ...base, change: 'none', tvlAfter: tvlToday, visibleAfter, reason: visibleToday && !visibleAfter ? `${ex0 ? 'token0' : 'token1'}-excluded` : undefined };
    };
    if (agrees || r0 === undefined || r1 === undefined) return kept();
    const v = evaluatePoolTvl({ reserve0: num(r0), reserve1: num(r1), price0: p0, price1: p1, confidence0: conf(anchor0, false), confidence1: conf(anchor1, false), feeTier: num(pool.fee), honeypotExempt });
    if (!v.risky) return kept();
    return { ...base, change: 'lose', tvlAfter: 0, visibleAfter: false, reason: 'pool-price-diverges' };
  }
  // Both legs trusted today AND under the projected mode, yet the pool is not
  // priced today: the sync left it risky / unpriced for a reason that has
  // nothing to do with trust (a pricePool fallback, a pool-derived listed leg,
  // incomplete pricing, a fee rule, a stale stub). The mode changes neither
  // leg's trust, and the only thing a stored-verdict mode adds to the pools
  // sync is the pool-price check — which can only REMOVE TVL — so the pool
  // stays as stored. (Re-valuing it here credited every such listed/anchor
  // pair to combined mode as "appearing", at optimistic confidences; the
  // honeypot exemption's re-entries are reported by `honeypotExemptionPool`.)
  if (before0 && before1) return { ...base, change: 'none', tvlAfter: tvlToday, visibleAfter: visibleToday, reason: 'risky-today' };
  // Newly priceable: a leg untrusted today is trusted under the mode.
  if (r0 === undefined || r1 === undefined) return { ...base, change: 'gain', tvlAfter: 0, visibleAfter: false, reason: 'reserves-unknown' };
  const v = evaluatePoolTvl({ reserve0: num(r0), reserve1: num(r1), price0: p0, price1: p1, confidence0: conf(anchor0, agrees), confidence1: conf(anchor1, agrees), feeTier: num(pool.fee), honeypotExempt });
  const complete = (v.tvlToken0 <= 0 || p0 > 0) && (v.tvlToken1 <= 0 || p1 > 0);
  const sane = complete && Number.isFinite(v.tvlUsd) && v.tvlUsd >= 0 && v.tvlUsd <= TVL_CEILING_USD;
  const tvlAfter = sane && !v.risky ? v.tvlUsd : 0;
  const reason = !complete ? 'leg-unpriced' : v.risky ? (!honeypotExempt && isHoneypotFee(num(pool.fee)) ? 'honeypot-fee' : agrees ? 'risky' : 'pool-price-diverges') : undefined;
  return { ...base, change: 'gain', tvlAfter, visibleAfter: sane && !v.risky && visible(tvlAfter, true, ex0, ex1), reason };
}

/**
 * HONEYPOT_FEE_ANCHOR_EXEMPT for one pool row: null unless the pools sync's
 * exemption would apply (both legs config anchors — the real `isAnchorPair` —
 * and a static fee the real `isHoneypotStaticFee` flags). Otherwise the pool
 * as the sync would value it with the exemption: anchor legs are trusted in
 * every trust mode and never downgraded by the pool-price check, so it is
 * reserves × stored leg prices through `evaluatePoolTvl` with
 * `honeypotExempt: true` (fabrication and corrupt reserves still make it
 * risky). `visibleExempt` = on the default Pools page with that TVL.
 */
export function honeypotExemptionPool(chainId, pool, ctx) {
  const a0 = String(pool.token0?.address ?? '').toLowerCase();
  const a1 = String(pool.token1?.address ?? '').toLowerCase();
  const fee = num(pool.fee);
  if (!RULES.isAnchorPair(chainId, a0, a1) || !RULES.isHoneypotStaticFee(fee)) return null;
  const tvlToday = num(pool.metrics?.tvlUsd);
  const pricedToday = pool.pricing?.source !== 'none' && pool.pricing?.usedFallback !== true;
  const excluded = ctx.excludedToday(a0) || ctx.excludedToday(a1);
  const visibleToday = pricedToday && tvlToday >= ctx.th.poolsMinTvlUsd && tvlToday <= TVL_CEILING_USD && !excluded;
  const base = { poolId: pool.poolId, a0, a1, fee, tvlToday, visibleToday };
  const r0 = pool.metrics?.tvlToken0;
  const r1 = pool.metrics?.tvlToken1;
  if (r0 === undefined || r1 === undefined) return { ...base, tvlExempt: 0, visibleExempt: false, reason: 'reserves-unknown' };
  const p0 = tokenUsd(chainId, a0, ctx.tokens, ctx.nativeUsd);
  const p1 = tokenUsd(chainId, a1, ctx.tokens, ctx.nativeUsd);
  const v = evaluatePoolTvl({ reserve0: num(r0), reserve1: num(r1), price0: p0, price1: p1, confidence0: 'anchor', confidence1: 'anchor', feeTier: fee, honeypotExempt: true });
  const complete = (v.tvlToken0 <= 0 || p0 > 0) && (v.tvlToken1 <= 0 || p1 > 0);
  const sane = complete && Number.isFinite(v.tvlUsd) && v.tvlUsd >= 0 && v.tvlUsd <= TVL_CEILING_USD;
  const tvlExempt = sane && !v.risky ? v.tvlUsd : 0;
  const reason = !complete ? 'leg-unpriced' : v.reserveCorrupt ? 'reserve-corrupt' : v.risky ? 'risky' : undefined;
  const visibleExempt = sane && !v.risky && tvlExempt >= ctx.th.poolsMinTvlUsd && !excluded;
  return { ...base, tvlExempt, visibleExempt, reason };
}

// ─── Bounded collections ────────────────────────────────────────────────────

/** Keeps the `k` items with the largest `score` (amortised O(1) push). */
export class TopK {
  constructor(k, score) {
    this.k = k;
    this.score = score;
    this.items = [];
  }
  push(item) {
    this.items.push(item);
    if (this.items.length >= this.k * 4) this.trim();
  }
  trim() {
    this.items.sort((a, b) => this.score(b) - this.score(a));
    if (this.items.length > this.k) this.items.length = this.k;
  }
  values() {
    this.trim();
    return [...this.items];
  }
}

/** A Map that forgets its oldest half when full. */
class BoundedCache {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(k) {
    return this.map.get(k);
  }
  has(k) {
    return this.map.has(k);
  }
  set(k, v) {
    if (this.map.size >= this.max) {
      let drop = Math.floor(this.max / 2);
      for (const key of this.map.keys()) {
        this.map.delete(key);
        if (--drop <= 0) break;
      }
    }
    this.map.set(k, v);
  }
}

// ─── CSV ────────────────────────────────────────────────────────────────────

export function csvCell(v) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

class CsvWriter {
  constructor(file, header) {
    this.stream = file ? createWriteStream(file) : undefined;
    this.header = header;
    this.rows = 0;
    this.stream?.write(header.join(',') + '\n');
  }
  write(record) {
    this.rows += 1;
    this.stream?.write(this.header.map((h) => csvCell(record[h])).join(',') + '\n');
  }
  close() {
    return new Promise((resolve) => (this.stream ? this.stream.end(resolve) : resolve()));
  }
}

export const POSITION_CSV_HEADER = Object.freeze([
  'chainId', 'protocol', 'positionId', 'owner', 'poolId', 'pair', 'fee', 'inRange', 'valueUsd', 'landingToday', 'landingAfter',
  'feeExcluded',
  'amount0Stored', 'amount0TickMath', 'amount1Stored', 'amount1TickMath', 'tickMathPriceSource', 'valuationBasis', 'valueTickMathUsd', 'tickMathDeltaUsd',
  'quoteRejectedLegUsd', 'crossCheckDeltaUsd', 'crossCheckIfAllSweptDeltaUsd',
  'trustNewlyExcluded', 'trustExemptionLost',
  // Combined trust + the honeypot exemption: appended, so every earlier column keeps its position.
  'landingAfterCombined', 'trustCombinedNewlyExcluded', 'trustCombinedExemptionLost', 'honeypotExemptKept',
]);
export const POOL_CSV_HEADER = Object.freeze([
  'chainId', 'protocol', 'poolId', 'pair', 'fee', 'change', 'reason', 'tvlTodayUsd', 'tvlAfterUsd', 'visibleToday', 'visibleAfter',
  'changeCombined', 'reasonCombined', 'tvlAfterCombinedUsd', 'visibleAfterCombined', 'honeypotExemptTvlUsd', 'visibleHoneypotExempt',
]);
export const TOKEN_CSV_HEADER = Object.freeze([
  'chainId', 'address', 'symbol', 'priceUsd', 'priceConfidence', 'priceSources', 'pricedAt',
  'anchor', 'allowlisted', 'trustToday', 'trustTodayReason', 'trustEarned', 'trustEarnedReason', 'trustEarnedNow', 'trustEvaluatedAt', 'trustChange',
  'quoteStatus', 'quoteReason', 'guardUsd', 'diaStatus', 'diaAgeDays', 'diaVolumeUsd',
  'openPositions', 'exposureUsd', 'landingPositions', 'landingExposureUsd',
  'trustCombined', 'trustCombinedReason', 'trustCombinedNow', 'trustCombinedChange', 'sourceBucket', 'storedVerdict',
]);

// ─── The scans ──────────────────────────────────────────────────────────────

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * A documents-per-second ceiling over the WHOLE run (every shard, every
 * collection): each read is charged with the documents it fetched, and the
 * next read waits once the run is more than one second's worth ahead of the
 * rate. Every read here is an equality-prefixed keyset range or an `$in` on a
 * unique key, so documents fetched = documents examined (when a hinted index
 * is missing and the planner picks, that no longer holds — the summary names
 * the index each walk used).
 */
export class DocPacer {
  constructor(docsPerSec, { now = () => Date.now(), wait = sleep, burstMs = 1000 } = {}) {
    this.rate = docsPerSec;
    this.now = now;
    this.wait = wait;
    this.burstMs = burstMs;
    this.dueAt = undefined;
    this.docs = 0;
    this.waitedMs = 0;
  }
  async charge(docs) {
    if (!(docs > 0)) return;
    this.docs += docs;
    if (!(this.rate > 0)) return;
    const t = this.now();
    this.dueAt = Math.max(this.dueAt ?? t, t) + (docs / this.rate) * 1000;
    const ahead = this.dueAt - t - this.burstMs;
    if (ahead > 0) {
      this.waitedMs += ahead;
      await this.wait(ahead);
    }
  }
}

/**
 * Keyset walk: `{...filter, [key]: {$gt: last}}` sorted on `key`, `pageSize`
 * rows a page, each page its own bounded query (`maxTimeMS`) on `hint`, each
 * charged to `pacer`.
 */
export async function* keysetPages(coll, { filter, key, projection, hint, pageSize, maxTimeMs, paceMs, readPreference, pacer }) {
  let last;
  for (;;) {
    const page = await coll
      .find(last === undefined ? filter : { ...filter, [key]: { $gt: last } }, {
        projection,
        sort: { [key]: 1 },
        limit: pageSize,
        hint,
        maxTimeMS: maxTimeMs,
        batchSize: pageSize,
        readPreference,
      })
      .toArray();
    await pacer?.charge(page.length);
    if (page.length === 0) return;
    yield page;
    if (page.length < pageSize) return;
    last = page[page.length - 1][key];
    await sleep(paceMs);
  }
}

async function indexHint(coll, wantName, fallbackKey) {
  try {
    const indexes = await coll.listIndexes().toArray();
    if (wantName && indexes.some((i) => i.name === wantName)) return { hint: wantName, name: wantName };
    const fk = JSON.stringify(fallbackKey);
    const match = indexes.find((i) => JSON.stringify(i.key) === fk && !i.partialFilterExpression && (!i.collation || i.collation.locale === 'simple'));
    if (match) return { hint: match.name, name: match.name };
  } catch {
    // fall through: unhinted (the planner picks)
  }
  return { hint: undefined, name: '(planner)' };
}

const TOKEN_PROJECTION = {
  _id: 0, address: 1, symbol: 1, tokenSymbol: 1, priceUsd: 1, pricedAt: 1, priceConfidence: 1, priceSources: 1,
  dexActive: 1, isHoneypot: 1, cannotSellAll: 1, personalSlippageModifiable: 1, isBlacklisted: 1,
  priceQuoteSource: 1, priceQuotedAt: 1, priceQuoteRejected: 1, priceGuardRejected: 1, priceGuardUsd: 1, pricePurgedAt: 1, pricePurgedReason: 1,
  priceEvidenceAt: 1, priceSourcesDisagreed: 1,
  trustEarned: 1, trustReason: 1, trustEvaluatedAt: 1, trustCheckedAt: 1, trustDenied: 1,
};

const POOL_PROJECTION = {
  _id: 0, poolId: 1, 'token0.address': 1, 'token0.symbol': 1, 'token0.decimals': 1, 'token1.address': 1, 'token1.symbol': 1, 'token1.decimals': 1,
  fee: 1, sqrtPriceX96: 1, currentTick: 1, 'metrics.tvlUsd': 1, 'metrics.tvlToken0': 1, 'metrics.tvlToken1': 1, pricing: 1,
};

/** The closed walk (fix 2 only): the fee, plus the two legs the anchor exemption's `$in` branch reads. */
const CLOSED_PROJECTION = { _id: 0, tokenId: 1, fee: 1, 'token0.address': 1, 'token1.address': 1 };

const POSITION_PROJECTION = {
  _id: 0, positionId: 1, owner: 1, poolId: 1, fee: 1, tickLower: 1, tickUpper: 1, liquidity: 1, currentTick: 1, sqrtPriceX96: 1,
  isActive: 1, closedAtTimestamp: 1,
  'token0.address': 1, 'token0.symbol': 1, 'token0.decimals': 1, 'token0.priceUsd': 1,
  'token1.address': 1, 'token1.symbol': 1, 'token1.decimals': 1, 'token1.priceUsd': 1,
  'amounts.amount0': 1, 'amounts.amount1': 1, 'metrics.underlyingValueUsd': 1, 'metrics.inRange': 1, 'poolStats.tvlUsd': 1,
};

function newChainTotals(chainId, protocol) {
  return {
    chainId,
    protocol,
    tokens: { scanned: 0, priced: 0, sweepAt: null },
    open: { rows: 0, valueUsd: 0, landingRows: 0, landingValueUsd: 0 },
    after: { landingRows: 0, landingValueUsd: 0 },
    /** The landing view with fixes 2 + 3 + 4 under TOKEN_TRUST_MODE=combined. */
    afterCombined: { landingRows: 0, landingValueUsd: 0 },
    feeExcluded: { rows: 0, valueUsd: 0, landingRows: 0, landingValueUsd: 0, closedRows: 0 },
    /** What HONEYPOT_FEE_ANCHOR_EXEMPT=on keeps (whether or not it is on here): anchor/anchor rows and pools with a fee ≥ 5%. */
    honeypotExempt: {
      rows: 0, valueUsd: 0, landingRows: 0, landingValueUsd: 0, closedRows: 0,
      pools: 0, poolsTvlUsd: 0, poolsVisible: 0, poolsVisibleTvlUsd: 0, poolsVisibleToday: 0, poolsReservesUnknown: 0, poolsRisky: 0,
    },
    tickMath: {
      rowsComputed: 0, rowsChanged: 0, rowsKept: 0,
      priceSource: { pool: 0, position: 0, tick: 0, none: 0 }, priceSourceDisagree: 0,
      basis: { linear: 0, leg0: 0, leg1: 0, zero: 0, unreconciled: 0 },
      valueBeforeUsd: 0, valueAfterUsd: 0, absDeltaUsd: 0, landingIn: 0, landingOut: 0,
    },
    quotes: { rejected: 0, repriced: 0, candidates: 0, purged: 0, rejectedExposureUsd: 0, rejectedLandingExposureUsd: 0, repricedDeltaUsd: 0, candidateExposureUsd: 0, candidateLandingExposureUsd: 0, evidenceTokens: 0 },
    crossCheck: { rows: 0, valueDeltaUsd: 0, landingRows: 0 },
    crossCheckIfAllSwept: { rows: 0, valueDeltaUsd: 0, landingRows: 0 },
    trust: {
      tokensGain: 0, tokensLose: 0, tokensLosePredicted: 0, tokensNoVerdictHeld: 0, tokensNoVerdictAllowlistedHeld: 0, verdicts: 0, verdictsStale: 0, verdictsEarned: 0,
      loseReasons: {},
      poolsScanned: 0, poolsVisibleToday: 0, poolsVisibleAfter: 0, poolsAppear: 0, poolsAppearTvlUsd: 0, poolsDisappear: 0, poolsDisappearTvlUsd: 0, poolsUndetermined: 0,
      poolsLoseNeverSwept: 0, poolsDisappearNeverSwept: 0, poolsDisappearNeverSweptTvlUsd: 0,
      positionsNewlyExcluded: 0, positionsNewlyExcludedValueUsd: 0, positionsNewlyExcludedLanding: 0, positionsNewlyIncluded: 0,
      positionsExemptionLost: 0, positionsExemptionLostValueUsd: 0,
      /** Non-anchor tokens an open position holds, by trust: today / earned (+ undecided) / combined (+ undecided). */
      heldToday: 0, heldEarned: 0, heldEarnedUndecided: 0, heldCombined: 0, heldCombinedUndecided: 0,
    },
    /** Fix 4 under TOKEN_TRUST_MODE=combined — the same counters as `trust`, against today. */
    trustCombined: newTrustProjection(),
    /** Source coverage + stored verdicts (tokens counted once per chain, on its first shard). */
    coverage: newCoverage(),
    indexes: {},
  };
}

function newTrustProjection() {
  return {
    tokensGain: 0, tokensLose: 0, tokensLosePredicted: 0, tokensNoVerdictHeld: 0, tokensNoVerdictAllowlistedHeld: 0,
    loseReasons: {},
    poolsVisibleAfter: 0, poolsAppear: 0, poolsAppearTvlUsd: 0, poolsDisappear: 0, poolsDisappearTvlUsd: 0, poolsUndetermined: 0,
    poolsLoseNeverSwept: 0, poolsDisappearNeverSwept: 0, poolsDisappearNeverSweptTvlUsd: 0,
    positionsNewlyExcluded: 0, positionsNewlyExcludedValueUsd: 0, positionsNewlyExcludedLanding: 0, positionsNewlyIncluded: 0,
    positionsExemptionLost: 0, positionsExemptionLostValueUsd: 0,
  };
}

/** Count one token's today → projected-mode change into a trust-projection block. */
function countTokenChange(target, tr, mode, change, m, isHeld) {
  if (change === 'gain') target.tokensGain += 1;
  if (change === 'lose') {
    target.tokensLose += 1;
    const r = projectedReason(tr, mode);
    target.loseReasons[r] = (target.loseReasons[r] ?? 0) + 1;
    const asOf = mode === 'combined' ? tr.combinedAsOf : tr.earnedAsOf;
    if (tr.predicted && asOf.reason === 'no-evidence') target.tokensLosePredicted += 1;
  }
  if (change === 'no-verdict' && isHeld) {
    target.tokensNoVerdictHeld += 1;
    if (m.allowlisted) target.tokensNoVerdictAllowlistedHeld += 1;
  }
}

/** Count one pool's projection into a trust-projection block; says whether it enters / leaves the Pools page. */
function countPoolProjection(target, p) {
  if (p.visibleAfter) target.poolsVisibleAfter += 1;
  if (p.change === 'undetermined') target.poolsUndetermined += 1;
  if (p.neverSwept && p.change === 'lose') target.poolsLoseNeverSwept += 1;
  const appears = !p.visibleToday && p.visibleAfter;
  const disappears = p.visibleToday && !p.visibleAfter;
  if (appears) {
    target.poolsAppear += 1;
    target.poolsAppearTvlUsd += p.tvlAfter;
  }
  if (disappears) {
    target.poolsDisappear += 1;
    target.poolsDisappearTvlUsd += p.tvlToday;
    if (p.neverSwept) {
      target.poolsDisappearNeverSwept += 1;
      target.poolsDisappearNeverSweptTvlUsd += p.tvlToday;
    }
  }
  return { appears, disappears };
}

/**
 * `tokens` = every token row of the chain plus held addresses with no row yet
 * (0 sources, no verdict); `held` = the non-anchor ones an open position holds
 * (the set whose verdict decides a valuation).
 */
function newCoverage() {
  const bucket = () => ({ tokens: 0, held: 0, dexOnly: 0, dexOnlyHeld: 0, withAggregator: 0, withAggregatorHeld: 0 });
  return {
    tokens: 0, held: 0, heldNoRow: 0,
    sources: Object.fromEntries(SOURCE_BUCKETS.map((b) => [b, bucket()])),
    verdicts: Object.fromEntries(VERDICT_BUCKETS.map((b) => [b, { tokens: 0, held: 0 }])),
  };
}

/**
 * Run the whole report against a read-only db handle. `fetchImpl` is used only
 * for `--probe-dia` and `--probe-dexscreener`, `probeWait` only to pace the
 * DexScreener probe (specs stub both: no network); outputs go to `outDir` (no
 * files when undefined). Returns the summary object.
 */
export async function runReport({ db, flags, thresholds, now = Date.now(), outDir, fetchImpl = globalThis.fetch, log = () => {}, pacerNow, pacerWait, probeWait = sleep }) {
  const th = thresholds;
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  const shards = discoverShards(names, { chains: flags.chains, protocol: flags.protocol });
  const pacer = new DocPacer(flags.docsPerSec ?? DEFAULTS.docsPerSec, { now: pacerNow, wait: pacerWait });
  const read = { pageSize: flags.pageSize, maxTimeMs: flags.maxTimeMs, paceMs: flags.paceMs, readPreference: flags.readPreference, pacer };
  const posCsv = new CsvWriter(outDir && path.join(outDir, 'positions.csv'), POSITION_CSV_HEADER);
  const poolCsv = new CsvWriter(outDir && path.join(outDir, 'pools.csv'), POOL_CSV_HEADER);
  const tokenCsv = new CsvWriter(outDir && path.join(outDir, 'tokens.csv'), TOKEN_CSV_HEADER);

  const top = {
    feeExcluded: new TopK(flags.top, (r) => r.valueUsd),
    tickMath: new TopK(flags.top, (r) => Math.abs(r.deltaUsd)),
    crossCheck: new TopK(flags.top, (r) => Math.abs(r.deltaUsd)),
    newlyExcluded: new TopK(flags.top, (r) => r.valueUsd),
    poolsAppear: new TopK(flags.top, (r) => r.tvlAfterUsd),
    poolsDisappear: new TopK(flags.top, (r) => r.tvlTodayUsd),
    quoteExposure: new TopK(flags.top, (r) => r.exposureUsd),
    trustLose: new TopK(flags.top, (r) => r.exposureUsd),
    trustGain: new TopK(flags.top, (r) => r.exposureUsd),
    landingToday: new TopK(DEFAULTS.landingTop, (r) => r.valueUsd),
    landingAfter: new TopK(DEFAULTS.landingTop, (r) => r.valueUsd),
    // TOKEN_TRUST_MODE=combined, the same lists.
    newlyExcludedCombined: new TopK(flags.top, (r) => r.valueUsd),
    poolsAppearCombined: new TopK(flags.top, (r) => r.tvlAfterUsd),
    poolsDisappearCombined: new TopK(flags.top, (r) => r.tvlTodayUsd),
    trustLoseCombined: new TopK(flags.top, (r) => r.exposureUsd),
    trustGainCombined: new TopK(flags.top, (r) => r.exposureUsd),
    landingAfterCombined: new TopK(DEFAULTS.landingTop, (r) => r.valueUsd),
    // HONEYPOT_FEE_ANCHOR_EXEMPT: what it keeps.
    honeypotExemptRows: new TopK(flags.top, (r) => r.valueUsd),
    honeypotExemptPools: new TopK(flags.top, (r) => r.tvlExemptUsd),
  };
  const chains = [];
  const tokenReports = [];
  /** `--probe-dexscreener`: per chain, the swept tokens to ask about (highest open exposure first). */
  const dexProbeTargets = [];

  // Shards come sorted by chainId, so one chain's shards are adjacent. Per
  // chain: its tokens once; every shard's OPEN positions (which also collects
  // the token set open positions hold — exactly what the price / trust sweep
  // evaluates, `distinctActiveTokenAddresses`); THEN every shard's pools, so a
  // pool leg no open position holds is known to be one no sweep will ever give
  // a verdict; then the token roll-up.
  const chainIds = [...new Set(shards.map((s) => s.chainId))];
  for (const chainId of chainIds) {
    const chainShards = shards.filter((s) => s.chainId === chainId);
    const shardTotals = new Map();
    for (const shard of chainShards) {
      const totals = newChainTotals(shard.chainId, shard.protocol);
      chains.push(totals);
      shardTotals.set(shard, totals);
    }
    const first = shardTotals.get(chainShards[0]);

    // ── Tokens: one compact map per chain (shared by that chain's protocol shards)
    log(`chain ${chainId}: tokens…`);
    const tokenMap = new Map();
    const tokensName = chainShards.find((s) => s.tokens)?.tokens;
    if (tokensName) {
      const coll = db.collection(tokensName);
      const { hint, name } = await indexHint(coll, undefined, { chainId: 1, address: 1 });
      first.indexes.tokens = name;
      for await (const page of keysetPages(coll, { ...read, filter: { chainId }, key: 'address', projection: TOKEN_PROJECTION, hint })) {
        for (const t of page) {
          t.address = String(t.address).toLowerCase();
          tokenMap.set(t.address, t);
        }
      }
    }
    const state = buildChainState(chainId, tokenMap, th, now);
    state.owner = first;
    const { tokens, meta, trustOf, excludedToday, excludedEarned, excludedCombined, nativeUsd, held } = state;
    for (const totals of shardTotals.values()) {
      totals.tokens.scanned = tokens.size;
      totals.tokens.priced = state.priced;
      totals.tokens.sweepAt = state.sweepAt;
    }

    for (const shard of chainShards) {
      const totals = shardTotals.get(shard);
      // ── Open positions (fixes 1–4)
      log(`chain ${shard.chainId} ${shard.protocol}: open positions…`);
      const posColl = db.collection(shard.positions);
      const poolColl = shard.pools ? db.collection(shard.pools) : undefined;
      const { hint: posHint, name: posHintName } = await indexHint(posColl, 'bg_active_walk', { chainId: 1, protocol: 1, positionId: 1 });
      totals.indexes.positions = posHintName;
      const poolHint = poolColl ? (await indexHint(poolColl, undefined, { chainId: 1, protocol: 1, poolId: 1 })).hint : undefined;
      const poolCache = new BoundedCache(DEFAULTS.poolCacheMax);
      const analyse = positionAnalyser({ shard, totals, th, tokens, meta, excludedToday, excludedEarned, excludedCombined, trustOf, held, top, posCsv, flags });
      for await (const page of keysetPages(posColl, {
        ...read,
        filter: { chainId: shard.chainId, protocol: shard.protocol, isActive: true },
        key: 'positionId',
        projection: POSITION_PROJECTION,
        hint: posHint,
      })) {
        if (poolColl) {
          const need = [...new Set(page.map((r) => r.poolId).filter((id) => id && !poolCache.has(id)))];
          if (need.length > 0) {
            const rows = await poolColl
              .find(
                { chainId: shard.chainId, protocol: shard.protocol, poolId: { $in: need } },
                { projection: { _id: 0, poolId: 1, sqrtPriceX96: 1, currentTick: 1, 'metrics.tvlToken0': 1, 'metrics.tvlToken1': 1 }, hint: poolHint, maxTimeMS: flags.maxTimeMs, readPreference: flags.readPreference },
              )
              .toArray();
            await pacer.charge(rows.length);
            const got = new Map(rows.map((r) => [r.poolId, r]));
            for (const id of need) poolCache.set(id, got.get(id) ?? null);
          }
        }
        for (const row of page) analyse(row, poolCache.get(row.poolId) ?? undefined);
      }

      // ── Closed rows fix 2 would also hide from the Closed / All tabs. On the
      // `{chainId, protocol, isActive, tokenId}` index with `isActive: false`
      // EQUALITY, so the walk reads closed rows only (the positionId index
      // would fetch every row, open ones included, to test `isActive`).
      if (flags.includeClosed) {
        log(`chain ${shard.chainId} ${shard.protocol}: closed positions (fee only)…`);
        const { hint, name } = await indexHint(posColl, undefined, { chainId: 1, protocol: 1, isActive: -1, tokenId: 1 });
        totals.indexes.closed = name;
        for await (const page of keysetPages(posColl, { ...read, filter: { chainId: shard.chainId, protocol: shard.protocol, isActive: false }, key: 'tokenId', projection: CLOSED_PROJECTION, hint })) {
          for (const row of page) {
            const exemption = { chainId: shard.chainId, token0: row.token0?.address, token1: row.token1?.address };
            if (isHoneypotFee(row.fee, { ...exemption, anchorExempt: th.honeypotAnchorExempt === true })) totals.feeExcluded.closedRows += 1;
            if (isHoneypotFee(row.fee) && !isHoneypotFee(row.fee, { ...exemption, anchorExempt: true })) totals.honeypotExempt.closedRows += 1;
          }
        }
      }
    }

    // ── Pools (fix 4: the Pools page), after every shard's open walk filled `held`
    for (const shard of chainShards) {
      if (!shard.pools) continue;
      const totals = shardTotals.get(shard);
      log(`chain ${shard.chainId} ${shard.protocol}: pools…`);
      const coll = db.collection(shard.pools);
      const { hint, name } = await indexHint(coll, undefined, { chainId: 1, protocol: 1, poolId: 1 });
      totals.indexes.pools = name;
      const ctx = { th, tokens, nativeUsd, excludedToday, excludedEarned, excludedCombined, trustOf, held };
      for await (const page of keysetPages(coll, { ...read, filter: { chainId: shard.chainId, protocol: shard.protocol }, key: 'poolId', projection: POOL_PROJECTION, hint })) {
        for (const pool of page) {
          totals.trust.poolsScanned += 1;
          const p = poolProjection(shard.chainId, pool, ctx);
          const pc = poolProjection(shard.chainId, pool, ctx, 'combined');
          if (p.visibleToday) totals.trust.poolsVisibleToday += 1;
          const e = countPoolProjection(totals.trust, p);
          const c = countPoolProjection(totals.trustCombined, pc);
          // HONEYPOT_FEE_ANCHOR_EXEMPT: an anchor/anchor pool the fee alone makes risky.
          const ex = honeypotExemptionPool(shard.chainId, pool, ctx);
          if (ex) {
            const h = totals.honeypotExempt;
            h.pools += 1;
            h.poolsTvlUsd += ex.tvlExempt;
            if (ex.visibleToday) h.poolsVisibleToday += 1;
            if (ex.visibleExempt) {
              h.poolsVisible += 1;
              h.poolsVisibleTvlUsd += ex.tvlExempt;
            }
            if (ex.reason === 'reserves-unknown') h.poolsReservesUnknown += 1;
            else if (ex.reason) h.poolsRisky += 1;
          }
          const pair = `${pool.token0?.symbol ?? '?'}/${pool.token1?.symbol ?? '?'}`;
          const earnedMoves = e.appears || e.disappears || (p.change !== 'none' && p.change !== 'undetermined');
          const combinedMoves = c.appears || c.disappears || (pc.change !== 'none' && pc.change !== 'undetermined');
          if (earnedMoves || combinedMoves || ex) {
            const rec = {
              chainId: shard.chainId, protocol: shard.protocol, poolId: p.poolId, pair,
              fee: p.fee, change: e.appears ? 'appear' : e.disappears ? 'disappear' : p.change, reason: p.reason,
              tvlTodayUsd: p.tvlToday, tvlAfterUsd: p.tvlAfter, visibleToday: p.visibleToday, visibleAfter: p.visibleAfter,
              changeCombined: c.appears ? 'appear' : c.disappears ? 'disappear' : pc.change, reasonCombined: pc.reason,
              tvlAfterCombinedUsd: pc.tvlAfter, visibleAfterCombined: pc.visibleAfter,
              honeypotExemptTvlUsd: ex?.tvlExempt, visibleHoneypotExempt: ex?.visibleExempt,
            };
            poolCsv.write(rec);
            if (e.appears) top.poolsAppear.push(rec);
            if (e.disappears) top.poolsDisappear.push(rec);
            if (c.appears) top.poolsAppearCombined.push({ ...rec, change: 'appear', reason: pc.reason, tvlAfterUsd: pc.tvlAfter });
            if (c.disappears) top.poolsDisappearCombined.push({ ...rec, change: 'disappear', reason: pc.reason, tvlAfterUsd: pc.tvlAfter });
            if (ex) top.honeypotExemptPools.push({ chainId: shard.chainId, poolId: p.poolId, pair, fee: ex.fee, tvlTodayUsd: ex.tvlToday, tvlExemptUsd: ex.tvlExempt, visibleExempt: ex.visibleExempt, reason: ex.reason });
          }
        }
      }
    }

    // ── Token roll-up, once per chain, counted on the chain's first shard
    const owner = state.owner;
    const cov = owner.coverage;
    const countCoverage = (t, isHeld) => {
      const sc = sourceCoverage(t);
      const b = cov.sources[sc.bucket];
      const vb = storedVerdictBucket(t, th, now);
      cov.tokens += 1;
      b.tokens += 1;
      cov.verdicts[vb].tokens += 1;
      if (sc.dexOnly) b.dexOnly += 1;
      if (sc.withAggregator) b.withAggregator += 1;
      if (isHeld) {
        cov.held += 1;
        b.held += 1;
        cov.verdicts[vb].held += 1;
        if (sc.dexOnly) b.dexOnlyHeld += 1;
        if (sc.withAggregator) b.withAggregatorHeld += 1;
      }
      return { sourceBucket: sc.bucket, storedVerdict: vb };
    };
    // One token's trust change under earned / combined, into the chain's
    // counters — for token rows AND held tokens with no row yet, so the
    // held-trust comparison and the coverage section count the same tokens.
    const countTrust = (tr, m, isHeld) => {
      const before = tr.today.trusted;
      const after = earnedTrusted(tr);
      const afterCombined = projectedTrusted(tr, 'combined');
      const change = trustChange(before, after, m.anchor);
      const changeCombined = trustChange(before, afterCombined, m.anchor);
      countTokenChange(owner.trust, tr, 'earned', change, m, isHeld);
      countTokenChange(owner.trustCombined, tr, 'combined', changeCombined, m, isHeld);
      if (isHeld) {
        if (before) owner.trust.heldToday += 1;
        if (after === true) owner.trust.heldEarned += 1;
        if (after === null) owner.trust.heldEarnedUndecided += 1;
        if (afterCombined === true) owner.trust.heldCombined += 1;
        if (afterCombined === null) owner.trust.heldCombinedUndecided += 1;
      }
      return { change, changeCombined };
    };
    for (const [address, m] of meta) {
      const t = tokens.get(address);
      const tr = trustOf(address);
      if (tr.hasVerdict) {
        owner.trust.verdicts += 1;
        if (tr.stale) owner.trust.verdictsStale += 1;
        if (t.trustEarned === true) owner.trust.verdictsEarned += 1;
      }
      const isHeld = m.openPositions > 0;
      const { change, changeCombined } = countTrust(tr, m, isHeld);
      const coverage = countCoverage(t, isHeld);
      const quoteMatters = ['rejected', 'repriced', 'purged'].includes(m.quote.status) || (m.quote.status === 'candidate' && m.exposureUsd > 0);
      // Earned's changes cover combined's: combined loses a token only to a
      // denial earned honours too, and gains one only through an earned
      // verdict (the combined spec pins both over random tokens).
      const trustMatters = change === 'gain' || (change === 'lose' && (isHeld || m.allowlisted)) || (change === 'no-verdict' && isHeld && m.allowlisted);
      if (quoteMatters || trustMatters) tokenReports.push({ owner, chainId, address, t, m, tr, change, changeCombined, coverage });
    }
    // Held tokens the sweep has never written a row for: no sources, no
    // verdict — counted as held in the trust comparison too (an allowlisted
    // one is trusted today and under combined, undecided under earned).
    for (const address of held) {
      if (tokens.has(address) || RULES.isAnchorTokenStandalone(chainId, address)) continue;
      cov.heldNoRow += 1;
      countCoverage(undefined, true);
      countTrust(trustOf(address), { anchor: false, allowlisted: RULES.isAllowlisted(chainId, address) }, true);
    }

    // `--probe-dexscreener`: up to N of the tokens this chain's sweep asks about
    // (the open positions' legs), highest open exposure first; the native
    // pseudo-address is skipped (no DEX lists it).
    if (flags.probeDexscreener && DEXSCREENER_CHAIN[chainId]) {
      const native = String(RULES.getChainConfig(chainId)?.nativeToken?.address ?? '').toLowerCase();
      const exposure = (a) => meta.get(a)?.exposureUsd ?? 0;
      const swept = [...held].filter((a) => /^0x[0-9a-f]{40}$/.test(a) && a !== native);
      swept.sort((x, y) => exposure(y) - exposure(x) || (x < y ? -1 : x > y ? 1 : 0));
      dexProbeTargets.push({ chainId, swept: swept.length, addresses: swept.slice(0, flags.probeDexscreenerLimit ?? DEFAULTS.dexProbeLimit) });
    }
  }

  // ── Fix 1: optional DIA probe of the top-exposure candidates
  const probe = { asked: 0, rejected: 0, errors: 0 };
  if (flags.probeDia) {
    const candidates = tokenReports
      .filter((r) => r.m.quote.status === 'candidate' && isDiaBacked(r.t) && DIA_CHAIN[r.chainId] && r.m.exposureUsd > 0)
      .sort((a, b) => b.m.exposureUsd - a.m.exposureUsd)
      .slice(0, flags.probeLimit);
    log(`probing DIA for ${candidates.length} saved prices…`);
    let i = 0;
    const worker = async () => {
      while (i < candidates.length) {
        const r = candidates[i++];
        probe.asked += 1;
        try {
          const res = await fetchImpl(`${DIA_BASE_URL}/assetQuotation/${DIA_CHAIN[r.chainId]}/${r.address}`, { signal: AbortSignal.timeout(10_000) });
          const body = res.ok ? await res.json() : undefined;
          r.dia = diaProbeVerdict(body, r.t.priceUsd, th, now);
          if (r.dia.status === 'rejected') {
            probe.rejected += 1;
            r.m.quote = { status: 'rejected', reason: `dia-probe:${r.dia.reason}`, guardUsd: 0 };
          }
        } catch {
          probe.errors += 1;
          r.dia = { status: 'error' };
        }
        await sleep(Math.max(flags.paceMs, 100));
      }
    };
    await Promise.all(Array.from({ length: DEFAULTS.probeConcurrency }, worker));
  }

  // ── Optional DexScreener probe: both batch endpoints over the same tokens
  const dexProbe = flags.probeDexscreener ? await probeDexscreener(dexProbeTargets, { fetchImpl, wait: probeWait, intervalMs: Math.max(DEFAULTS.dexProbeIntervalMs, flags.paceMs), log }) : null;

  // ── Quote + trust roll-up and token CSV
  for (const r of tokenReports) {
    const c = r.owner;
    const q = r.m.quote;
    if (q.status === 'rejected') {
      c.quotes.rejected += 1;
      c.quotes.rejectedExposureUsd += r.m.exposureUsd;
      c.quotes.rejectedLandingExposureUsd += r.m.landingExposureUsd;
    } else if (q.status === 'repriced') {
      c.quotes.repriced += 1;
      c.quotes.repricedDeltaUsd += r.m.exposureUsd * (q.guardUsd / num(r.t?.priceUsd) - 1);
    } else if (q.status === 'purged') {
      c.quotes.purged += 1;
    } else if (q.status === 'candidate' && r.m.exposureUsd > 0) {
      c.quotes.candidates += 1;
      c.quotes.candidateExposureUsd += r.m.exposureUsd;
      c.quotes.candidateLandingExposureUsd += r.m.landingExposureUsd;
    }
    const symbol = r.t?.symbol ?? r.t?.tokenSymbol;
    if (['rejected', 'repriced', 'candidate'].includes(q.status) && r.m.exposureUsd > 0) {
      top.quoteExposure.push({ chainId: r.chainId, address: r.address, symbol, priceUsd: num(r.t?.priceUsd), status: q.status, reason: q.reason, guardUsd: q.guardUsd, exposureUsd: r.m.exposureUsd, landingExposureUsd: r.m.landingExposureUsd, positions: r.m.top.map((p) => p.positionId).slice(0, 3) });
    }
    const trustRow = { chainId: r.chainId, address: r.address, symbol, reason: earnedReason(r.tr), exposureUsd: r.m.exposureUsd, landingExposureUsd: r.m.landingExposureUsd, openPositions: r.m.openPositions, stale: r.tr.stale };
    if (r.change === 'lose') top.trustLose.push(trustRow);
    if (r.change === 'gain') top.trustGain.push(trustRow);
    const trustRowCombined = { ...trustRow, reason: projectedReason(r.tr, 'combined'), stale: r.tr.combinedStale };
    if (r.changeCombined === 'lose') top.trustLoseCombined.push(trustRowCombined);
    if (r.changeCombined === 'gain') top.trustGainCombined.push(trustRowCombined);
    const earnedNow = earnedTrusted(r.tr);
    const combinedNow = projectedTrusted(r.tr, 'combined');
    tokenCsv.write({
      chainId: r.chainId, address: r.address, symbol, priceUsd: num(r.t?.priceUsd), priceConfidence: r.t?.priceConfidence,
      priceSources: (r.t?.priceSources ?? []).join('|'), pricedAt: asDate(r.t?.pricedAt)?.toISOString(),
      anchor: r.m.anchor, allowlisted: r.m.allowlisted,
      trustToday: r.tr.today.trusted, trustTodayReason: r.tr.today.reason,
      trustEarned: earnedNow === null ? 'undetermined' : earnedNow, trustEarnedReason: earnedReason(r.tr),
      trustEarnedNow: r.tr.earned.reason, trustEvaluatedAt: asDate(r.t?.trustEvaluatedAt ?? r.t?.trustCheckedAt)?.toISOString(), trustChange: r.change,
      quoteStatus: q.status, quoteReason: q.reason, guardUsd: q.guardUsd,
      diaStatus: r.dia?.status, diaAgeDays: r.dia?.ageMs !== undefined ? r.dia.ageMs / 86_400_000 : undefined, diaVolumeUsd: r.dia?.volumeUsd,
      openPositions: r.m.openPositions, exposureUsd: r.m.exposureUsd, landingPositions: r.m.landingPositions, landingExposureUsd: r.m.landingExposureUsd,
      trustCombined: combinedNow === null ? 'undetermined' : combinedNow, trustCombinedReason: projectedReason(r.tr, 'combined'),
      trustCombinedNow: r.tr.combined.reason, trustCombinedChange: r.changeCombined,
      sourceBucket: r.coverage?.sourceBucket, storedVerdict: r.coverage?.storedVerdict,
    });
  }

  await Promise.all([posCsv.close(), poolCsv.close(), tokenCsv.close()]);

  const summary = {
    generatedAt: new Date(now).toISOString(),
    thresholds: printableThresholds(th),
    flags: {
      chains: flags.chains, protocol: flags.protocol, readPreference: flags.readPreference, pageSize: flags.pageSize, paceMs: flags.paceMs,
      docsPerSec: flags.docsPerSec ?? DEFAULTS.docsPerSec, maxTimeMs: flags.maxTimeMs, probeDia: flags.probeDia, includeClosed: flags.includeClosed,
      probeDexscreener: flags.probeDexscreener === true, probeDexscreenerLimit: flags.probeDexscreener ? flags.probeDexscreenerLimit : undefined,
    },
    reads: { docs: pacer.docs, pacedMs: Math.round(pacer.waitedMs) },
    shards: shards.map((s) => ({ chainId: s.chainId, protocol: s.protocol, positions: s.positions, pools: s.pools ?? null, tokens: s.tokens ?? null })),
    chains,
    totals: sumTotals(chains),
    probe,
    dexProbe,
    top: Object.fromEntries(Object.entries(top).map(([k, v]) => [k, v.values()])),
    csvRows: { positions: posCsv.rows, pools: poolCsv.rows, tokens: tokenCsv.rows },
  };
  summary.landingTop = landingTopComparison(summary.top.landingToday, summary.top.landingAfter);
  summary.landingTopCombined = landingTopComparison(summary.top.landingToday, summary.top.landingAfterCombined);
  return summary;
}

/** Per-chain token state: trust in every mode, the three exclusion sets, exposure accumulators. */
function buildChainState(chainId, tokens, th, now) {
  const meta = new Map();
  const trustCache = new Map();
  let priced = 0;
  let sweepAt = 0;
  for (const [address, t] of tokens) {
    if (num(t.priceUsd) > 0) priced += 1;
    const at = asDate(t.pricedAt)?.getTime() ?? 0;
    if (at > sweepAt) sweepAt = at;
    meta.set(address, {
      anchor: RULES.isAnchorTokenStandalone(chainId, address),
      allowlisted: RULES.isAllowlisted(chainId, address),
      quote: savedQuoteVerdict(t, th),
      openPositions: 0, exposureUsd: 0, landingPositions: 0, landingExposureUsd: 0, top: [],
    });
  }
  const trustOf = (address) => {
    let tr = trustCache.get(address);
    if (!tr) {
      tr = tokenTrust(chainId, address, tokens.get(address), th, now);
      trustCache.set(address, tr);
    }
    return tr;
  };
  const exToday = new Set();
  const exEarned = new Set();
  const exCombined = new Set();
  // As-of-sweep trust for the projected exclusions (a paused sweep must not read as "everything excluded").
  const asOfFn = (mode) => (addr) => {
    const tr = trustOf(addr);
    const asOf = mode === 'combined' ? tr.combinedAsOf : tr.earnedAsOf;
    return asOf.reason === 'no-evidence' && tr.predicted ? tr.predicted : asOf;
  };
  const earnedAsOfFn = asOfFn('earned');
  const combinedAsOfFn = asOfFn('combined');
  for (const [address, t] of tokens) {
    const spam = isSpamToken(t);
    if (spam || isNoRealMarket(chainId, t, th.allowlist, now)) exToday.add(address);
    if (spam || isNoRealMarket(chainId, t, th.earned, now, earnedAsOfFn)) exEarned.add(address);
    if (spam || isNoRealMarket(chainId, t, th.combined, now, combinedAsOfFn)) exCombined.add(address);
  }
  const chainConfig = RULES.getChainConfig(chainId);
  const nativeUsd =
    num(tokens.get(String(chainConfig?.nativeToken?.address ?? '').toLowerCase())?.priceUsd) ||
    num(tokens.get(String(chainConfig?.wrappedNativeToken?.address ?? '').toLowerCase())?.priceUsd);
  return {
    tokens,
    meta,
    priced,
    sweepAt: sweepAt > 0 ? new Date(sweepAt).toISOString() : null,
    trustOf,
    excludedToday: (a) => exToday.has(a) || isEnvDenied(chainId, a, th.allowlist),
    excludedEarned: (a) => exEarned.has(a) || isEnvDenied(chainId, a, th.earned),
    excludedCombined: (a) => exCombined.has(a) || isEnvDenied(chainId, a, th.combined),
    nativeUsd,
    /** Token addresses open positions hold (filled by the open walk) — the set the sweep evaluates. */
    held: new Set(),
  };
}

/** The per-row analysis of one open position (closure over the shard's state). */
function positionAnalyser({ shard, totals, th, tokens, meta, excludedToday, excludedEarned, excludedCombined, trustOf, held, top, posCsv, flags }) {
  return function analyse(row, pool) {
    const a0 = String(row.token0?.address ?? '').toLowerCase();
    const a1 = String(row.token1?.address ?? '').toLowerCase();
    // `distinctActiveTokenAddresses` reads token0/token1.address of isActive:true rows — this walk's rows.
    if (held) {
      if (a0) held.add(a0);
      if (a1) held.add(a1);
    }
    const value = num(row.metrics?.underlyingValueUsd);
    const inRange = row.metrics?.inRange === true;
    const poolTvl = row.poolStats?.tvlUsd;
    const pair = `${row.token0?.symbol ?? '?'}/${row.token1?.symbol ?? '?'}`;
    const landingToday = landingVisible({ inRange, value, poolTvl, excluded0: excludedToday(a0), excluded1: excludedToday(a1) }, th);
    totals.open.rows += 1;
    totals.open.valueUsd += value;
    if (landingToday) {
      totals.open.landingRows += 1;
      totals.open.landingValueUsd += value;
      top.landingToday.push({ chainId: shard.chainId, positionId: row.positionId, pair, valueUsd: value });
    }
    const rec = { chainId: shard.chainId, protocol: shard.protocol, positionId: row.positionId, owner: row.owner, poolId: row.poolId, pair, fee: row.fee, inRange, valueUsd: value, landingToday };
    let interesting = false;

    // Fix 2 — the rule as configured (HONEYPOT_FEE_ANCHOR_EXEMPT from the env;
    // off = today's three-branch clause), and separately what the exemption
    // keeps: a ≥ 5% row whose STORED legs are both anchors.
    const exemption = { chainId: shard.chainId, token0: row.token0?.address, token1: row.token1?.address };
    const feeExcluded = isHoneypotFee(row.fee, { ...exemption, anchorExempt: th.honeypotAnchorExempt === true });
    const exemptKeeps = isHoneypotFee(row.fee) && !isHoneypotFee(row.fee, { ...exemption, anchorExempt: true });
    rec.feeExcluded = feeExcluded;
    if (exemptKeeps) {
      interesting = true;
      rec.honeypotExemptKept = true;
      totals.honeypotExempt.rows += 1;
      totals.honeypotExempt.valueUsd += value;
      if (landingToday) {
        totals.honeypotExempt.landingRows += 1;
        totals.honeypotExempt.landingValueUsd += value;
      }
      top.honeypotExemptRows.push({ chainId: shard.chainId, positionId: row.positionId, pair, fee: num(row.fee), valueUsd: value, landingToday });
    }
    if (feeExcluded) {
      interesting = true;
      totals.feeExcluded.rows += 1;
      totals.feeExcluded.valueUsd += value;
      if (landingToday) {
        totals.feeExcluded.landingRows += 1;
        totals.feeExcluded.landingValueUsd += value;
      }
      top.feeExcluded.push({ chainId: shard.chainId, positionId: row.positionId, pair, fee: num(row.fee), valueUsd: value, landingToday });
    }

    // Fix 3
    const state = choosePoolState(pool, row);
    totals.tickMath.priceSource[state.source] += 1;
    const s0 = num(row.amounts?.amount0);
    const s1 = num(row.amounts?.amount1);
    const p0 = num(row.token0?.priceUsd);
    const p1 = num(row.token1?.priceUsd);
    const range = { liquidity: row.liquidity, tickLower: row.tickLower, tickUpper: row.tickUpper, decimals0: num(row.token0?.decimals), decimals1: num(row.token1?.decimals) };
    const tm = isPositionOpen(row) && state.source !== 'none' ? tickMathAmounts({ ...range, sqrtPriceX96: state.sqrtPriceX96, currentTick: state.currentTick }) : null;
    let valueAfter = value;
    if (!tm) {
      totals.tickMath.rowsKept += 1;
    } else {
      totals.tickMath.rowsComputed += 1;
      if (state.source === 'pool' && usableSqrt(row.sqrtPriceX96) && row.sqrtPriceX96 !== state.sqrtPriceX96) {
        const alt = tickMathAmounts({ ...range, sqrtPriceX96: row.sqrtPriceX96, currentTick: num(row.currentTick) });
        if (alt && (!relClose(alt.amount0, tm.amount0) || !relClose(alt.amount1, tm.amount1))) totals.tickMath.priceSourceDisagree += 1;
      }
      const basis = valuationBasis({ value, a0: s0, a1: s1, p0, p1 });
      totals.tickMath.basis[basis] += 1;
      valueAfter = Math.max(0, projectValue(basis, { value, a0: s0, a1: s1, p0, p1, tm0: tm.amount0, tm1: tm.amount1 }));
      const delta = valueAfter - value;
      totals.tickMath.valueBeforeUsd += value;
      totals.tickMath.valueAfterUsd += valueAfter;
      totals.tickMath.absDeltaUsd += Math.abs(delta);
      if (!relClose(tm.amount0, s0) || !relClose(tm.amount1, s1)) totals.tickMath.rowsChanged += 1;
      Object.assign(rec, { amount0Stored: s0, amount0TickMath: tm.amount0, amount1Stored: s1, amount1TickMath: tm.amount1, tickMathPriceSource: state.source, valuationBasis: basis, valueTickMathUsd: valueAfter, tickMathDeltaUsd: delta });
      if (Math.abs(delta) >= flags.csvMinDeltaUsd) {
        interesting = true;
        top.tickMath.push({ chainId: shard.chainId, positionId: row.positionId, pair, valueUsd: value, valueAfterUsd: valueAfter, deltaUsd: delta, basis, source: state.source });
      }
      const inAfter = landingVisible({ inRange, value: valueAfter, poolTvl, excluded0: excludedToday(a0), excluded1: excludedToday(a1) }, th);
      if (inAfter && !landingToday) totals.tickMath.landingIn += 1;
      if (!inAfter && landingToday) totals.tickMath.landingOut += 1;
    }

    // Fix 1 — exposure on each leg's saved price (non-anchor legs)
    let rejectedLegUsd = 0;
    for (const [addr, amount, price] of [[a0, s0, p0], [a1, s1, p1]]) {
      const m = meta.get(addr);
      if (!m || m.anchor) continue;
      const legUsd = amount * price;
      m.openPositions += 1;
      m.exposureUsd += legUsd;
      if (landingToday) {
        m.landingPositions += 1;
        m.landingExposureUsd += legUsd;
      }
      if (m.quote.status === 'rejected') rejectedLegUsd += legUsd;
      if (legUsd > 0) {
        m.top.push({ positionId: row.positionId, legUsd });
        if (m.top.length > 6) m.top = m.top.sort((x, y) => y.legUsd - x.legUsd).slice(0, 3);
      }
    }
    if (rejectedLegUsd > 0) {
      interesting = true;
      rec.quoteRejectedLegUsd = rejectedLegUsd;
    }
    const metrics = pool?.metrics;
    const reserves = metrics && metrics.tvlToken0 !== undefined && metrics.tvlToken1 !== undefined && num(metrics.tvlToken0) >= 0 && num(metrics.tvlToken1) >= 0
      ? { reserve0: num(metrics.tvlToken0), reserve1: num(metrics.tvlToken1) }
      : undefined;
    const crossState = state.source === 'none' ? undefined : state;
    const cross = allowlistCrossCheck(shard.chainId, row, tokens, crossState, reserves, th, { corroboration: 'built' });
    const crossIfAllSwept = allowlistCrossCheck(shard.chainId, row, tokens, crossState, reserves, th, { corroboration: 'all-swept' });
    if (crossIfAllSwept?.changed) {
      totals.crossCheckIfAllSwept.rows += 1;
      totals.crossCheckIfAllSwept.valueDeltaUsd += crossIfAllSwept.deltaUsd;
      if (landingToday) totals.crossCheckIfAllSwept.landingRows += 1;
      rec.crossCheckIfAllSweptDeltaUsd = crossIfAllSwept.deltaUsd;
    }
    if (cross?.changed) {
      interesting = true;
      totals.crossCheck.rows += 1;
      totals.crossCheck.valueDeltaUsd += cross.deltaUsd;
      if (landingToday) totals.crossCheck.landingRows += 1;
      rec.crossCheckDeltaUsd = cross.deltaUsd;
      top.crossCheck.push({ chainId: shard.chainId, positionId: row.positionId, pair, valueUsd: value, deltaUsd: cross.deltaUsd, trust: `${cross.trust0}/${cross.trust1}` });
    }

    // Fix 4 — the no-real-market exemption follows the projected trust mode
    // (earned, then combined: the same rule, the same counters, its own block).
    const exclusionMoves = (excludedAfter, mode, target, topList) => {
      const newly = (excludedAfter(a0) && !excludedToday(a0)) || (excludedAfter(a1) && !excludedToday(a1));
      const included = !newly && (excludedToday(a0) || excludedToday(a1)) && !excludedAfter(a0) && !excludedAfter(a1);
      const lostExemption = [a0, a1].some((a) => {
        const m = meta.get(a);
        return m && !m.anchor && trustOf(a).today.trusted && projectedTrusted(trustOf(a), mode) === false;
      });
      if (newly) {
        target.positionsNewlyExcluded += 1;
        target.positionsNewlyExcludedValueUsd += value;
        if (landingToday) target.positionsNewlyExcludedLanding += 1;
        topList.push({ chainId: shard.chainId, positionId: row.positionId, pair, valueUsd: value, landingToday });
      } else if (lostExemption) {
        target.positionsExemptionLost += 1;
        target.positionsExemptionLostValueUsd += value;
      }
      if (included) target.positionsNewlyIncluded += 1;
      return { newly, lostExemption: !newly && lostExemption };
    };
    const earnedMove = exclusionMoves(excludedEarned, 'earned', totals.trust, top.newlyExcluded);
    if (earnedMove.newly) {
      interesting = true;
      rec.trustNewlyExcluded = true;
    } else if (earnedMove.lostExemption) {
      rec.trustExemptionLost = true;
    }
    const combinedMove = exclusionMoves(excludedCombined, 'combined', totals.trustCombined, top.newlyExcludedCombined);
    if (combinedMove.newly) {
      interesting = true;
      rec.trustCombinedNewlyExcluded = true;
    } else if (combinedMove.lostExemption) {
      rec.trustCombinedExemptionLost = true;
    }

    // The landing view with fixes 2 + 3 + 4 together (fix 1's re-price is reported separately), per projected mode
    const landingAfter = !feeExcluded && landingVisible({ inRange, value: valueAfter, poolTvl, excluded0: excludedEarned(a0), excluded1: excludedEarned(a1) }, th);
    rec.landingAfter = landingAfter;
    if (landingAfter) {
      totals.after.landingRows += 1;
      totals.after.landingValueUsd += valueAfter;
      top.landingAfter.push({ chainId: shard.chainId, positionId: row.positionId, pair, valueUsd: valueAfter });
    }
    const landingAfterCombined = !feeExcluded && landingVisible({ inRange, value: valueAfter, poolTvl, excluded0: excludedCombined(a0), excluded1: excludedCombined(a1) }, th);
    rec.landingAfterCombined = landingAfterCombined;
    if (landingAfterCombined) {
      totals.afterCombined.landingRows += 1;
      totals.afterCombined.landingValueUsd += valueAfter;
      top.landingAfterCombined.push({ chainId: shard.chainId, positionId: row.positionId, pair, valueUsd: valueAfter });
    }
    if (interesting || landingAfter !== landingToday || landingAfterCombined !== landingToday) posCsv.write(rec);
  };
}

/** Sum every numeric leaf of the per-chain totals. */
export function sumTotals(chains) {
  const add = (acc, obj) => {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'chainId' || k === 'protocol' || k === 'indexes' || k === 'sweepAt') continue;
      if (typeof v === 'number') acc[k] = (acc[k] ?? 0) + v;
      else if (v && typeof v === 'object') add((acc[k] ??= {}), v);
    }
    return acc;
  };
  return chains.reduce((acc, c) => add(acc, c), {});
}

/** The landing view's top N (all chains merged) today vs after fixes 2+3+4. */
export function landingTopComparison(today, after) {
  const sum = (rows) => rows.reduce((s, r) => s + r.valueUsd, 0);
  const afterIds = new Set(after.map((r) => `${r.chainId}:${r.positionId}`));
  const leaving = today.filter((r) => !afterIds.has(`${r.chainId}:${r.positionId}`));
  return { n: today.length, todayValueUsd: sum(today), afterValueUsd: sum(after), leaving: leaving.length, leavingValueUsd: sum(leaving) };
}

// ─── Markdown ───────────────────────────────────────────────────────────────

export function usd(v) {
  const n = num(v);
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(0);
  return `${n < 0 ? '−' : ''}$${s}`;
}
const int = (v) => num(v).toLocaleString('en-US');
const pctFee = (fee) => `${(num(fee) / 10_000).toFixed(2)}%`;

function table(header, rows) {
  if (rows.length === 0) return '_none_\n';
  const esc = (c) => String(c ?? '').replace(/\|/g, '\\|');
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`), ''].join('\n');
}

export function renderMarkdown(s) {
  const T = s.totals;
  const L = [];
  const th = s.thresholds;
  L.push(`# Valuation impact report — ${s.generatedAt.slice(0, 10)}`);
  L.push('');
  L.push(`Read-only dry run of fixes 1–4 (docs/spam-and-pool-mismatch-2026-10-05.md) over every open position and pool on ${s.chains.length} shard(s). Generated ${s.generatedAt}. Fix 4 is projected for \`TOKEN_TRUST_MODE=earned\` and \`=combined\` (anchor ‖ allowlisted ‖ earned); fix 2 applies \`HONEYPOT_FEE_ANCHOR_EXEMPT=${th.honeypotAnchorExempt ? 'on' : 'off'}\` (this env).`);
  L.push('');
  L.push(`## Landing view (open, in range, value ≥ ${usd(th.landingMinValueUsd)}, pool TVL ≥ ${usd(th.landingMinPoolTvlUsd)} or unknown, not excluded)`);
  L.push('');
  L.push(table(['', 'Rows', 'Value'], [
    ['Today', int(T.open?.landingRows), usd(T.open?.landingValueUsd)],
    ['After fixes 2 + 3 + 4', int(T.after?.landingRows), usd(T.after?.landingValueUsd)],
    ['After fixes 2 + 3 + 4, combined trust (`TOKEN_TRUST_MODE=combined`)', int(T.afterCombined?.landingRows), usd(T.afterCombined?.landingValueUsd)],
    ['Landing value on saved prices fix 1 rejects (re-priced or cleared by the next sweep)', '', usd(T.quotes?.rejectedLandingExposureUsd)],
    ['Landing value on unverified DIA-only / single-source saved prices (candidates)', '', usd(T.quotes?.candidateLandingExposureUsd)],
  ]));
  L.push(`Top ${s.landingTop.n} of the landing view (all chains merged): ${usd(s.landingTop.todayValueUsd)} today → ${usd(s.landingTop.afterValueUsd)} after; ${s.landingTop.leaving} of today's top ${s.landingTop.n} rows (${usd(s.landingTop.leavingValueUsd)}) leave it.`);
  if (s.landingTopCombined) {
    L.push(`With combined trust instead: ${usd(s.landingTopCombined.afterValueUsd)} after; ${s.landingTopCombined.leaving} of today's top ${s.landingTopCombined.n} rows (${usd(s.landingTopCombined.leavingValueUsd)}) leave it.`);
  }
  L.push('');
  L.push('## Per chain');
  L.push('');
  L.push(table(
    ['Chain', 'Open rows', 'Landing today', 'Landing after', 'Landing after (combined)', 'Fee ≥ 5% rows (landing)', 'Tick-math Σ|Δ|', 'Pools appear / disappear', 'Newly excluded rows', 'Newly excluded (combined)', 'Newest saved price'],
    s.chains.map((c) => [
      `${c.chainId} ${c.protocol}`,
      int(c.open.rows),
      `${int(c.open.landingRows)} · ${usd(c.open.landingValueUsd)}`,
      `${int(c.after.landingRows)} · ${usd(c.after.landingValueUsd)}`,
      `${int(c.afterCombined?.landingRows)} · ${usd(c.afterCombined?.landingValueUsd)}`,
      `${int(c.feeExcluded.rows)} (${int(c.feeExcluded.landingRows)}) · ${usd(c.feeExcluded.valueUsd)}`,
      usd(c.tickMath.absDeltaUsd),
      `${int(c.trust.poolsAppear)} · ${usd(c.trust.poolsAppearTvlUsd)} / ${int(c.trust.poolsDisappear)} · ${usd(c.trust.poolsDisappearTvlUsd)}`,
      `${int(c.trust.positionsNewlyExcluded)} · ${usd(c.trust.positionsNewlyExcludedValueUsd)}`,
      `${int(c.trustCombined?.positionsNewlyExcluded)} · ${usd(c.trustCombined?.positionsNewlyExcludedValueUsd)}`,
      c.tokens.sweepAt ? c.tokens.sweepAt.slice(0, 16).replace('T', ' ') : '–',
    ]),
  ));

  L.push('## Fix 2 — honeypot fees (`HONEYPOT_FEE_FILTER=on`, exact)');
  L.push('');
  L.push(`${int(T.feeExcluded?.rows)} open rows (${usd(T.feeExcluded?.valueUsd)}) sit in pools with a static fee ≥ 5%${th.honeypotAnchorExempt ? ' (anchor/anchor pools exempt: `HONEYPOT_FEE_ANCHOR_EXEMPT=on` here)' : ''}; ${int(T.feeExcluded?.landingRows)} of them (${usd(T.feeExcluded?.landingValueUsd)}) are on the landing view today.` + (s.flags.includeClosed ? ` Closed rows the Closed / All tabs would also hide: ${int(T.feeExcluded?.closedRows)}.` : ' Closed rows not counted (`--include-closed`).') + ' Every one stays reachable by id or owner lookup.');
  L.push('');
  L.push(table(['Chain', 'Position', 'Pair', 'Fee', 'Value', 'Landing'], s.top.feeExcluded.map((r) => [r.chainId, r.positionId, r.pair, pctFee(r.fee), usd(r.valueUsd), r.landingToday ? 'yes' : ''])));
  const hx = T.honeypotExempt ?? {};
  L.push(`### What \`HONEYPOT_FEE_ANCHOR_EXEMPT=on\` keeps (${th.honeypotAnchorExempt ? 'on in this env — applied to fix 2 above; the pools it re-values are counted here, not under fix 4' : 'off in this env — counted, not applied'})`);
  L.push('');
  L.push(`A pool whose BOTH legs are config anchors (stables, native, wrapped native, trusted majors — \`isAnchorPair\`) is never a honeypot-fee pool. Open rows kept: ${int(hx.rows)} (${usd(hx.valueUsd)}; ${int(hx.landingRows)} on the landing view today, ${usd(hx.landingValueUsd)})` + (s.flags.includeClosed ? `; closed rows kept: ${int(hx.closedRows)}` : '') + `. Anchor/anchor pools with a fee ≥ 5%: ${int(hx.pools)} — re-valued with the exemption at ${usd(hx.poolsTvlUsd)} TVL; ${int(hx.poolsVisible)} (${usd(hx.poolsVisibleTvlUsd)}) would be on the Pools page (TVL ≥ ${usd(th.poolsMinTvlUsd)}; ${int(hx.poolsVisibleToday)} already are), ${int(hx.poolsRisky)} stay risky for another reason (fabrication, corrupt reserves, an unpriced leg), ${int(hx.poolsReservesUnknown)} have no stored reserves.`);
  L.push('');
  L.push('Anchor/anchor pools the exemption re-values:');
  L.push('');
  L.push(table(['Chain', 'Pool', 'Pair', 'Fee', 'TVL today', 'TVL exempt', 'Pools page', 'Note'], s.top.honeypotExemptPools.map((r) => [r.chainId, `${r.poolId.slice(0, 12)}…`, r.pair, pctFee(r.fee), usd(r.tvlTodayUsd), usd(r.tvlExemptUsd), r.visibleExempt ? 'yes' : '', r.reason ?? ''])));
  L.push('Open rows the exemption keeps:');
  L.push('');
  L.push(table(['Chain', 'Position', 'Pair', 'Fee', 'Value', 'Landing'], s.top.honeypotExemptRows.map((r) => [r.chainId, r.positionId, r.pair, pctFee(r.fee), usd(r.valueUsd), r.landingToday ? 'yes' : ''])));

  L.push('## Fix 3 — tick-math amounts (`POSITION_AMOUNTS_SOURCE=tickmath`)');
  L.push('');
  const tm = T.tickMath ?? {};
  L.push(`${int(tm.rowsComputed)} open rows recomputed; ${int(tm.rowsKept)} keep the indexer's amounts (no liquidity, an unreadable range, or no pool price stored). Pool price from: pool row ${int(tm.priceSource?.pool)}, row snapshot ${int(tm.priceSource?.position)}, tick only ${int(tm.priceSource?.tick)}, none ${int(tm.priceSource?.none)}; the pool row's and the row's own stored price give amounts more than 1% apart on ${int(tm.priceSourceDisagree)} rows (the refresh itself uses the indexer's current pool price).`);
  L.push(`Open value ${usd(tm.valueBeforeUsd)} → ${usd(tm.valueAfterUsd)} (Σ|Δ| ${usd(tm.absDeltaUsd)}); amounts move > 1% on ${int(tm.rowsChanged)} rows. Landing view: ${int(tm.landingIn)} rows cross into the ${usd(th.landingMinValueUsd)} floor, ${int(tm.landingOut)} fall out.`);
  L.push(`Valuation basis: both legs ${int(tm.basis?.linear)}, one leg gated ${int(num(tm.basis?.leg0) + num(tm.basis?.leg1))}, valued $0 ${int(tm.basis?.zero)}, unreconciled (scaled, approximate) ${int(tm.basis?.unreconciled)}. Values are at the leg prices each row serves today; the adapter's gates re-run on the next refresh.`);
  L.push('');
  L.push(table(['Chain', 'Position', 'Pair', 'Stored', 'Tick math', 'Δ', 'Basis', 'Price from'], s.top.tickMath.map((r) => [r.chainId, r.positionId, r.pair, usd(r.valueUsd), usd(r.valueAfterUsd), usd(r.deltaUsd), r.basis, r.source])));

  L.push('## Fix 1 — stale / thin quotes (`PRICE_QUOTE_GUARD=on`)');
  L.push('');
  const q = T.quotes ?? {};
  L.push(`Saved prices the guard rejects: ${int(q.rejected)} tokens carrying ${usd(q.rejectedExposureUsd)} of open-position leg value (${usd(q.rejectedLandingExposureUsd)} on the landing view). Saved prices the guard's accepted-only consensus re-prices: ${int(q.repriced)} tokens, net ${usd(q.repricedDeltaUsd)}. Already purged: ${int(q.purged)}. Unverified candidates (DIA-only / single-source, quote time not stored): ${int(q.candidates)} tokens, ${usd(q.candidateExposureUsd)} (${usd(q.candidateLandingExposureUsd)} landing).` + (s.flags.probeDia ? ` DIA probe: asked ${int(s.probe.asked)}, proved ${int(s.probe.rejected)} saved prices stale/thin, ${int(s.probe.errors)} errors.` : ' Run with `--probe-dia` to turn the top DIA-backed candidates into definite verdicts, or run one sweep with `TOKEN_TRUST_SHADOW=on` so the sweep stores the guard evidence.'));
  L.push(`Thresholds: max quote age ${(th.quoteMaxAgeMs / 3_600_000).toFixed(1)} h, DIA minimum 24h volume ${usd(th.diaMinVolumeUsd)}.`);
  L.push('');
  L.push(table(['Chain', 'Token', 'Saved price', 'Verdict', 'Open leg value', 'Landing', 'Top positions'], s.top.quoteExposure.map((r) => [r.chainId, `${r.symbol ?? '?'} ${r.address.slice(0, 10)}…`, `$${num(r.priceUsd).toPrecision(5)}`, `${r.status}${r.reason ? ` (${r.reason})` : ''}${r.status === 'repriced' ? ` → $${num(r.guardUsd).toPrecision(5)}` : ''}`, usd(r.exposureUsd), usd(r.landingExposureUsd), r.positions.join(' ')])));
  L.push(`Both-legs-allowlisted cross-check, as built (\`PricingService\` marks a leg corroborated from the sweep's stored consensus; a leg whose sources disagreed stays unverified; a leg the sweep never priced is left alone): ${int(T.crossCheck?.rows)} open rows change value (net ${usd(T.crossCheck?.valueDeltaUsd)}; ${int(T.crossCheck?.landingRows)} on the landing view). Backing floor ${usd(th.minRealMarketBackingUsd)}.`);
  L.push(`Upper bound, once every held leg has a sweep verdict (a leg with none counted as single-source): ${int(T.crossCheckIfAllSwept?.rows)} open rows change (net ${usd(T.crossCheckIfAllSwept?.valueDeltaUsd)}; ${int(T.crossCheckIfAllSwept?.landingRows)} on the landing view). The table below is the as-built case.`);
  L.push('');
  L.push(table(['Chain', 'Position', 'Pair', 'Value', 'Δ', 'Trust after'], s.top.crossCheck.map((r) => [r.chainId, r.positionId, r.pair, usd(r.valueUsd), usd(r.deltaUsd), r.trust])));

  renderCoverage(L, s);

  L.push('## Fix 4 — earned trust (`TOKEN_TRUST_MODE=earned`) and combined (`TOKEN_TRUST_MODE=combined`)');
  L.push('');
  const tr = T.trust ?? {};
  renderTrustComparison(L, s);
  L.push('### Earned (`TOKEN_TRUST_MODE=earned`)');
  L.push('');
  L.push(`Stored verdicts read: ${int(tr.verdicts)} (${int(tr.verdictsEarned)} earned; ${int(tr.verdictsStale)} older than ${(th.quoteMaxAgeMs / 3_600_000).toFixed(1)} h — used as of their sweep here, but flipping now would revoke them until the next sweep).` + (num(tr.verdicts) === 0 ? ' **No verdicts are stored: run one sweep with `TOKEN_TRUST_SHADOW=on`, then re-run this report. Until then every non-anchor token reads untrusted in earned mode, and the pool / exclusion numbers below cover only what the verdicts that exist decide.**' : ''));
  L.push(`Tokens: ${int(tr.tokensGain)} gain trust, ${int(tr.tokensLose)} lose it (${int(tr.tokensLosePredicted)} of those predicted from stored evidence without a verdict — \`dexActive: false\` or a non-consensus saved price; ${Object.entries(tr.loseReasons ?? {}).map(([k, v]) => `${k} ${int(v)}`).join(', ') || 'none'}); ${int(tr.tokensNoVerdictHeld)} held by open positions have no verdict yet (${int(tr.tokensNoVerdictAllowlistedHeld)} of them allowlisted).`);
  L.push(`Pools page (TVL ≥ ${usd(th.poolsMinTvlUsd)}, risky off): ${int(tr.poolsVisibleToday)} visible today → ${int(tr.poolsVisibleAfter)} after; ${int(tr.poolsAppear)} appear (${usd(tr.poolsAppearTvlUsd)}), ${int(tr.poolsDisappear)} disappear (${usd(tr.poolsDisappearTvlUsd)}; ${int(tr.poolsDisappearNeverSwept)} of them, ${usd(tr.poolsDisappearNeverSweptTvlUsd)}, because a leg no open position holds is never swept, so it can never earn trust), ${int(tr.poolsUndetermined)} undetermined (a held leg with no verdict yet — a shadow sweep decides it), of ${int(tr.poolsScanned)} pools.`);
  L.push(`Positions: ${int(tr.positionsNewlyExcluded)} open rows (${usd(tr.positionsNewlyExcludedValueUsd)}; ${int(tr.positionsNewlyExcludedLanding)} landing) fall into the no-real-market exclusion; ${int(tr.positionsExemptionLost)} more (${usd(tr.positionsExemptionLostValueUsd)}) keep showing but lose the allowlist exemption from the pool cross-check / backing floor (their new values are not estimated here); ${int(tr.positionsNewlyIncluded)} leave the exclusion.`);
  L.push('');
  L.push('Tokens losing trust (by open value):');
  L.push('');
  L.push(table(['Chain', 'Token', 'Why', 'Open rows', 'Open leg value', 'Landing'], s.top.trustLose.map((r) => [r.chainId, `${r.symbol ?? '?'} ${r.address.slice(0, 10)}…`, `${r.reason}${r.stale ? ' (stale)' : ''}`, int(r.openPositions), usd(r.exposureUsd), usd(r.landingExposureUsd)])));
  L.push('Tokens gaining trust:');
  L.push('');
  L.push(table(['Chain', 'Token', 'Open rows', 'Open leg value'], s.top.trustGain.map((r) => [r.chainId, `${r.symbol ?? '?'} ${r.address.slice(0, 10)}…`, int(r.openPositions), usd(r.exposureUsd)])));
  L.push('Pools appearing:');
  L.push('');
  L.push(table(['Chain', 'Pool', 'Pair', 'Fee', 'TVL after'], s.top.poolsAppear.map((r) => [r.chainId, `${r.poolId.slice(0, 12)}…`, r.pair, pctFee(r.fee), usd(r.tvlAfterUsd)])));
  L.push('Pools disappearing:');
  L.push('');
  L.push(table(['Chain', 'Pool', 'Pair', 'TVL today', 'Why'], s.top.poolsDisappear.map((r) => [r.chainId, `${r.poolId.slice(0, 12)}…`, r.pair, usd(r.tvlTodayUsd), r.reason ?? ''])));
  L.push('Positions newly excluded:');
  L.push('');
  L.push(table(['Chain', 'Position', 'Pair', 'Value', 'Landing'], s.top.newlyExcluded.map((r) => [r.chainId, r.positionId, r.pair, usd(r.valueUsd), r.landingToday ? 'yes' : ''])));
  renderCombined(L, s);
  renderDexProbe(L, s);

  L.push('## Run');
  L.push('');
  L.push(`Shards: ${s.shards.map((x) => `${x.chainId} ${x.protocol}`).join(', ')}. Read preference ${s.flags.readPreference}, ${s.flags.pageSize} rows a page, ${s.flags.paceMs} ms between pages, at most ${int(s.flags.docsPerSec)} documents/s (${int(s.reads?.docs)} documents read, ${((s.reads?.pacedMs ?? 0) / 1000).toFixed(1)} s spent waiting on the ceiling), maxTimeMS ${s.flags.maxTimeMs}. Indexes: ${s.chains.map((c) => `${c.chainId}: ${Object.entries(c.indexes).map(([k, v]) => `${k}=${v}`).join(' ')}`).join('; ')}.`);
  L.push(`CSV rows: positions ${int(s.csvRows.positions)}, pools ${int(s.csvRows.pools)}, tokens ${int(s.csvRows.tokens)}.`);
  L.push(`Thresholds: quote max age ${th.quoteMaxAgeMs} ms, DIA min volume ${th.diaMinVolumeUsd}, min pools ${th.earned.minPools}, min outside counter ${th.earned.minOutsideCounterUsd}, deep-pool counter ${th.earned.deepPoolCounterUsd}, per-pool counter ${th.earned.perPoolCounterUsd}, deny ${th.earned.deny.length}, backing floor ${th.minRealMarketBackingUsd}, pools floor ${th.poolsMinTvlUsd}, landing floor ${th.landingMinValueUsd}, landing pool-TVL floor ${th.landingMinPoolTvlUsd}, honeypot anchor exemption ${th.honeypotAnchorExempt ? 'on' : 'off'}.`);
  L.push('');
  return L.join('\n');
}

const pct = (part, whole) => (num(whole) > 0 ? `${((100 * num(part)) / num(whole)).toFixed(1)}%` : '–');
const tokenLabel = (r) => `${r.symbol ?? '?'} ${r.address.slice(0, 10)}…`;

/** Source coverage + stored verdicts, per chain (counted once per chain, on its first shard). */
function renderCoverage(L, s) {
  const th = s.thresholds;
  const chains = s.chains.filter((c) => num(c.coverage?.tokens) > 0);
  L.push('## Price-source coverage and stored trust verdicts');
  L.push('');
  L.push(`Independent sources behind each token's stored price (\`priceSources\`, pool-derived \`subgraph-*\` never counted; DexScreener + GeckoTerminal read the same on-chain pools, so DEX-only is one market — earned trust (a) needs a non-DEX aggregator among two agreeing sources). "All" = every token row of the chain (plus held tokens with no row yet); "held" = the non-anchor tokens an open position holds, the set whose verdict decides a valuation.`);
  L.push('');
  if (chains.length === 0) {
    L.push('_no tokens read_');
    L.push('');
    return;
  }
  for (const c of chains) {
    const cov = c.coverage;
    L.push(`**${c.chainId}** — ${int(cov.tokens)} tokens, ${int(cov.held)} held${cov.heldNoRow ? ` (${int(cov.heldNoRow)} held with no token row yet: 0 sources, no verdict)` : ''}.`);
    L.push('');
    const split = (b, a, h) => (b === '0' ? '–' : `${int(a)} · ${int(h)} held`);
    L.push(table(
      ['Independent sources', 'All', 'Held', 'DEX-only', 'Incl. a non-DEX aggregator'],
      SOURCE_BUCKETS.map((b) => {
        const x = cov.sources?.[b] ?? {};
        return [b, int(x.tokens), int(x.held), split(b, x.dexOnly, x.dexOnlyHeld), split(b, x.withAggregator, x.withAggregatorHeld)];
      }),
    ));
    L.push(table(
      ['Stored verdict', 'All', 'Held'],
      VERDICT_BUCKETS.filter((b) => b !== 'other' || num(cov.verdicts?.other?.tokens) > 0).map((b) => [verdictLabel(b, th), int(cov.verdicts?.[b]?.tokens), int(cov.verdicts?.[b]?.held)]),
    ));
    const unknownAll = num(cov.verdicts?.['no-verdict']?.tokens) + num(cov.verdicts?.['stale-verdict']?.tokens);
    const unknownHeld = num(cov.verdicts?.['no-verdict']?.held) + num(cov.verdicts?.['stale-verdict']?.held);
    L.push(`Unknown share (no stored verdict, or one older than ${(th.quoteMaxAgeMs / 3_600_000).toFixed(1)} h): ${int(unknownHeld)} of ${int(cov.held)} held tokens (${pct(unknownHeld, cov.held)}); ${int(unknownAll)} of ${int(cov.tokens)} tokens overall (${pct(unknownAll, cov.tokens)}).`);
    L.push('');
  }
  L.push('Verdicts stored by a build without the definite-only rule — a single-source / stale-quote failure is stored only when every provider answered for the token, and a token a capped DexScreener answer left out gets no verdict at all — may be artefacts of a rate-limited or capped provider rather than evidence about the token. Read the failure counts above with that in mind until one sweep on this build has re-derived them (`trust=…/… unknown=…` in the sweep log).');
  L.push('');
}

function verdictLabel(bucket, th) {
  switch (bucket) {
    case 'no-verdict':
      return 'no stored verdict';
    case 'stale-verdict':
      return `stale verdict (> ${(th.quoteMaxAgeMs / 3_600_000).toFixed(1)} h)`;
    case 'other':
      return 'other (unrecognised reason)';
    default:
      return bucket;
  }
}

/** Today vs earned vs combined, side by side (all chains). */
function renderTrustComparison(L, s) {
  const T = s.totals;
  const th = s.thresholds;
  const tr = T.trust ?? {};
  const tc = T.trustCombined ?? {};
  const undecided = (n) => (num(n) > 0 ? ` (+${int(n)} undecided)` : '');
  L.push(table(['', 'Today (`allowlist`)', '`earned`', '`combined`'], [
    ['Held non-anchor tokens trusted', int(tr.heldToday), `${int(tr.heldEarned)}${undecided(tr.heldEarnedUndecided)}`, `${int(tr.heldCombined)}${undecided(tr.heldCombinedUndecided)}`],
    ['Tokens gaining / losing trust (vs today)', '–', `${int(tr.tokensGain)} / ${int(tr.tokensLose)}`, `${int(tc.tokensGain)} / ${int(tc.tokensLose)}`],
    [`Pools on the Pools page (TVL ≥ ${usd(th.poolsMinTvlUsd)})`, int(tr.poolsVisibleToday), int(tr.poolsVisibleAfter), int(tc.poolsVisibleAfter)],
    ['Pools appearing', '–', `${int(tr.poolsAppear)} · ${usd(tr.poolsAppearTvlUsd)}`, `${int(tc.poolsAppear)} · ${usd(tc.poolsAppearTvlUsd)}`],
    ['Pools disappearing', '–', `${int(tr.poolsDisappear)} · ${usd(tr.poolsDisappearTvlUsd)}`, `${int(tc.poolsDisappear)} · ${usd(tc.poolsDisappearTvlUsd)}`],
    ['Pools undetermined (a held leg has no verdict yet)', '–', int(tr.poolsUndetermined), int(tc.poolsUndetermined)],
    ['Open rows entering the no-real-market exclusion (landing)', '–', `${int(tr.positionsNewlyExcluded)} · ${usd(tr.positionsNewlyExcludedValueUsd)} (${int(tr.positionsNewlyExcludedLanding)})`, `${int(tc.positionsNewlyExcluded)} · ${usd(tc.positionsNewlyExcludedValueUsd)} (${int(tc.positionsNewlyExcludedLanding)})`],
    ['Open rows leaving the exclusion', '–', int(tr.positionsNewlyIncluded), int(tc.positionsNewlyIncluded)],
    ['Open rows losing the allowlist exemption', '–', `${int(tr.positionsExemptionLost)} · ${usd(tr.positionsExemptionLostValueUsd)}`, `${int(tc.positionsExemptionLost)} · ${usd(tc.positionsExemptionLostValueUsd)}`],
    ['Landing view, fixes 2 + 3 + 4', `${int(T.open?.landingRows)} · ${usd(T.open?.landingValueUsd)}`, `${int(T.after?.landingRows)} · ${usd(T.after?.landingValueUsd)}`, `${int(T.afterCombined?.landingRows)} · ${usd(T.afterCombined?.landingValueUsd)}`],
  ]));
  L.push('Combined = anchor ‖ allowlisted ‖ a fresh earned verdict, with the pools sync\'s 10% pool-price check on every non-anchor leg (listed ones included) and the stored `trustDenied` flag honoured. It can only add trust to the allowlist, except for a token someone flagged by hand; what it can take away is pool TVL, through the pool-price check.');
  L.push('');
}

/** TOKEN_TRUST_MODE=combined: the same detail as earned's. */
function renderCombined(L, s) {
  const tc = s.totals.trustCombined ?? {};
  L.push('### Combined (`TOKEN_TRUST_MODE=combined`)');
  L.push('');
  L.push(`Tokens: ${int(tc.tokensGain)} gain trust, ${int(tc.tokensLose)} lose it (${int(tc.tokensLosePredicted)} predicted from stored evidence without a verdict; ${Object.entries(tc.loseReasons ?? {}).map(([k, v]) => `${k} ${int(v)}`).join(', ') || 'none'}); ${int(tc.tokensNoVerdictHeld)} held by open positions have no verdict yet. Pools page: ${int(tc.poolsAppear)} appear (${usd(tc.poolsAppearTvlUsd)}), ${int(tc.poolsDisappear)} disappear (${usd(tc.poolsDisappearTvlUsd)}; ${int(tc.poolsDisappearNeverSwept)} of them, ${usd(tc.poolsDisappearNeverSweptTvlUsd)}, through a never-swept leg the allowlist does not carry), ${int(tc.poolsUndetermined)} undetermined. Positions: ${int(tc.positionsNewlyExcluded)} open rows (${usd(tc.positionsNewlyExcludedValueUsd)}; ${int(tc.positionsNewlyExcludedLanding)} landing) enter the no-real-market exclusion, ${int(tc.positionsNewlyIncluded)} leave it.`);
  L.push('');
  L.push('Tokens losing trust under combined:');
  L.push('');
  L.push(table(['Chain', 'Token', 'Why', 'Open rows', 'Open leg value', 'Landing'], s.top.trustLoseCombined.map((r) => [r.chainId, tokenLabel(r), `${r.reason}${r.stale ? ' (stale)' : ''}`, int(r.openPositions), usd(r.exposureUsd), usd(r.landingExposureUsd)])));
  L.push('Tokens gaining trust under combined:');
  L.push('');
  L.push(table(['Chain', 'Token', 'Open rows', 'Open leg value'], s.top.trustGainCombined.map((r) => [r.chainId, tokenLabel(r), int(r.openPositions), usd(r.exposureUsd)])));
  L.push('Pools appearing under combined:');
  L.push('');
  L.push(table(['Chain', 'Pool', 'Pair', 'Fee', 'TVL after'], s.top.poolsAppearCombined.map((r) => [r.chainId, `${r.poolId.slice(0, 12)}…`, r.pair, pctFee(r.fee), usd(r.tvlAfterUsd)])));
  L.push('Pools disappearing under combined:');
  L.push('');
  L.push(table(['Chain', 'Pool', 'Pair', 'TVL today', 'Why'], s.top.poolsDisappearCombined.map((r) => [r.chainId, `${r.poolId.slice(0, 12)}…`, r.pair, usd(r.tvlTodayUsd), r.reason ?? ''])));
  L.push('Positions newly excluded under combined:');
  L.push('');
  L.push(table(['Chain', 'Position', 'Pair', 'Value', 'Landing'], s.top.newlyExcludedCombined.map((r) => [r.chainId, r.positionId, r.pair, usd(r.valueUsd), r.landingToday ? 'yes' : ''])));
}

/** `--probe-dexscreener`: covered counts per endpoint per chain. */
function renderDexProbe(L, s) {
  if (!s.dexProbe) return;
  const d = s.dexProbe;
  L.push('## DexScreener batch endpoints (`--probe-dexscreener`, live)');
  L.push('');
  L.push(`Asked DexScreener's public API about the same swept tokens (open positions' legs, highest open exposure first) through \`/latest/dex/tokens\` (\`DEXSCREENER_BATCH_ENDPOINT=latest\`, today) and \`/tokens/v1/{chain}\` (\`=per-chain\`), ${DEXSCREENER_BATCH} addresses a request, one request a second: ${int(d.requests)} requests, ${int(d.rateLimited)} rate-limited, ${int(d.errors)} failed (their tokens count as not answered). Covered = the answer holds a pair on the chain with the token as its BASE token and a USD price (the provider's own reading). A capped answer holds ${DEXSCREENER_PAIR_CAP} pairs: on /latest that cap is for the whole request, so one popular token can crowd every other one out. The both / only-one / neither split compares only tokens BOTH endpoints answered; a token one of them did not answer (rate-limited, failed) is counted apart, never as a coverage difference.`);
  L.push('');
  L.push(table(
    ['Chain', 'Tokens asked (swept)', '/latest covered', '/latest capped answers', '/tokens/v1 covered', '/tokens/v1 capped answers', 'Both / only latest / only per-chain / neither (answered by both)', 'Unanswered by one'],
    d.chains.map((c) => [
      `${c.chainId} (${c.dexChain})`,
      `${int(c.asked)} (${int(c.swept)})`,
      `${int(c.latest.covered)} of ${int(c.latest.answered)} answered`,
      `${int(c.latest.cappedAnswers)} of ${int(c.latest.requests)}`,
      `${int(c.perChain.covered)} of ${int(c.perChain.answered)} answered`,
      `${int(c.perChain.cappedAnswers)} of ${int(c.perChain.requests)}`,
      `${int(c.both)} / ${int(c.onlyLatest)} / ${int(c.onlyPerChain)} / ${int(c.neither)}`,
      int(c.unansweredByOne),
    ]),
  ));
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Create the output directory with a `.gitignore` of `*` inside it: the dump
 * is derived from production (positions.csv carries owner wallets) and the
 * default location is the working tree, where a later `git add -A` would
 * otherwise commit it. The ignore file ignores itself too.
 */
export function prepareOutDir(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.gitignore'), '# valuation-impact-report output (derived from production data, holds owner wallets): never commit\n*\n');
  return dir;
}

const USAGE = `Usage (from backend/): npx tsx scripts/valuation-impact-report.mjs [--env-file=<file>] [--chain=1,4663] [--protocol=uniswap-v4]
         [--out=<dir>] [--probe-dia [--probe-limit=200]] [--probe-dexscreener[=60]] [--include-closed] [--read-preference=secondary]
         [--page-size=1000] [--pace-ms=25] [--docs-per-sec=5000] [--max-time-ms=60000] [--top=25] [--csv-min-delta=1]
         [--quote-max-age-ms=…] [--dia-min-volume=…] [--trust-min-pools=…] [--trust-min-outside-liquidity=…] [--deny=0x…,0x…]
         [--pools-min-tvl=10000] [--landing-min-value=500] [--landing-min-pool-tvl=1000]
Reads MONGODB_URI from the environment (or --env-file); thresholds (and HONEYPOT_FEE_ANCHOR_EXEMPT) from the same env.
--probe-dia / --probe-dexscreener are the only network calls besides MongoDB (public APIs, no keys, paced).
Read-only; writes only the files under --out
(positions.csv carries owner wallets — the directory gets its own .gitignore so it is never committed).`;

async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message ?? err));
    console.error(USAGE);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  if (flags.envFile) {
    const file = flags.envFile.startsWith('~') ? path.join(os.homedir(), flags.envFile.slice(1)) : flags.envFile;
    process.loadEnvFile(file);
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set (export it, or pass --env-file=<file>).');
    process.exit(2);
  }
  let thresholds;
  try {
    thresholds = resolveThresholds(flags);
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const outDir = prepareOutDir(path.resolve(flags.out ?? `valuation-impact-${stamp}`));
  console.error(`output: ${outDir} (positions.csv holds owner wallets — keep it out of git; the directory carries its own .gitignore)`);

  const { default: mongoose } = await import('mongoose');
  const client = new mongoose.mongo.MongoClient(uri, {
    appName: 'valuation-impact-report',
    readPreference: flags.readPreference,
    readConcern: { level: 'local' },
    maxPoolSize: 4,
    serverSelectionTimeoutMS: 20_000,
    monitorCommands: true,
  });
  attachWriteTripwire(client, (commandName) => {
    console.error(`ABORT: the read-only report saw a "${commandName}" command — exiting without finishing.`);
    process.exit(70);
  });
  console.error(`mongo: ${redactUri(uri)} (read preference ${flags.readPreference})`);
  await client.connect();
  try {
    const db = readOnlyDb(client.db(flags.db));
    const started = Date.now();
    const summary = await runReport({ db, flags, thresholds, outDir, log: (m) => console.error(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`) });
    writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    const md = renderMarkdown(summary);
    writeFileSync(path.join(outDir, 'summary.md'), md);
    console.log(md);
    console.error(`\nwrote ${outDir}/{summary.md,summary.json,positions.csv,pools.csv,tokens.csv} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await client.close();
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}
