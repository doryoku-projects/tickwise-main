/*
 * Single source of truth for how the vanilla Uniswap v4 subgraph's schema maps
 * onto this Envio indexer's Hasura surface.
 *
 * Hand-written from uniswap-v4-indexer-envio/schema.graphql. Three Envio facts
 * drive everything here:
 *
 *  - Root fields are the entity name verbatim (Hasura.res:194 sets
 *    `custom_name` to the table name), so `pools` -> `Pool`, never `pools`.
 *  - A reference field is exposed as BOTH an object relationship (`pool`) and
 *    the FK scalar column (`pool_id`) — Table.res:119 appends `_id`.
 *  - Pool.token0/token1 are plain `String!` columns holding a complete
 *    `Token.id`, NOT relations. Nested selection on them needs a join.
 */

import type { IdClass } from "./ids.js";

/**
 * The ONLY Token columns a stitched `token0`/`token1` sub-selection can return.
 *
 * The indexer writes these once, in initialize-handler's `if (!token0)` branch,
 * so they never change for a given address and the upstream batch fetch caches
 * them. Every other Token column — volume, volumeUSD, txCount, poolCount, the
 * TVLs, derivedETH — is rewritten on each swap, so it is deliberately NOT
 * fetched and NOT cached. Shared between `upstream.ts` (which selects them) and
 * `translate.ts` (which rejects anything outside the set), because the two
 * drifting apart is what let a query ask for `derivedETH` and read back a
 * fabricated `null`.
 */
export const STITCHED_TOKEN_FIELDS = ['id', 'chainId', 'symbol', 'name', 'decimals'] as const;

/** GraphQL variable type Hasura expects for a column. */
export type Scalar = "String" | "numeric" | "Int" | "Boolean";

export interface FieldSpec {
  /** Hasura column/relationship name, when it differs from the subgraph's. */
  readonly column?: string;
  readonly scalar: Scalar;
  /** Set when the value is an entity id needing translation. */
  readonly idClass?: IdClass;
  /** Reference field: object relationship + `<name>_id` FK column. */
  readonly ref?: { readonly entity: string };
  /** Array relationship (@derivedFrom). */
  readonly list?: { readonly entity: string };
  /**
   * Pool.token0/token1: a String column holding a Token.id that the backend
   * selects as if it were a relation. Resolved by a batched join.
   */
  readonly tokenStitch?: true;
}

export interface EntitySpec {
  /** Hasura root field / table name. */
  readonly table: string;
  readonly idClass: IdClass;
  /** Entities carrying a `chainId` column that must be filtered on. */
  readonly chainScoped: boolean;
  readonly fields: Readonly<Record<string, FieldSpec>>;
}

const NUM: FieldSpec = { scalar: "numeric" };
const STR: FieldSpec = { scalar: "String" };
const INT: FieldSpec = { scalar: "Int" };

