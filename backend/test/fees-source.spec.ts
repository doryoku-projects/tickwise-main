/*
 * The uncollected-fee freshness key and its label, end to end:
 *   indexer `lastModifyBlock` → POSITION_FIELDS → the hyperindex schema map →
 *   EnvioAdapter.normalize (`chooseUncollected`, with a zeroed indexer figure
 *   since the indexer stopped computing uncollected fees) → the stored document
 *   (`upsertMany`) → /api and /v1 list + detail (`metrics.feesSource`,
 *   `metrics.feesMeasuredAt`) — plus the live listener feeding the dirty set.
 */
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { PositionSchema } from '../src/database/schemas/position.schema.js';
import { SyncCursorSchema } from '../src/database/schemas/sync-cursor.schema.js';
import type { PriceResult, PricingService } from '../src/pricing/pricing.service.js';
import { EnvioAdapter } from '../src/subgraph/adapters/envio.adapter.js';
import type { IntegrationConfig } from '../src/config/integrations.config.js';
import type { NormalizedPosition } from '../src/subgraph/normalized-position.js';
import type { RpcFees } from '../src/sync/position-fee-math.js';
import { translate } from '../src/subgraph/hyperindex/translate.js';
import { PositionsRepository } from '../src/database/positions.repository.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { LeaderboardCountService } from '../src/leaderboard/count-cache.js';

const CHAIN = 4663;
const INTEGRATION: IntegrationConfig = {
  chainId: CHAIN,
  protocol: 'uniswap-v4',
  enabled: true,
  subgraphUrl: 'https://example.com/v1/graphql',
};
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const POOL_ID = `0x${'d7'.repeat(32)}`;
const SQRT_1_X96 = String(1n << 96n);

describe('lastModifyBlock reaches the adapter', () => {
  const source = readFileSync('src/subgraph/adapters/envio.adapter.ts', 'utf8');
  const fields = /const POSITION_FIELDS = `([\s\S]*?)`;/.exec(source)![1]!;

  it('is selected by every position query (POSITION_FIELDS)', () => {
    expect(fields.split(/\s+/)).toContain('lastModifyBlock');
  });

  // The translator validates every selected column against the schema map, so
  // a column missing there throws — for EVERY position fetch, not just this one.
  it('translates through the real hyperindex schema map', () => {
    const p = translate(`query P { positions(first: 1) { ${fields} } }`, {}, CHAIN);
    expect(p.query).toContain('lastModifyBlock');
    expect(p.query).toContain('updatedAtBlock');
  });
});

describe('the dropped indexer fee fields are never selected', () => {
  // The indexer no longer carries the fee sweep's outputs, and Hasura rejects the
  // WHOLE query when a selected field does not exist — so one stray name here
  // fails every position fetch the moment the indexer is switched.
  const source = readFileSync('src/subgraph/adapters/envio.adapter.ts', 'utf8');
  const fields = /const POSITION_FIELDS = `([\s\S]*?)`;/.exec(source)![1]!.split(/\s+/);
  const DROPPED = ['totalFeesUncollected0', 'totalFeesUncollected1', 'feesUpdatedAtBlock', 'feesUpdatedAtTimestamp'];

  it('POSITION_FIELDS names none of them, and still selects the change feed and the settle block', () => {
    for (const name of DROPPED) expect(fields, name).not.toContain(name);
    expect(fields).toContain('updatedAtBlock');
    expect(fields).toContain('lastModifyBlock');
    expect(fields).toContain('totalFeesCollected0');
  });

  it('the schema map rejects each of them, so a stray selection fails in translation, not upstream', () => {
    for (const name of DROPPED) {
      expect(() => translate(`query P { positions(first: 1) { id ${name} } }`, {}, CHAIN), name).toThrow(/does not exist on Position/);
    }
  });
});

function adapter() {
  const prices: PriceResult = {
    token0Usd: 1,
    token1Usd: 2000,
    source: 'orchestrated' as PriceResult['source'],
    usedFallback: false,
    token0Confidence: 'anchor',
    token1Confidence: 'anchor',
  };
  return new EnvioAdapter(
    { pricePool: async () => prices, prefetchPrices: async () => undefined } as unknown as PricingService,
    { findByIds: async () => [] } as never,
    { minRealMarketBackingUsd: 1000 } as never,
  );
}

function raw(over: Record<string, unknown> = {}) {
  return {
    chainId: CHAIN,
    tokenId: '3468131',
    owner: '0xowner',
    poolId: POOL_ID,
    tickLower: -600,
    tickUpper: 600,
    liquidity: '50000000000000000',
    isActive: true,
    isPriceable: true,
    createdAtTimestamp: '1790770383',
    createdAtBlockNumber: '76707000',
    closedAtTimestamp: null,
    depositedToken0: 1000,
    depositedToken1: 0.5,
    withdrawnToken0: 0,
    withdrawnToken1: 0,
    totalFeesCollected0: 0,
    totalFeesCollected1: 0,
    amount0: 1000,
    amount1: 0.5,
    totalGasCostETH: 0.0001,
    updatedAtBlock: '77236915',
    updatedAtTimestamp: '1790800000',
    lastModifyBlock: '77236915',
    ...over,
  };
}

