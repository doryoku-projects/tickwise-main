import type { SubgraphTarget } from './base-provider.js';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { BaseProvider } from './base-provider.js';
import {
  providerHistoricalKey,
  type HistoricalReq,
  type PriceQuote,
} from './price-provider.interface.js';

const SECONDS_PER_HOUR = 3600;

interface TokenHourDataResponse {
  data?: {
    tokenHourDatas?: Array<{
      id: string;
      periodStartUnix: number;
      priceUSD: string;
      token: { id: string };
    }>;
  };
  errors?: Array<{ message: string }>;
}

/**
 * Historical price provider backed by a Uniswap-style subgraph's
 * `tokenHourDatas` table. Each row stores one hour's USD price for a token
 * (sourced from on-chain swap data the subgraph indexes), so coverage spans
 * every token that's been in a tracked Uniswap pool — broader than Chainlink,
 * narrower than DefiLlama, but **free with no external rate limits** (the
 * subgraph gateway has very generous quotas).
 *
 * Resolution is per-hour. With our 30-minute price-cache bucket, the nearest
 * hour boundary is at most 30 minutes off — well within `searchWidth`
 * tolerance for the orchestrator. For stable / large-cap tokens that's
 * indistinguishable; for volatile tokens it's still vastly better than the
 * daily granularity an alternative `tokenDayDatas` would offer.
 *
 * URLs come from the SINGLE per-integration `IntegrationConfig.subgraphUrl`
 * (the same deployment used for positions + current pricing — no separate
 * historical-price subgraph; we price live off one subgraph).
 * Integrations without a URL fall through to the next provider in the chain.
 * NOTE: for the live v4 aggregates path this provider is effectively dormant —
 * recompute is aggregates/current-price only, so historical pricing is never
 * invoked for v4 valuation; it exists for the deferred tx-time (vs-USD) toggle.
 */
@Injectable()
export class SubgraphHistoricalProvider extends BaseProvider {
  readonly name = 'subgraph-historical';
  readonly supportsCurrentBatch = false;
  readonly supportsHistoricalBatch = true;
  readonly skipsOrchestratorTimeout = true;
  readonly tier = 'primary' as const;
  readonly maxBatchSize: number;
  readonly singleConcurrency: number;
  readonly defaultBackoffMs = 30_000;

  /** `${chainId}:${protocol}` → resolved subgraph URL. */
  /**
   * Per `${chainId}:${protocol}`: the endpoint AND its dialect. The dialect must
   * travel with the URL because this provider keeps no AppConfigService after
   * construction.
   */
  private readonly urls: Map<string, SubgraphTarget>;
  /** Nearest-hour fallback window, in seconds. 0 disables the fallback. */
  private readonly nearestWindowSec: number;
  /** Max age (seconds) of a `first:1 desc` stale-fallback row. 0 disables. */
  private readonly staleFallbackSec: number;

  constructor(@Inject(AppConfigService) config: AppConfigService) {
    super({
      name: 'SubgraphHistoricalProvider',
      maxConcurrency: Math.max(1, config.historicalPriceSubgraphConcurrency),
      defaultBackoffMs: 30_000,
    });
    this.urls = new Map();
    for (const integration of config.enabledIntegrations) {
      if (integration.subgraphUrl) {
        this.urls.set(integrationKey(integration.chainId, integration.protocol), {
          chainId: integration.chainId,
          subgraphUrl: integration.subgraphUrl,
          dialect: integration.dialect,
          sources: integration.sources,
        });
      }
    }
    this.maxBatchSize = config.historicalPriceSubgraphBatchSize;
    this.singleConcurrency = Math.max(1, config.historicalPriceSubgraphConcurrency);
    this.nearestWindowSec = config.historicalPriceSubgraphNearestWindowHours * SECONDS_PER_HOUR;
    this.staleFallbackSec = config.historicalPriceSubgraphStaleFallbackHours * SECONDS_PER_HOUR;
    if (this.urls.size === 0) {
      this.logger.warn(
        'no subgraphUrl configured for any integration — historical provider disabled.',
      );
    } else {
      this.logger.log(
        `initialized with ${this.urls.size} integration(s): ${[...this.urls.keys()].join(', ')} (batchSize=${this.maxBatchSize}, concurrency=${this.singleConcurrency})`,
      );
    }
  }

  isEnabled(): boolean {
    return this.urls.size > 0;
  }

  async getCurrentSingle(): Promise<PriceQuote | null> {
    return null;
  }

  async getHistoricalSingle(req: HistoricalReq): Promise<PriceQuote | null> {
    const result = await this.getHistoricalBatch([req]);
    return result.get(providerHistoricalKey(req)) ?? null;
  }

