import { describe, expect, it, vi } from 'vitest';
import { PositionsRepository } from '../src/database/positions.repository.js';
import type { NormalizedPosition } from '../src/subgraph/normalized-position.js';

/**
 * Build a fake resolver that returns a unique mock model per (chainId, protocol)
 * pair. Lets the test verify that mixed-protocol bulk writes get routed to the
 * correct per-shard model.
 */
function makeResolver() {
  const models = new Map<string, ReturnType<typeof makeMockModel>>();
  function getOrCreate(chainId: number, protocol: string) {
    const key = `${chainId}:${protocol}`;
    let model = models.get(key);
    if (!model) {
      model = makeMockModel();
      models.set(key, model);
    }
    return model;
  }
  const resolver = {
    positionModel: (chainId: number, protocol: string) => getOrCreate(chainId, protocol),
    transactionModel: (chainId: number, protocol: string) => getOrCreate(chainId, protocol),
    priceModel: (chainId: number) => getOrCreate(chainId, '__price__'),
    transactionCollectionName: () => 'position_transactions',
    positionCollectionName: () => 'positions',
    priceCollectionName: () => 'token_price_historical',
  };
  return { resolver, models };
}

function makeMockModel(existingRows: Record<string, unknown>[] = []) {
  const find = vi.fn(() => ({ lean: vi.fn(async () => existingRows) }));
  return {
    bulkWrite: vi.fn(async () => ({ upsertedCount: 1, modifiedCount: 0 })),
    find,
  };
}

function position(partial: Partial<NormalizedPosition>): NormalizedPosition {
  return {
    chainId: partial.chainId ?? 1,
    protocol: partial.protocol ?? 'uniswap-v4',
    positionId: partial.positionId ?? '1',
    tokenId: partial.tokenId ?? '1',
    owner: '0x',
    poolId: '0x',
    token0: { address: '0x', decimals: 18, symbol: 'A', priceUsd: 0 } as never,
    token1: { address: '0x', decimals: 18, symbol: 'B', priceUsd: 0 } as never,
    fee: 0,
    tickSpacing: 0,
    tickLower: 0,
    tickUpper: 0,
    currentTick: 0,
    sqrtPriceX96: '0',
    liquidity: '0',
    isActive: true,
    createdAtTimestamp: 0,
    closedAtTimestamp: null,
    amounts: {} as never,
    metrics: {} as never,
    poolStats: {} as never,
    pricing: {} as never,
    rawSubgraph: {},
    ...partial,
  } as NormalizedPosition;
}