async function normalize(row: Record<string, unknown>, rpc?: RpcFees): Promise<NormalizedPosition> {
  const pools = new Map([
    [POOL_ID, { id: POOL_ID, name: 'USDC/WETH', fee: 500, tickSpacing: 10, tick: 0, sqrtPriceX96: SQRT_1_X96, token0Id: USDC, token1Id: WETH }],
  ]);
  const tokens = new Map([
    [USDC, { id: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, verified: true }],
    [WETH, { id: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, verified: true }],
  ]);
  const stats = new Map([
    [POOL_ID, { id: POOL_ID, totalValueLockedUSD: '5000000', totalValueLockedToken0: '2500000', totalValueLockedToken1: '1250', volumeUSD: '1000000', feesUSD: '3000' }],
  ]);
  const rpcFees = new Map(rpc ? [['3468131', rpc]] : []);
  return (adapter() as unknown as {
    normalize: (...args: unknown[]) => Promise<NormalizedPosition>;
  }).normalize(row, INTEGRATION, pools, tokens, stats, rpcFees);
}

describe('normalize labels the served figure', () => {
  const at = new Date('2026-10-01T10:00:00Z');

  it('serves a measurement taken after the last modify as onchain, with its time, and stores lastModifyBlock', async () => {
    const pos = await normalize(raw(), { fees0: 9.5, fees1: 0.001, block: 77_300_000, at });
    expect(pos.amounts.totalFeesUncollected0).toBe('9.5');
    expect(pos.metrics.pendingFeesUsd).toBeCloseTo(9.5 + 0.001 * 2000, 6);
    expect(pos.metrics.feesSource).toBe('onchain');
    expect(pos.metrics.feesMeasuredAt).toBe(at);
    expect(pos.lastModifyBlock).toBe(77_236_915);
  });

  it('Transfer case: updatedAtBlock past the measurement, lastModifyBlock before it → still onchain', async () => {
    const pos = await normalize(raw({ updatedAtBlock: '77400000' }), { fees0: 9.5, fees1: 0, block: 77_300_000, at });
    expect(pos.metrics.feesSource).toBe('onchain');
    expect(pos.amounts.totalFeesUncollected0).toBe('9.5');
  });

  it('a modify after the measurement → 0, labelled unmeasured (dashboard: Pending)', async () => {
    const pos = await normalize(raw({ lastModifyBlock: '77400000', updatedAtBlock: '77400000' }), {
      fees0: 9.5,
      fees1: 0,
      block: 77_300_000,
      at,
    });
    expect(pos.amounts.totalFeesUncollected0).toBe('0');
    expect(pos.metrics.feesSource).toBe('unmeasured');
    expect(pos.metrics.feesMeasuredAt).toBeNull();
  });

  it('a closed position (no liquidity) is settled at 0 — never "Pending" forever', async () => {
    // Closing is a modify: lastModifyBlock is the close, past every measurement,
    // and the fee job never re-reads an inactive row.
    const pos = await normalize(raw({ liquidity: '0', isActive: false, lastModifyBlock: '77400000' }), {
      fees0: 9.5,
      fees1: 0,
      block: 77_300_000,
      at,
    });
    expect(pos.isActive).toBe(false);
    expect(pos.metrics.feesSource).toBe('settled');
    expect(pos.amounts.totalFeesUncollected0).toBe('0');
    expect(pos.metrics.pendingFeesUsd).toBe(0);
  });

  it('never measured → unmeasured at 0, and the label `indexer` is never returned', async () => {
    const none = await normalize(raw());
    expect(none.metrics.feesSource).toBe('unmeasured');
    expect(none.amounts.totalFeesUncollected0).toBe('0');
    expect(none.metrics.pendingFeesUsd).toBe(0);
    // A row from an indexer that still carries the old sweep's columns is served
    // 0 too: nothing reads them (the backend does not even select them).
    const legacy = await normalize(
      raw({ feesUpdatedAtBlock: '77300000', totalFeesUncollected0: 4, totalFeesUncollected1: 1 }),
    );
    expect(legacy.metrics.feesSource).toBe('unmeasured');
    expect(legacy.amounts.totalFeesUncollected0).toBe('0');
    expect(legacy.amounts.totalFeesUncollected1).toBe('0');
    expect(legacy.metrics.pendingFeesUsd).toBe(0);
  });
});

