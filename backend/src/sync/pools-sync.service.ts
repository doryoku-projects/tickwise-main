import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { GraphQLClient, gql } from 'graphql-request';
import { subgraphFetch } from '../subgraph/hyperindex/client.js';
import { AppConfigService } from '../config/app-config.service.js';
import type { PoolUpsert } from '../database/pools.repository.js';
import { PoolsRepository } from '../database/pools.repository.js';
import { SyncRepository } from '../database/sync.repository.js';
import { FlowLocks, sweepFlowLockName } from '../common/flow-lock.js';
import { PricingService } from '../pricing/pricing.service.js';
import { TokenTrustService } from '../pricing/token-trust.service.js';
import { poolPriceAgrees, usesStoredVerdicts } from '../pricing/token-trust.js';
import { sqrtRatioX96ToToken1PerToken0 } from '../pricing/tick-math.js';
import { isAnchorPair, isHoneypotStaticFee } from '../common/pool-fee.js';
import { normalizeHooks } from '../common/pool-hooks.js';
// The shared retry policy (sweep lane: today's exponential schedule, or a wait on
// the gateway's paused bucket when it enforces). A page that still fails is
// rethrown below exactly as before, so the job fails and BullMQ retries it.
import { requestWithRetry } from '../subgraph/request-retry.js';
import { MAX_FIRST } from '../subgraph/hyperindex/schema-map.js';

/*
 * KEYSET-paged by `id`, not offset-paged by volume. `skip` costs grow with the
 * offset (measured on the live deployment: skip 100k = 1.3–3 s a page), which
 * made a chain-1 walk (~89k pools) run past 90 min; an `id_gt` page is
 * ~170 ms at any depth. Pool ids are immutable and unique, so the walk neither
 * skips nor repeats a row however the set moves underneath it. One page is
 * slow: the LAST one (8.7 s on chain 1), because the indexer has no
 * `(chainId, id)` index and the scan runs past this chain's ids into the
 * others' — paid once per walk. Order is irrelevant to the upserts.
 */
const POOLS_QUERY = gql`
  query PoolsPage($first: Int!, $where: Pool_filter) {
    pools(
      orderBy: id
      orderDirection: asc
      first: $first
      where: $where
    ) {
      id
      token0 {
        id
        symbol
        decimals
      }
      token1 {
        id
        symbol
        decimals
      }
      feeTier
      hooks
      tickSpacing
      tick
      sqrtPrice
      liquidity
      createdAtTimestamp
      totalValueLockedToken0
      totalValueLockedToken1
      totalValueLockedUSD
      volumeUSD
      feesUSD
      txCount
      token0Price
      token1Price
    }
  }
`;

/*
 * DAY DATA IS FETCHED SEPARATELY, AND MUST STAY THAT WAY.
 *
 * It used to hang off `POOLS_QUERY` as
 * `poolDayData(orderBy: date, orderDirection: desc, first: 7)`. Nested inside
 * each pool that becomes ONE ORDERED SUBQUERY PER POOL on the indexer, and it
 * times the gateway out: measured against the live deployment, `Pool` with only
 * scalar fields answers in 0.88s while the same query carrying this nested block
 * returns HTTP 504 after 15.6s. It is not row count — 25 pools fail exactly like
 * 100 — and it is not a missing index, since `schema.graphql` already declares
 * `@index(fields: ["pool", ["date","DESC"]])`. It is the per-parent lateral,
 * which tips over once the indexer is CPU-saturated mid-backfill.
 *
 * Top-level with `pool_in` costs 1.18s for the same 100 pools. `charts.service`
 * has always fetched it this way; pool sync was the outlier.
 */
const POOL_DAY_MAX_QUERY = gql`
  query PoolDayMax {
    poolDayDatas(orderBy: date, orderDirection: desc, first: 1) {
      date
    }
  }
`;

const POOL_DAY_BATCH_QUERY = gql`
  query PoolDayBatch($ids: [String!]!, $fromDate: Int!, $first: Int!) {
    poolDayDatas(
      where: { pool_in: $ids, date_gte: $fromDate }
      orderBy: date
      orderDirection: desc
      first: $first
    ) {
      # Selected with a selection set, not bare: in the subgraph dialect this is
      # a REFERENCE field and the converter rejects a bare one outright
      # (hyperindex: poolDayDatas.pool: a reference field needs a selection set).
      # It costs nothing — the id is the FK column already on the row, not a join.
      pool {
        id
      }
      date
      volumeUSD
      feesUSD
      tvlUSD
    }
  }
`;

/** Days of history the two consumers need: `[0]` is 24h, the sum is 7d. */
const DAY_WINDOW = 7;
const DAY_SECONDS = 86_400;

interface PoolDayDataRow {
  date: string;
  volumeUSD: string;
  feesUSD: string;
  tvlUSD: string;
}

interface SubgraphToken {
  id: string;
  symbol: string;
  decimals: string;
}

interface SubgraphPool {
  id: string;
  token0: SubgraphToken;
  token1: SubgraphToken;
  feeTier: string;
  /** The hook contract (mixed-case EIP-55; the zero address = none). Absent on a stubbed indexer. */
  hooks?: string | null;
  tickSpacing: string;
  tick: string | null;
  sqrtPrice: string;
  liquidity: string;
  createdAtTimestamp: string;
  totalValueLockedToken0: string;
  totalValueLockedToken1: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
  feesUSD: string;
  txCount: string;
  token0Price: string;
  token1Price: string;
  poolDayData: PoolDayDataRow[];
}

