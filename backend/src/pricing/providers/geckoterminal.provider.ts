import { Inject, Injectable, Optional } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { getChainConfig, isWrappedNative } from '../../config/chains.config.js';
import { currentIndexerContext } from '../../subgraph/hyperindex/indexer-context.js';
import { BaseProvider } from './base-provider.js';
import type { HistoricalReq, PriceQuote } from './price-provider.interface.js';
import { providerAddressKey } from './price-provider.interface.js';

const BASE_URL = 'https://api.geckoterminal.com/api/v2';
const MAX_BATCH = 30;

/**
 * Maps a `chainId` from chains.config.ts to the GeckoTerminal network slug.
 * GeckoTerminal uses its own short codes (e.g. `eth`, `avax`, `base`) that
 * differ from DeFiLlama (`ethereum`) and CoinGecko (`ethereum`).
 */
export const GT_NETWORK_SLUG: Record<number, string> = {
  1: 'eth',
  43114: 'avax',
  // From GeckoTerminal's own networks list: id 'arbitrum', name 'Arbitrum',
  // coingecko_asset_platform_id 'arbitrum-one'. NOT 'arbitrum_nova' (chain 42170).
  42161: 'arbitrum',
  // GeckoTerminal network id 'robinhood' (coingecko_asset_platform_id agrees).
  // Probed 2026-09-02 on the provider's own endpoint: real prices + 24h volume for
  // WETH and USDG. A 429 body has no `data` key and can arrive as HTTP 200, which
  // reads as empty — distinguish it from 404 when re-probing coverage.
  4663: 'robinhood',
};

interface GtTokenPriceResponse {
  data?: {
    attributes?: {
      token_prices?: Record<string, string>;
      h24_volume_usd?: Record<string, string>;
    };
  };
  status?: { error_code?: number; error_message?: string };
}

// ─── fleet-wide call budget ──────────────────────────────────────────────────
/*
 * GeckoTerminal's free tier is 30 calls/min PER CALLER IP — i.e. per fleet, not
 * per process — and every process used to spend it independently until a 429
 * sent it into a 60 s backoff. With `GECKOTERMINAL_BUDGET` on, every call first
 * takes a token from ONE bucket (`tw:gt:v1:all`, 30/min) plus a per-lane cap so
 * no background job can starve the others: backfill ≤ 60 %, refresh ≤ 50 %,
 * sweeps ≤ 40 %, live (a refresh after a user's on-chain action) ≤ 30 % with a
 * 5 s wait; interactive takes only the shared bucket. `shared` keeps the
 * buckets in Redis (one Lua call each, `GECKOTERMINAL_GCRA`); `local` (and
 * `shared` while no bucket is bound or Redis is unreachable — counted in
 * `localFallbacks`) keeps them in this process at `gtLocalShareOf` of the rate:
 * the whole rate for the single `all` process (exact, today), a fraction per
 * process in a split fleet, because a local bucket cannot see the others.
 *
 * A call the budget refuses (its wait would pass the lane's `maxWaitMs`) is not
 * made: the batch returns empty and is recorded as a `skip`, which the price
 * walk treats as UNKNOWN — never as a miss for the ledger, never as "covered"
 * for the DEX-market verdict.
 */
export type GtLane = 'interactive' | 'live' | 'backfill' | 'refresh' | 'sweeps';
export type GtBudgetMode = 'off' | 'local' | 'shared';

