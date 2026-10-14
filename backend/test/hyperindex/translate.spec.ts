import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { translate } from "../../src/subgraph/hyperindex/translate.js";
import { TranslationError } from "../../src/subgraph/hyperindex/errors.js";
import * as Q from "./fixtures.js";

const CHAIN = 1;
const POOL = "0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a";
const TOKEN = "0x31a519f6cf89d9a334e26808f3acb43c1d081c66";

const t = (src: string, vars: Record<string, unknown> = {}) =>
  translate(src, vars, CHAIN);

describe("root fields and arguments", () => {
  it("POOLS_QUERY: injects the chain filter, an id tiebreak, and translates ordering/pagination", () => {
    const p = t(Q.POOLS_QUERY, { first: 100, skip: 200 });
    expect(p.query).toMatchInlineSnapshot(`
      "query TopPools($p0: numeric!, $p1: Int!, $p2: Int!, $p3: Int!) {
        pools: Pool(where: { _and: [{ chainId: { _eq: $p0 } }] }, order_by: [{ volumeUSD: desc }, { id: asc }], limit: $p1, offset: $p2) { id token0 token1 feeTier tickSpacing tick sqrtPrice liquidity createdAtTimestamp totalValueLockedToken0 totalValueLockedToken1 totalValueLockedUSD volumeUSD feesUSD txCount token0Price token1Price poolDayData(order_by: [{ date: desc }], limit: $p3) { date volumeUSD feesUSD tvlUSD } }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": "1",
        "p1": 100,
        "p2": 200,
        "p3": 7,
      }
    `);
  });

  it("POOL_STATS_QUERY: prefixes every id in an _in list", () => {
    const p = t(Q.POOL_STATS_QUERY, { ids: [POOL, "0xabc"] });
    expect(p.query).toMatchInlineSnapshot(`
      "query PoolStats($p0: [String!]!, $p1: numeric!, $p2: Int!) {
        pools: Pool(where: { _and: [{ id: { _in: $p0 } }, { chainId: { _eq: $p1 } }] }, order_by: [{ id: asc }], limit: $p2) { id totalValueLockedUSD totalValueLockedUSDUntracked totalValueLockedToken0 totalValueLockedToken1 volumeUSD feesUSD }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": [
          "1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
          "1_0xabc",
        ],
        "p1": "1",
        "p2": 1000,
      }
    `);
  });

  it("POOL_DAY_QUERY: ref field becomes pool_id and Int stays Int", () => {
    const p = t(Q.POOL_DAY_QUERY, { pool: POOL, fromDate: 1735689600 });
    expect(p.query).toMatchInlineSnapshot(`
      "query PoolDay($p0: String!, $p1: Int!, $p2: numeric!, $p3: Int!) {
        poolDayDatas: PoolDayData(where: { _and: [{ pool_id: { _eq: $p0 } }, { date: { _gte: $p1 } }, { chainId: { _eq: $p2 } }] }, order_by: [{ date: asc }, { id: asc }], limit: $p3) { date tick token0Price token1Price open high low close tvlUSD volumeUSD feesUSD }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": "1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
        "p1": 1735689600,
        "p2": "1",
        "p3": 1000,
      }
    `);
  });

  it("TOKEN_DAY_QUERY", () => {
    const p = t(Q.TOKEN_DAY_QUERY, { token: TOKEN, fromDate: 1735689600 });
    expect(p.query).toMatchInlineSnapshot(`
      "query TokenDay($p0: String!, $p1: Int!, $p2: numeric!, $p3: Int!) {
        tokenDayDatas: TokenDayData(where: { _and: [{ token_id: { _eq: $p0 } }, { date: { _gte: $p1 } }, { chainId: { _eq: $p2 } }] }, order_by: [{ date: asc }, { id: asc }], limit: $p3) { date priceUSD }
      }"
    `);
  });

  it("TICKS_QUERY: liquidityGross_gt keeps its string value against a numeric column", () => {
    const p = t(Q.TICKS_QUERY, { pool: POOL });
    expect(p.query).toMatchInlineSnapshot(`
      "query Ticks($p0: String!, $p1: numeric!, $p2: numeric!, $p3: Int!) {
        ticks: Tick(where: { _and: [{ pool_id: { _eq: $p0 } }, { liquidityGross: { _gt: $p1 } }, { chainId: { _eq: $p2 } }] }, order_by: [{ tickIdx: asc }, { id: asc }], limit: $p3) { tickIdx liquidityGross liquidityNet price0 price1 }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": "1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
        "p1": "0",
        "p2": "1",
        "p3": 1000,
      }
    `);
  });

  it("POOL_STATE_QUERY: pool(id:) becomes a filtered limit-1 list", () => {
    const p = t(Q.POOL_STATE_QUERY, { pool: POOL });
    expect(p.query).toMatchInlineSnapshot(`
      "query PoolState($p0: String!, $p1: numeric!, $p2: Int!) {
        pool: Pool(where: { _and: [{ id: { _eq: $p0 } }, { chainId: { _eq: $p1 } }] }, order_by: [{ id: asc }], limit: $p2) { tick sqrtPrice tickSpacing token0 token1 }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": "1_0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
        "p1": "1",
        "p2": 1,
      }
    `);
  });

  it("CURRENT_PRICES_QUERY: bundles is pinned by id because Bundle has no chainId column", () => {
    const p = t(Q.CURRENT_PRICES_QUERY, { ids: [TOKEN] });
    expect(p.query).toMatchInlineSnapshot(`
      "query CurrentPrices($p0: String!, $p1: Int!, $p2: [String!]!, $p3: numeric!, $p4: Int!) {
        bundles: Bundle(where: { _and: [{ id: { _eq: $p0 } }] }, order_by: [{ id: asc }], limit: $p1) { ethPriceUSD }
        tokens: Token(where: { _and: [{ id: { _in: $p2 } }, { chainId: { _eq: $p3 } }] }, order_by: [{ id: asc }], limit: $p4) { id derivedETH }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": "1",
        "p1": 1,
        "p2": [
          "1_0x31a519f6cf89d9a334e26808f3acb43c1d081c66",
        ],
        "p3": "1",
        "p4": 100,
      }
    `);
  });

  it("TOKEN_HOUR_PRICES_QUERY: cursor id_gt and token { id } collapse to the FK column", () => {
    const p = t(Q.TOKEN_HOUR_PRICES_QUERY, {
      tokens: [TOKEN],
      hours: [1768478400],
      first: 1000,
      lastId: "",
    });
    expect(p.query).toMatchInlineSnapshot(`
      "query TokenHourPrices($p0: [String!]!, $p1: [Int!]!, $p2: String!, $p3: numeric!, $p4: Int!) {
        tokenHourDatas: TokenHourData(where: { _and: [{ token_id: { _in: $p0 } }, { periodStartUnix: { _in: $p1 } }, { id: { _gt: $p2 } }, { chainId: { _eq: $p3 } }] }, order_by: [{ id: asc }], limit: $p4) { id periodStartUnix priceUSD token_id }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": [
          "1_0x31a519f6cf89d9a334e26808f3acb43c1d081c66",
        ],
        "p1": [
          1768478400,
        ],
        "p2": "",
        "p3": "1",
        "p4": 1000,
      }
    `);
  });

  it("LATEST_HOUR_PRICE_QUERY", () => {
    const p = t(Q.LATEST_HOUR_PRICE_QUERY, { token: TOKEN, hourLte: 1768478400 });
    expect(p.query).toMatchInlineSnapshot(`
      "query LatestHourPrice($p0: String!, $p1: Int!, $p2: numeric!, $p3: Int!) {
        tokenHourDatas: TokenHourData(where: { _and: [{ token_id: { _eq: $p0 } }, { periodStartUnix: { _lte: $p1 } }, { chainId: { _eq: $p2 } }] }, order_by: [{ periodStartUnix: desc }, { id: asc }], limit: $p3) { periodStartUnix priceUSD }
      }"
    `);
  });

  it("META_QUERY: emits its own document, and does NOT probe Swap", () => {
    /*
     * The `sw: Swap(... order_by timestamp desc ...)` root was removed and must
     * not return. Measured against the live deployment 2026-09-22: that one root
     * took 10s by itself and pushed the document to 14-16s or an outright HTTP
     * 504, against `/health`'s 4s deadline — so `indexedBlock` came back null for
     * every chain and the status page showed "indexed not reporting".
     *
     * `Swap` is indexed on `(pool, timestamp DESC)`; constraining `chainId` while
     * ordering on `timestamp` cannot use it, so it scans the biggest table in the
     * indexer. `ModifyLiquidity` answers the same question in ~1s.
     */
    const p = t(Q.META_QUERY);
    expect(p.query).not.toContain("Swap");
    expect(p.query).toMatchInlineSnapshot(`
      "query ProxyMeta($p0: Int!, $p1: numeric!) {
        meta: _meta(where: { chainId: { _eq: $p0 } }, limit: 1) { progressBlock }
        ml: ModifyLiquidity(where: { chainId: { _eq: $p1 } }, order_by: [{ timestamp: desc }], limit: 1) { timestamp }
      }"
    `);
    expect(p.variables).toMatchInlineSnapshot(`
      {
        "p0": 1,
        "p1": "1",
      }
    `);
  });
});