describe('the schema declares the new fields', () => {
  // Mongoose `strict` SILENTLY drops an undeclared path — on a document and on
  // a `$set` alike — so an undeclared field would look written and store nothing.
  const Model = mongoose.model('W5FeesSourceSchemaProbe', PositionSchema);

  it('keeps metrics.feesSource / feesMeasuredAt and top-level lastModifyBlock', () => {
    const at = new Date('2026-10-01T10:00:00Z');
    const doc = new Model({ lastModifyBlock: 77_236_915, metrics: { feesSource: 'onchain', feesMeasuredAt: at } });
    expect(doc.lastModifyBlock).toBe(77_236_915);
    expect(doc.metrics.feesSource).toBe('onchain');
    expect(doc.metrics.feesMeasuredAt).toEqual(at);
  });

  it('rejects a label outside the published vocabulary, and declares no default', () => {
    const bad = new Model({ metrics: { feesSource: 'rpc' } });
    expect(bad.validateSync()?.errors['metrics.feesSource']).toBeDefined();
    const settled = new Model({ metrics: { feesSource: 'settled' } });
    expect(settled.validateSync()?.errors?.['metrics.feesSource']).toBeUndefined();
    expect(new Model({ metrics: {} }).metrics.feesSource).toBeUndefined();
    expect(new Model({}).lastModifyBlock).toBeUndefined();
  });

  it('declares the sync_cursors tier fields', () => {
    const paths = Object.keys(SyncCursorSchema.paths);
    for (const p of ['feeCursorHot', 'feeHotStartedAt', 'feeHotFinishedAt', 'feeCursorAll', 'feeAllStartedAt', 'feeAllFinishedAt']) {
      expect(paths, p).toContain(p);
    }
  });
});

describe('the label is stored and served', () => {
  it('upsertMany $sets lastModifyBlock and metrics.feesSource / feesMeasuredAt', async () => {
    const at = new Date('2026-10-01T10:00:00Z');
    const pos = await normalize(raw(), { fees0: 9.5, fees1: 0, block: 77_300_000, at });
    const bulkWrite = vi.fn(async () => ({ upsertedCount: 1, modifiedCount: 0 }));
    const model = {
      find: () => ({ lean: async () => [] }),
      bulkWrite,
    };
    const repo = new PositionsRepository({ positionModel: () => model } as never, {} as never);
    await repo.upsertMany([pos]);
    const op = (bulkWrite.mock.calls[0] as unknown as [Array<{ updateOne: { update: { $set: Record<string, unknown> } } }>])[0][0];
    const set = op.updateOne.update.$set as { lastModifyBlock: number; metrics: Record<string, unknown> };
    expect(set.lastModifyBlock).toBe(77_236_915);
    expect(set.metrics.feesSource).toBe('onchain');
    expect(set.metrics.feesMeasuredAt).toBe(at);
  });

  function stored() {
    return {
      chainId: CHAIN,
      protocol: 'uniswap-v4',
      positionId: '3468131',
      tokenId: '3468131',
      owner: '0xowner',
      poolId: POOL_ID,
      token0: { address: USDC, symbol: 'USDC', decimals: 6, verified: true, priceUsd: 1 },
      token1: { address: WETH, symbol: 'WETH', decimals: 18, verified: true, priceUsd: 2000 },
      isActive: true,
      lastModifyBlock: 77_236_915,
      rpcFeesBlock: 77_300_000,
      amounts: { amount0: '1000', amount1: '0.5' },
      metrics: {
        underlyingValueUsd: 2000,
        isPriceable: true,
        pendingFeesUsd: 9.5,
        feesSource: 'onchain',
        feesMeasuredAt: new Date('2026-10-01T10:00:00Z'),
      },
      poolStats: { tvlUsd: 5_000_000, tvlUsdUntracked: 5_000_000, volumeUsd: 1_000_000, totalFeesUsd: 3000 },
      pricing: { source: 'orchestrated', usedFallback: false },
    };
  }

  function service(positions: Record<string, unknown>) {
    return new LeaderboardService(
      {
        isSupportedChain: () => true,
        isSupportedProtocol: () => true,
        getIntegration: () => INTEGRATION,
        leaderboardCountCap: 25_000,
        enabledIntegrations: [INTEGRATION],
      } as never,
      positions as never,
      { findForPosition: async () => [] } as never,
      { resolve: () => ({ recomputeMode: 'aggregates', fetchPositionTransactions: async () => ({ transactions: [] }) }) } as never,
      new LeaderboardCountService(),
    );
  }

  it('list rows carry metrics.feesSource and metrics.feesMeasuredAt; internal watermarks stay internal', async () => {
    const svc = service({ findLeaderboard: async () => ({ positions: [stored()], hasMore: false, cache: 'hit' }) });
    const res = await svc.getTopPositions({ chainId: CHAIN, protocol: 'uniswap-v4', page: 1, limit: 25 } as never);
    expect(res.positions[0].metrics).toMatchObject({ feesSource: 'onchain', feesMeasuredAt: new Date('2026-10-01T10:00:00Z') });
    expect(res.positions[0]).not.toHaveProperty('lastModifyBlock');
    expect(res.positions[0]).not.toHaveProperty('rpcFeesBlock');
  });

  it('detail carries them too; lastModifyBlock is not in the detail allow-list', async () => {
    const svc = service({ findOneForRead: async () => stored() });
    const detail = (await svc.getPosition(CHAIN, 'uniswap-v4', '3468131')) as Record<string, unknown>;
    expect(detail.metrics).toMatchObject({ feesSource: 'onchain' });
    expect(detail).not.toHaveProperty('lastModifyBlock');
    expect(detail).not.toHaveProperty('rpcFeesBlock');
  });
});