export const ENTITIES: Readonly<Record<string, EntitySpec>> = {
  /*
   * Uniswap v4 NFT liquidity positions, ported into the Envio indexer from the
   * Ponder one. Everything here is chain-scoped and id-prefixed the same way
   * Pool and Token are.
   *
   * Fields deliberately absent: `feeGrowthInside0/1LastX128` is the indexer's
   * internal fee baseline and `origin` duplicates the first transaction's
   * sender (nothing reads either), and the indexer's fee-sweep outputs are GONE
   * from the new deployment — `totalFeesUncollected0/1` (its uncollected-fee
   * figure) and `feesUpdatedAtBlock` / `feesUpdatedAtTimestamp` (its
   * watermark). The backend serves the on-chain fee measurement alone
   * (`chooseUncollected`). Hasura rejects a WHOLE query that selects a column
   * the table lacks, so a query naming one of these fails here, in translation,
   * rather than upstream. `updatedAtBlock` is the change feed and moves only on
   * a real position change.
   */
  Position: {
    table: "Position",
    idClass: "position",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "position" },
      chainId: NUM,
      tokenId: NUM,
      owner: STR,
      /*
       * The pool this position belongs to — and the ONE id column in this
       * schema that is stored BARE while the entity it points at is prefixed.
       * Verified live on indexer.hyperindex.xyz across all three chains:
       *
       *   Position.poolId  0x4f88…24a7        (no prefix)
       *   Pool.id          1_0x4f88…24a7      (prefixed)
       *
       * so the join is `Pool.id == "<chainId>_" + Position.poolId`, which is
       * exactly what the adapter does — it feeds these values back as
       * `pools(where: {id_in: …})` and the `pool` id class on `Pool.id` adds
       * the prefix on the way in.
       *
       * Hence `opaque`, NOT `pool`. Declaring it `pool` broke BOTH directions,
       * each in the way that is hardest to see: reading a position threw
       * `UpstreamShapeError` ("lacks the chain-N prefix") on every row, so the
       * Envio position path could not return a single position; and a
       * `positions(where: {poolId: …})` filter went out prefixed and matched
       * nothing, i.e. a well-formed EMPTY list. Do not "restore" the symmetry
       * with Pool.id here — fix it in the indexer if it is ever fixed at all,
       * and change this line in the same breath.
       */
      poolId: { scalar: "String", idClass: "opaque" },
      tickLower: NUM,
      tickUpper: NUM,
      liquidity: NUM,
      isActive: { scalar: "Boolean" },
      isPriceable: { scalar: "Boolean" },
      createdAtTimestamp: NUM,
      createdAtBlockNumber: NUM,
      closedAtTimestamp: NUM,
      depositedToken0: NUM,
      depositedToken1: NUM,
      withdrawnToken0: NUM,
      withdrawnToken1: NUM,
      totalFeesCollected0: NUM,
      totalFeesCollected1: NUM,
      amount0: NUM,
      amount1: NUM,
      totalGasCostETH: NUM,
      updatedAtBlock: NUM,
      updatedAtTimestamp: NUM,
      // Block of the last ModifyLiquidity folded into the row — written ONLY by
      // the modify handler (never a Transfer), which is what
      // makes it the freshness key for an on-chain fee measurement.
      lastModifyBlock: NUM,
      positionTransactions: { scalar: "String", list: { entity: "PositionTransaction" } },
    },
  },

  /*
   * One row per position-touching event.
   *
   * `type` is part of the id, not just a label: a single ModifyLiquidity can
   * emit BOTH a WITHDRAW and a COLLECT_FEES row at the same txHash and logIndex,
   * so an id without it would collapse the two.
   *
   * `opaque` id class because the id is `<chainId>_<txHash>_<logIndex>_<type>` —
   * not an address or a pool id, so no prefix arithmetic applies to it.
   */
  PositionTransaction: {
    table: "PositionTransaction",
    idClass: "opaque",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "opaque" },
      chainId: NUM,
      tokenId: NUM,
      txHash: STR,
      logIndex: NUM,
      type: STR,
      amount0: NUM,
      amount1: NUM,
      gasCostETH: NUM,
      timestamp: NUM,
      blockNumber: NUM,
      sender: STR,
      position: { scalar: "String", ref: { entity: "Position" } },
    },
  },

  Pool: {
    table: "Pool",
    idClass: "pool",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "pool" },
      chainId: NUM,
      name: STR,
      createdAtTimestamp: NUM,
      createdAtBlockNumber: NUM,
      // `idClass` is what the WHERE path reads to prefix a caller's bare address
      // into the `<chainId>_0x…` id the column physically stores. Without it a
      // `pools(where: {token0: "0x…"})` filter went to the wire unprefixed and
      // could never match — returning a well-formed EMPTY list, indistinguishable
      // from end-of-walk. The SELECT path already knew the column was a prefixed
      // token id and stripped it; only the filter direction was missing.
      // Inert elsewhere: translateSelection branches on `tokenStitch` first and
      // hardcodes its own coercer, and the stitch join keys off the raw value.
      token0: { scalar: "String", idClass: "token", tokenStitch: true },
      token1: { scalar: "String", idClass: "token", tokenStitch: true },
      feeTier: NUM,
      liquidity: NUM,
      sqrtPrice: NUM,
      token0Price: NUM,
      token1Price: NUM,
      tick: NUM,
      tickSpacing: NUM,
      observationIndex: NUM,
      volumeToken0: NUM,
      volumeToken1: NUM,
      volumeUSD: NUM,
      untrackedVolumeUSD: NUM,
      feesUSD: NUM,
      feesUSDUntracked: NUM,
      txCount: NUM,
      collectedFeesToken0: NUM,
      collectedFeesToken1: NUM,
      collectedFeesUSD: NUM,
      totalValueLockedToken0: NUM,
      totalValueLockedToken1: NUM,
      totalValueLockedETH: NUM,
      totalValueLockedUSD: NUM,
      totalValueLockedUSDUntracked: NUM,
      liquidityProviderCount: NUM,
      hooks: STR,
      ticks: { scalar: "String", list: { entity: "Tick" } },
      poolDayData: { scalar: "String", list: { entity: "PoolDayData" } },
      poolHourData: { scalar: "String", list: { entity: "PoolHourData" } },
    },
  },
  Token: {
    table: "Token",
    idClass: "token",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "token" },
      chainId: NUM,
      symbol: STR,
      name: STR,
      decimals: NUM,
      totalSupply: NUM,
      volume: NUM,
      volumeUSD: NUM,
      untrackedVolumeUSD: NUM,
      feesUSD: NUM,
      txCount: NUM,
      poolCount: NUM,
      totalValueLocked: NUM,
      totalValueLockedUSD: NUM,
      totalValueLockedUSDUntracked: NUM,
      derivedETH: NUM,
      tokenDayData: { scalar: "String", list: { entity: "TokenDayData" } },
      tokenHourData: { scalar: "String", list: { entity: "TokenHourData" } },
    },
  },
  // Bundle has NO chainId column — its id IS the chain id.
  Bundle: {
    table: "Bundle",
    idClass: "bundle",
    chainScoped: false,
    fields: {
      id: { scalar: "String", idClass: "bundle" },
      ethPriceUSD: NUM,
    },
  },
  Tick: {
    table: "Tick",
    idClass: "tick",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "tick" },
      chainId: NUM,
      pool: { scalar: "String", ref: { entity: "Pool" } },
      tickIdx: NUM,
      liquidityGross: NUM,
      liquidityNet: NUM,
      price0: NUM,
      price1: NUM,
      createdAtTimestamp: NUM,
      createdAtBlockNumber: NUM,
    },
  },
  PoolDayData: {
    table: "PoolDayData",
    idClass: "interval",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "interval" },
      chainId: NUM,
      date: INT,
      pool: { scalar: "String", ref: { entity: "Pool" } },
      liquidity: NUM,
      sqrtPrice: NUM,
      token0Price: NUM,
      token1Price: NUM,
      tick: NUM,
      tvlUSD: NUM,
      volumeToken0: NUM,
      volumeToken1: NUM,
      volumeUSD: NUM,
      feesUSD: NUM,
      txCount: NUM,
      open: NUM,
      high: NUM,
      low: NUM,
      close: NUM,
    },
  },
  PoolHourData: {
    table: "PoolHourData",
    idClass: "interval",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "interval" },
      chainId: NUM,
      periodStartUnix: INT,
      pool: { scalar: "String", ref: { entity: "Pool" } },
      liquidity: NUM,
      sqrtPrice: NUM,
      token0Price: NUM,
      token1Price: NUM,
      tick: NUM,
      tvlUSD: NUM,
      volumeToken0: NUM,
      volumeToken1: NUM,
      volumeUSD: NUM,
      feesUSD: NUM,
      txCount: NUM,
      open: NUM,
      high: NUM,
      low: NUM,
      close: NUM,
    },
  },
  TokenDayData: {
    table: "TokenDayData",
    idClass: "interval",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "interval" },
      chainId: NUM,
      date: INT,
      token: { scalar: "String", ref: { entity: "Token" } },
      volume: NUM,
      volumeUSD: NUM,
      untrackedVolumeUSD: NUM,
      totalValueLocked: NUM,
      totalValueLockedUSD: NUM,
      priceUSD: NUM,
      feesUSD: NUM,
      open: NUM,
      high: NUM,
      low: NUM,
      close: NUM,
    },
  },
  TokenHourData: {
    table: "TokenHourData",
    idClass: "interval",
    chainScoped: true,
    fields: {
      id: { scalar: "String", idClass: "interval" },
      chainId: NUM,
      periodStartUnix: INT,
      token: { scalar: "String", ref: { entity: "Token" } },
      volume: NUM,
      volumeUSD: NUM,
      untrackedVolumeUSD: NUM,
      totalValueLocked: NUM,
      totalValueLockedUSD: NUM,
      priceUSD: NUM,
      feesUSD: NUM,
      open: NUM,
      high: NUM,
      low: NUM,
      close: NUM,
    },
  },
};