export const GT_CALLS_PER_MIN = 30;
/** Max share of `GT_CALLS_PER_MIN` each background lane may use. */
export const GT_LANE_SHARES: Readonly<Record<Exclude<GtLane, 'interactive'>, number>> = {
  // A refresh triggered by a user's on-chain action (`live-refresh`, the live
  // listener): its own small share with a SHORT wait — it must neither sit
  // behind the sweeps' 60 s queue nor take the whole shared bucket.
  live: 0.3,
  backfill: 0.6,
  refresh: 0.5,
  sweeps: 0.4,
};
/** The longest a call waits for its token before it is skipped (a walk must not stall on prices). */
export const GT_LANE_MAX_WAIT_MS: Readonly<Record<GtLane, number>> = {
  interactive: 2_000,
  live: 5_000,
  backfill: 10_000,
  refresh: 10_000,
  sweeps: 60_000,
};
export const GT_ALL_KEY = 'tw:gt:v1:all';
export const gtLaneKey = (lane: Exclude<GtLane, 'interactive'>): string => `tw:gt:v1:lane:${lane}`;

/** The lane of the current caller, from the indexer context `QueueService` / `main.ts` set. */
export function currentGtLane(): GtLane {
  const ctx = currentIndexerContext();
  if (ctx.lane === 'interactive') return 'interactive';
  if (ctx.lane === 'live') return 'live';
  if (ctx.job === 'backfill') return 'backfill';
  if (ctx.job === 'refresh') return 'refresh';
  return 'sweeps';
}

/**
 * A GCRA bucket: take one token from `key` refilling at `perMinute` with a
 * `burst`. Resolves the wait (ms, ≥ 0) before the call may go out, or a
 * NEGATIVE number when that wait would pass `maxWaitMs` (nothing taken).
 * Throws when the backing store is unavailable.
 */
export interface GtBucketBackend {
  take(key: string, perMinute: number, burst: number, maxWaitMs: number): Promise<number>;
}

/** Injection token for the Redis-backed bucket (bound by the integrator to `common/redis-gcra.ts`). */
export const GECKOTERMINAL_GCRA = 'GECKOTERMINAL_GCRA';

/** `GECKOTERMINAL_BUDGET` from config (`geckoterminalBudget` getter); anything unknown or absent = `off` (today). */
export function gtBudgetModeOf(config: unknown): GtBudgetMode {
  const raw = (config as { geckoterminalBudget?: unknown } | undefined)?.geckoterminalBudget;
  return raw === 'local' || raw === 'shared' ? raw : 'off';
}

/**
 * Package E's provider-health rules (design §6.2-3) are on whenever one of E's
 * pricing flags is: `PRICE_MISS_LEDGER=on` or `GECKOTERMINAL_BUDGET=local|shared`.
 *  - GeckoTerminal's rate limit dressed as HTTP 200 (a body with no `data`) is a
 *    RATE LIMIT: 60 s backoff, no `miss` outcomes, the walk sees UNKNOWN;
 *  - an empty chunk during which the provider recorded a skip / rate limit /
 *    error is UNKNOWN in the consensus sweep, never "covered".
 * Each of those flags NEEDS them (the ledger must not record a rate-limited
 * body as a definite miss; a budget-refused call is a `skip` that must not
 * count as coverage). With both off (the default) the classification is
 * today's exactly — including today's known defect: a 429-as-200 records every
 * address as a miss and the sweep may bake `dexActive:false` from it. Turning
 * either flag on fixes it (CHANGELOG owed on that day).
 */
export function strictProviderHealthOf(config: unknown): boolean {
  if (gtBudgetModeOf(config) !== 'off') return true;
  const ledger = (config as { priceMissLedger?: unknown } | undefined)?.priceMissLedger;
  return ledger === 'on' || ledger === true;
}