describe("_meta: the two halves are requested independently", () => {
  /*
   * The `ModifyLiquidity` root behind `block.timestamp` HANGS past 30s in roughly
   * one call in seven on mainnet (measured 2026-09-30, 15 samples); the bare
   * `_meta` root answered in 0.6-1.2s every time. They shared a document, so a
   * hung timestamp took the block number down with it. A document now asks Hasura
   * only for the halves it selects.
   */
  const NUMBER_ONLY = `query MetaBlock { _meta { block { number } } }`;
  const TIMESTAMP_ONLY = `query MetaTimestamp { _meta { block { timestamp } } }`;

  it("number only: emits the bare `_meta` root and NEVER touches ModifyLiquidity", () => {
    const p = t(NUMBER_ONLY);
    expect(p.query).not.toContain("ModifyLiquidity");
    expect(p.query).toMatchInlineSnapshot(`
      "query ProxyMeta($p0: Int!) {
        meta: _meta(where: { chainId: { _eq: $p0 } }, limit: 1) { progressBlock }
      }"
    `);
    expect(p.variables).toEqual({ p0: 1 });
    expect(p.shape).toEqual({ kind: "meta", number: true, timestamp: false });
  });

  it("timestamp only: emits just the ModifyLiquidity root, with its own variable", () => {
    const p = t(TIMESTAMP_ONLY);
    expect(p.query).not.toContain("_meta(");
    expect(p.query).toMatchInlineSnapshot(`
      "query ProxyMeta($p0: numeric!) {
        ml: ModifyLiquidity(where: { chainId: { _eq: $p0 } }, order_by: [{ timestamp: desc }], limit: 1) { timestamp }
      }"
    `);
    // `_meta.chainId` is an Int and every entity `chainId` is numeric — sharing one
    // variable across the two fails, so each root carries the type it needs.
    expect(p.variables).toEqual({ p0: "1" });
    expect(p.shape).toEqual({ kind: "meta", number: false, timestamp: true });
  });

  it("both selected: byte-identical to the document every `_meta` query used to get", () => {
    const p = t(`query M { _meta { block { number timestamp } } }`);
    expect(p.query).toBe(t(Q.META_QUERY).query);
    expect(p.shape).toEqual({ kind: "meta", number: true, timestamp: true });
  });

  // Each alias case selects ONE half: a document selecting both would come back
  // `{number:true, timestamp:true}` whether or not aliases were understood, so it
  // could not notice a regression that read the alias instead of the field name.
  it.each([
    ["an aliased number", `query M { _meta { block { n: number } } }`, { number: true, timestamp: false }],
    ["an aliased timestamp", `query M { _meta { block { ts: timestamp } } }`, { number: false, timestamp: true }],
    ["an aliased `block`", `query M { _meta { b: block { number } } }`, { number: true, timestamp: false }],
  ])("%s does not change which half is asked for", (_name, src, want) => {
    expect(t(src).shape).toEqual({ kind: "meta", ...want });
  });

  it("a sibling of `block` selected first does not hide it", () => {
    const p = t(`query M { _meta { deployment block { number } } }`);
    expect(p.shape).toEqual({ kind: "meta", number: true, timestamp: false });
    expect(p.query).not.toContain("ModifyLiquidity");
    const q = t(`query M { _meta { hasIndexingErrors block { timestamp } } }`);
    expect(q.shape).toEqual({ kind: "meta", number: false, timestamp: true });
    expect(q.query).not.toContain("_meta(");
  });

  // `block { number } block { timestamp }` is ONE object with both keys in the
  // response. Reading only the first `block` silently dropped the second half.
  it.each([
    ["two plain `block` selections", `query M { _meta { block { number } block { timestamp } } }`],
    ["two aliased `block` selections", `query M { _meta { a: block { number } b: block { timestamp } } }`],
  ])("unions the halves across %s", (_name, src) => {
    const p = t(src);
    expect(p.shape).toEqual({ kind: "meta", number: true, timestamp: true });
    expect(p.query).toBe(t(Q.META_QUERY).query);
  });

  it("an inline fragment alongside `block` at the `_meta` level falls back to both halves", () => {
    const p = t(`query M { _meta { block { number } ... on _Meta_ { block { timestamp } } } }`);
    expect(p.shape).toEqual({ kind: "meta", number: true, timestamp: true });
    expect(p.query).toBe(t(Q.META_QUERY).query);
  });

  // A caller selecting nothing this can read used to get everything; answering
  // with an empty document instead would be a silent regression for it.
  it.each([
    ["no `block` at all", `query M { _meta { deployment } }`],
    ["a `block` selecting neither half", `query M { _meta { block { hash } } }`],
    // Fragment DEFINITIONS are refused outright by `pickOperation`; an INLINE
    // fragment is the form that can actually reach this code.
    ["an inline fragment inside `block`", `query M { _meta { block { ... on Block_ { number } } } }`],
    ["an inline fragment at the `_meta` level", `query M { _meta { ... on _Meta_ { block { number } } } }`],
  ])("falls back to BOTH halves for %s", (_name, src) => {
    const p = t(src);
    expect(p.shape).toEqual({ kind: "meta", number: true, timestamp: true });
    expect(p.query).toBe(t(Q.META_QUERY).query);
  });
});