/**
 * Pools per page (and per day-data request). 1,000 since 2026-10-03 (scale
 * plan 1.6; it was 100): a 953k-pool walk of 4663 was ~9.5k pool pages + ~9.5k
 * day-data batches ≈ 19k indexer requests (35–60% of the background cap); at
 * 1,000 it is ~1.9k. The day-data fetch stays truncation-safe at this size
 * (`fetchDayDataFor`).
 */
export const POOL_SYNC_PAGE_SIZE = 1000;
/**
 * Rows one day-data request asks for — the indexer's page cap (`MAX_FIRST`; it
 * errors above). A page of 1,000 pools × 8 days could hold up to 8,000 rows, so
 * a request that comes back FULL may have dropped rows and is split in halves
 * (`fetchDayDataFor`); most pages, mostly stubs with no recent day rows, return
 * a few hundred and cost one request.
 */
export const DAY_DATA_MAX_ROWS = MAX_FIRST;
// Re-valued TVL can blow up when pool-ratio pricing assigns a nonsense USD
// price to a thin/scam token (e.g. USDT/ASTEROID → $1.25T). No single v4 pool
// realistically exceeds ~$50B, so anything above is corrupt re-valuation:
// zero the TVL and flag fallback so the default (non-risky) leaderboard hides
// it — mirrors the position-side valuation guard.
const TVL_CEILING_USD = 5e10;
// v4 subgraph `feesUSD` is known-unreliable (astronomical), so feeApr derived
// from it can read as 700,000%+. Cap the stored value to a sane band.
const FEE_APR_CAP = 100_000;
// A reserve leg counts toward TVL only at trusted confidence — anchor or a
// real aggregator-verified market. Pool-derived/unverified/missing quotes
// contribute $0 (same trust model as the position-side valuation).
const TRUSTED_TVL_CONFIDENCES: ReadonlySet<string> = new Set(['anchor', 'external-verified']);
// If untrusted legs would have contributed more than this share of the trusted
// TVL, the pool's headline number is fabricated → flag risky.
const UNTRUSTED_TVL_MAX_SHARE = 0.2;
// Static lpFee at or above 5% (50,000 pips) is a honeypot — the LP keeps the
// bulk of every swap, so the pool is non-arbitrageable and its price/TVL
// meaningless. The observed garbage sits deliberately just under round gates:
// fake-DOT/USDT at 60,001 (6.0001%) and USDR/USDT at 99,993 (9.9993% — SEVEN
// pips under the previous 10% threshold). The v4 dynamic-fee sentinel
// (0x800000) is exempt. ONE definition (`isHoneypotStaticFee`), shared with
// the positions filter (common/pool-fee.ts).

export interface PoolTvlVerdict {
  /** Trusted-leg TVL (USD); 0 when the pool is flagged. */
  tvlUsd: number;
  /** Clamped human reserves actually used. */
  tvlToken0: number;
  tvlToken1: number;
  /** True → hide from the default (non-risky) leaderboard. */
  risky: boolean;
  /** True → a pre-clamp reserve was negative: the pool's reserve accounting is
   * broken and NEITHER leg can be trusted (callers must not persist these
   * reserves — the last-good fallback would feed them to the realizability
   * gate as backing). */
  reserveCorrupt: boolean;
}

/**
 * Trust-tiered pool TVL: clamp negative subgraph reserves, count a leg's value
 * only at trusted confidence (anchor / aggregator-verified), and flag the pool
 * risky when an untrusted leg would have contributed materially (fabricated
 * headline, e.g. allowlisted AMKT priced $10.4M by a seeded derivedETH), the
 * static fee tier is a honeypot (≥5% = 50,000 pips; dynamic-fee sentinel exempt), OR either
 * reserve is NEGATIVE pre-clamp. A negative reserve is physically impossible —
 * it deterministically proves the subgraph's reserve accounting is broken for
 * this pool (DiYP v4 flash-accounting drift is SYMMETRIC: one leg goes hugely
 * negative, the other equally inflated positive, e.g. −1.49B USDC / +1.47B
 * USDT on a pool whose own USD TVL reads −$17.8M while ALL of v4 mainnet holds
 * ~$469M). Clamping the negative leg and trusting the positive one laundered
 * that corruption into a "$1.47B" trusted headline — the positive leg is
 * exactly as untrustworthy as the negative one, so the whole pool is risky.
 * Impossibility check, not a magnitude cap.
 */
