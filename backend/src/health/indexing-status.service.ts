import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { GraphQLClient, gql } from 'graphql-request';
import { can, leasesEnabled } from '../common/process-role.js';
import { CoordinationRedis } from '../common/coordination-redis.js';
import { LeaderLoop } from '../common/leader-loop.js';
import { AppConfigService } from '../config/app-config.service.js';
import { getChainConfig } from '../config/chains.config.js';
import type { IntegrationConfig } from '../config/integrations.config.js';
import { subgraphFetch } from '../subgraph/hyperindex/client.js';
import { indexerFailoverSnapshot, type IndexerFailoverSnapshot } from '../subgraph/indexer-failover.js';
import { runInLane } from '../subgraph/hyperindex/indexer-context.js';
import { indexerGatewayMode } from '../subgraph/hyperindex/indexer-gateway.js';

/**
 * NOTE: "CopyPools" below is the SEPARATE product in this tree, not this
 * service — this API is Tickwise. The rebrand deliberately left these two
 * references alone; renaming them would make the sentences false.
 *
 * Per-(chainId, protocol) indexer status surfaced on `GET /health`. Field names
 * mirror the CopyPools backend's subgraph-health shape so the client's
 * indexing-status badge ports 1:1: `indexedBlock` (synced) vs `chainHeadBlock`
 * (current) + `lagBlocks`.
 */
export interface IndexingStatus {
  /**
   * Latest block the indexer has PROCESSED, i.e. up to which data is QUERYABLE
   * (`_meta.block.number`, which the converter maps to Envio's `progressBlock` —
   * deliberately not `sourceBlock`/`bufferBlock`, which run ahead of what a
   * position query can see and would UNDERSTATE the lag this field exists to
   * report).
   *
   * If the probe FAILS (timeout, 5xx, rate limit) the last reading that did
   * succeed is reported for up to `LAST_GOOD_MAX_AGE_MS`, with `lagBlocks`
   * re-derived against the live chain head — so the lag can only be OVERSTATED by
   * the carried block's age, never hidden. Past that window it is `null`.
   */
  indexedBlock: number | null;
  /**
   * Epoch seconds the indexed data is current to, kept for back-compat with the
   * old field. Now an ESTIMATE, `now − lagSeconds`, and null whenever
   * `lagSeconds` is — AND while `chainHeadEstimated` is true: `/v1/stats`
   * `indexedTo` / `byChain[].indexedUpToTimestamp` are read from this field and
   * carry no estimate flag, so during a DeFiLlama outage they stay null exactly
   * as before the head estimate existed rather than turning a time-based guess
   * into an unmarked figure on a paid endpoint. It used to be the newest indexed `ModifyLiquidity` event,
   * read by a `chainId`-filtered `order_by timestamp desc` scan that took 18-30s+
   * on every chain but mainnet and kept running on the indexer's Postgres after
   * we gave up on it — the same database that serves every position read.
   */
  indexedUpToTimestamp: number | null;
  /**
   * Latest block on the chain, from an INDEPENDENT observer (DeFiLlama's keyless
   * block-by-timestamp endpoint — not an RPC node, and deliberately not the
   * indexer's own `chain_metadata.block_height`, which stalls with the indexer
   * and would read as zero lag during exactly the outage this field exists to
   * expose). null when the chain has no DeFiLlama slug.
   *
   * When the probe FAILS (DeFiLlama rate-limits per IP, and the pricing
   * provider shares `coins.llama.fi` from the same egress), it is ESTIMATED
   * from the last good reading for up to `HEAD_ESTIMATE_MAX_AGE_MS`:
   * `lastGoodHead + floor(elapsed / blockTimeMs)`, with `chainHeadEstimated:
   * true`. Past that window, or with no good reading yet, it is null.
   */
  chainHeadBlock: number | null;
  /**
   * True when `chainHeadBlock` (and so `lagBlocks` / `lagSeconds`) is the
   * time-based estimate above rather than a live reading. Additive.
   */
  chainHeadEstimated: boolean;
  /** `max(0, chainHead - indexed)`; null when either side is unknown. */
  lagBlocks: number | null;
  /**
   * `lagBlocks` expressed as time: `lagBlocks × the chain's average block time`
   * (`ChainConfig.blockTimeMs`), in whole seconds. An ESTIMATE — block times drift
   * a little — but it is available whenever `lagBlocks` is, which the old
   * timestamp probe was not. null when `lagBlocks` is null or the chain has no
   * block time.
   */
  lagSeconds: number | null;
  /** indexed exists AND lag within the healthy threshold (or chain head unknown). */
  synced: boolean;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'not_deployed';
  /**
   * Only when the chain has more than one indexer (Envio and Ponder): which one
   * answered most recently, and each one's state from the failover's own probe.
   * The fields above describe whichever source served this status's probe.
   */
  indexer?: IndexerFailoverSnapshot;
}