/** The same GCRA as `read-budget.ts`'s Lua, in process (local mode, Redis-down fallback, specs). */
export class LocalGcra implements GtBucketBackend {
  private readonly state = new Map<string, { tokens: number; ts: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async take(key: string, perMinute: number, burst: number, maxWaitMs: number): Promise<number> {
    const rate = perMinute / 60_000; // tokens per ms
    const nowMs = this.now();
    const prev = this.state.get(key) ?? { tokens: burst, ts: nowMs };
    let tokens = Math.min(burst, prev.tokens + Math.max(0, nowMs - prev.ts) * rate);
    const wait = tokens >= 1 ? 0 : Math.ceil((1 - tokens) / rate);
    if (wait > maxWaitMs) {
      this.state.set(key, { tokens, ts: nowMs });
      return -wait;
    }
    tokens -= 1;
    this.state.set(key, { tokens, ts: nowMs });
    return wait;
  }
}

export interface GtBudgetStats {
  taken: number;
  denied: number;
  waitMs: number;
  /** Shared-mode calls that fell back to the local bucket (Redis unreachable). */
  localFallbacks: number;
}

/** Process-wide counters (the backfill profile reads deltas of `waitMs`). */
const budgetStats: GtBudgetStats = { taken: 0, denied: 0, waitMs: 0, localFallbacks: 0 };
export function geckoTerminalBudgetStats(): GtBudgetStats {
  return { ...budgetStats };
}

/**
 * The share of the fleet's GeckoTerminal rate ONE process may spend when it
 * keeps its buckets locally (`local` mode, or `shared` with Redis unbound /
 * unreachable). GeckoTerminal's 30/min is per caller IP — the whole fleet — so
 * N processes each spending the full rate locally make N × 30/min and walk
 * straight back into 429s and 60 s backoffs. Mirrors the indexer budget's
 * `INDEXER_BUDGET_LOCAL_SHARE` role defaults: `all` (one process, today) keeps
 * the whole rate; `sync` (the main price consumer) half; any other role a
 * quarter. `geckoterminalLocalShare` (a number in (0, 1]) overrides it.
 */
export function gtLocalShareOf(config: unknown): number {
  const c = config as { geckoterminalLocalShare?: unknown; processRole?: unknown } | undefined;
  const raw = c?.geckoterminalLocalShare;
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  }
  const role = c?.processRole;
  if (role === undefined || role === null || role === '' || role === 'all') return 1;
  if (role === 'sync') return 0.5;
  return 0.25;
}

/**
 * Takes the lane token, then the shared one. Resolves the total wait before
 * the call may be made, or `null` when either bucket refuses within the lane's
 * max wait (the call must be skipped). Whenever the LOCAL bucket answers
 * (`backend === fallback`, or the shared one threw) the rates are scaled by
 * `localShare` — a local bucket only ever sees this process's calls.
 */
export async function takeGtBudget(
  backend: GtBucketBackend,
  fallback: GtBucketBackend,
  lane: GtLane,
  localShare = 1,
): Promise<number | null> {
  const maxWait = GT_LANE_MAX_WAIT_MS[lane];
  const share = Number.isFinite(localShare) && localShare > 0 && localShare <= 1 ? localShare : 1;
  const local = (perMin: number, burst: number) => ({
    perMin: perMin * share,
    burst: Math.max(1, Math.floor(burst * share)),
  });
  const take = async (key: string, perMin: number, burst: number): Promise<number> => {
    if (backend === fallback) {
      const l = local(perMin, burst);
      return fallback.take(key, l.perMin, l.burst, maxWait);
    }
    try {
      return await backend.take(key, perMin, burst, maxWait);
    } catch {
      budgetStats.localFallbacks += 1;
      const l = local(perMin, burst);
      return fallback.take(key, l.perMin, l.burst, maxWait);
    }
  };
  let wait = 0;
  if (lane !== 'interactive') {
    const perMin = GT_CALLS_PER_MIN * GT_LANE_SHARES[lane];
    const laneWait = await take(gtLaneKey(lane), perMin, Math.max(1, Math.floor(perMin / 6)));
    if (laneWait < 0) return null;
    wait = laneWait;
  }
  // Burst 5 (= 10 s of the shared rate): a cold fleet does not fire 30 calls at once.
  const allWait = await take(GT_ALL_KEY, GT_CALLS_PER_MIN, 5);
  if (allWait < 0) return null;
  return Math.max(wait, allWait);
}