export function evaluatePoolTvl(input: {
  reserve0: number;
  reserve1: number;
  price0: number;
  price1: number;
  confidence0?: string;
  confidence1?: string;
  feeTier: number;
  /**
   * `HONEYPOT_FEE_ANCHOR_EXEMPT=on` and both legs are config anchors
   * (`isAnchorPair`, common/pool-fee.ts): the fee alone never flags the pool
   * (42161 ETH/USDC at 6.094%, 1 ETH/USDT at 21.079% are real pools).
   * Fabrication and corrupt reserves still do. Absent / false = today.
   */
  honeypotExempt?: boolean;
}): PoolTvlVerdict {
  const reserveCorrupt = finiteNum(input.reserve0) < 0 || finiteNum(input.reserve1) < 0;
  const tvlToken0 = Math.max(0, finiteNum(input.reserve0));
  const tvlToken1 = Math.max(0, finiteNum(input.reserve1));
  const trusted0 = TRUSTED_TVL_CONFIDENCES.has(input.confidence0 ?? '');
  const trusted1 = TRUSTED_TVL_CONFIDENCES.has(input.confidence1 ?? '');
  const legUsd0 = tvlToken0 * finiteNum(input.price0);
  const legUsd1 = tvlToken1 * finiteNum(input.price1);
  const trustedTvl = (trusted0 ? legUsd0 : 0) + (trusted1 ? legUsd1 : 0);
  const untrustedUsd = (trusted0 ? 0 : Math.max(0, legUsd0)) + (trusted1 ? 0 : Math.max(0, legUsd1));
  const materiallyFabricated = untrustedUsd > Math.max(1, trustedTvl) * UNTRUSTED_TVL_MAX_SHARE;
  // ≥, not >: real spam sits at exactly 100,000 pips (DHN/USDT's flat 10.00%
  // fee is just as non-arbitrageable as 10.01%).
  const honeypotFee = input.honeypotExempt !== true && isHoneypotStaticFee(input.feeTier);
  const risky = materiallyFabricated || honeypotFee || reserveCorrupt;
  return { tvlUsd: risky ? 0 : trustedTvl, tvlToken0, tvlToken1, risky, reserveCorrupt };
}