export interface RootFieldSpec {
  readonly entity: string;
  /** `single` unwraps to `row ?? null`; `list` returns the array. */
  readonly kind: "single" | "list";
}

/*
 * Only the root fields the backend actually issues. Anything else is a hard
 * TranslationError rather than a silently-empty result — adding one is a line
 * here plus its EntitySpec above.
 */
export const ROOT_FIELDS: Readonly<Record<string, RootFieldSpec>> = {
  pools: { entity: "Pool", kind: "list" },
  pool: { entity: "Pool", kind: "single" },
  tokens: { entity: "Token", kind: "list" },
  token: { entity: "Token", kind: "single" },
  bundles: { entity: "Bundle", kind: "list" },
  bundle: { entity: "Bundle", kind: "single" },
  ticks: { entity: "Tick", kind: "list" },
  tick: { entity: "Tick", kind: "single" },
  poolDayDatas: { entity: "PoolDayData", kind: "list" },
  poolHourDatas: { entity: "PoolHourData", kind: "list" },
  tokenDayDatas: { entity: "TokenDayData", kind: "list" },
  tokenHourDatas: { entity: "TokenHourData", kind: "list" },
  positions: { entity: "Position", kind: "list" },
  position: { entity: "Position", kind: "single" },
  positionTransactions: { entity: "PositionTransaction", kind: "list" },
  positionTransaction: { entity: "PositionTransaction", kind: "single" },
};

/** The Graph's where-suffix grammar -> Hasura comparison operators. */
export const WHERE_OPS: Readonly<Record<string, string>> = {
  "": "_eq",
  _not: "_neq",
  _gt: "_gt",
  _gte: "_gte",
  _lt: "_lt",
  _lte: "_lte",
  _in: "_in",
  _not_in: "_nin",
};

/** Longest-first so `_not_in` wins over `_in`, and `_gte` over `_gt`. */
export const WHERE_SUFFIXES: readonly string[] = Object.keys(WHERE_OPS)
  .filter((s) => s !== "")
  .sort((a, b) => b.length - a.length);

/** The Graph caps a page at 1000 rows and errors above it. Match that. */
export const MAX_FIRST = 1000;
/** The Graph's default page size when `first` is omitted. */
export const DEFAULT_FIRST = 100;
