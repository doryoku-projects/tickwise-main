import { GraphQLClient } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import { makeHyperindexFetch } from '../../src/subgraph/hyperindex/fetch.js';
import * as Q from './fixtures.js';

const CHAIN = 4663;
const URL_ = 'https://indexer.example.test/v1/graphql';
const POOL = '0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a';
const T0 = '0x31a519f6cf89d9a334e26808f3acb43c1d081c66';
const T1 = '0xaecaf33b3892a9eac2ac9ef9df69e0516510ac4f';

/**
 * Stand in for the hosted endpoint. Records every upstream call so a test can
 * assert how many round trips one logical query actually cost.
 */
function stubUpstream(reply: (query: string, variables: Record<string, unknown>) => unknown) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const spy = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init as { body?: string })?.body ?? '{}'));
    calls.push({ query: body.query, variables: body.variables });
    return new Response(JSON.stringify({ data: reply(body.query, body.variables) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy);
  return calls;
}

function client() {
  return new GraphQLClient(URL_, { fetch: makeHyperindexFetch({ chainId: CHAIN, url: URL_ }) });
}

describe('the graphql-request contract', () => {
  it('satisfies a real GraphQLClient end to end, with ids in subgraph form', async () => {
    stubUpstream(() => ({
      bundles: [{ ethPriceUSD: '1914.66' }],
      tokens: [{ id: `${CHAIN}_${T0}`, derivedETH: '1' }],
    }));
    const out = await client().request<{
      bundles: { ethPriceUSD: string }[];
      tokens: { id: string; derivedETH: string }[];
    }>(Q.CURRENT_PRICES_QUERY, { ids: [T0] });

    expect(out.bundles[0]!.ethPriceUSD).toBe('1914.66');
    // The chain prefix must never reach the caller.
    expect(out.tokens[0]!.id).toBe(T0);
  });

  it('emits Hasura, not the dialect it was handed', async () => {
    const calls = stubUpstream(() => ({ poolDayDatas: [] }));
    await client().request(Q.POOL_DAY_QUERY, { pool: POOL, fromDate: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain('PoolDayData');
    expect(calls[0]!.query).toContain('order_by');
    expect(calls[0]!.query).not.toContain('orderDirection');
    // The ref field filters on the FK column, with the id prefixed.
    expect(calls[0]!.query).toContain('pool_id');
    expect(Object.values(calls[0]!.variables)).toContain(`${CHAIN}_${POOL}`);
  });

  it('resolves Pool.token0 with ONE extra round trip, then serves it from cache', async () => {
    const calls = stubUpstream((q) =>
      q.includes('HxTokens')
        ? {
            Token: [
              { id: `${CHAIN}_${T0}`, symbol: 'AAA', decimals: '18' },
              { id: `${CHAIN}_${T1}`, symbol: 'BBB', decimals: '6' },
            ],
          }
        : {
            pools: [
              {
                id: `${CHAIN}_${POOL}`,
                token0: `${CHAIN}_${T0}`,
                token1: `${CHAIN}_${T1}`,
                poolDayData: [],
              },
            ],
          },
    );
    const c = client();
    const first = await c.request<{ pools: { token0: { symbol: string } }[] }>(Q.POOLS_QUERY, {
      first: 1,
      skip: 0,
    });
    expect(first.pools[0]!.token0.symbol).toBe('AAA');
    expect(calls).toHaveLength(2); // the page, then one batched Token fetch

    // Second page: symbol/name/decimals are write-once in the indexer, so the
    // stitch must cost nothing.
    await c.request(Q.POOLS_QUERY, { first: 1, skip: 0 });
    expect(calls).toHaveLength(3);
    expect(calls.filter((x) => x.query.includes('HxTokens'))).toHaveLength(1);
  });

  it("passes the indexer's own errors through untouched", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ errors: [{ message: 'upstream said no' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(client().request(Q.POOL_DAY_QUERY, { pool: POOL, fromDate: 0 })).rejects.toThrow(
      /upstream said no/,
    );
  });

  it('reports an untranslatable query as 200 + errors, never as a 5xx', async () => {
    // A 5xx would read as congestion: requestWithRetry and the pricing
    // providers both back off on >= 500, which would mask a permanent bug.
    const seen: number[] = [];
    const f = makeHyperindexFetch({ chainId: CHAIN, url: URL_ });
    const res = await f(URL_, {
      method: 'POST',
      body: JSON.stringify({ query: '{ swaps(first: 1) { id } }' }),
    } as RequestInit);
    seen.push(res.status);
    expect(seen).toEqual([200]);
    const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
    expect(body.data).toBeUndefined();
    expect(body.errors?.[0]?.message).toMatch(/unknown root field/);
  });
});