function finiteNum(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Fees cannot exceed the swap volume they are charged against. This rejects
 * indexer totals inflated by treating the dynamic-fee sentinel as a literal
 * fee, while preserving valid per-swap dynamic-fee totals.
 */
const MAX_FEE_TO_VOLUME = 1;

export function plausibleFeesUsd(feesUsd: number, volumeUsd: number): number | undefined {
  const fees = finiteNum(feesUsd);
  const volume = Math.max(0, finiteNum(volumeUsd));
  return fees <= volume * MAX_FEE_TO_VOLUME * (1 + 1e-9) ? fees : undefined;
}

/** token1 per token0 (human units) from the pool's sqrtPrice; 0 when unusable. */
function poolRatio(row: { sqrtPrice?: string | null }, dec0: number, dec1: number): number {
  try {
    return row.sqrtPrice ? sqrtRatioX96ToToken1PerToken0(BigInt(row.sqrtPrice), dec0, dec1) : 0;
  } catch {
    return 0;
  }
}

/**
 * The pool's hook as the upsert carries it: `{ hooks }` (lower-cased) for a
 * hooked pool, and NOTHING for one without (the zero address, or an indexer
 * that does not report it). The key is left out rather than set to
 * `undefined` so a pool without a hook keeps the content hash it had before
 * the field existed (`stableKey` drops `undefined`, but the Mongo `$set` must
 * not see the key either) — only a hooked pool is rewritten, once, and the
 * unhooked majority is not.
 */
function hooksField(row: { hooks?: string | null }): { hooks?: string } {
  const hooks = normalizeHooks(row.hooks);
  return hooks ? { hooks } : {};
}

/**
 * Pool doc for a pool we refuse to price (non-allowlisted leg): zero trusted
 * TVL, risky-flagged (`usedFallback: true` → hidden from the default pools
 * leaderboard), but carrying the REAL clamped reserves and volume/fees so
 * pool-detail lookups and the position adapter's last-good reserve fallback
 * (the realizability gate's backing input) always have a row to serve.
 */
export function buildRiskyPoolUpsert(chainId: number, protocol: string, row: SubgraphPool): PoolUpsert {
  const dayData = row.poolDayData ?? [];
  const day1 = dayData[0];
  const reserve0 = num(row.totalValueLockedToken0);
  const reserve1 = num(row.totalValueLockedToken1);
  // Same corrupt-reserve rule as evaluatePoolTvl: a negative leg proves the
  // pool's reserve accounting is broken → persist NO reserves (unknown) rather
  // than a clamped pair that would fabricate realizability backing.
  const reserveCorrupt = reserve0 < 0 || reserve1 < 0;
  return {
    chainId,
    protocol,
    poolId: row.id.toLowerCase(),
    token0: { address: row.token0.id.toLowerCase(), symbol: row.token0.symbol, decimals: num(row.token0.decimals) },
    token1: { address: row.token1.id.toLowerCase(), symbol: row.token1.symbol, decimals: num(row.token1.decimals) },
    fee: num(row.feeTier),
    ...hooksField(row),
    tickSpacing: num(row.tickSpacing),
    currentTick: row.tick !== null ? num(row.tick) : 0,
    sqrtPriceX96: row.sqrtPrice,
    liquidity: row.liquidity,
    createdAtTimestamp: num(row.createdAtTimestamp),
    metrics: {
      tvlUsd: 0,
      volumeTvl24h: 0,
      tvlToken0: reserveCorrupt ? undefined : Math.max(0, reserve0),
      tvlToken1: reserveCorrupt ? undefined : Math.max(0, reserve1),
      volumeUsd24h: day1 ? num(day1.volumeUSD) : 0,
      volumeUsd7d: dayData.reduce((s, d) => s + num(d.volumeUSD), 0),
      // Same impossibility rule as the main walk (plausibleFeesUsd).
      feesUsd24h: day1 ? plausibleFeesUsd(num(day1.feesUSD), num(day1.volumeUSD)) ?? 0 : 0,
      feesUsd7d: dayData.reduce((s, d) => s + (plausibleFeesUsd(num(d.feesUSD), num(d.volumeUSD)) ?? 0), 0),
      volumeUsdTotal: num(row.volumeUSD),
      feesUsdTotal: plausibleFeesUsd(num(row.feesUSD), num(row.volumeUSD)),
      feeApr: 0,
      txCount: num(row.txCount),
      currentPrice: num(row.token0Price),
    },
    pricing: { source: 'none', usedFallback: true },
  };
}

/** P2.1: the walk's flow lock was held by another process (nothing ran). */
const HELD_ELSEWHERE = Symbol('held-elsewhere');

@Injectable()
export class PoolsSyncService {
  private readonly logger = new Logger(PoolsSyncService.name);
  // Coalesce concurrent syncs for the same (chainId, protocol). The admin
  // trigger, the boot kick, and the hourly cron all enqueue distinct jobs; the
  // worker could otherwise run two full subgraph walks for one chain at once.
  // Idempotent upserts make that harmless for data, but it doubles subgraph +
  // pricing load — so dedup in-process. Coalesced callers return at once
  // rather than awaiting the shared promise (see `syncPools`).
  private readonly inFlight = new Map<string, Promise<{ upserted: number; skipped: number }>>();
  // When the last COMPLETE walk per chain finished, for the scheduled-run skip.
  // In-process only: a restart forgets it, and the boot kick syncs anyway.
  private readonly lastFinishedAt = new Map<string, number>();
  // Where a FAILED walk stopped, so the BullMQ retry (same process) resumes
  // there instead of re-walking the chain from its first pool.
  private readonly resumeAfter = new Map<string, string>();
  // The current walk's running totals (pools seen, trusted TVL summed, pricing
  // failures), carried across a resumed retry like `resumeAfter` and recorded
  // in sync_cursors when the walk COMPLETES — `/v1/stats` reads them instead of
  // counting and summing the pools collection (0 extra reads here: the walk
  // already holds every pool's TVL).
  private readonly walkTotals = new Map<string, { pools: number; tvlUsd: number; skipped: number }>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PoolsRepository) private readonly poolsRepo: PoolsRepository,
    @Inject(PricingService) private readonly pricing: PricingService,
    // APPENDED and optional: specs construct this service positionally. Absent,
    // complete walks are not recorded (`/v1/stats` then uses its fallback).
    @Optional() @Inject(SyncRepository) private readonly syncRepo?: SyncRepository,
    // P2.1, APPENDED and optional: the fleet flow lock `flow:pool-sync:<chain>:<protocol>`
    // (a pass-through while leases are off; absent = the in-process guard only, today).
    @Optional() @Inject(FlowLocks) private readonly flowLocks?: FlowLocks,
    // APPENDED and optional: the ONE token-trust answer, shared with the
    // position path (`TOKEN_TRUST_MODE`). Absent = a private instance over the
    // same config, i.e. today's anchor-or-allowlisted rule in allowlist mode.
    @Optional() @Inject(TokenTrustService) private readonly trustService?: TokenTrustService,
  ) {}

  private trustFallback?: TokenTrustService;
  private tokenTrust(): TokenTrustService {
    return this.trustService ?? (this.trustFallback ??= new TokenTrustService(this.config));
  }

  async syncAllPools(): Promise<{ upserted: number; skipped: number }> {
    let upserted = 0;
    let skipped = 0;
    for (const integration of this.config.enabledIntegrations) {
      const result = await this.syncPools(integration.chainId, integration.protocol);
      upserted += result.upserted;
      skipped += result.skipped;
    }
    return { upserted, skipped };
  }

  /**
   * `scheduled` = the repeatable cron fired this (not an admin trigger or the
   * boot kick). A scheduled run is skipped when this chain's last complete walk
   * finished less than half an interval ago — the boot kick and the first cron
   * slot otherwise ran back to back (seen locally: 42161 walked twice in a row
   * within 15 min of boot).
   */
  async syncPools(
    chainId: number,
    protocol: string,
    options: { scheduled?: boolean; now?: number } = {},
  ): Promise<{ upserted: number; skipped: number }> {
    const key = `${chainId}:${protocol}`;
    // A walk is already running → return IMMEDIATELY, do NOT await the shared
    // promise. This runs inside a BullMQ handler, so a waiter holds a worker
    // slot for the whole walk — and a 4663 walk outlasts the hourly tick, so
    // every tick pinned one more slot. Same fix as TokenPriceSyncService
    // (2026-06-12) and TokenSecuritySyncService.
    if (this.inFlight.has(key)) {
      this.logger.debug(`Pool sync already in flight for ${key}; skipping tick`);
      return { upserted: 0, skipped: 0 };
    }
    const last = this.lastFinishedAt.get(key);
    const now = options.now ?? Date.now();
    if (options.scheduled && last !== undefined && now - last < this.config.poolsSyncIntervalMs / 2) {
      this.logger.log(
        `Pool sync for ${key} skipped: last walk finished ${Math.round((now - last) / 60_000)} min ago`,
      );
      return { upserted: 0, skipped: 0 };
    }
    // The in-process claim comes FIRST (above), then the fleet lock: held
    // elsewhere = another process is walking this chain → skip, as today's
    // coalesced tick does; the next repeatable tick runs.
    const run = this.runSyncLocked(chainId, protocol)
      .then((result) => {
        if (result === HELD_ELSEWHERE) return { upserted: 0, skipped: 0 };
        this.lastFinishedAt.set(key, Date.now());
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  private async runSyncLocked(
    chainId: number,
    protocol: string,
  ): Promise<{ upserted: number; skipped: number } | typeof HELD_ELSEWHERE> {
    if (!this.flowLocks) return this.runSync(chainId, protocol);
    const out = await this.flowLocks.run(sweepFlowLockName('pool-sync', chainId, protocol), () => this.runSync(chainId, protocol));
    if (out.held) {
      this.logger.log(`Pool sync for ${chainId}:${protocol} held elsewhere — another process is walking it; skipped`);
      return HELD_ELSEWHERE;
    }
    return out.value;
  }

  private async runSync(chainId: number, protocol: string): Promise<{ upserted: number; skipped: number }> {
    const integration = this.config.getIntegration(chainId, protocol);
    if (!integration?.subgraphUrl) {
      this.logger.warn(`No subgraphUrl for ${chainId}:${protocol}, skipping pool sync`);
      return { upserted: 0, skipped: 0 };
    }

    const key = `${chainId}:${protocol}`;
    // The server's last id, never one this loop kept: a page whose rows all
    // fail pricing still advances the walk.
    let cursor: string | null = this.resumeAfter.get(key) ?? null;
    // A walk from the top starts its totals over; a resumed one keeps them.
    let totals = cursor !== null ? this.walkTotals.get(key) : undefined;
    if (!totals) {
      totals = { pools: 0, tvlUsd: 0, skipped: 0 };
      this.walkTotals.set(key, totals);
    }
    this.logger.log(
      `Starting pool sync for ${key}${cursor !== null ? ` (resuming after ${cursor})` : ''}`,
    );
    if (cursor === null) {
      // A walk from the top re-checks the repository's memory of stored hashes
      // against the shard (a hand-dropped collection must not stay skipped).
      try {
        await this.poolsRepo.revalidateWriteMemo?.(chainId, protocol);
      } catch (err) {
        this.logger.warn(`Pool write-memory check failed for ${key} (memory kept): ${(err as Error)?.message ?? String(err)}`);
      }
    }
    const client = new GraphQLClient(integration.subgraphUrl, subgraphFetch(integration));
    let fetched = 0;
    let upserted = 0;
    let unchanged = 0;
    let hashReads = 0;
    let skipped = 0;
    let hasMore = true;

    // Resolved ONCE per run, not per page: it is one row and it does not move
    // while the run is in flight. `null` means the indexer has no day data yet
    // (a fresh chain), in which case every pool simply gets an empty window.
    let dayFloor: number | null = null;
    try {
      const latest = await fetchLatestDayDate(client);
      if (latest !== null) dayFloor = latest - DAY_WINDOW * DAY_SECONDS;
    } catch (err) {
      // Non-fatal: pools still sync, they just carry no volume/fee window this
      // run. Louder than a silent zero, cheaper than failing the whole job.
      this.logger.warn(
        `Day-data floor lookup failed for ${chainId}:${protocol} — pools will sync without a volume window: ${(err as Error)?.message}`,
      );
    }

    try {
      while (hasMore) {
        let rows: SubgraphPool[] = [];
        try {
          const result = await requestWithRetry<{ pools: SubgraphPool[] }>(client, POOLS_QUERY, {
            first: POOL_SYNC_PAGE_SIZE,
            where: cursor !== null ? { id_gt: cursor } : {},
          });
          rows = result.pools ?? [];
        } catch (err) {
          // Re-throw so the BullMQ worker marks the job FAILED → the queue-level
          // `attempts` + exponential backoff engage and the `failed` alert fires.
          // Swallowing it (break + normal return) made a full outage or a
          // mid-pagination truncation look identical to a healthy empty sync, so
          // the only recovery was the next hourly cron tick. Pages already
          // upserted persist (upserts are idempotent, no stale-prune), and the
          // retry resumes after the last page that was written.
          this.logger.error(
            `Pool fetch failed after id=${cursor ?? '(start)'} for ${key} (fetched=${fetched}, upserted=${upserted}, skipped=${skipped}): ${(err as Error)?.message}`,
          );
          throw err instanceof Error
            ? err
            : new Error(`Pool fetch failed after id=${cursor ?? '(start)'} for ${key}`);
        }
        hasMore = rows.length === POOL_SYNC_PAGE_SIZE;
        fetched += rows.length;

        // Day data for exactly this page, in ONE query. Failure degrades the
        // window to empty rather than failing the page — the pool scalars, which
        // are what the risky/TVL gates actually need, are already in hand.
        if (dayFloor !== null && rows.length > 0) {
          try {
            const byPool = await fetchDayDataFor(
              client,
              rows.map((r) => r.id),
              dayFloor,
            );
            for (const row of rows) row.poolDayData = byPool.get(row.id) ?? [];
          } catch (err) {
            this.logger.warn(
              `Day-data fetch failed after id=${cursor ?? '(start)'} for ${key} — ${rows.length} pools sync without a volume window: ${(err as Error)?.message}`,
            );
            for (const row of rows) row.poolDayData = [];
          }
        } else {
          for (const row of rows) row.poolDayData = [];
        }

        const toUpsert: PoolUpsert[] = [];
        // Earned / combined trust reads the page's stored verdicts (one
        // indexed read; skipped in allowlist mode, which needs no I/O).
        const trust = this.tokenTrust();
        const storedVerdicts = usesStoredVerdicts(trust.policy());
        if (storedVerdicts) {
          await trust.warm(chainId, rows.flatMap((r) => [r.token0.id.toLowerCase(), r.token1.id.toLowerCase()]));
        }
        for (const row of rows) {
          const t0Addr = row.token0.id.toLowerCase();
          const t1Addr = row.token1.id.toLowerCase();

          // A leg is trust-priceable when it's a config ANCHOR (stable / native /
          // wrapped-native / trusted) OR CoinGecko-allowlisted. The anchor check
          // is load-bearing: native ETH is the ZERO pseudo-address in v4 and is
          // NOT in the CoinGecko contract-address snapshot (native coins have no
          // contract), so an allowlist-only gate shunted EVERY ETH/* pool —
          // 34,673 docs incl. ETH/USDC ($24M), ETH/USDT ($35M real reserves),
          // ETH/LINK — into risky stubs (tvl 0) and the leaderboard showed no
          // native-ETH pool at all. pricePool itself prices the zero address via
          // the native anchor (classifyAnchor → nativeUsd).
          // The ONE trust rule (`TokenTrustService`, the same answer the
          // position path gets): anchor-or-allowlisted in allowlist mode
          // (today), anchor-or-earned in earned mode, anchor-or-allowlisted-
          // or-earned in combined mode — so a real token that is not on the
          // committed allowlist (BTC.b on Ethereum) can still be priced here
          // once it has earned trust.
          const legTrusted = (addr: string) => trust.isTrusted(chainId, addr);
          if (!legTrusted(t0Addr) || !legTrusted(t1Addr)) {
            // A non-allowlisted leg can't be trust-priced — but DON'T drop the
            // pool: persist a risky doc (tvlUsd=0, usedFallback=true) carrying
            // the REAL reserves + volume. Skipping left referenced pools with no
            // row at all, so pool-detail lookups found nothing and the position
            // adapter's last-good reserve fallback had nothing to serve —
            // silently disabling the realizability gate for exactly the spam
            // pools that need it most (USDC/RPC) whenever the live stats fetch
            // flapped. The default pools leaderboard hides usedFallback=true
            // docs, so spam never ranks. No pricePool call: pricing 30k+ spam
            // pools per sync would burn provider quota for quotes we'd distrust.
            toUpsert.push(buildRiskyPoolUpsert(chainId, protocol, row));
            continue;
          }

          const dec0 = num(row.token0.decimals);
          const dec1 = num(row.token1.decimals);

          let priceResult: {
            token0Usd: number;
            token1Usd: number;
            source: string;
            usedFallback: boolean;
            token0Confidence?: string;
            token1Confidence?: string;
          };
          try {
            priceResult = await this.pricing.pricePool({
              chainId,
              protocol,
              token0: { address: t0Addr, decimals: dec0, symbol: row.token0.symbol },
              token1: { address: t1Addr, decimals: dec1, symbol: row.token1.symbol },
              sqrtPriceX96: row.sqrtPrice,
              tick: row.tick !== null ? num(row.tick) : undefined,
              poolTvlUsd: num(row.totalValueLockedUSD),
            });
          } catch (err) {
            this.logger.warn(`pricePool failed for ${row.id}: ${(err as Error)?.message}`);
            skipped++;
            continue;
          }

          // Earned / combined mode: the pool's OWN price must agree with the
          // legs' market prices within 10% (the consensus ratio), or a
          // non-anchor leg's value is not counted here — a pool trading far
          // off its tokens' market (HPP/AERGO: pool says $0.0062, the stale
          // quote $31,374) is not a market for them. In combined mode that
          // covers an ALLOWLISTED leg as well as an earned one: a listing
          // proves a token exists, not that this pool prices it. Allowlist
          // mode (today) skips it. Anchor legs are config, never downgraded.
          let confidence0 = priceResult.token0Confidence;
          let confidence1 = priceResult.token1Confidence;
          if (storedVerdicts && !poolPriceAgrees(priceResult.token0Usd, priceResult.token1Usd, poolRatio(row, dec0, dec1))) {
            if (trust.trust(chainId, t0Addr).reason !== 'anchor') confidence0 = 'external-unverified';
            if (trust.trust(chainId, t1Addr).reason !== 'anchor') confidence1 = 'external-unverified';
          }

          // Trust-tiered TVL: clamped reserves × trusted-leg prices only, with
          // fabrication + honeypot-fee flags (see evaluatePoolTvl).
          const verdict = evaluatePoolTvl({
            reserve0: num(row.totalValueLockedToken0),
            reserve1: num(row.totalValueLockedToken1),
            price0: priceResult.token0Usd,
            price1: priceResult.token1Usd,
            confidence0,
            confidence1,
            feeTier: num(row.feeTier),
            // HONEYPOT_FEE_ANCHOR_EXEMPT (default off): an anchor/anchor pool's
            // fee is never a honeypot flag. Read per row, so a spec config
            // without the getter is today's behaviour.
            honeypotExempt: this.config.honeypotFeeAnchorExempt === 'on' && isAnchorPair(chainId, t0Addr, t1Addr),
          });
          const tvlToken0 = verdict.tvlToken0;
          const tvlToken1 = verdict.tvlToken1;
          const tvlRaw = verdict.tvlUsd;

          // Both reserve legs must be priced (or hold ~no reserve) for the
          // re-valued TVL to be trusted — otherwise tvlRaw silently counts only
          // one leg, halving the pool's TVL and inflating feeApr, yet usedFallback
          // stays false so it passes the default leaderboard. Mirrors the
          // position-side hasCompleteHeldAssetPricing guard.
          const completePricing =
            (tvlToken0 <= 0 || priceResult.token0Usd > 0) &&
            (tvlToken1 <= 0 || priceResult.token1Usd > 0);

          // Sanity-gate the re-valued TVL. Implausible magnitude (or non-finite)
          // means a bad token price leaked through — zero it out and mark fallback
          // so the default leaderboard hides the pool instead of ranking the junk
          // at the top of the TVL sort.
          const tvlSane =
            completePricing && Number.isFinite(tvlRaw) && tvlRaw >= 0 && tvlRaw <= TVL_CEILING_USD;
          const tvlUsd = tvlSane && !verdict.risky ? tvlRaw : 0;
          const usedFallback = priceResult.usedFallback || !tvlSane || verdict.risky;

          // Last 7 day entries (desc order from query → [0] = most recent)
          const dayData = row.poolDayData ?? [];
          const day1 = dayData[0];
          const volumeUsd24h = day1 ? num(day1.volumeUSD) : 0;
          // Dynamic-fee pools are NOT special-cased here. This used to zero their
          // fee metrics because the old indexer priced each swap at the PREVIOUS
          // swap's `pool.feeTier`, which for a dynamic pool starts as the 0x800000
          // flag, so the first swap booked 838.8608% of its volume (feesUSD exactly
          // volume × 8.388608: $8.97M "fees" on $1.07M volume, feeApr pinned at the
          // cap). The indexer now prices each swap at that swap's own fee
          // (`event.params.fee`) and leaves `Pool.feeTier` alone — a dynamic pool
          // keeps the flag (the "dynamic" label), a static one keeps its LP tier —
          // so `feesUSD` is real for every pool and zeroing it would hide correct
          // figures. (On the previous indexer `feeTier` was overwritten by each
          // swap, so the check never fired there either.)
          const feesUsd24h = day1 ? num(day1.feesUSD) : 0;
          const volumeUsd7d = dayData.reduce((s, d) => s + num(d.volumeUSD), 0);
          const feesUsd7d = dayData.reduce((s, d) => s + num(d.feesUSD), 0);
          const feeAprRaw = tvlUsd > 0 ? (feesUsd24h * 365 / tvlUsd) * 100 : 0;
          const feeApr = Number.isFinite(feeAprRaw)
            ? Math.max(-FEE_APR_CAP, Math.min(FEE_APR_CAP, feeAprRaw))
            : 0;

          toUpsert.push({
            chainId,
            protocol,
            poolId: row.id.toLowerCase(),
            token0: { address: t0Addr, symbol: row.token0.symbol, decimals: dec0 },
            token1: { address: t1Addr, symbol: row.token1.symbol, decimals: dec1 },
            fee: num(row.feeTier),
            ...hooksField(row),
            tickSpacing: num(row.tickSpacing),
            currentTick: row.tick !== null ? num(row.tick) : 0,
            sqrtPriceX96: row.sqrtPrice,
            liquidity: row.liquidity,
            createdAtTimestamp: num(row.createdAtTimestamp),
            metrics: {
              tvlUsd,
              // Krystal-style utilization (24h volume / TVL) — a strong organic-
              // activity signal: spam pools show huge "TVL" with ~zero volume.
              volumeTvl24h: tvlUsd > 0 ? volumeUsd24h / tvlUsd : 0,
              // Corrupt-reserve pools persist NO reserves: `undefined` reads as
              // "unknown" downstream, whereas the clamped pair (0 / +1.47B)
              // would feed a fabricated backing to the realizability gate via
              // the adapter's last-good fallback.
              tvlToken0: verdict.reserveCorrupt ? undefined : tvlToken0,
              tvlToken1: verdict.reserveCorrupt ? undefined : tvlToken1,
              volumeUsd24h,
              volumeUsd7d,
              feesUsd24h,
              feesUsd7d,
              volumeUsdTotal: num(row.volumeUSD),
              feesUsdTotal: num(row.feesUSD),
              feeApr,
              txCount: num(row.txCount),
              currentPrice: num(row.token0Price),
            },
            pricing: {
              source: priceResult.source,
              usedFallback,
            },
          });
        }

        if (toUpsert.length > 0) {
          const result = await this.poolsRepo.upsertMany(toUpsert);
          upserted += result.written;
          unchanged += result.unchanged;
          hashReads += result.hashReads ?? 0;
        }
        // Counted only once the page is written, like the cursor below, so a
        // resumed retry neither loses nor repeats a page in the walk's totals.
        totals.pools += rows.length;
        totals.skipped += rows.length - toUpsert.length;
        for (const pool of toUpsert) {
          const tvl = pool.metrics.tvlUsd;
          if (Number.isFinite(tvl) && tvl > 0) totals.tvlUsd += tvl;
        }
        // Advanced only after the page is written, so a failure resumes here.
        if (rows.length > 0) cursor = rows[rows.length - 1]!.id;
      }
    } catch (err) {
      // Any failure — a page fetch or a write — resumes after the last WRITTEN
      // page (and keeps the totals with it); a failure before the first page
      // starts the next walk from the top.
      if (cursor !== null) this.resumeAfter.set(key, cursor);
      else {
        this.resumeAfter.delete(key);
        this.walkTotals.delete(key);
      }
      throw err;
    }

    this.resumeAfter.delete(key);
    this.walkTotals.delete(key);
    await this.recordCompleteWalk(chainId, protocol, totals);
    this.logger.log(
      `Pool sync done for ${key} — fetched=${fetched}, upserted=${upserted}, unchanged=${unchanged}, skipped=${skipped}, ` +
        `hashReads=${hashReads} (stored hashes read from Mongo; 0 once this process has walked the chain)`,
    );
    return { upserted, skipped };
  }

  /**
   * A COMPLETE walk's totals into sync_cursors (`/v1/stats` reads them).
   * Best-effort: losing it only keeps `/v1/stats` on its fallback.
   */
  private async recordCompleteWalk(
    chainId: number,
    protocol: string,
    totals: { pools: number; tvlUsd: number; skipped: number },
  ): Promise<void> {
    if (!this.syncRepo) return;
    try {
      await this.syncRepo.recordPoolWalk(chainId, protocol, { ...totals, finishedAt: new Date() });
    } catch (err) {
      this.logger.warn(
        `Pool walk totals for ${chainId}:${protocol} not recorded (pools=${totals.pools}, tvlUsd=${Math.round(totals.tvlUsd)}): ` +
          `${(err as Error)?.message ?? String(err)}`,
      );
    }
  }
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Latest `date` the indexer actually holds, which is NOT wall-clock.
 *
 * THIS IS THE WHOLE REASON THE FLOOR IS DERIVED RATHER THAN COMPUTED. The
 * deployment is months behind head during a backfill — measured 2026-09-22, the
 * newest chain-1 `PoolDayData` was 2026-03-10, 196 days back. A `Date.now() - 7d`
 * floor would therefore match NOTHING and silently zero every pool's 24h and 7d
 * volume and fees, with no error anywhere. Anchoring to the indexer's own newest
 * row keeps the window meaningful at any backfill position.
 */
async function fetchLatestDayDate(client: GraphQLClient): Promise<number | null> {
  const res = await requestWithRetry<{ poolDayDatas: { date: string }[] }>(
    client,
    POOL_DAY_MAX_QUERY,
    {},
  );
  const raw = res.poolDayDatas?.[0]?.date;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The last `DAY_WINDOW` days of data for a page of pools, grouped by pool id.
 *
 * One top-level query instead of one ordered subquery per pool — see the note on
 * `POOL_DAY_BATCH_QUERY`. TRUNCATION-SAFE: a request asks for
 * `DAY_DATA_MAX_ROWS` (the indexer's page cap), and one that comes back FULL
 * may have cut rows off — ordered globally by date desc, the cut is the oldest
 * days of SOME pools, which would silently shrink their 7d volume — so it is
 * re-asked as two halves of the ids, recursively, until every request comes
 * back short. A single pool with a full page needs no split: its newest rows
 * are the ones kept (a pool can carry more than one row per day across a
 * reorg; grouping slices back to `DAY_WINDOW`).
 */
export async function fetchDayDataFor(
  client: GraphQLClient,
  poolIds: string[],
  fromDate: number,
): Promise<Map<string, PoolDayDataRow[]>> {
  const byPool = new Map<string, PoolDayDataRow[]>();
  if (poolIds.length === 0) return byPool;
  await fetchDayDataInto(client, poolIds, fromDate, byPool);
  // The query orders globally by date desc, so each pool's slice is already
  // newest-first. Both consumers rely on that: `[0]` is the 24h figure.
  for (const [id, list] of byPool) byPool.set(id, list.slice(0, DAY_WINDOW));
  return byPool;
}

async function fetchDayDataInto(
  client: GraphQLClient,
  poolIds: string[],
  fromDate: number,
  byPool: Map<string, PoolDayDataRow[]>,
): Promise<void> {
  const res = await requestWithRetry<{
    poolDayDatas: (PoolDayDataRow & { pool: { id: string } })[];
  }>(client, POOL_DAY_BATCH_QUERY, {
    ids: poolIds,
    fromDate,
    first: DAY_DATA_MAX_ROWS,
  });
  const rows = res.poolDayDatas ?? [];
  if (rows.length >= DAY_DATA_MAX_ROWS && poolIds.length > 1) {
    // Halves one after the other, not in parallel: the walk stays one request
    // at a time against the indexer's background budget.
    const mid = Math.ceil(poolIds.length / 2);
    await fetchDayDataInto(client, poolIds.slice(0, mid), fromDate, byPool);
    await fetchDayDataInto(client, poolIds.slice(mid), fromDate, byPool);
    return;
  }
  for (const row of rows) {
    const id = row.pool?.id;
    if (!id) continue;
    const list = byPool.get(id);
    if (list) list.push(row);
    else byPool.set(id, [row]);
  }
}
