/*
 * P3.1 end to end inside this package's reach: package E's tokenId walk with
 * the REAL FeeMeasurer bound as its PageFeeReader (over a fake StateView), so
 * a freshly walked active row leaves normalize with `feesSource: 'onchain'`
 * and the rpcFees* stamp of THIS reading — the multicall, the head pin and
 * the decimals exactly as the fee job would have produced them.
 */
import type { PublicClient } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexer } from '../backfill/fake-indexer.js';
import { Q128, fakeClient } from '../fee-refresh-harness.js';
import { formatUnits } from 'viem';
import { toRaw } from '../../src/sync/fee-candidate-store.js';

let indexer = new FakeIndexer();
vi.mock('graphql-request', async () => {
  const mod = await import('../backfill/fake-indexer.js');
  return mod.graphqlRequestMock(() => indexer);
});

const { EnvioAdapter } = await import('../../src/subgraph/adapters/envio.adapter.js');
const { FeeMeasurer } = await import('../../src/sync/fee-measurer.js');

const integration = { chainId: 1, protocol: 'uniswap-v4', dialect: 'hyperindex', enabled: true, subgraphUrl: 'http://envio.local/v1/graphql' } as never;

function pricing() {
  return {
    prefetchPrices: vi.fn(async () => undefined),
    seedLastKnown: vi.fn(async () => 0),
    pricePool: vi.fn(async () => ({ token0Usd: 1, token1Usd: 1, source: 'external', usedFallback: false, token0Confidence: 'anchor', token1Confidence: 'anchor' })),
  };
}

beforeEach(() => {
  indexer = new FakeIndexer();
});

