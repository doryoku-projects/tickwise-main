/*
 * Which GraphQL dialect the position adapter speaks, and what it does with no
 * source at all.
 *
 * Everything goes out in the subgraph dialect (flat arrays, `first`/`skip`
 * offset paging) and is translated to the indexer's Hasura surface by
 * `src/subgraph/hyperindex/`. There used to be a SECOND dialect here — Ponder's
 * `{items, pageInfo}` cursor pages — selected at runtime by whether `ponderUrl`
 * was set, plus an explicit `positionsFromSubgraph` opt-in guarding against
 * aiming position queries at a vanilla Uniswap subgraph. Both are gone with the
 * cutover, so the tests that pinned them are gone too; what survives is the part
 * that still matters, because every one of these failures is a silent wrong
 * answer rather than a crash:
 *
 *  - field SHAPE (the three aliased pool columns, the whitelist-derived
 *    `verified`), where a missing property reads as `undefined` and prices a
 *    position at zero; and
 *  - OFFSET PAGING, where an offset derived from anything but the server's own
 *    row count silently skips rows (see the last describe block).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const requests: Array<{ url: string; query: string; variables: Record<string, unknown> }> = [];
let responder: (query: string, variables: Record<string, unknown>) => unknown;

vi.mock('graphql-request', () => ({
  gql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), ''),
  GraphQLClient: class {
    constructor(private readonly url: string) {}
    async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      requests.push({ url: this.url, query, variables });
      return responder(query, variables) as T;
    }
  },
}));

const { EnvioAdapter } = await import('../src/subgraph/adapters/envio.adapter.js');
type Adapter = InstanceType<typeof EnvioAdapter>;

/*
 * Collaborators stubbed to the minimum these tests exercise. Pricing returns an
 * anchor-grade quote for both legs so a row survives normalization — valuation
 * is not what is under test here, routing and field shape are.
 */
function makeAdapter(): Adapter {
  const pricing = {
    pricePool: async () => ({
      token0Usd: 1,
      token1Usd: 1,
      token0Confidence: 'anchor',
      token1Confidence: 'anchor',
    }),
    prefetchPrices: async () => undefined,
  };
  const poolsRepo = { findByIds: async () => [], upsertPoolStats: async () => undefined };
  const config = { get: () => undefined };
  return new EnvioAdapter(
    pricing as never,
    poolsRepo as never,
    config as never,
  ) as Adapter;
}

const ENVIO_URL = 'http://envio.local/v1/graphql';
/** On mainnet's token whitelist. */
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
/** Not on any whitelist. */
const SPAM = '0x00000000000000000000000000000000deadbeef';

function integration(over: Record<string, unknown> = {}) {
  return {
    chainId: 1,
    protocol: 'uniswap-v4' as const,
    dialect: 'hyperindex' as const,
    enabled: true,
    ...over,
  };
}

function options(over: Record<string, unknown> = {}) {
  const { integration: integrationOver, ...rest } = over;
  return {
    integration: integration(integrationOver as Record<string, unknown> | undefined),
    maxPages: 1,
    pageSize: 100,
    // Required: the backfill post-filter compares against this, so leaving it
    // undefined drops every row before it is ever normalized.
    cursorTimestamp: 0,
    skipPrefetch: true,
    ...rest,
  } as never;
}

/** The one position row both dialects have to produce identically. */
const ROW = {
  id: '1_12345',
  chainId: '1',
  tokenId: '12345',
  owner: '0x1111111111111111111111111111111111111111',
  poolId: '0xaaaa',
  tickLower: '-100',
  tickUpper: '100',
  liquidity: '0',
  isActive: true,
  createdAtTimestamp: '1700000000',
  createdAtBlockNumber: '1',
  updatedAtBlock: '2',
  updatedAtTimestamp: '1700000100',
};

beforeEach(() => {
  requests.length = 0;
  responder = () => ({});
});