describe("nullable ordering", () => {
  it("spells out null placement when sorting on tick", () => {
    const p = t(`{ pools(orderBy: tick, orderDirection: desc, first: 5) { id } }`);
    expect(p.query).toContain("desc_nulls_first");
  });
});

describe("refusals", () => {
  const cases: Array<[string, string]> = [
    ["unknown root field", `{ swaps(first: 1) { id } }`],
    ["unknown column", `{ pools(first: 1) { nope } }`],
    ["unsupported where suffix", `{ pools(where: { id_contains: "a" }, first: 1) { id } }`],
    ["time travel", `{ pools(block: { number: 100 }, first: 1) { id } }`],
    ["oversized page", `{ pools(first: 5000) { id } }`],
    ["orderDirection without orderBy", `{ pools(orderDirection: desc, first: 1) { id } }`],
    ["fragments", `{ pools(first: 1) { ...F } } fragment F on Pool { id }`],
    ["scalar with a selection set", `{ pools(first: 1) { feeTier { x } } }`],
  ];
  for (const [name, src] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => t(src)).toThrow(TranslationError);
    });
  }

  it("never emits a message the backend would mistake for a transient gateway fault", () => {
    // envio.adapter.ts:890 retries HTTP-200 errors matching this.
    const RE = /bad indexers|no attestation|indexing_error|too far behind|unavailable/i;
    for (const [, src] of cases) {
      try {
        t(src);
      } catch (e) {
        expect(RE.test((e as Error).message)).toBe(false);
      }
    }
  });
});

