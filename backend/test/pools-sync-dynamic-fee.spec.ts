import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A dynamic-fee pool's fee figures are served as the indexer reports them.
 *
 * The pools sync used to zero `feesUsd24h` / `feesUsd7d` and omit `feesUsdTotal`
 * for any pool whose `feeTier` was the 0x800000 flag, because the OLD indexer
 * priced each swap at the previous swap's `pool.feeTier` and so booked the first
 * swap of a dynamic pool at 838.8608% of its volume. The indexer now prices each
 * swap at its own fee (`event.params.fee`) and leaves `Pool.feeTier` alone: a
 * dynamic pool keeps the flag (the "dynamic" label) and its `feesUSD` is real, so
 * the zeroing would hide correct figures and is gone.
 *
 * What must NOT change with it: the pool still reads as dynamic (`fee` stays the
 * flag; `isDynamicFee` in the pools service), and the honeypot static-fee rule
 * never fires for it (a flag is not a 838.86% static fee).
 */

let universe: Array<Record<string, unknown>> = [];
let dayRows: Map<string, Array<{ date: string; volumeUSD: string; feesUSD: string; tvlUSD: string }>> = new Map();

vi.mock('../src/subgraph/request-retry.js', () => ({
  requestWithRetry: async (_client: unknown, query: unknown, vars: Record<string, unknown>) => {
    const text = String(query);
    if (text.includes('PoolDayMax')) return { poolDayDatas: [{ date: '1000000' }] };
    if (text.includes('PoolDayBatch')) {
      const ids = vars.ids as string[];
      return {
        poolDayDatas: ids.flatMap((id) => (dayRows.get(id) ?? []).map((r) => ({ ...r, pool: { id } }))),
      };
    }
    const where = (vars.where ?? {}) as { id_gt?: string };
    return { pools: universe.filter((p) => where.id_gt === undefined || String(p.id) > where.id_gt) };
  },
}));

import type { PoolUpsert } from '../src/database/pools.repository.js';
import { DYNAMIC_FEE_FLAG, isHoneypotStaticFee } from '../src/common/pool-fee.js';
import { PoolsSyncService } from '../src/sync/pools-sync.service.js';

const DYNAMIC = 8_388_608;

/** Two chain-1 ANCHOR legs (USDC / WETH) so the pool is priced, not stubbed as risky. */
function poolRow(id: string, feeTier: number) {
  return {
    id,
    token0: { id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: '6' },
    token1: { id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: '18' },
    feeTier: String(feeTier),
    tickSpacing: '60',
    tick: '10',
    sqrtPrice: '79228162514264337593543950336',
    liquidity: '1000',
    createdAtTimestamp: '1700000000',
    totalValueLockedToken0: '1',
    totalValueLockedToken1: '2',
    totalValueLockedUSD: '0',
    volumeUSD: '1000000',
    feesUSD: '1234.5',
    txCount: '3',
    token0Price: '1',
    token1Price: '1',
  };
}

async function sync(): Promise<PoolUpsert[]> {
  const written: PoolUpsert[] = [];
  const repo = {
    upsertMany: async (pools: PoolUpsert[]) => {
      written.push(...pools);
      return { written: pools.length, unchanged: 0, hashReads: 0 };
    },
  };
  const config = {
    getIntegration: () => ({ chainId: 1, protocol: 'uniswap-v4', subgraphUrl: 'http://indexer.test/graphql' }),
    poolsSyncIntervalMs: 6 * 3_600_000,
  };
  // Anchor legs: a priced pool's trusted TVL is reserve0 × 1 + reserve1 × 2,000 = 4,001.
  const pricing = {
    pricePool: async () => ({ token0Usd: 1, token1Usd: 2_000, source: 'test', usedFallback: false, token0Confidence: 'anchor', token1Confidence: 'anchor' }),
  };
  const syncRepo = { recordPoolWalk: async () => undefined };
  const svc = new PoolsSyncService(config as never, repo as never, pricing as never, syncRepo as never);
  (svc as unknown as { logger: unknown }).logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  await svc.syncPools(1, 'uniswap-v4');
  return written;
}

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

beforeEach(() => {
  universe = [];
  dayRows = new Map();
});

describe('pools sync: dynamic-fee pool fee metrics', () => {
  it('serves a dynamic pool\'s day, week and lifetime fees as reported, and keeps the flag as its fee', async () => {
    universe = [poolRow(id(1), DYNAMIC)];
    dayRows.set(id(1), [
      { date: '1000000', volumeUSD: '40000', feesUSD: '120', tvlUSD: '4001' },
      { date: '913600', volumeUSD: '30000', feesUSD: '90', tvlUSD: '4001' },
    ]);

    const [pool] = await sync();

    expect(pool!.fee).toBe(DYNAMIC); // the label's input: never rewritten to a swap fee
    expect(pool!.metrics.feesUsd24h).toBe(120);
    expect(pool!.metrics.feesUsd7d).toBe(210);
    expect(pool!.metrics.feesUsdTotal).toBe(1234.5);
    expect(pool!.metrics.volumeUsd24h).toBe(40_000);
    expect(pool!.metrics.volumeUsd7d).toBe(70_000);
    // 120 × 365 / 4,001 × 100 — the same formula every pool gets.
    expect(pool!.metrics.feeApr).toBeCloseTo((120 * 365 * 100) / 4_001, 6);
  });

  it('is not special-cased: a static pool with the same figures is served identically', async () => {
    universe = [poolRow(id(1), DYNAMIC), poolRow(id(2), 3000)];
    for (const pid of [id(1), id(2)]) {
      dayRows.set(pid, [{ date: '1000000', volumeUSD: '40000', feesUSD: '120', tvlUSD: '4001' }]);
    }

    const out = await sync();
    const dynamic = out.find((p) => p.poolId === id(1))!;
    const fixed = out.find((p) => p.poolId === id(2))!;

    expect(fixed.fee).toBe(3000);
    expect(dynamic.metrics).toEqual(fixed.metrics);
  });

  it('never flags a dynamic pool as a honeypot-fee pool', async () => {
    universe = [poolRow(id(1), DYNAMIC)];

    const [pool] = await sync();

    expect(isHoneypotStaticFee(DYNAMIC_FEE_FLAG)).toBe(false);
    expect(pool!.pricing.usedFallback).toBe(false); // the risky stamp the default Pools page hides
    expect(pool!.metrics.tvlUsd).toBeGreaterThan(0);
  });
});