// A 60s TTL bounds outbound fetches to ≤1 REFRESH per minute per integration
// regardless of how often clients poll /health — one indexer request (the
// indexed block) and one DeFiLlama call. It was 15s, which let /health alone
// spend up to ~32 indexer requests a minute from a budget shared with every user
// read. Block numbers may now be up to a minute stale, which the status page's
// "~N days" granularity cannot show. Each service instance has its own cache.
const STATUS_TTL_MS = 60_000;
/*
 * 10s, not 4s, for the indexed block and the chain head. The bare `_meta` probe
 * costs ~0.6-1.2s against the live deployment even when nothing else is in
 * flight, so a 4s deadline left almost no headroom under normal server load —
 * four chains probing concurrently alongside pool sync and the price providers —
 * and a DIFFERENT two chains lost the race on every refresh. Still far inside
 * the 20s the status page refreshes on.
 *
 * There used to be a third probe, the `ModifyLiquidity ... order_by timestamp
 * desc` scan behind `_meta { block { timestamp } }`, on a 4s leash. It cost 18-30s+
 * on 42161/43114/4663, so it missed that leash nearly always — and abandoning it
 * locally did not stop it running on the indexer's Postgres. It is gone; see
 * `indexedUpToTimestamp`.
 */
const FETCH_TIMEOUT_MS = 10_000;
/*
 * How long a probe's last SUCCESSFUL reading may stand in for a failed one.
 *
 * Before this, a failed probe REPLACED the cached value with nulls — so one slow
 * request flipped a healthy chain to `unhealthy` / "indexed not reporting" for a
 * full TTL, and the status page showed that to visitors about one refresh in four
 * for mainnet. The comment in `refresh` below claims it keeps last-good; it did
 * not, because `fetchStatus` fails soft and returns nulls rather than throwing.
 *
 * Bounded, because carrying forever would turn a dead indexer into a permanently
 * green page. Five minutes of WALL-CLOCK time since the last success — five
 * failed refreshes only while somebody is polling; refreshes are demand-driven,
 * so after a quiet spell the same five minutes can have elapsed with none — after
 * which the honest answer is `null`. The carried reading is conservative: lag is
 * computed against the LIVE chain head, so the indexer's real progress since then
 * can only make the true lag smaller than reported.
 *
 * The FIRST failed refresh of an episode is carried regardless of age. After an
 * idle gap the last success is already older than the window, and one slow probe
 * landing there is a blip, not an outage: nulling the reading on it would make
 * every quiet spell end with a blank whenever that one probe was slow. The age bound
 * applies from the second consecutive failure on.
 */
const LAST_GOOD_MAX_AGE_MS = 5 * 60_000;

/*
 * The chain head (DeFiLlama `coins.llama.fi/block/<chain>/<now>`).
 *
 * Prod showed `chainHeadBlock: null` on EVERY chain while the same URL answered
 * from elsewhere, beside `DefillamaProvider` 429s in the log. The probe has no
 * limiter or backoff of its own and shares none with the pricing provider (it
 * is a plain `fetch`), but DeFiLlama rate-limits per client IP: the pricing
 * provider's batched `coins.llama.fi/prices/...` traffic from the same egress
 * spends that allowance, the probe's own request then answers 429 too, and the
 * probe used to map ANY failure straight to `null` — no retry, no carry — for
 * the whole 60 s TTL, on all four chains at once (they refresh together).
 *
 * Fixed without adding an RPC call (the internal design notes, no nodes):
 *  - one RETRY on a 429 / 5xx / transport error / timeout, after `Retry-After`
 *    (capped at `HEAD_RETRY_MAX_DELAY_MS`) or a 250–1000 ms jitter, inside the
 *    same 10 s leash (no retry when less than `HEAD_RETRY_MIN_BUDGET_MS` of it
 *    is left), so a refresh still never waits longer than before;
 *  - a failed probe is ESTIMATED from the last good head for up to
 *    `HEAD_ESTIMATE_MAX_AGE_MS`: `lastGood + floor(elapsed / blockTimeMs)`,
 *    flagged `chainHeadEstimated: true`. Block times drift, so the bound is
 *    kept short (15 min on Arbitrum's ~250 ms blocks is ~3,600 blocks; a 10 %
 *    drift there is ~360 blocks against a 12,000-block lag budget). A chain
 *    with no block time is not estimated (null, as before).
 *  - with leases on, only the `indexing-status` lease holder probes at all
 *    (one probe per chain per minute fleet-wide instead of one per replica).
 */