  /**
   * Builds one paginated GraphQL query per `(chainId, protocol)` group,
   * covering all unique `(token, hourStart)` pairs in that group. The
   * subgraph returns matched rows; we map each back to the originating
   * request via `providerHistoricalKey`.
   */
  async getHistoricalBatch(requests: HistoricalReq[]): Promise<Map<string, PriceQuote>> {
    const result = new Map<string, PriceQuote>();
    if (requests.length === 0) return result;
    if (this.urls.size === 0) {
      this.logger.warn(`skip ${requests.length} requests: provider has no URLs configured`);
      this.recordOutcome('skip');
      return result;
    }
    if (!this.isAvailable()) {
      this.logger.warn(`skip ${requests.length} requests: provider currently rate-limited`);
      this.recordOutcome('skip');
      return result;
    }

    // Group requests by integration. A single batch can mix v3 and v4 hits
    // (or different chains in the future), but each subgraph deployment is
    // protocol-scoped, so we issue one paginated query per group.
    const byIntegration = new Map<string, HistoricalReq[]>();
    let droppedMissingMeta = 0;
    let droppedNoUrl = 0;
    for (const req of requests) {
      if (!req.timestamp || req.timestamp <= 0) {
        droppedMissingMeta += 1;
        continue;
      }
      if (!req.protocol) {
        droppedMissingMeta += 1;
        continue;
      }
      const key = integrationKey(req.chainId, req.protocol);
      if (!this.urls.has(key)) {
        droppedNoUrl += 1;
        continue;
      }
      const list = byIntegration.get(key);
      if (list) list.push(req);
      else byIntegration.set(key, [req]);
    }

    if (byIntegration.size === 0) {
      this.logger.warn(
        `skip ${requests.length} requests: 0 routable (droppedMissingMeta=${droppedMissingMeta}, droppedNoUrl=${droppedNoUrl}). Configured URLs: ${[...this.urls.keys()].join(', ') || '<none>'}`,
      );
      this.recordOutcome('skip');
      return result;
    }

    if (droppedMissingMeta > 0 || droppedNoUrl > 0) {
      this.logger.log(
        `routing ${requests.length} requests → ${byIntegration.size} integration(s) (droppedMissingMeta=${droppedMissingMeta}, droppedNoUrl=${droppedNoUrl})`,
      );
    }

    for (const [intKey, group] of byIntegration) {
      if (!this.isAvailable()) break;
      const target = this.urls.get(intKey);
      if (!target) continue;
      await this.fetchIntegrationGroup(intKey, target, group, result);
    }

    return result;
  }

