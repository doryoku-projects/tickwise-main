import { describe, expect, it } from "vitest";

import { makeIdCodec } from "../../src/subgraph/hyperindex/ids.js";
import { postProcess, type Row } from "../../src/subgraph/hyperindex/postprocess.js";
import { translate } from "../../src/subgraph/hyperindex/translate.js";
import { UpstreamShapeError } from "../../src/subgraph/hyperindex/errors.js";
import * as Q from "./fixtures.js";

const CHAIN = 1;
const POOL = "0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a";
const T0 = "0x31a519f6cf89d9a334e26808f3acb43c1d081c66";
const T1 = "0xaecaf33b3892a9eac2ac9ef9df69e0516510ac4f";

const tokenRows = new Map<string, Row>([
  [`1_${T0}`, { id: `1_${T0}`, symbol: "AAA", decimals: "18" }],
  [`1_${T1}`, { id: `1_${T1}`, symbol: "BBB", decimals: "6" }],
]);

const ctx = (tokens = tokenRows) => ({
  ids: makeIdCodec(CHAIN),
  chainId: CHAIN,
  loadTokens: async (ids: readonly string[]) =>
    new Map([...tokens].filter(([k]) => ids.includes(k))),
});

describe("response reshaping", () => {
  it("strips the chain prefix and stitches Pool.token0/token1 into nested objects", async () => {
    const plan = translate(Q.POOLS_QUERY, { first: 2, skip: 0 }, CHAIN);
    const out = await postProcess(
      plan.shape,
      {
        pools: [
          {
            id: `1_${POOL}`,
            token0: `1_${T0}`,
            token1: `1_${T1}`,
            feeTier: "500",
            tickSpacing: "10",
            tick: "-29959",
            sqrtPrice: "17715796892483574839390870793",
            liquidity: "7635099351093484",
            createdAtTimestamp: "1768435200",
            totalValueLockedToken0: "1.5",
            totalValueLockedToken1: "2.5",
            totalValueLockedUSD: "200219",
            volumeUSD: "18490000",
            feesUSD: "9242.51",
            txCount: "4",
            token0Price: "20.0003",
            token1Price: "0.04999",
            poolDayData: [
              { date: 1768435200, volumeUSD: "1", feesUSD: "2", tvlUSD: "3" },
            ],
          },
        ],
      },
      ctx(),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "pools": [
          {
            "createdAtTimestamp": "1768435200",
            "feeTier": "500",
            "feesUSD": "9242.51",
            "id": "0xe4bfadebdec1425d2f8e45bf325a6c99b0d9641d7895dde497b4c04e8dcec09a",
            "liquidity": "7635099351093484",
            "poolDayData": [
              {
                "date": 1768435200,
                "feesUSD": "2",
                "tvlUSD": "3",
                "volumeUSD": "1",
              },
            ],
            "sqrtPrice": "17715796892483574839390870793",
            "tick": "-29959",
            "tickSpacing": "10",
            "token0": {
              "decimals": "18",
              "id": "0x31a519f6cf89d9a334e26808f3acb43c1d081c66",
              "symbol": "AAA",
            },
            "token0Price": "20.0003",
            "token1": {
              "decimals": "6",
              "id": "0xaecaf33b3892a9eac2ac9ef9df69e0516510ac4f",
              "symbol": "BBB",
            },
            "token1Price": "0.04999",
            "totalValueLockedToken0": "1.5",
            "totalValueLockedToken1": "2.5",
            "totalValueLockedUSD": "200219",
            "txCount": "4",
            "volumeUSD": "18490000",
          },
        ],
      }
    `);
  });

  it("unwraps a singular root to an object, and to null when absent", async () => {
    const plan = translate(Q.POOL_STATE_QUERY, { pool: POOL }, CHAIN);
    const hit = await postProcess(
      plan.shape,
      { pool: [{ tick: "-29959", sqrtPrice: "1771", tickSpacing: "10", token0: `1_${T0}`, token1: `1_${T1}` }] },
      ctx(),
    );
    expect(hit).toMatchInlineSnapshot(`
      {
        "pool": {
          "sqrtPrice": "1771",
          "tick": "-29959",
          "tickSpacing": "10",
          "token0": {
            "decimals": "18",
          },
          "token1": {
            "decimals": "6",
          },
        },
      }
    `);

    const miss = await postProcess(plan.shape, { pool: [] }, ctx());
    expect(miss).toEqual({ pool: null });
  });

  it("re-expands a collapsed FK column back into token { id }, in subgraph id format", async () => {
    const plan = translate(
      Q.TOKEN_HOUR_PRICES_QUERY,
      { tokens: [T0], hours: [1768478400], first: 10, lastId: "" },
      CHAIN,
    );
    const out = await postProcess(
      plan.shape,
      {
        tokenHourDatas: [
          {
            id: `1_${T0}_491244`,
            periodStartUnix: 1768478400,
            priceUSD: "1791.94",
            token_id: `1_${T0}`,
          },
        ],
      },
      ctx(),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "tokenHourDatas": [
          {
            "id": "0x31a519f6cf89d9a334e26808f3acb43c1d081c66-491244",
            "periodStartUnix": 1768478400,
            "priceUSD": "1791.94",
            "token": {
              "id": "0x31a519f6cf89d9a334e26808f3acb43c1d081c66",
            },
          },
        ],
      }
    `);
  });

  it("reports Bundle.id back as the subgraph's canonical '1'", async () => {
    const plan = translate(`{ bundles(first: 1) { id ethPriceUSD } }`, {}, CHAIN);
    const out = await postProcess(plan.shape, { bundles: [{ id: "1", ethPriceUSD: "1791.94" }] }, ctx());
    expect(out).toEqual({ bundles: [{ id: "1", ethPriceUSD: "1791.94" }] });
  });

  it("refuses a row whose id lacks the chain prefix rather than passing it through", async () => {
    const plan = translate(`{ pools(first: 1) { id } }`, {}, CHAIN);
    await expect(
      postProcess(plan.shape, { pools: [{ id: "0xdeadbeef" }] }, ctx()),
    ).rejects.toThrow(UpstreamShapeError);
  });

  it("refuses a pool whose token row is missing instead of emitting a half-built object", async () => {
    const plan = translate(`{ pools(first: 1) { id token0 { symbol } } }`, {}, CHAIN);
    await expect(
      postProcess(
        plan.shape,
        { pools: [{ id: `1_${POOL}`, token0: "1_0xmissing" }] },
        ctx(new Map()),
      ),
    ).rejects.toThrow(UpstreamShapeError);
  });
});