describe('position reads — dialect and missing source', () => {
  it('speaks the subgraph dialect — a flat array, `first`/`skip` offset paging', async () => {
    responder = (query) => {
      if (/positions\(/.test(query)) return { positions: [ROW] };
      if (/pools\(/.test(query)) return { pools: [] };
      if (/tokens\(/.test(query)) return { tokens: [] };
      return {};
    };

    const adapter = makeAdapter();
    const result = await adapter.fetchPositions(
      options({ integration: { subgraphUrl: ENVIO_URL } }),
    );

    const positionsCall = requests.find((r) => /positions\(/.test(r.query));
    expect(positionsCall?.url).toBe(ENVIO_URL);
    expect(positionsCall?.variables).toMatchObject({ first: expect.any(Number), skip: 0 });
    expect(positionsCall?.variables).not.toHaveProperty('after');
    // The flat array was unwrapped into rows: a pool lookup only happens for
    // rows the walk actually consumed, so its presence is the proof. (The row
    // itself does not survive normalization here because this fixture serves no
    // pool — the whitelist test below carries one and asserts the full path.)
    expect(requests.some((r) => /pools\(/.test(r.query))).toBe(true);
    expect(result.positions).toEqual([]);
  });

  it('unwraps the subgraph dialect flat array for pool and token lookups too', async () => {
    responder = (query) => {
      if (/positions\(/.test(query)) return { positions: [ROW] };
      if (/pools\(/.test(query)) {
        // A GraphQL alias means the RESPONSE carries Ponder's names even though
        // the columns are the subgraph's, which is what the query encodes.
        return {
          pools: [
            {
              id: '0xaaaa',
              name: 'A/B',
              fee: '3000',
              tickSpacing: '60',
              tick: '0',
              sqrtPriceX96: '1',
              token0Id: WETH,
              token1Id: SPAM,
            },
          ],
        };
      }
      if (/tokens\(/.test(query)) {
        return {
          tokens: [
            { id: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: '18' },
            { id: SPAM, symbol: 'SPAM', name: 'Spam', decimals: '18' },
          ],
        };
      }
      return {};
    };

    const adapter = makeAdapter();
    await adapter.fetchPositions(
      options({ integration: { subgraphUrl: ENVIO_URL } }),
    );

    const poolCall = requests.find((r) => /pools\(/.test(r.query));
    const tokenCall = requests.find((r) => /tokens\(/.test(r.query));
    // `first`, not Ponder's `limit`: the batch helpers follow the same dialect
    // as the page walk, so one read can never mix the two.
    expect(poolCall?.variables).toHaveProperty('first');
    expect(poolCall?.variables).not.toHaveProperty('limit');
    expect(tokenCall?.variables).toHaveProperty('first');
    expect(tokenCall?.variables).not.toHaveProperty('limit');

    // The three renamed pool columns are aliased back to Ponder's names. Without
    // the aliases `normalize` reads undefined and prices the position at zero.
    expect(poolCall?.query).toMatch(/fee:\s*feeTier/);
    expect(poolCall?.query).toMatch(/sqrtPriceX96:\s*sqrtPrice/);
    expect(poolCall?.query).toMatch(/token0Id:\s*token0/);
    expect(poolCall?.query).toMatch(/token1Id:\s*token1/);
    // `verified` is Ponder-only, so it must NOT be requested from the subgraph.
    expect(tokenCall?.query).not.toMatch(/verified/);
  });

  it('derives the `verified` hint from the static whitelist', async () => {
    responder = (query) => {
      if (/positions\(/.test(query)) return { positions: [ROW] };
      if (/pools\(/.test(query)) {
        return {
          pools: [
            {
              id: '0xaaaa',
              name: 'W/S',
              fee: '3000',
              tickSpacing: '60',
              tick: '0',
              sqrtPriceX96: '79228162514264337593543950336',
              token0Id: WETH,
              token1Id: SPAM,
            },
          ],
        };
      }
      if (/tokens\(/.test(query)) {
        return {
          tokens: [
            { id: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: '18' },
            { id: SPAM, symbol: 'SPAM', name: 'Spam', decimals: '18' },
          ],
        };
      }
      return {};
    };

    const adapter = makeAdapter();
    const result = await adapter.fetchPositions(
      options({ integration: { subgraphUrl: ENVIO_URL } }),
    );

    const pos = result.positions[0] as unknown as {
      token0: { verified: boolean };
      token1: { verified: boolean };
    };
    // Defaulting the missing column to false instead would demote EVERY token to
    // `unverified`, silently changing position valuation on this path only.
    expect(pos.token0.verified).toBe(true);
    expect(pos.token1.verified).toBe(false);
  });

  it('sends NOTHING and alerts when the integration has no indexer URL', async () => {
    responder = () => {
      throw new Error('must not query anything');
    };

    const adapter = makeAdapter();
    const warn = vi
      .spyOn((adapter as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => {});
    const result = await adapter.fetchPositions(options({ integration: { subgraphUrl: undefined } }));

    expect(requests).toHaveLength(0);
    expect(result.positions).toEqual([]);
    // A bare empty result here is indistinguishable from "nothing new to sync",
    // and the run is recorded `status: success, fetched: 0` either way — which is
    // how an Ethereum integration sat empty for five days behind two runs that
    // finished in 39ms reporting success.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/indexer\.missing_url/);
  });
});

/*
 * BATCH CHUNKING for the per-page pool/token lookups.
 *
 * `first` is a ROW cap, not an id cap: asking for more ids than the cap returns a
 * truncated list with no error and no flag. The missing tokens are then absent
 * from the Map, `normalize` returns null for every position whose pool references
 * one, and those positions are dropped from the page — never upserted, and never
 * retried, because the walk's offset has already counted them. A backfill page of
 * 1,000 positions can span ~950 pools and therefore MORE than 1,000 distinct
 * token ids, so this is reachable on the real corpus, not a theoretical edge.
 */
describe('batch lookups are chunked to the page cap', () => {
  const MAX = 1000;

  it('splits a token batch larger than the cap and merges the results', async () => {
    // 700 pools → 1,400 distinct token ids, over the 1,000 cap.
    const poolCount = 700;
    const tokenId = (i: number) => `0x${String(i).padStart(40, '0')}`;
    const pools = Array.from({ length: poolCount }, (_, i) => ({
      id: `0xpool${i}`,
      name: 'A/B',
      fee: '3000',
      tickSpacing: '60',
      tick: '0',
      sqrtPriceX96: '79228162514264337593543950336',
      token0Id: tokenId(i * 2),
      token1Id: tokenId(i * 2 + 1),
    }));
    const allTokens = Array.from({ length: poolCount * 2 }, (_, i) => ({
      id: tokenId(i),
      symbol: 'T',
      name: 'T',
      decimals: '18',
    }));

    const tokenBatches: string[][] = [];
    responder = (query, variables) => {
      if (/positions\(/.test(query)) {
        return {
          positions: pools.map((p, i) => ({ ...ROW, tokenId: String(1000 + i), poolId: p.id })),
        };
      }
      if (/pools\(/.test(query)) {
        const asked = new Set((variables.where as { id_in: string[] }).id_in);
        return { pools: pools.filter((p) => asked.has(p.id)) };
      }
      if (/tokens\(/.test(query)) {
        const asked = (variables.where as { id_in: string[] }).id_in;
        tokenBatches.push(asked);
        // The SERVER's truncation: never return more rows than `first`.
        const first = Number(variables.first);
        const askedSet = new Set(asked);
        return { tokens: allTokens.filter((t) => askedSet.has(t.id)).slice(0, first) };
      }
      return {};
    };

    const adapter = makeAdapter();
    const result = await adapter.fetchPositions(
      options({ integration: { subgraphUrl: ENVIO_URL }, pageSize: poolCount }),
    );

    // Two token requests, neither over the cap.
    expect(tokenBatches.length).toBeGreaterThan(1);
    for (const batch of tokenBatches) expect(batch.length).toBeLessThanOrEqual(MAX);
    // Every id asked for exactly once, and all of them asked for.
    const asked = tokenBatches.flat();
    expect(new Set(asked).size).toBe(poolCount * 2);
    expect(asked).toHaveLength(poolCount * 2);
    // The point of all of it: no position silently dropped. A single unchunked
    // request would return 1,000 of 1,400 tokens and lose ~300 positions.
    expect(result.positions).toHaveLength(poolCount);
  });
});

describe('fetchPositionTransactions — dialect routing', () => {
  const txRow = {
    chainId: '1',
    txHash: '0xdead',
    logIndex: '0',
    type: 'DEPOSIT',
    tokenId: '12345',
    amount0: '1',
    amount1: '2',
    gasCostETH: '0.01',
    timestamp: '1700000000',
    blockNumber: '2',
    sender: '0x1111111111111111111111111111111111111111',
  };

  it('offset-pages a flat array from the subgraph dialect', async () => {
    responder = () => ({ positionTransactions: [txRow] });

    const adapter = makeAdapter();
    const result = await adapter.fetchPositionTransactions(
      options({
        integration: { subgraphUrl: ENVIO_URL },
        positionIds: ['1_12345'],
      }),
    );

    expect(requests[0]?.variables).toMatchObject({ first: expect.any(Number), skip: 0 });
    expect(result.transactions).toHaveLength(1);
    // A short page ends the walk; without that the offset loop never terminates.
    expect(requests).toHaveLength(1);
  });

  it('flags degraded and sends nothing when no position source is configured', async () => {
    responder = () => {
      throw new Error('must not query anything');
    };

    const adapter = makeAdapter();
    vi.spyOn((adapter as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    const result = await adapter.fetchPositionTransactions(
      options({ integration: { subgraphUrl: undefined }, positionIds: ['1_12345'] }),
    );

    expect(requests).toHaveLength(0);
    expect(result).toEqual({ transactions: [], degraded: true });
  });
});

/*
 * Offset paging across a FLUSH.
 *
 * `skip` must be the number of rows the SERVER has handed back, and nothing
 * else. It used to be `seenPositionIds.length + flushedCount`, and because
 * `seenPositionIds` is never trimmed when a flush empties `collected`, every
 * flushed row was counted twice — the offset ran at ~2x and the walk stepped
 * over roughly half the corpus. Measured live: 202,622 of 403,622 mainnet
 * positions, missing in scattered chunks rather than one clean tail.
 *
 * Unreachable on Ponder, whose cursor paging ignores `skip`, so the Envio
 * cutover is what exposed it. Both properties are pinned: the offsets the walk
 * asks for, and the rows it ends up with.
 */
describe('subgraph offset paging', () => {
  const TOTAL = 250;
  const PAGE = 50;

  function serve(total: number) {
    const all = Array.from({ length: total }, (_, i) => ({
      ...ROW,
      id: `1_${1000 + i}`,
      tokenId: String(1000 + i),
      // Distinct and ascending, so the resume post-filter keeps every row.
      createdAtTimestamp: String(1700000000 + i),
    }));
    responder = (query, variables) => {
      if (/positions\(/.test(query)) {
        const skip = Number(variables.skip ?? 0);
        const first = Number(variables.first ?? PAGE);
        return { positions: all.slice(skip, skip + first) };
      }
      // A real pool and both its tokens, so rows survive normalization and the
      // walk can be judged on the ids it actually returns.
      if (/pools\(/.test(query)) {
        return {
          pools: [
            {
              id: '0xaaaa',
              name: 'W/S',
              fee: '3000',
              tickSpacing: '60',
              tick: '0',
              sqrtPriceX96: '79228162514264337593543950336',
              token0Id: WETH,
              token1Id: SPAM,
            },
          ],
        };
      }
      if (/tokens\(/.test(query)) {
        return {
          tokens: [
            { id: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: '18' },
            { id: SPAM, symbol: 'SPAM', name: 'Spam', decimals: '18' },
          ],
        };
      }
      return {};
    };
    return all;
  }

  it('walks every row exactly once when flushing mid-walk', async () => {
    const all = serve(TOTAL);
    const flushed: string[] = [];

    const adapter = makeAdapter();
    const result = await adapter.fetchPositions(
      options({
        integration: { subgraphUrl: ENVIO_URL },
        maxPages: 50,
        pageSize: PAGE,
        // Below the page size, so a flush fires on EVERY page — the condition
        // that made the old offset double-count.
        flushThreshold: 10,
        onFlush: async (rows: Array<{ positionId: string }>) => {
          flushed.push(...rows.map((r) => r.positionId));
          return rows.length;
        },
      }),
    );

    const seen = [...flushed, ...result.positions.map((p) => p.positionId)];
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    expect(new Set(seen)).toEqual(new Set(all.map((r) => r.tokenId)));
  });

  it('asks for contiguous offsets — never advancing faster than rows returned', async () => {
    serve(TOTAL);

    const adapter = makeAdapter();
    await adapter.fetchPositions(
      options({
        integration: { subgraphUrl: ENVIO_URL },
        maxPages: 50,
        pageSize: PAGE,
        flushThreshold: 10,
        onFlush: async (rows: Array<unknown>) => rows.length,
      }),
    );

    const skips = requests
      .filter((r) => /positions\(/.test(r.query))
      .map((r) => Number(r.variables.skip));
    expect(skips).toEqual([0, 50, 100, 150, 200, 250]);
  });

  // 2026-10-03: only the refresh's stale sweep reads `seenPositionIds`. A
  // backfill used to accumulate every id it ever saw — 3.5M strings on a full
  // Robinhood walk — for a caller that never looked at them.
  it('a backfill walk keeps no seen-id list', async () => {
    serve(TOTAL);
    const adapter = makeAdapter();
    const result = await adapter.fetchPositions(
      options({
        integration: { subgraphUrl: ENVIO_URL },
        maxPages: 50,
        pageSize: PAGE,
        flushThreshold: 10,
        onFlush: async (rows: Array<unknown>) => rows.length,
      }),
    );
    expect(result.seenPositionIds).toEqual([]);
    expect(result.flushedCount + result.positions.length).toBe(TOTAL);
  });

  it('a refresh walk returns the ids it saw', async () => {
    const all = serve(TOTAL);
    const adapter = makeAdapter();
    const ids = all.slice(0, PAGE).map((r) => r.tokenId);
    const result = await adapter.fetchPositions(
      options({ integration: { subgraphUrl: ENVIO_URL }, mode: 'refresh', positionIds: ids, pageSize: PAGE }),
    );
    expect(result.seenPositionIds).toEqual(ids);
    expect(result.positions.map((p) => p.positionId)).toEqual(ids);
  });

  it('latestOnlyLimit still stops at its limit without the id list', async () => {
    serve(TOTAL);
    const adapter = makeAdapter();
    const result = await adapter.fetchPositions(
      options({ integration: { subgraphUrl: ENVIO_URL }, maxPages: 50, pageSize: PAGE, latestOnlyLimit: 70 }),
    );
    expect(result.positions).toHaveLength(70);
    expect(result.seenPositionIds).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('latestOnlyLimit holds even when the server returns more rows than `first` asked for', async () => {
    const all = serve(TOTAL);
    const inner = responder;
    // A page of PAGE rows whatever `first` says.
    responder = (query, variables) =>
      /positions\(/.test(query)
        ? { positions: all.slice(Number(variables.skip ?? 0), Number(variables.skip ?? 0) + PAGE) }
        : inner(query, variables);
    const adapter = makeAdapter();
    const result = await adapter.fetchPositions(
      options({ integration: { subgraphUrl: ENVIO_URL }, maxPages: 50, pageSize: PAGE, latestOnlyLimit: 70 }),
    );
    expect(result.positions).toHaveLength(70);
  });
});