  private async fetchIntegrationGroup(
    intKey: string,
    target: SubgraphTarget,
    group: HistoricalReq[],
    result: Map<string, PriceQuote>,
  ): Promise<void> {
    // Build unique token + hour sets for this integration. One hour boundary
    // can map to multiple 30-min buckets (e.g. 08:00 + 08:30 → hour 08:00),
    // so the per-pair store is an array — every matched row fans out to all
    // requests sharing that (token, hour) pair.
    //
    // The `hours` set is also expanded by ±nearestWindowSec so the single
    // `_in` query returns neighbour rows for low-volume tokens that didn't
    // trade exactly at the requested hour. We then pick the row with the
    // smallest `|periodStart - requestedHour|` per pair in the match loop.
    const tokens = new Set<string>();
    const hours = new Set<number>();
    const reqsByPair = new Map<string, HistoricalReq[]>();
    for (const req of group) {
      const address = req.address.toLowerCase();
      const hour = Math.floor(req.timestamp / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
      tokens.add(address);
      hours.add(hour);
      for (let delta = SECONDS_PER_HOUR; delta <= this.nearestWindowSec; delta += SECONDS_PER_HOUR) {
        hours.add(hour - delta);
        hours.add(hour + delta);
      }
      const pairKey = `${address}:${hour}`;
      const existing = reqsByPair.get(pairKey);
      if (existing) existing.push(req);
      else reqsByPair.set(pairKey, [req]);
    }
    if (tokens.size === 0 || hours.size === 0) return;

    // Partition tokens so multiple paginated `_in` queries run in parallel
    // — each slice holds its own slot via `fetchPartition`. With 500 tokens
    // and 10 partitions, wall-clock drops ~10x vs a single serial query.
    const tokenList = [...tokens];
    const targetPerPartition = 50;
    const partitionCount = Math.max(1, Math.min(this.singleConcurrency, Math.ceil(tokenList.length / targetPerPartition)));
    const partitionSize = Math.ceil(tokenList.length / partitionCount);
    const partitions: string[][] = [];
    for (let i = 0; i < tokenList.length; i += partitionSize) {
      partitions.push(tokenList.slice(i, i + partitionSize));
    }

    const rowsByToken = new Map<string, NearestRow[]>();
    const partitionResults = await Promise.all(
      partitions.map((partitionTokens) =>
        this.fetchPartition(target, intKey, partitionTokens, hours),
      ),
    );
    for (const partResult of partitionResults) {
      if (!partResult) continue;
      for (const [token, rows] of partResult.rowsByToken) {
        const existing = rowsByToken.get(token);
        if (existing) existing.push(...rows);
        else rowsByToken.set(token, rows);
      }
    }

    // Match phase: for each (token, requestedHour) pair, pick the row from
    // the same token with the smallest `|periodStart - requestedHour|`,
    // capped at `nearestWindowSec`. Exact-hour rows always win (dist=0).
    // No extra HTTP — the expanded `hours` set already brought neighbours
    // into the primary response.
    for (const [pairKey, reqs] of reqsByPair) {
      const [token, hourStr] = pairKey.split(':');
      if (!token || !hourStr) continue;
      const requestedHour = Number(hourStr);
      if (!Number.isFinite(requestedHour)) continue;
      const candidates = rowsByToken.get(token);
      if (!candidates || candidates.length === 0) continue;
      let best: NearestRow | null = null;
      let bestDist = Infinity;
      for (const c of candidates) {
        const dist = Math.abs(c.periodStart - requestedHour);
        if (dist > this.nearestWindowSec) continue;
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      if (!best) continue;
      for (const req of reqs) {
        result.set(providerHistoricalKey(req), { priceUsd: best.price });
        this.recordOutcome('success');
      }
    }

    // Stale fallback: per pair still unmatched, ask subgraph for the latest
    // `tokenHourData` row at-or-before the requested hour (`first: 1, desc`).
    // Accept it only when within `staleFallbackSec`. Cheap (one row per call)
    // and parallelised so total cost ≈ ceil(missedPairs / concurrency) RTT.
    if (this.staleFallbackSec > 0) {
      const stillMissed: Array<{ token: string; hour: number; reqs: HistoricalReq[] }> = [];
      for (const [pairKey, reqs] of reqsByPair) {
        const allHit = reqs.every((r) => result.has(providerHistoricalKey(r)));
        if (allHit) continue;
        const [token, hourStr] = pairKey.split(':');
        if (!token || !hourStr) continue;
        const hour = Number(hourStr);
        if (!Number.isFinite(hour)) continue;
        stillMissed.push({ token, hour, reqs });
      }
      if (stillMissed.length > 0) {
        await this.runStaleFallback(target, intKey, stillMissed, result);
      }
    }

    // Anything in reqsByPair not in result is a miss for this group.
    let missed = 0;
    for (const reqs of reqsByPair.values()) {
      for (const req of reqs) {
        if (!result.has(providerHistoricalKey(req))) missed += 1;
      }
    }
    for (let i = 0; i < missed; i += 1) this.recordOutcome('miss');
  }

  /**
   * Per-pair stale fallback. For each (token, requestedHour) pair still
   * unmatched, fire one `tokenHourDatas(first:1, desc, periodStartUnix_lte)`
   * call. If the returned row's hour is within `staleFallbackSec`, set its
   * price. Parallelised at `singleConcurrency` so e.g. 200 misses at conc=20
   * finish in ~10 × HTTP RTT.
   */
  private async runStaleFallback(
    target: SubgraphTarget,
    intKey: string,
    pairs: Array<{ token: string; hour: number; reqs: HistoricalReq[] }>,
    result: Map<string, PriceQuote>,
  ): Promise<void> {
    const query = `query LatestHourPrice($token: String!, $hourLte: Int!) {
  tokenHourDatas(
    first: 1,
    orderBy: periodStartUnix,
    orderDirection: desc,
    where: { token: $token, periodStartUnix_lte: $hourLte }
  ) {
    periodStartUnix
    priceUSD
  }
}`;
    const concurrency = Math.max(1, Math.min(this.singleConcurrency, pairs.length));
    let nextIndex = 0;
    let aborted = false;

    const worker = async (): Promise<void> => {
      while (!aborted) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= pairs.length) return;
        const pair = pairs[currentIndex];
        if (!pair) continue;
        if (!this.isAvailable()) { aborted = true; return; }
        await this.acquireSlot();
        try {
          const res = await this.graphqlJson<TokenHourDataResponse>(target.subgraphUrl, target, {
            query,
            variables: { token: pair.token, hourLte: pair.hour },
            bodyTimeoutMs: 20_000,
            headersTimeoutMs: 20_000,
          });
          if (res.statusCode === 429 || res.statusCode >= 500) {
            this.markRateLimited(res.retryAfterMs, res.statusCode);
            aborted = true;
            return;
          }
          if (res.statusCode !== 200 || !res.data) return;
          if (res.data.errors && res.data.errors.length > 0) {
            this.logger.warn(
              `stale-fallback ${intKey} ${pair.token}: GraphQL errors: ${res.data.errors.map((e) => e.message).join('; ')}`,
            );
            return;
          }
          const row = res.data.data?.tokenHourDatas?.[0];
          if (!row) return;
          const periodStart = Number(row.periodStartUnix);
          const price = Number(row.priceUSD ?? 0);
          if (!Number.isFinite(periodStart) || periodStart <= 0) return;
          if (!Number.isFinite(price) || price <= 0) return;
          if (pair.hour - periodStart > this.staleFallbackSec) return;
          for (const req of pair.reqs) {
            const key = providerHistoricalKey(req);
            if (result.has(key)) continue;
            result.set(key, { priceUsd: price });
            this.recordOutcome('success');
          }
        } finally {
          this.releaseSlot();
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  /**
   * Paginate `tokenHourDatas` for a single token-partition. Holds one slot
   * for the duration of the run (each page is sequential due to `id_gt`
   * cursor pagination). Returns rows grouped by token for the caller to
   * fold into the per-integration map.
   */
  private async fetchPartition(
    target: SubgraphTarget,
    intKey: string,
    partitionTokens: string[],
    hours: Set<number>,
  ): Promise<{ rowsByToken: Map<string, NearestRow[]>; rowCount: number; pages: number } | null> {
    if (partitionTokens.length === 0 || hours.size === 0) {
      return { rowsByToken: new Map(), rowCount: 0, pages: 0 };
    }
    const PAGE_SIZE = 1000;
    const query = `query TokenHourPrices($tokens: [String!]!, $hours: [Int!]!, $first: Int!, $lastId: String!) {
  tokenHourDatas(
    first: $first,
    orderBy: id,
    orderDirection: asc,
    where: { token_in: $tokens, periodStartUnix_in: $hours, id_gt: $lastId }
  ) {
    id
    periodStartUnix
    priceUSD
    token { id }
  }
}`;
    await this.acquireSlot();
    try {
      const rowsByToken = new Map<string, NearestRow[]>();
      let lastId = '';
      let rowCount = 0;
      let pages = 0;
      const hoursArr = [...hours];
      while (true) {
        pages += 1;
        const res = await this.graphqlJson<TokenHourDataResponse>(target.subgraphUrl, target, {
          query,
          variables: { tokens: partitionTokens, hours: hoursArr, first: PAGE_SIZE, lastId },
          bodyTimeoutMs: 20_000,
          headersTimeoutMs: 20_000,
        });
        if (res.statusCode === 429 || res.statusCode >= 500) {
          this.logger.warn(
            `tokenHourDatas ${intKey}: rate-limited/server-error ${res.statusCode} (page=${pages}, tokens=${partitionTokens.length}, hours=${hoursArr.length}). Backing off.`,
          );
          this.markRateLimited(res.retryAfterMs, res.statusCode);
          return null;
        }
        if (res.statusCode !== 200 || !res.data) {
          this.logger.warn(
            `tokenHourDatas ${intKey}: HTTP ${res.statusCode} (page=${pages}). Likely bad URL or missing API key.`,
          );
          this.recordOutcome('error');
          return null;
        }
        if (res.data.errors && res.data.errors.length > 0) {
          this.logger.warn(
            `tokenHourDatas ${intKey}: GraphQL errors (page=${pages}): ${res.data.errors.map((e) => e.message).join('; ')}`,
          );
          this.recordOutcome('error');
          return null;
        }
        const rows = res.data.data?.tokenHourDatas ?? [];
        for (const row of rows) {
          const tokenId = row.token?.id?.toLowerCase();
          if (!tokenId) continue;
          const periodStart = Number(row.periodStartUnix);
          if (!Number.isFinite(periodStart) || periodStart <= 0) continue;
          const price = Number(row.priceUSD ?? 0);
          if (!Number.isFinite(price) || price <= 0) continue;
          const list = rowsByToken.get(tokenId);
          if (list) list.push({ periodStart, price });
          else rowsByToken.set(tokenId, [{ periodStart, price }]);
        }
        rowCount += rows.length;
        if (rows.length < PAGE_SIZE) break;
        const tailId = rows[rows.length - 1]?.id;
        if (!tailId || tailId === lastId) break;
        lastId = tailId;
        if (rowCount >= 200_000) {
          this.logger.warn(
            `tokenHourDatas pagination sanity cap hit at ${rowCount} rows for ${intKey} partition`,
          );
          break;
        }
      }
      return { rowsByToken, rowCount, pages };
    } finally {
      this.releaseSlot();
    }
  }
}

function integrationKey(chainId: number, protocol: string): string {
  return `${chainId}:${protocol}`;
}

interface NearestRow { periodStart: number; price: number }