const HEAD_ESTIMATE_MAX_AGE_MS = 15 * 60_000;
const HEAD_RETRY_MIN_DELAY_MS = 250;
const HEAD_RETRY_MAX_JITTER_MS = 750;
const HEAD_RETRY_MAX_DELAY_MS = 2_000;
const HEAD_RETRY_MIN_BUDGET_MS = 2_000;

/*
 * Leases on (capacity plan step 1): ONE process — the `indexing-status` lease
 * holder — refreshes every enabled integration every `STATUS_TTL_MS` and
 * publishes the results (with their last-good readings) to
 * `tw:health:v1:<ns>:status`. Every other replica serves its memory copy and
 * refreshes it from that key (one GET per TTL, shared by every integration);
 * it probes locally — exactly as with leases off — only when the key is
 * missing, older than `STATUS_SNAPSHOT_MAX_AGE_MS`, malformed, or Redis is
 * unreachable. With leases off none of this exists: no lease, no key.
 */
export const INDEXING_STATUS_LEASE = 'indexing-status';
const STATUS_SNAPSHOT_TTL_MS = Math.round(3.5 * STATUS_TTL_MS);
const STATUS_SNAPSHOT_MAX_AGE_MS = 3 * STATUS_TTL_MS;
/** A follower holding a copy the leader has not yet replaced re-checks Redis at most this often. */
const FOLLOWER_RECHECK_MS = 10_000;
/** One GET serves every integration refreshing within this window. */
const SNAPSHOT_READ_MEMO_MS = 1_000;

export function indexingStatusSnapshotKey(namespace: string): string {
  return `tw:health:v1:${namespace}:status`;
}

interface PublishedEntry {
  value: IndexingStatus;
  fetchedAt: number;
  lastBlock?: LastGood;
  lastHead?: LastGood;
}

interface PublishedStatus {
  v: 1;
  at: number;
  entries: Record<string, PublishedEntry>;
}

/*
 * `block { number }` ONLY. `translateMeta` builds the Hasura document from what
 * is selected, so this is the bare `_meta` root (answered in under 1.2s on every
 * sample). Asking for `timestamp` as well would add the `ModifyLiquidity` scan
 * this service no longer runs. `_meta` must be the ONLY root selection — the
 * converter routes a meta-only document down a separate path and throws if it
 * is mixed with entity queries.
 */
const META_BLOCK_QUERY = gql`
  query MetaBlock {
    _meta {
      block {
        number
      }
    }
  }
`;

// DeFiLlama chain slug per chainId for the keyless block-by-timestamp endpoint
// (`coins.llama.fi/block/{chain}/{unixSeconds}` → `{ height, timestamp }`).
export const LLAMA_CHAIN_SLUG: Record<number, string> = {
  1: 'ethereum',
  43114: 'avax',
  // Same string as `ChainConfig.slug`; probed independently against the block
  // endpoint (which errors loudly on a bad slug): returns {height, timestamp}.
  42161: 'arbitrum',
  // Same string as `ChainConfig.slug`; probed live 2026-09-02 against the block
  // endpoint: block/robinhood/1788000000 -> {height:49090077}. A bad slug 400s; a
  // PRE-GENESIS timestamp 500s (genesis ~ts 1778003237), which is NOT non-coverage.
  4663: 'robinhood',
};

// The lag budget is calibrated as a block COUNT against mainnet's ~12s blocks
// (`INDEXER_MAX_LAG_BLOCKS`); chainId 1 is its reference chain.
const LAG_BUDGET_REFERENCE_CHAIN = 1;

/** The last value a probe SUCCESSFULLY returned, and when (epoch ms). */
interface LastGood {
  value: number;
  at: number;
}

/**
 * One probe's outcome. `ok: false` means the probe did not produce an answer
 * (timeout, transport error, rate limit, a Hasura error) and is the ONLY state
 * that may be papered over with a last-good value; `ok: true` with a `null` is a
 * real answer — "the indexer has nothing for this chain" — and must never be.
 */
type Probe = { ok: true; value: number | null } | { ok: false; reason: string };

interface CacheEntry {
  value: IndexingStatus;
  /** epoch ms of the last completed refresh; 0 = cold (never fetched). */
  fetchedAt: number;
  /** in-flight refresh, if any — concurrent callers dedup onto it. */
  inflight?: Promise<IndexingStatus>;
  /** Last successful indexed-block reading; see LAST_GOOD_MAX_AGE_MS. */
  lastBlock?: LastGood;
  /**
   * Whether the block probe failed on the previous refresh. The first failure of
   * a run is carried whatever the reading's age, and the probe logs on the
   * transition rather than on every refresh.
   */
  blockFailing?: boolean;
  /** Last successful chain-head reading; see HEAD_ESTIMATE_MAX_AGE_MS. */
  lastHead?: LastGood;
  /** Whether the chain-head probe failed on the previous refresh (logged on the transition). */
  headFailing?: boolean;
}