/**
 * Regressions for defects found by review after this layer shipped. Each one
 * was invisible to the suite above, and the reason is noted — the point of
 * these tests is the class of gap, not just the specific bug.
 */
describe("pagination is a single total order across the whole walk", () => {
  // The original guard was `skip > 0`, so page 1 (always skip:0) was ordered by
  // volumeUSD alone while page 2 carried `id asc` as well. Two different total
  // orders across the seam: Postgres may order a tied block one way for the
  // first query and re-sort it for the second, so a row inside a large
  // volumeUSD="0" tie can sit in positions 1..100 of ordering A and past 100 in
  // ordering B, and never be fetched. The suite missed it because every
  // existing case passed skip:200 — the seam is specifically at skip:0 vs 100.
  it("emits the SAME order_by on the first page as on every later page", () => {
    const orderOf = (q: string) => q.match(/order_by: \[[^\]]*\]/)?.[0];

    const page1 = t(Q.POOLS_QUERY, { first: 100, skip: 0 });
    const page2 = t(Q.POOLS_QUERY, { first: 100, skip: 100 });

    expect(orderOf(page1.query)).toBe("order_by: [{ volumeUSD: desc }, { id: asc }]");
    expect(orderOf(page1.query)).toBe(orderOf(page2.query));
  });

  it("tiebreaks a root list even with no orderBy at all, and on the first page", () => {
    const p = t(`query Q($first: Int!) { pools(first: $first) { id } }`, { first: 100 });
    expect(p.query).toContain("order_by: [{ id: asc }]");
  });

  it("does not duplicate the tiebreak when the caller already orders by id", () => {
    const p = t(
      `query Q($first: Int!) { pools(orderBy: id, orderDirection: asc, first: $first) { id } }`,
      { first: 100 },
    );
    expect(p.query.match(/\{ id: asc \}/g)).toHaveLength(1);
  });
});