describe('P3.1 with the real FeeMeasurer', () => {
  it('a walked active row is served on-chain with the measurer\'s stamp; a closed one is never measured', async () => {
    indexer.positions = [
      { tokenId: 1, createdAt: 1, lastModifyBlock: 50 },
      { tokenId: 2, createdAt: 2, isActive: false },
    ];
    const { client, calls } = fakeClient([777], (contracts) =>
      contracts.map((c) =>
        c.functionName === 'getFeeGrowthInside'
          ? { status: 'success', result: [3n * Q128, 4n * Q128] }
          : { status: 'success', result: [10n ** 18n, 0n, 0n] },
      ),
    );
    const measurer = new FeeMeasurer({ evmRpcUrls: new Map([[1, 'http://rpc']]), positionFeeBatchSize: 200, positionFeeConcurrency: 8 } as never, undefined, {
      client: (_c, lane) => {
        expect(lane).toBe('backfill');
        return client as unknown as PublicClient;
      },
    });
    const adapter = new EnvioAdapter(
      pricing() as never,
      { findByIds: async () => [] } as never,
      { minRealMarketBackingUsd: 1000 } as never,
      { findRpcFees: vi.fn(async () => new Map()) } as never,
      measurer as never,
    );
    const got: Array<Record<string, unknown>> = [];
    const result = await adapter.walkTokenIdRanges({
      integration,
      fromTokenId: '0',
      lookahead: 0,
      pipeline: false,
      priceWaitMs: 5_000,
      feeRead: true,
      onRange: async (positions) => {
        got.push(...(positions as unknown as Array<Record<string, unknown>>));
        return positions.length;
      },
      onCursor: async () => undefined,
    });
    expect(result.completed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.salts).toHaveLength(1); // only the active row
    const open = got.find((p) => p.positionId === '1')!;
    expect(open).toMatchObject({ rpcFeesBlock: 777 });
    expect(Number(open.rpcFeesUncollected0)).toBeGreaterThan(0);
    expect((open.metrics as { feesSource?: string }).feesSource).toBe('onchain');
    const closed = got.find((p) => p.positionId === '2')!;
    expect(closed.rpcFeesBlock).toBeUndefined();
  });

  it('a fee below 1e-6 is stamped as the exact plain decimal (never exponent form) and the RAM store accepts it', async () => {
    indexer.positions = [{ tokenId: 1, createdAt: 1, lastModifyBlock: 50 }];
    // liquidity 1, fee growth 7 per unit: 7 wei of an 18-decimal token = 7e-18
    const { client } = fakeClient([777], (contracts) =>
      contracts.map((c) =>
        c.functionName === 'getFeeGrowthInside'
          ? { status: 'success', result: [7n * Q128, 123_456_789n * Q128] }
          : { status: 'success', result: [1n, 0n, 0n] },
      ),
    );
    const measurer = new FeeMeasurer({ evmRpcUrls: new Map([[1, 'http://rpc']]), positionFeeBatchSize: 200, positionFeeConcurrency: 8 } as never, undefined, {
      client: () => client as unknown as PublicClient,
    });
    const measureSpy = vi.spyOn(measurer, 'measure');
    const adapter = new EnvioAdapter(
      pricing() as never,
      { findByIds: async () => [] } as never,
      { minRealMarketBackingUsd: 1000 } as never,
      { findRpcFees: vi.fn(async () => new Map()) } as never,
      measurer as never,
    );
    const got: Array<Record<string, unknown>> = [];
    await adapter.walkTokenIdRanges({
      integration,
      fromTokenId: '0',
      lookahead: 0,
      pipeline: false,
      priceWaitMs: 5_000,
      feeRead: true,
      onRange: async (positions) => {
        got.push(...(positions as unknown as Array<Record<string, unknown>>));
        return positions.length;
      },
      onCursor: async () => undefined,
    });
    // the measurer hands over the exact formatUnits strings
    expect(measureSpy).toHaveBeenCalledTimes(1);
    const reading = (await measureSpy.mock.results[0]!.value).get('1');
    expect(reading).toBeDefined();
    expect(reading.fees0Exact).toBe(formatUnits(7n, 18));
    expect(reading.fees1Exact).toBe(formatUnits(123_456_789n, 6));
    const open = got.find((p) => p.positionId === '1')!;
    const stamp0 = String(open.rpcFeesUncollected0);
    expect(String(7e-18)).toContain('e'); // what String(number) would have stamped
    expect(stamp0).toMatch(/^\d+(\.\d+)?$/);
    expect(stamp0).toBe(formatUnits(7n, 18));
    expect(toRaw(stamp0, 18)).toBe(7n); // the candidate store's parser takes it, exactly
    expect(String(open.rpcFeesUncollected1)).toMatch(/^\d+(\.\d+)?$/);
  });

  it('an aborted read (the adapter\'s deadline passed) starts no RPC call', async () => {
    const { client, calls } = fakeClient([777], (contracts) => contracts.map(() => ({ status: 'success', result: [0n, 0n, 0n] })));
    const measurer = new FeeMeasurer({ evmRpcUrls: new Map([[1, 'http://rpc']]), positionFeeBatchSize: 200, positionFeeConcurrency: 8 } as never, undefined, {
      client: () => client as unknown as PublicClient,
    });
    const ac = new AbortController();
    ac.abort(new Error('deadline'));
    const out = await measurer.measure(
      1,
      'uniswap-v4',
      [{ positionId: '1', tokenId: '1', poolId: `0x${'01'.repeat(32)}`, tickLower: -10, tickUpper: 10, decimals0: 18, decimals1: 6, lastModifyBlock: 1 }] as never,
      { signal: ac.signal },
    );
    expect(out.size).toBe(0);
    expect(calls).toHaveLength(0);
    expect(client.getBlockNumber).not.toHaveBeenCalled();
  });

  it('…also with one head per page (POSITION_FEE_HEAD_PER=page): not even the page\'s head read starts', async () => {
    const { client, calls } = fakeClient([777], (contracts) => contracts.map(() => ({ status: 'success', result: [0n, 0n, 0n] })));
    const measurer = new FeeMeasurer(
      { evmRpcUrls: new Map([[1, 'http://rpc']]), positionFeeBatchSize: 200, positionFeeConcurrency: 8, positionFeeHeadPer: 'page' } as never,
      undefined,
      { client: () => client as unknown as PublicClient },
    );
    const ac = new AbortController();
    ac.abort(new Error('deadline'));
    const out = await measurer.measure(
      1,
      'uniswap-v4',
      [{ positionId: '1', tokenId: '1', poolId: `0x${'01'.repeat(32)}`, tickLower: -10, tickUpper: 10, decimals0: 18, decimals1: 6, lastModifyBlock: 1 }] as never,
      { signal: ac.signal },
    );
    expect(out.size).toBe(0);
    expect(client.getBlockNumber).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('an abort DURING the read stops new batches (rows come back unanswered)', async () => {
    const ac = new AbortController();
    const { client, calls } = fakeClient([777], (contracts) => {
      ac.abort(new Error('deadline')); // the first batch's answer arrives after the deadline fired
      return contracts.map((c) =>
        c.functionName === 'getFeeGrowthInside' ? { status: 'success', result: [0n, 0n] } : { status: 'success', result: [1n, 0n, 0n] },
      );
    });
    const measurer = new FeeMeasurer(
      { evmRpcUrls: new Map([[1, 'http://rpc']]), positionFeeBatchSize: 1, positionFeeConcurrency: 1 } as never,
      undefined,
      { client: () => client as unknown as PublicClient },
    );
    const rows = [1, 2, 3].map((i) => ({ positionId: String(i), tokenId: String(i), poolId: `0x${'01'.repeat(32)}`, tickLower: -10, tickUpper: 10, decimals0: 18, decimals1: 6, lastModifyBlock: 1 }));
    await measurer.measure(1, 'uniswap-v4', rows as never, { signal: ac.signal });
    expect(calls).toHaveLength(1); // batch 1 only; batches 2 and 3 never start
  });
});