/**
 * GeckoTerminal price provider — free, no auth required.
 *
 * Strong fit for DEX-native tokens (the data is sourced directly from on-chain
 * DEX pools). Supports batched current prices with up to 30 addresses per call.
 *
 * Historical pricing is intentionally not implemented here: GeckoTerminal
 * exposes history via per-pool OHLCV (`/networks/{net}/pools/{pool}/ohlcv/{tf}`),
 * which requires a `poolHint` on the request. That path will be wired in once
 * the request shape carries pool context (PR 4, alongside the on-chain TWAP
 * provider that also needs poolHint).
 *
 * Free-tier rate limit: 30 calls/min. We use a 60s default backoff so a single
 * 429 effectively "cools off" until the bucket refills.
 */
@Injectable()
export class GeckoTerminalProvider extends BaseProvider {
  readonly name = 'geckoterminal';
  readonly supportsCurrentBatch = true;
  readonly supportsHistoricalBatch = false;
  readonly maxBatchSize = MAX_BATCH;
  readonly singleConcurrency = 2;
  readonly defaultBackoffMs = 60_000;
  private localBucket: GtBucketBackend = new LocalGcra();
  private unboundWarned = false;
  private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(
    // Both optional: specs construct it bare, and without config the budget
    // is `off` — today's behaviour.
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    @Optional() @Inject(GECKOTERMINAL_GCRA) private readonly sharedBucket?: GtBucketBackend,
  ) {
    super({ name: 'GeckoTerminalProvider', maxConcurrency: 2, defaultBackoffMs: 60_000 });
  }

  /** Specs: a deterministic local bucket and a sleep that does not wait. */
  setBudgetHooks(hooks: { local?: GtBucketBackend; sleep?: (ms: number) => Promise<void> }): void {
    if (hooks.local) this.localBucket = hooks.local;
    if (hooks.sleep) this.sleep = hooks.sleep;
  }

  isEnabled(): boolean {
    return true;
  }

  private mode(): GtBudgetMode {
    return gtBudgetModeOf(this.config);
  }

  /** True = go ahead (after any wait). False = the budget refused: skip the call. */
  private async acquireBudget(): Promise<boolean> {
    const mode = this.mode();
    if (mode === 'off') return true;
    if (mode === 'shared' && !this.sharedBucket) {
      // `shared` asked for, no Redis bucket bound: every process would keep
      // its own bucket. Say so once and count every such call as a fallback,
      // so `geckoTerminalBudgetStats()` cannot read as a healthy fleet bucket.
      budgetStats.localFallbacks += 1;
      if (!this.unboundWarned) {
        this.unboundWarned = true;
        this.logger.warn(
          `[alert] geckoterminal.budget_unbound GECKOTERMINAL_BUDGET=shared but no GECKOTERMINAL_GCRA is bound — ` +
            `using a per-process bucket at ${gtLocalShareOf(this.config)} of ${GT_CALLS_PER_MIN}/min`,
        );
      }
    }
    const backend = mode === 'shared' && this.sharedBucket ? this.sharedBucket : this.localBucket;
    let wait: number | null;
    try {
      wait = await takeGtBudget(backend, this.localBucket, currentGtLane(), gtLocalShareOf(this.config));
    } catch {
      return true; // the budget itself broke: today's behaviour (unpaced) rather than no prices
    }
    if (wait === null) {
      budgetStats.denied += 1;
      return false;
    }
    budgetStats.taken += 1;
    if (wait > 0) {
      budgetStats.waitMs += wait;
      await this.sleep(wait);
    }
    return true;
  }

  async getCurrentBatch(
    chainId: number,
    addresses: string[],
  ): Promise<Map<string, PriceQuote>> {
    const result = new Map<string, PriceQuote>();
    const network = GT_NETWORK_SLUG[chainId];
    const chain = getChainConfig(chainId);
    if (!network || !chain || addresses.length === 0) return result;
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return result;
    }
    if (!(await this.acquireBudget())) {
      // Refused by the fleet budget: UNKNOWN for every address (a `skip`),
      // never a miss. The provider stays available — the budget, not a 429,
      // is what said no.
      this.recordOutcome('skip');
      return result;
    }