describe("two comparison ops on one column", () => {
  // `{x_gte, x_lte}` is the canonical subgraph range idiom and is already used
  // elsewhere in this backend. Sharing one input object emitted
  // `where: { tickIdx: { _gte: .. }, tickIdx: { _lte: .. } }` — a duplicate
  // input-object field, which is invalid GraphQL and, if a server resolves it
  // last-wins instead of rejecting it, silently drops a bound and returns
  // out-of-range rows that look healthy.
  it("keeps both bounds of a range filter", () => {
    const p = t(
      `query Q($lo: BigInt!, $hi: BigInt!) {
         ticks(where: { tickIdx_gte: $lo, tickIdx_lte: $hi }, first: 10) { tickIdx }
       }`,
      { lo: "-100", hi: "100" },
    );
    expect(p.query).toContain("_gte");
    expect(p.query).toContain("_lte");
    // Neither bound may be nested inside an object that also declares the other.
    expect(p.query).not.toMatch(/\{[^{}]*_gte[^{}]*_lte[^{}]*\}/);
  });

  it("does not collide a caller chainId filter with the injected one", () => {
    const p = t(
      `query Q($c: BigInt!) { pools(where: { chainId: $c }, first: 5) { id } }`,
      { c: "1" },
    );
    // Two chainId predicates may both be present, but never as duplicate keys
    // of one input object.
    expect(p.query).not.toMatch(/\{[^{}]*chainId:[^{}]*chainId:[^{}]*\}/);
  });
});

