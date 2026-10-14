/*
 * The combined chart document through the REAL translating fetch
 * (`subgraphFetch` → `makeHyperindexFetch` → translate → one Hasura request),
 * with only the global `fetch` stubbed. This is the claim the batching rests
 * on: several aliased roots in one subgraph document become ONE upstream call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChartInputsService } from '../../src/charts/chart-inputs.service.js';
import { __resetSubgraphFetchCache } from '../../src/subgraph/hyperindex/client.js';
import { EnvioAdapter } from '../../src/subgraph/adapters/envio.adapter.js';

const CHAIN = 1;
const POOL = `0x${'ab'.repeat(32)}`;
const T0 = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const T1 = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

interface UpstreamCall {
  query: string;
  variables: Record<string, unknown>;
}

/** The hosted endpoint: answers by root alias, in Hasura's shape; records every call. */
function stubUpstream() {
  const calls: UpstreamCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as UpstreamCall;
      calls.push(body);
      const data: Record<string, unknown> = {};
      if (body.query.includes('HxTokens')) {
        data.Token = [
          { id: `${CHAIN}_${T0}`, chainId: String(CHAIN), symbol: 'USDC', name: 'USD Coin', decimals: '6' },
          { id: `${CHAIN}_${T1}`, chainId: String(CHAIN), symbol: 'WETH', name: 'Wrapped Ether', decimals: '18' },
        ];
      }
      if (body.query.includes('pd: PoolDayData')) {
        data.pd = [
          { date: 200 * 86_400, tick: '198000', token0Price: '0.0004', token1Price: '2500', open: '1', high: '1', low: '1', close: '1', tvlUSD: '10', volumeUSD: '5', feesUSD: '1' },
          { date: 199 * 86_400, tick: '197990', token0Price: '0.0004', token1Price: '2499', open: '1', high: '1', low: '1', close: '1', tvlUSD: '10', volumeUSD: '5', feesUSD: '1' },
        ];
      }
      if (body.query.includes('tk: Tick')) {
        data.tk = [{ tickIdx: '197940', liquidityGross: '10', liquidityNet: '10', price0: '0', price1: '0' }];
      }
      if (body.query.includes('t0: TokenDayData')) data.t0 = [{ date: 200 * 86_400, priceUSD: '1' }];
      if (body.query.includes('t1: TokenDayData')) data.t1 = [{ date: 200 * 86_400, priceUSD: '2500' }];
      if (body.query.includes('tx: PositionTransaction')) {
        data.tx = [
          { chainId: '1', txHash: '0xAA', logIndex: '3', type: 'DEPOSIT', tokenId: '42', amount0: '5', amount1: '1', gasCostETH: '0.001', timestamp: '17280000', blockNumber: '9', sender: '0xBB' },
        ];
      }
      if (body.query.includes('ps: Pool')) {
        data.ps = [{ tick: '198000', sqrtPrice: '1', tickSpacing: '60', token0: `${CHAIN}_${T0}`, token1: `${CHAIN}_${T1}` }];
      }
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

let urlSeq = 0;
function world() {
  // A fresh url per test: the translating fetch (and its token cache) is cached per (chain, url).
  const integration = {
    chainId: CHAIN,
    protocol: 'uniswap-v4',
    dialect: 'hyperindex' as const,
    enabled: true,
    subgraphUrl: `https://indexer.example.test/${++urlSeq}/v1/graphql`,
  };
  const adapter = new EnvioAdapter({} as never, {} as never, {} as never);
  return { integration, adapter, inputs: new ChartInputsService({ chartCacheMaxBytes: 1 << 20 } as never) };
}

const position = {
  chainId: CHAIN,
  protocol: 'uniswap-v4',
  positionId: '42',
  poolId: POOL,
  owner: '0xbb',
  isActive: true,
  liquidity: '1000',
  token0: { address: T0 },
  token1: { address: T1 },
  amounts: { depositedToken0: '5', depositedToken1: '1' },
};

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSubgraphFetchCache();
});

describe('the combined chart document upstream', () => {
  it('five roots — pool days, ticks, two token day series, transactions — are ONE upstream request', async () => {
    const calls = stubUpstream();
    const w = world();
    const inputs = await w.inputs.positionInputs(position, w.integration as never, w.adapter);

    expect(calls).toHaveLength(1);
    const query = calls[0]!.query;
    for (const root of ['pd: PoolDayData', 'tk: Tick', 't0: TokenDayData', 't1: TokenDayData', 'tx: PositionTransaction']) {
      expect(query).toContain(root);
    }
    // Every root came back to its own input, reshaped to the subgraph dialect.
    expect(inputs.missing).toEqual([]);
    expect(inputs.poolDay!.rows.map((r) => r.date)).toEqual([199 * 86_400, 200 * 86_400]); // oldest first
    expect(inputs.ticks).toHaveLength(1);
    expect(inputs.token0Day!.rows[0]!.priceUSD).toBe('1');
    expect(inputs.token1Day!.rows[0]!.priceUSD).toBe('2500');
    expect(inputs.transactions!.transactions).toEqual([
      expect.objectContaining({ positionId: '42', txHash: '0xaa', transactionId: '0xaa-3-DEPOSIT', timestamp: 17_280_000 }),
    ]);
  });

  it('a warm reopen sends nothing', async () => {
    const calls = stubUpstream();
    const w = world();
    await w.inputs.positionInputs(position, w.integration as never, w.adapter);
    await w.inputs.positionInputs(position, w.integration as never, w.adapter);
    expect(calls).toHaveLength(1);
  });

  it('pool charts: one request, plus the one-off token lookup the pool root stitches on a cold token cache', async () => {
    const calls = stubUpstream();
    const w = world();
    const cold = await w.inputs.poolInputs(w.integration as never, POOL);
    expect(cold.missing).toEqual([]);
    expect(cold.poolState).toEqual(
      expect.objectContaining({ tick: '198000', tickSpacing: '60', token0: { decimals: '6' }, token1: { decimals: '18' } }),
    );
    expect(calls.map((c) => (c.query.includes('HxTokens') ? 'tokens' : 'charts'))).toEqual(['charts', 'tokens']);

    // Another pool with the same (now cached, immutable) tokens: exactly one.
    await w.inputs.poolInputs(w.integration as never, `0x${'cd'.repeat(32)}`);
    expect(calls).toHaveLength(3);
  });
});