describe("_meta shim", () => {
  it("maps progressBlock to block.number and derives the timestamp from the newest event", async () => {
    const plan = translate(Q.META_QUERY, {}, CHAIN);
    const out = await postProcess(
      plan.shape,
      { meta: [{ progressBlock: 24240020 }], sw: [{ timestamp: "1768478831" }], ml: [{ timestamp: "1768478000" }] },
      ctx(),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "_meta": {
          "block": {
            "hash": null,
            "number": 24240020,
            "timestamp": 1768478831,
          },
          "deployment": "envio:1:24240020",
          "hasIndexingErrors": false,
        },
      }
    `);
  });

  describe("only the requested halves are read or emitted", () => {
    const NUMBER_ONLY = `query MetaBlock { _meta { block { number } } }`;
    const TIMESTAMP_ONLY = `query MetaTimestamp { _meta { block { timestamp } } }`;

    it("number only: no `timestamp` key, and no no-events warning for a root it never asked for", async () => {
      const warnings: string[] = [];
      const out = await postProcess(
        translate(NUMBER_ONLY, {}, CHAIN).shape,
        { meta: [{ progressBlock: 24240020 }] }, // no `ml` — it was never requested
        { ...ctx(), warn: (m) => warnings.push(m) },
      );
      const block = (out._meta as { block: Record<string, unknown> }).block;
      expect(block).toEqual({ hash: null, number: 24240020 });
      expect("timestamp" in block).toBe(false); // absent, not a fabricated 0
      expect(warnings).toEqual([]);
    });

    it("timestamp only: no `number` key — a block that was never fetched is not genesis", async () => {
      const out = await postProcess(
        translate(TIMESTAMP_ONLY, {}, CHAIN).shape,
        { ml: [{ timestamp: "1768478000" }] },
        ctx(),
      );
      const meta = out._meta as { block: Record<string, unknown>; deployment: string };
      expect(meta.block).toEqual({ hash: null, timestamp: 1768478000 });
      expect("number" in meta.block).toBe(false);
      expect(meta.deployment).toBe("envio:1"); // no block, so no `:<block>` suffix to invent
    });

    it("timestamp only: still warns when the chain has no indexed event", async () => {
      const warnings: string[] = [];
      const out = await postProcess(
        translate(TIMESTAMP_ONLY, {}, CHAIN).shape,
        { ml: [] },
        { ...ctx(), warn: (m) => warnings.push(m) },
      );
      expect((out._meta as { block: { timestamp: number } }).block.timestamp).toBe(0);
      expect(warnings).toHaveLength(1);
    });
  });

  it("holds at timestamp 0 on an index with no events, and says so", async () => {
    const plan = translate(Q.META_QUERY, {}, CHAIN);
    const warnings: string[] = [];
    const out = await postProcess(
      plan.shape,
      { meta: [{ progressBlock: 9070 }], sw: [], ml: [] },
      { ...ctx(), warn: (m) => warnings.push(m) },
    );
    expect((out._meta as { block: { timestamp: number } }).block.timestamp).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});

/*
 * `Position.poolId` is stored BARE while `Pool.id` is prefixed — the one
 * asymmetry in this schema, confirmed live on all three indexed chains. Pinned
 * from BOTH sides because declaring it a `pool` id broke both: the read threw on
 * every row (no prefix to strip), and a filter went out prefixed and matched
 * nothing. See the field's comment in schema-map.ts.
 */
describe("Position.poolId is not prefixed", () => {
  const POSITION_POOL = `query P { positions(first: 1) { tokenId poolId } }`;

  it("returns the bare pool id untouched instead of demanding a chain prefix", async () => {
    const plan = translate(POSITION_POOL, {}, CHAIN);
    const out = await postProcess(
      plan.shape,
      { positions: [{ tokenId: "1", poolId: POOL }] },
      ctx(),
    );
    expect((out.positions as Row[])[0]!.poolId).toBe(POOL);
  });

  it("does not prefix a poolId filter on the way to the wire", () => {
    const plan = translate(
      `query P($p: String!) { positions(where: { poolId: $p }, first: 1) { tokenId } }`,
      { p: POOL },
      CHAIN,
    );
    expect(Object.values(plan.variables)).toContain(POOL);
    expect(JSON.stringify(plan.variables)).not.toContain(`${CHAIN}_${POOL}`);
  });
});

describe("numeric fidelity", () => {
  it("keeps a uint256 exact rather than routing it through a JS number", async () => {
    const plan = translate(`{ pools(first: 1) { liquidity } }`, {}, CHAIN);
    const huge = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const out = await postProcess(plan.shape, { pools: [{ liquidity: huge }] }, ctx());
    expect((out.pools as Row[])[0]!.liquidity).toBe(huge);
  });

  it("rejects an unstringified numeric that would already have lost precision", async () => {
    const plan = translate(`{ pools(first: 1) { liquidity } }`, {}, CHAIN);
    await expect(
      postProcess(plan.shape, { pools: [{ liquidity: 1e30 }] }, ctx()),
    ).rejects.toThrow(/STRINGIFY_NUMERIC_TYPES/);
  });
});