describe("id translation is symmetric between reading and filtering", () => {
  // Pool.token0/token1 physically store a prefixed `<chainId>_0x…` Token id.
  // The SELECT path stripped the prefix; the WHERE path did not add it, so a
  // filter went to the wire bare and could never match — yielding a well-formed
  // EMPTY list, indistinguishable from end-of-walk.
  it("prefixes a token0 filter to the id space the column actually stores", () => {
    const p = t(`query Q($t: String!) { pools(where: { token0: $t }, first: 10) { id } }`, {
      t: TOKEN,
    });
    const value = Object.values(p.variables).find(
      (v) => typeof v === "string" && v.includes(TOKEN),
    );
    expect(value).toBe(`${CHAIN}_${TOKEN}`);
  });

  it("prefixes every element of a token0_in filter", () => {
    const other = "0x0000000000000000000000000000000000000abc";
    const p = t(`query Q($t: [String!]!) { pools(where: { token0_in: $t }, first: 10) { id } }`, {
      t: [TOKEN, other],
    });
    const list = Object.values(p.variables).find(Array.isArray) as string[];
    expect(list).toEqual([`${CHAIN}_${TOKEN}`, `${CHAIN}_${other}`]);
  });
});

describe("a stitched token selection cannot promise unfetched columns", () => {
  // The batch loader selects only the write-once Token columns. Anything else
  // used to translate cleanly and read back `null` — a fabricated value rather
  // than an error. Rejected at translation time now, like a nested list.
  it("rejects a Token column the loader never fetches", () => {
    expect(() =>
      t(`query Q { pools(first: 1) { id token0 { id derivedETH } } }`),
    ).toThrow(TranslationError);
  });

  it("still accepts every field that IS fetched", () => {
    const p = t(`query Q { pools(first: 1) { id token0 { id symbol name decimals } } }`);
    expect(p.query).toContain("token0");
  });

  it("rejects __typename here too, by the same rule that rejects it everywhere", () => {
    expect(() => t(`query Q { pools(first: 1) { id token0 { id __typename } } }`)).toThrow(
      /__typename is not supported/,
    );
  });
});

/**
 * Position entities, added when v4 position indexing moved from the Ponder
 * indexer into the Envio one. Translation lives HERE rather than in the
 * indexer: the converter already owns subgraph→Hasura for eight entities, so a
 * second dialect layer inside the indexer would have been a duplicate of this.
 */