describe('PositionsRepository sharded routing', () => {
  it('dispatches one bulk write per (chainId, protocol) in a mixed upsertMany', async () => {
    const { resolver, models } = makeResolver();
    const repo = new PositionsRepository(resolver as never);

    await repo.upsertMany([
      position({ chainId: 1, protocol: 'uniswap-v4', positionId: 'a' }),
      position({ chainId: 1, protocol: 'uniswap-v3', positionId: 'b' }),
      position({ chainId: 1, protocol: 'uniswap-v4', positionId: 'c' }),
      position({ chainId: 137, protocol: 'uniswap-v4', positionId: 'd' }),
    ]);

    const v4Eth = models.get('1:uniswap-v4');
    const v3Eth = models.get('1:uniswap-v3');
    const v4Polygon = models.get('137:uniswap-v4');
    expect(v4Eth?.bulkWrite).toHaveBeenCalledTimes(1);
    expect(v3Eth?.bulkWrite).toHaveBeenCalledTimes(1);
    expect(v4Polygon?.bulkWrite).toHaveBeenCalledTimes(1);

    // V4 eth got 2 ops (positionId a + c).
    expect(v4Eth?.bulkWrite.mock.calls[0]?.[0]).toHaveLength(2);
    // V3 eth got 1 op.
    expect(v3Eth?.bulkWrite.mock.calls[0]?.[0]).toHaveLength(1);
    // V4 polygon got 1 op.
    expect(v4Polygon?.bulkWrite.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it('only touches models for chains/protocols actually present in the batch', async () => {
    const { resolver, models } = makeResolver();
    const repo = new PositionsRepository(resolver as never);

    await repo.upsertMany([position({ chainId: 1, protocol: 'uniswap-v4', positionId: 'a' })]);

    expect(models.get('1:uniswap-v4')?.bulkWrite).toHaveBeenCalledTimes(1);
    expect(models.get('1:uniswap-v3')).toBeUndefined();
    expect(models.get('137:uniswap-v4')).toBeUndefined();
  });
});

describe('PositionsRepository keep-last-known-price guard', () => {
  const tokenA = { address: '0xaaa', decimals: 18, symbol: 'TKA', verified: true } as never;
  const tokenB = { address: '0xbbb', decimals: 18, symbol: 'TKB', verified: true } as never;

  function priceFromBulkWrite(model: ReturnType<typeof makeMockModel>) {
    const op = (model.bulkWrite.mock.calls[0]?.[0] as Array<{ updateOne: { update: { $set: { token0: { priceUsd: number }; token1: { priceUsd: number } } } } }>)?.[0];
    return {
      token0: op?.updateOne.update.$set.token0.priceUsd,
      token1: op?.updateOne.update.$set.token1.priceUsd,
    };
  }

  it('retains previous positive priceUsd when incoming snapshot is 0 (provider failure)', async () => {
    const { resolver, models } = makeResolver();
    // Seed model with an existing position row that has known-good prices.
    models.set('1:uniswap-v4', makeMockModel([
      { chainId: 1, protocol: 'uniswap-v4', positionId: '40', isActive: true, token0: { priceUsd: 75000 }, token1: { priceUsd: 1 } },
    ]));
    const repo = new PositionsRepository(resolver as never);

    // Incoming snapshot has priceUsd=0 on both sides (provider fan-out failed).
    await repo.upsertMany([
      position({ positionId: '40', token0: { ...tokenA, priceUsd: 0 }, token1: { ...tokenB, priceUsd: 0 } }),
    ]);

    const prices = priceFromBulkWrite(models.get('1:uniswap-v4')!);
    expect(prices.token0).toBe(75000);
    expect(prices.token1).toBe(1);
  });

  it('does not retain previous positive priceUsd for an unverified token', async () => {
    const { resolver, models } = makeResolver();
    models.set('1:uniswap-v4', makeMockModel([
      { chainId: 1, protocol: 'uniswap-v4', positionId: '40', isActive: true, token0: { priceUsd: 75000 }, token1: { priceUsd: 1.25 } },
    ]));
    const repo = new PositionsRepository(resolver as never);

    await repo.upsertMany([
      position({
        positionId: '40',
        token0: { ...tokenA, priceUsd: 0 },
        token1: { address: '0xbbb', decimals: 18, symbol: 'TKB', verified: false, priceUsd: 0 } as never,
      }),
    ]);

    const prices = priceFromBulkWrite(models.get('1:uniswap-v4')!);
    expect(prices.token0).toBe(75000);
    expect(prices.token1).toBe(0);
  });

  it('lets a positive incoming priceUsd overwrite the stored value (normal refresh)', async () => {
    const { resolver, models } = makeResolver();
    models.set('1:uniswap-v4', makeMockModel([
      { chainId: 1, protocol: 'uniswap-v4', positionId: '40', isActive: true, token0: { priceUsd: 74000 }, token1: { priceUsd: 0.99 } },
    ]));
    const repo = new PositionsRepository(resolver as never);

    await repo.upsertMany([
      position({ positionId: '40', token0: { ...tokenA, priceUsd: 75500 }, token1: { ...tokenB, priceUsd: 1.01 } }),
    ]);

    const prices = priceFromBulkWrite(models.get('1:uniswap-v4')!);
    expect(prices.token0).toBe(75500);
    expect(prices.token1).toBe(1.01);
  });

  it('writes 0 as-is on first insert when there is no previous row', async () => {
    const { resolver, models } = makeResolver();
    // No existing rows seeded — `find()` returns [].
    const repo = new PositionsRepository(resolver as never);

    await repo.upsertMany([
      position({ positionId: '40', token0: { ...tokenA, priceUsd: 0 }, token1: { ...tokenB, priceUsd: 0 } }),
    ]);

    const prices = priceFromBulkWrite(models.get('1:uniswap-v4')!);
    expect(prices.token0).toBe(0);
    expect(prices.token1).toBe(0);
  });

  it('preserves one side independently — incoming 0 + previous>0 on token0, fresh value on token1', async () => {
    const { resolver, models } = makeResolver();
    models.set('1:uniswap-v4', makeMockModel([
      { chainId: 1, protocol: 'uniswap-v4', positionId: '40', isActive: true, token0: { priceUsd: 75000 }, token1: { priceUsd: 0 } },
    ]));
    const repo = new PositionsRepository(resolver as never);

    await repo.upsertMany([
      position({ positionId: '40', token0: { ...tokenA, priceUsd: 0 }, token1: { ...tokenB, priceUsd: 1.5 } }),
    ]);

    const prices = priceFromBulkWrite(models.get('1:uniswap-v4')!);
    expect(prices.token0).toBe(75000); // preserved
    expect(prices.token1).toBe(1.5);   // fresh wins
  });

  it('preserves a configured anchor token (USDC) even when the verified flag is missing/false', async () => {
    const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const { resolver, models } = makeResolver();
    models.set('1:uniswap-v4', makeMockModel([
      { chainId: 1, protocol: 'uniswap-v4', positionId: '40', isActive: true, token0: { priceUsd: 75000 }, token1: { priceUsd: 1 } },
    ]));
    const repo = new PositionsRepository(resolver as never);

    // Mis-flagged: USDC marked unverified by upstream metadata. Anchor policy
    // overrides the verified gate so its previous $1 is still preserved.
    await repo.upsertMany([
      position({
        positionId: '40',
        token0: { ...tokenA, priceUsd: 0 },
        token1: { address: USDC, decimals: 6, symbol: 'USDC', verified: false, priceUsd: 0 } as never,
      }),
    ]);

    const prices = priceFromBulkWrite(models.get('1:uniswap-v4')!);
    expect(prices.token0).toBe(75000);
    expect(prices.token1).toBe(1); // preserved despite verified=false because USDC is a configured anchor
  });
});