/** One chain-head attempt; `retryable` = 429 / 5xx / transport error / timeout. */
type HeadAttempt = { ok: true; value: number } | { ok: false; reason: string; retryable: boolean; retryAfterMs?: number };

@Injectable()
export class IndexingStatusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexingStatusService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /** Leases on only: the `indexing-status` lease (undefined with leases off — today). */
  private leader?: LeaderLoop;
  private snapshotRead?: { at: number; promise: Promise<PublishedStatus | undefined> };
  private snapshotLoggedAt = 0;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    // APPENDED and optional: specs construct this service with the config
    // alone. Only read when leases are on; without it every process probes.
    @Optional() @Inject(CoordinationRedis) private readonly coordination?: CoordinationRedis,
  ) {}

  /**
   * Warm every enabled integration at boot, without blocking it.
   *
   * A cold key AWAITS its first refresh (there is nothing stale to serve), so the
   * first `/health` after a deploy or restart used to wait on a live probe — up
   * to 10s, against the status page's 2.5s server-render deadline, which rendered
   * a blank first paint. Kicking the refreshes off here means that by the time a
   * visitor arrives the cache is populated and every request is O(1).
   */
  onModuleInit(): void {
    // P2.1: only roles that serve `/health` in full warm it (all, api); a
    // worker role's `/health` never probes the indexer, so warming there
    // would only spend indexer budget.
    if (!can('indexing-status-warm')) return;
    if (leasesEnabled() && this.coordination) {
      // Leases on: the holder probes every TTL and publishes; the boot warm
      // below then reads the published copy here (or probes when there is none).
      this.leader = new LeaderLoop({
        name: INDEXING_STATUS_LEASE,
        coordination: this.coordination,
        intervalMs: STATUS_TTL_MS,
        lead: () => this.leadCycle(),
        logger: this.logger,
      });
      this.leader.start();
    }
    for (const integration of this.config.enabledIntegrations) {
      void this.getStatus(integration).catch(() => undefined);
    }
  }

  onModuleDestroy(): void {
    void this.leader?.stop();
  }

  /** Leases on and another process holds `indexing-status`: read its published results. */
  private followsLeader(): boolean {
    return this.leader !== undefined && !this.leader.leading;
  }

  /**
   * Leader: refresh every enabled integration now (joining a refresh already
   * in flight), then publish them all. A publish failure is logged and ignored.
   */
  private async leadCycle(): Promise<void> {
    const integrations = this.config.enabledIntegrations ?? [];
    await Promise.all(
      integrations.map(async (integration) => {
        const key = this.cacheKey(integration);
        const entry = this.cache.get(key) ?? { value: this.coldValue(integration), fetchedAt: 0 };
        if (!entry.inflight) {
          entry.inflight = this.refresh(key, integration, entry);
          this.cache.set(key, entry);
        }
        await entry.inflight.catch(() => undefined);
      }),
    );
    await this.publish(integrations.map((integration) => this.cacheKey(integration)));
  }

  private async publish(keys: string[]): Promise<void> {
    const coordination = this.coordination;
    if (!coordination) return;
    const entries: Record<string, PublishedEntry> = {};
    for (const key of keys) {
      const entry = this.cache.get(key);
      if (!entry || entry.fetchedAt <= 0) continue;
      entries[key] = { value: entry.value, fetchedAt: entry.fetchedAt, lastBlock: entry.lastBlock, lastHead: entry.lastHead };
    }
    if (Object.keys(entries).length === 0) return;
    try {
      const redis = await coordination.client();
      if (!redis) return;
      const body: PublishedStatus = { v: 1, at: Date.now(), entries };
      await redis.set(indexingStatusSnapshotKey(coordination.namespace), JSON.stringify(body), 'PX', STATUS_SNAPSHOT_TTL_MS);
    } catch (err) {
      this.logSnapshot('publish', err);
    }
  }

  /** The published results (memoised for a second: one GET serves every integration refreshing together). */
  private readPublished(): Promise<PublishedStatus | undefined> {
    const now = Date.now();
    if (this.snapshotRead && now - this.snapshotRead.at < SNAPSHOT_READ_MEMO_MS) return this.snapshotRead.promise;
    const promise = (async (): Promise<PublishedStatus | undefined> => {
      const coordination = this.coordination;
      if (!coordination) return undefined;
      try {
        const redis = await coordination.client();
        if (!redis) return undefined;
        const raw = await redis.get(indexingStatusSnapshotKey(coordination.namespace));
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as Partial<PublishedStatus>;
        if (parsed?.v !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) return undefined;
        return parsed as PublishedStatus;
      } catch (err) {
        this.logSnapshot('read', err);
        return undefined;
      }
    })();
    this.snapshotRead = { at: now, promise };
    return promise;
  }

  /**
   * Follower refresh: adopt the leader's published entry for `key` when it is
   * no older than `STATUS_SNAPSHOT_MAX_AGE_MS`; otherwise probe locally (the
   * leases-off path, with its fail-soft / last-good rules).
   */
  private async followerRefresh(key: string, integration: IntegrationConfig, entry: CacheEntry): Promise<IndexingStatus> {
    const published = (await this.readPublished())?.entries?.[key];
    const now = Date.now();
    if (
      !published ||
      typeof published.fetchedAt !== 'number' ||
      now - published.fetchedAt > STATUS_SNAPSHOT_MAX_AGE_MS ||
      typeof published.value !== 'object' ||
      published.value === null
    ) {
      return this.refresh(key, integration, entry);
    }
    // Spread over the cold value so a payload from an older build (no
    // `chainHeadEstimated`) still yields the full response shape.
    entry.value = { ...this.coldValue(integration), ...published.value };
    // The leader's last-good readings, when newer: a later local fallback then
    // carries / estimates from them like the leader would have.
    if (published.lastBlock && (!entry.lastBlock || published.lastBlock.at > entry.lastBlock.at)) entry.lastBlock = published.lastBlock;
    if (published.lastHead && (!entry.lastHead || published.lastHead.at > entry.lastHead.at)) entry.lastHead = published.lastHead;
    // Aged from the leader's refresh, so the copy is re-read when the leader's
    // is due — but at most every FOLLOWER_RECHECK_MS while the leader is late.
    entry.fetchedAt = Math.max(published.fetchedAt, now - STATUS_TTL_MS + FOLLOWER_RECHECK_MS);
    entry.inflight = undefined;
    return entry.value;
  }

  private logSnapshot(what: string, err: unknown): void {
    const now = Date.now();
    if (now - this.snapshotLoggedAt < 60_000) return;
    this.snapshotLoggedAt = now;
    this.logger.warn(`indexing-status Redis ${what} failed (ignored): ${(err as Error)?.message ?? String(err)}`);
  }

  private cacheKey(integration: IntegrationConfig): string {
    return `${integration.chainId}:${integration.subgraphUrl ?? ''}`;
  }

  /**
   * Stale-while-revalidate + single-flight. A fresh entry is returned directly;
   * a stale one is returned IMMEDIATELY while a deduped background refresh runs
   * (client latency stays O(1) after warmup); a cold key awaits one shared
   * refresh. Net: at most one refresh — one indexer request (the indexed block)
   * and one chain-head fetch — per integration per TTL, no matter the request volume.
   */
  async getStatus(integration: IntegrationConfig): Promise<IndexingStatus> {
    const key = this.cacheKey(integration);
    const entry = this.cache.get(key);
    const hasValue = entry !== undefined && entry.fetchedAt > 0;

    if (hasValue && Date.now() - entry!.fetchedAt < STATUS_TTL_MS) {
      return entry!.value; // fresh
    }

    // Ensure exactly one in-flight refresh per key.
    const tracked: CacheEntry = entry ?? { value: this.coldValue(integration), fetchedAt: 0 };
    if (!tracked.inflight) {
      // Leases on, another process leads: its published result (or, when there
      // is none fresh enough, a local probe). Otherwise: probe (today).
      tracked.inflight = this.followsLeader()
        ? this.followerRefresh(key, integration, tracked)
        : this.refresh(key, integration, tracked);
      this.cache.set(key, tracked);
    }

    // Stale → serve last-good now (refresh runs in the background).
    // Cold → await the shared refresh.
    return hasValue ? tracked.value : tracked.inflight;
  }

  private async refresh(
    key: string,
    integration: IntegrationConfig,
    entry: CacheEntry,
  ): Promise<IndexingStatus> {
    try {
      // Its own lane, whoever asked. A refresh is SHARED by every caller that
      // dedups onto it, so it must not inherit one caller's interactive context
      // (`/v1/stats` reaches here from an HTTP request) — that caller hanging up
      // would abort the probe for everyone waiting on it. When the gateway
      // enforces, the probe also carries its own deadline, so a call still queued
      // behind the budget when `withDeadline` gives up is dropped rather than sent.
      entry.value = await runInLane(
        {
          lane: 'health',
          job: 'health',
          chainId: integration.chainId,
          signal: indexerGatewayMode() === 'enforce' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
        },
        () => this.fetchStatus(integration, entry),
      );
      return entry.value;
    } catch (err) {
      // fetchStatus already fails soft; this is belt-and-suspenders.
      this.logger.warn(
        `indexing-status refresh failed (${key}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return entry.value; // keep last-good / cold sentinel
    } finally {
      // Stamp even on failure so a persistent outage backs off one TTL instead
      // of hot-looping the fetch on every request.
      entry.fetchedAt = Date.now();
      entry.inflight = undefined;
    }
  }

  /**
   * Samples the indexed block and the chain head together so `lagBlocks` is
   * coherent. The two probes run in parallel and fail INDEPENDENTLY: neither can
   * take the other down.
   */
  private async fetchStatus(
    integration: IntegrationConfig,
    entry: CacheEntry,
  ): Promise<IndexingStatus> {
    if (!integration.subgraphUrl) {
      return {
        indexedBlock: null,
        indexedUpToTimestamp: null,
        chainHeadBlock: null,
        chainHeadEstimated: false,
        lagBlocks: null,
        lagSeconds: null,
        synced: false,
        status: 'not_deployed',
      };
    }

    const [blockProbe, headProbe] = await Promise.all([
      this.fetchIndexedBlock(integration),
      this.fetchChainHead(integration.chainId),
    ]);

    const now = Date.now();
    // The first failure of a run is carried whatever the reading's age (see
    // LAST_GOOD_MAX_AGE_MS), so the previous refresh's outcome is read BEFORE it is
    // overwritten below.
    const block = this.settle(blockProbe, entry.lastBlock, now, !entry.blockFailing);
    entry.lastBlock = block.lastGood;
    this.logBlockProbe(integration, entry, blockProbe, block.carried);

    const head = this.settleHead(headProbe, entry.lastHead, now, integration.chainId);
    entry.lastHead = head.lastGood;
    this.logHeadProbe(integration, entry, headProbe, head.estimated);
    const chainHeadBlock = head.value;

    const indexedBlock = block.value;
    const lagBlocks =
      indexedBlock !== null && chainHeadBlock !== null
        ? Math.max(0, chainHeadBlock - indexedBlock)
        : null;

    const maxLag = this.maxLagBlocksFor(integration.chainId);
    let status: IndexingStatus['status'];
    let synced: boolean;
    if (indexedBlock === null || indexedBlock <= 0) {
      status = 'unhealthy';
      synced = false;
    } else if (lagBlocks !== null && lagBlocks > maxLag) {
      status = 'degraded';
      synced = false;
    } else {
      // Healthy even when the chain head is unknown — show the indexed block
      // alone (matches CopyPools' non-primary-chain rows).
      status = 'healthy';
      synced = true;
    }

    const blockTimeMs = getChainConfig(integration.chainId)?.blockTimeMs;
    const lagSeconds =
      lagBlocks !== null && blockTimeMs ? Math.round((lagBlocks * blockTimeMs) / 1000) : null;
    // Derived, not probed: "data is current to `lagSeconds` ago". Null when the
    // lag is unknown — never a guess from the wall clock alone — and while the
    // head is ESTIMATED: this field feeds `/v1/stats` `indexedTo`, which has no
    // estimate flag, so it keeps answering null during a DeFiLlama outage as it
    // did before the estimate (only `/health` carries `chainHeadEstimated`).
    const indexedUpToTimestamp =
      lagSeconds !== null && !head.estimated ? Math.floor(now / 1000) - lagSeconds : null;
    const indexer = indexerFailoverSnapshot(integration.chainId);

    return {
      indexedBlock,
      indexedUpToTimestamp,
      chainHeadBlock,
      chainHeadEstimated: head.estimated,
      lagBlocks,
      lagSeconds,
      synced,
      status,
      ...(indexer ? { indexer } : {}),
    };
  }

  /**
   * Turns one probe into the value to REPORT and the last-good to REMEMBER.
   *
   *  - answered, non-null  → that value, and it becomes the new last-good.
   *  - answered, null      → null, and last-good is CLEARED. "The indexer has no
   *                          block for this chain" is a real answer; serving an
   *                          old block over it would hide exactly the outage the
   *                          page exists to show.
   *  - did not answer      → the last-good if it is younger than
   *                          `LAST_GOOD_MAX_AGE_MS` — or if this is the FIRST
   *                          failure of an episode, whatever its age — else null
   *                          (and forgotten).
   */
  private settle(
    probe: Probe,
    previous: LastGood | undefined,
    now: number,
    firstFailure: boolean,
  ): { value: number | null; lastGood: LastGood | undefined; carried: boolean } {
    if (probe.ok) {
      return {
        value: probe.value,
        lastGood: probe.value === null ? undefined : { value: probe.value, at: now },
        carried: false,
      };
    }
    if (previous && (firstFailure || now - previous.at <= LAST_GOOD_MAX_AGE_MS)) {
      return { value: previous.value, lastGood: previous, carried: true };
    }
    return { value: null, lastGood: undefined, carried: false };
  }

  /**
   * The indexed-block probe is the one worth a log line: it rarely fails, and when
   * it does the status page is showing a carried or a missing reading. Logged on
   * the TRANSITION (failing, then recovered), not on every refresh of a probe
   * that stays down.
   */
  private logBlockProbe(
    integration: IntegrationConfig,
    entry: CacheEntry,
    probe: Probe,
    carried: boolean,
  ): void {
    const chain = integration.chainId;
    if (probe.ok) {
      if (entry.blockFailing) this.logger.log(`indexed-block probe recovered (chain ${chain})`);
      entry.blockFailing = false;
      return;
    }
    if (!entry.blockFailing) {
      this.logger.warn(
        `indexed-block probe failed (chain ${chain}): ${probe.reason} — ` +
          (carried
            ? 'reporting the last good block'
            : 'no recent reading to fall back on, reporting it as not available'),
      );
    }
    entry.blockFailing = true;
  }

  /**
   * Best-effort read of the indexer's own head block via `_meta`, through the
   * same translating fetch every other indexer read uses. Never throws.
   *
   * `block.number` is 0 (never null) for a chain the deployment does not
   * cover, which the `> 0 ? x : null` test maps onto the existing
   * `indexedBlock <= 0 → 'unhealthy'` rule.
   *
   * The deadline is a `Promise.race`, NOT an `AbortSignal` on the request,
   * because the translating fetch builds its own upstream request and does not
   * forward `init.signal`, so `AbortSignal.timeout` here would be silently
   * ignored. In observe mode the losing request is not cancelled and finishes in
   * the background — acceptable because single-flight plus the TTL cap it at one
   * in-flight call per key. (In enforce mode the refresh's lane context carries a
   * deadline signal, which the gateway does honour.)
   *
   * Deliberately NOT wrapped in `requestWithRetry`: /health must be fast and fail
   * soft, and retrying a chain the deployment does not index would turn one slow
   * refresh into four.
   */
  private async fetchIndexedBlock(integration: IntegrationConfig): Promise<Probe> {
    return this.probeMeta(
      integration,
      META_BLOCK_QUERY,
      FETCH_TIMEOUT_MS,
      (data) => data?._meta?.block?.number,
    );
  }

  private async probeMeta(
    integration: IntegrationConfig,
    query: string,
    timeoutMs: number,
    pick: (data: MetaResponse | undefined) => unknown,
  ): Promise<Probe> {
    const url = integration.subgraphUrl;
    if (!url) return { ok: true, value: null };
    try {
      const client = new GraphQLClient(url, subgraphFetch(integration));
      const data = await withDeadline(client.request<MetaResponse>(query), timeoutMs);
      const raw = pick(data);
      return { ok: true, value: typeof raw === 'number' && raw > 0 ? raw : null };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Chain head via DeFiLlama's keyless block-by-timestamp endpoint — NOT a
   * JSON-RPC node call. The block closest to `now` is the current tip within a
   * few seconds (`max(0, head - indexed)` clamps the occasional case where the
   * indexer momentarily reports a fresher block than Llama's tip). Reuses an
   * aggregator we already depend on; no key, no extra config. Never throws.
   *
   * `{ok: true, value: null}` only for a chain with no DeFiLlama slug (a real
   * "no source"); every failure is `ok: false` so `settleHead` may estimate.
   * One retry on a transient failure, inside the same `FETCH_TIMEOUT_MS` leash
   * (see HEAD_ESTIMATE_MAX_AGE_MS for why).
   */
  private async fetchChainHead(chainId: number): Promise<Probe> {
    const slug = LLAMA_CHAIN_SLUG[chainId];
    if (!slug) return { ok: true, value: null }; // chain head omitted (indexed block shown alone)
    const startedAt = Date.now();
    const first = await this.headAttempt(slug, FETCH_TIMEOUT_MS);
    if (first.ok) return first;
    if (!first.retryable) return { ok: false, reason: first.reason };
    const delay = Math.min(
      HEAD_RETRY_MAX_DELAY_MS,
      first.retryAfterMs ?? HEAD_RETRY_MIN_DELAY_MS + Math.floor(Math.random() * HEAD_RETRY_MAX_JITTER_MS),
    );
    const remaining = FETCH_TIMEOUT_MS - (Date.now() - startedAt) - delay;
    if (remaining < HEAD_RETRY_MIN_BUDGET_MS) return { ok: false, reason: first.reason };
    await sleep(delay);
    const second = await this.headAttempt(slug, remaining);
    return second.ok ? second : { ok: false, reason: `${first.reason}; retry: ${second.reason}` };
  }

  private async headAttempt(slug: string, timeoutMs: number): Promise<HeadAttempt> {
    const url = `https://coins.llama.fi/block/${slug}/${Math.floor(Date.now() / 1000)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        const status = typeof res.status === 'number' ? res.status : 0;
        return {
          ok: false,
          reason: `HTTP ${status || 'error'}`,
          retryable: status === 429 || status >= 500,
          retryAfterMs: parseRetryAfterMs(res.headers?.get?.('retry-after') ?? null),
        };
      }
      const body = (await res.json()) as { height?: number };
      return typeof body.height === 'number' && body.height > 0
        ? { ok: true, value: body.height }
        : { ok: false, reason: 'no height in the response', retryable: false };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err), retryable: true };
    }
  }

  /**
   * The chain head to REPORT and the last good one to REMEMBER.
   *
   *  - answered          → that value (null only for a chain with no slug); it
   *                        becomes the new last good (null clears it).
   *  - did not answer    → `lastGood + floor(elapsed / blockTimeMs)`, flagged
   *                        estimated, while the last good is no older than
   *                        `HEAD_ESTIMATE_MAX_AGE_MS` and the chain has a
   *                        block time; else null (and forgotten once too old).
   */
  private settleHead(
    probe: Probe,
    previous: LastGood | undefined,
    now: number,
    chainId: number,
  ): { value: number | null; estimated: boolean; lastGood: LastGood | undefined } {
    if (probe.ok) {
      return {
        value: probe.value,
        estimated: false,
        lastGood: probe.value === null ? undefined : { value: probe.value, at: now },
      };
    }
    if (!previous || now - previous.at > HEAD_ESTIMATE_MAX_AGE_MS) {
      return { value: null, estimated: false, lastGood: undefined };
    }
    const blockTimeMs = getChainConfig(chainId)?.blockTimeMs;
    if (!blockTimeMs || blockTimeMs <= 0) return { value: null, estimated: false, lastGood: previous };
    const elapsed = Math.max(0, now - previous.at);
    return { value: previous.value + Math.floor(elapsed / blockTimeMs), estimated: true, lastGood: previous };
  }

  /** Like `logBlockProbe`: once when the chain-head probe starts failing, once when it recovers. */
  private logHeadProbe(integration: IntegrationConfig, entry: CacheEntry, probe: Probe, estimated: boolean): void {
    const chain = integration.chainId;
    if (probe.ok) {
      if (entry.headFailing) this.logger.log(`chain-head probe recovered (chain ${chain})`);
      entry.headFailing = false;
      return;
    }
    if (!entry.headFailing) {
      this.logger.warn(
        `chain-head probe failed (chain ${chain}): ${probe.reason} — ` +
          (estimated
            ? 'reporting an estimate from the last good head (chainHeadEstimated)'
            : 'no recent head to estimate from, reporting it as not available'),
      );
    }
    entry.headFailing = true;
  }

  /**
   * Per-chain "degraded" lag threshold in THIS chain's blocks. `INDEXER_MAX_LAG_BLOCKS`
   * is a block COUNT tuned for mainnet's ~12s blocks, so applying it verbatim to a
   * fast chain (Avalanche ~1s) would trip 'degraded' ~12× sooner in wall-clock
   * terms. Convert the budget to wall-clock time using the reference chain's block
   * time, then re-express it in the target chain's blocks. Falls back to the flat
   * block budget when either chain's block time is unknown (and such a chain has no
   * DeFiLlama slug anyway → lag is null → this threshold is never consulted).
   */
  private maxLagBlocksFor(chainId: number): number {
    const flat = this.config.indexerMaxLagBlocks;
    if (chainId === LAG_BUDGET_REFERENCE_CHAIN) return flat;
    const chain = getChainConfig(chainId);
    const reference = getChainConfig(LAG_BUDGET_REFERENCE_CHAIN);
    if (!chain?.blockTimeMs || !reference?.blockTimeMs) return flat;
    const budgetMs = flat * reference.blockTimeMs;
    return Math.max(1, Math.round(budgetMs / chain.blockTimeMs));
  }

  private coldValue(integration: IntegrationConfig): IndexingStatus {
    return {
      indexedBlock: null,
      indexedUpToTimestamp: null,
      chainHeadBlock: null,
      chainHeadEstimated: false,
      lagBlocks: null,
      lagSeconds: null,
      synced: false,
      status: integration.subgraphUrl ? 'unhealthy' : 'not_deployed',
    };
  }
}

/** The slice of the translated `_meta` response the block probe reads. */
interface MetaResponse {
  _meta?: { block?: { number?: number } };
}

/**
 * `Promise.race` with a timer that does not hold the process open. See
 * `fetchIndexedBlock` for why an AbortSignal cannot be used here.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`indexer probe timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolves after `ms` on a timer that does not hold the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

/** `Retry-After` (delta-seconds or an HTTP date) in ms; undefined when absent or unparseable. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