describe("positions", () => {
  it("translates a position backfill walk", () => {
    const p = t(
      `query P($first: Int!, $skip: Int!, $since: BigInt!) {
         positions(where: { createdAtTimestamp_gte: $since }, orderBy: createdAtTimestamp,
                   orderDirection: asc, first: $first, skip: $skip) {
           id tokenId owner poolId tickLower tickUpper liquidity isActive
           amount0 amount1 totalFeesCollected0 totalFeesCollected1
         }
       }`,
      { first: 100, skip: 0, since: "0" },
    );
    expect(p.query).toContain("Position(");
    expect(p.query).toContain("chainId");
    expect(p.query).toMatch(/order_by: \[\{ createdAtTimestamp: asc \}/);
  });

  it("prefixes a position id filter into the chain's id space", () => {
    const p = t(`query P($id: ID!) { position(id: $id) { id owner } }`, { id: "133850" });
    const v = Object.values(p.variables).find((x) => typeof x === "string" && x.includes("133850"));
    expect(v).toBe(`${CHAIN}_133850`);
  });

  it("exposes lastModifyBlock separately from updatedAtBlock", () => {
    // updatedAtBlock is the change feed (modify / transfer / burn); lastModifyBlock
    // moves on a modify only, which is the freshness key for an on-chain fee read.
    const p = t(`query P { positions(first: 5) { id updatedAtBlock lastModifyBlock } }`);
    expect(p.query).toContain("updatedAtBlock");
    expect(p.query).toContain("lastModifyBlock");
  });

  it("rejects the fee-sweep columns the indexer no longer carries", () => {
    // Hasura rejects the whole query when one selected column is missing, so a
    // name the new indexer lacks must fail here, in translation.
    for (const field of ["totalFeesUncollected0", "totalFeesUncollected1", "feesUpdatedAtBlock", "feesUpdatedAtTimestamp"]) {
      expect(() => t(`query P { positions(first: 5) { id ${field} } }`), field).toThrow(/does not exist on Position/);
    }
  });

  it("translates the position transaction list", () => {
    const p = t(
      `query T($ids: [BigInt!]!) {
         positionTransactions(where: { tokenId_in: $ids }, orderBy: timestamp,
                              orderDirection: asc, first: 1000) {
           id txHash logIndex type amount0 amount1 gasCostETH timestamp
         }
       }`,
      { ids: ["1", "2"] },
    );
    expect(p.query).toContain("PositionTransaction(");
    expect(p.query).toMatch(/order_by: \[\{ timestamp: asc \}/);
  });

  it("does not prefix a PositionTransaction id — it is opaque, not an address", () => {
    // `<chainId>_<txHash>_<logIndex>_<type>` already carries the chain, so
    // prefix arithmetic would corrupt it.
    const p = t(`query T($id: ID!) { positionTransaction(id: $id) { id type } }`, {
      id: "1_0xabc_3_COLLECT_FEES",
    });
    const v = Object.values(p.variables).find((x) => typeof x === "string" && x.includes("0xabc"));
    expect(v).toBe("1_0xabc_3_COLLECT_FEES");
  });

  it("rejects a position field that does not exist", () => {
    expect(() => t(`query P { positions(first: 1) { id notAField } }`)).toThrow(TranslationError);
  });
});

/*
 * The fixtures file opens by claiming its documents are "copied byte-exact from
 * source", so that a backend change which alters the emitted Hasura document
 * shows up here as a failing diff rather than as a production surprise. Nothing
 * enforced that, and it had already drifted — the pool-stats query was renamed
 * and its comment body rewritten while the fixture kept the old text, so the
 * suite went on translating a document the backend no longer sends.
 *
 * Extracting the template from the source at test time is the same technique
 * that caught the `Position.poolId` prefix bug: a retyped fixture only ever
 * reproduces the assumption you retyped.
 */
describe("fixtures do not drift from the shipped documents", () => {
  const SOURCES: Array<[fixture: keyof typeof Q, file: string, constName: string]> = [
    ["POOL_STATS_QUERY", "src/subgraph/adapters/envio.adapter.ts", "POOL_STATS_QUERY"],
    ["SG_POSITIONS_QUERY", "src/subgraph/adapters/envio.adapter.ts", "SG_POSITIONS_QUERY"],
  ];

  for (const [fixture, file, constName] of SOURCES) {
    const declared = Q[fixture];
    if (typeof declared !== "string") continue;
    it(`${String(fixture)} matches ${file}`, () => {
      const src = readFileSync(file, "utf8");
      const m = new RegExp(`const ${constName} = gql\`([\\s\\S]*?)\`;`).exec(src);
      expect(m, `${constName} not found in ${file}`).not.toBeNull();
      // Two normalisations, both necessary:
      //  - the SOURCE text still carries TypeScript's template-literal escapes
      //    (a backtick inside a gql template is written `\``), which the runtime
      //    string does not;
      //  - `POSITION_FIELDS` is interpolated into some documents, so the
      //    interpolation marker is dropped from both sides rather than resolved.
      const norm = (v: string) =>
        v
          .replace(/\\`/g, "`")
          .replace(/\$\{[^}]*\}/g, "")
          .replace(/\s+/g, " ")
          .trim();
      expect(norm(declared)).toBe(norm(m![1]!));
    });
  }
});