    const lookup = new Map<string, string>(); // gt-query-address -> original lower address
    for (const addr of addresses) {
      const lower = addr.toLowerCase();
      const queryAddr = isWrappedNative(chainId, lower)
        ? chain.wrappedNativeToken.address.toLowerCase()
        : lower;
      lookup.set(queryAddr, lower);
    }

    const joined = [...lookup.keys()].join(',');
    // include_24hr_vol → `h24_volume_usd` map: the activity signal the
    // active-market gate needs (GT covers pools DexScreener may miss).
    const url = `${BASE_URL}/simple/networks/${network}/token_price/${joined}?include_24hr_vol=true`;

    await this.acquireSlot();
    try {
      const res = await this.httpJson<GtTokenPriceResponse>(url, {
        bodyTimeoutMs: 8000,
        headersTimeoutMs: 8000,
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.markRateLimited(res.retryAfterMs, res.statusCode);
        return result;
      }
      if (res.statusCode !== 200 || !res.data) {
        this.logger.warn(`batch returned ${res.statusCode} for ${addresses.length} tokens`);
        this.recordOutcome('error');
        return result;
      }
      // GeckoTerminal answers a rate limit as HTTP 200 with NO `data` key (a
      // `status.error_code: 429` body). Read as "no prices", that recorded every
      // address as a miss, left the provider available — so the consensus sweep
      // counted the batch as COVERED and baked `dexActive: false` onto real
      // tokens — and kept calling into the limit. It is a rate limit: back off
      // as for an HTTP 429, and let the walk see it as UNKNOWN. Only with E's
      // pricing flags on (`strictProviderHealthOf`); off = today's reading.
      if (strictProviderHealthOf(this.config) && !isGtSuccessBody(res.data)) {
        this.markRateLimited(undefined, res.data.status?.error_code ?? 200);
        return result;
      }
      const prices = res.data.data?.attributes?.token_prices ?? {};
      const volumes = res.data.data?.attributes?.h24_volume_usd ?? {};
      for (const [queryAddr, original] of lookup) {
        const raw = prices[queryAddr];
        const price = raw ? Number(raw) : 0;
        if (Number.isFinite(price) && price > 0) {
          const vol = Number(volumes[queryAddr]);
          result.set(providerAddressKey(chainId, original), {
            priceUsd: price,
            volume24hUsd: Number.isFinite(vol) ? vol : undefined,
          });
          this.recordOutcome('success');
        } else {
          this.recordOutcome('miss');
        }
      }
      return result;
    } catch (error) {
      this.logger.error(`batch prefetch failed for ${addresses.length} tokens: ${error}`);
      this.recordOutcome('error');
      return result;
    } finally {
      this.releaseSlot();
    }
  }

  async getCurrentSingle(chainId: number, address: string): Promise<PriceQuote | null> {
    const batch = await this.getCurrentBatch(chainId, [address]);
    return batch.get(providerAddressKey(chainId, address)) ?? null;
  }

  /**
   * Historical path deferred. GeckoTerminal's history requires `poolHint`
   * which isn't carried by `HistoricalReq` yet — PR 4 (Uniswap TWAP) plumbs
   * that field and we'll re-enable here at the same time.
   */
  async getHistoricalSingle(_req: HistoricalReq): Promise<PriceQuote | null> {
    this.recordOutcome('skip');
    return null;
  }
}

/** A real answer carries the `data` object; a 429-as-200 (or any error body) does not. */
export function isGtSuccessBody(body: GtTokenPriceResponse | undefined): boolean {
  return !!body && typeof body === 'object' && body.data !== undefined && body.data !== null && typeof body.data === 'object';
}
