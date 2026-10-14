/**
 * The read models' row layout (Phase P-R, design §3.3 `FEEDER_PROJECTION`).
 *
 * Two models, one change stream:
 *  - `rank`  — one row per POSITION document (`{chainId}_{protocol}_positions`),
 *    what the positions rank engine (R3) filters, sorts and counts;
 *  - `pools` — one row per POOL document (`{chainId}_{protocol}_pools`), the
 *    pool catalog (R2).
 *
 * A row is the ordered list of its model's LEAVES. Every leaf of every row is
 * kept (design §6.1: no "rows with value only" side table), so any feeder
 * candidate can turn a dotted-leaf update into a full row state.
 *
 * The order of each list is part of the delta and snapshot wire formats (a
 * row record carries its cells positionally): APPEND new leaves, never reorder
 * or remove one — a snapshot column the loader does not know is a field
 * backfill (§3.5), a reordered list is silent corruption.
 */

export type ReadModelName = 'rank' | 'pools';
export const READ_MODEL_NAMES: readonly ReadModelName[] = ['rank', 'pools'];

/**
 * What a leaf holds, which decides the classes its cells may take:
 *  - `num`  — a number (f64; NaN and ±Infinity are native, -0 is stored as +0)
 *  - `str`  — a string (interned per shard)
 *  - `bool` — true / false
 *  - `pid`  — a canonical decimal id string `0 | [1-9][0-9]*` below 2^32,
 *             stored as a u32 (positionId / tokenId). Anything else is odd.
 * null and missing are ONE class everywhere (MongoDB orders and filters them
 * alike for every operator the engines use). Anything outside a leaf's
 * native classes is ODD and quarantines that (shard, field) (§4.8).
 */
export type LeafKind = 'num' | 'str' | 'bool' | 'pid';

export interface LeafSpec {
  /** Short column name (snapshot columns are `<name>.cls` / `<name>.val`). */
  readonly name: string;
  /** The document path, e.g. `metrics.aprExGas`. */
  readonly path: string;
  /** First path segment (`metrics`), or the whole path for a top-level leaf. */
  readonly top: string;
  /** Second segment, undefined for a top-level leaf. Every leaf is at most two deep. */
  readonly sub?: string;
  readonly kind: LeafKind;
}

function leaf(name: string, path: string, kind: LeafKind): LeafSpec {
  const dot = path.indexOf('.');
  return dot < 0
    ? { name, path, top: path, kind }
    : { name, path, top: path.slice(0, dot), sub: path.slice(dot + 1), kind };
}

/**
 * Whether the rank model carries the `fee` leaf (spam-and-pool-mismatch fix 2),
 * decided ONCE per process at module load — the leaf layout must be the same
 * in the main thread and in every read-model worker (each re-imports this
 * module; `worker_threads` inherit `process.env`, which `main.ts` fills from
 * `.env` through `dotenv/config` before any other import).
 *
 * It follows `HONEYPOT_FEE_FILTER` (the `AppConfigService` getter is the
 * typed source of the flag; this pure module cannot reach DI, so it reads the
 * same variable): OFF (the default) is today's 20-leaf layout exactly — the
 * flag-off deploy rewrites no snapshot, raises no field backfill and rescans
 * no shard. Switching the flag ON (a restart) appends the leaf: every
 * positions snapshot then loads it as missing and the holder rescans each
 * positions shard once (an intended, off-peak, one-time backfill). A mismatch
 * between the two reads is safe either way: flag on without the leaf
 * compiles the honeypot clause to `unsupported:field:fee` (Mongo answers);
 * the leaf without the flag is a column no filter reads.
 */
export function rankFeeLeafEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env.HONEYPOT_FEE_FILTER ?? '').trim().toLowerCase() === 'on';
}

/** Positions (the rank model), design §3.3. */
const RANK_BASE_LEAVES: readonly LeafSpec[] = [
  leaf('chainId', 'chainId', 'num'),
  leaf('protocol', 'protocol', 'str'),
  leaf('positionId', 'positionId', 'pid'),
  leaf('tokenId', 'tokenId', 'pid'),
  leaf('owner', 'owner', 'str'),
  leaf('poolId', 'poolId', 'str'),
  leaf('isActive', 'isActive', 'bool'),
  leaf('createdAt', 'createdAtTimestamp', 'num'),
  leaf('token0', 'token0.address', 'str'),
  leaf('token1', 'token1.address', 'str'),
  leaf('value', 'metrics.underlyingValueUsd', 'num'),
  leaf('pnl', 'metrics.poolPnlUsd', 'num'),
  leaf('aprExGas', 'metrics.aprExGas', 'num'),
  leaf('feeApr', 'metrics.feeApr', 'num'),
  leaf('roi', 'metrics.roi', 'num'),
  leaf('inRange', 'metrics.inRange', 'bool'),
  leaf('perfReady', 'metrics.performanceReady', 'bool'),
  leaf('poolTvl', 'poolStats.tvlUsd', 'num'),
  leaf('source', 'pricing.source', 'str'),
  leaf('usedFallback', 'pricing.usedFallback', 'bool'),
];

/**
 * The pool's LP fee in pips, read by the honeypot-fee clause — APPENDED, and
 * only while `HONEYPOT_FEE_FILTER=on` (`rankFeeLeafEnabled`). A snapshot
 * written without it loads it as missing and the holder rescans the shard.
 */
export const RANK_FEE_LEAF: LeafSpec = leaf('fee', 'fee', 'num');

/** The rank model's leaves for one flag value (exported for the layout specs). */
export function rankLeavesFor(withFee: boolean): readonly LeafSpec[] {
  return withFee ? [...RANK_BASE_LEAVES, RANK_FEE_LEAF] : RANK_BASE_LEAVES;
}

export const RANK_LEAVES: readonly LeafSpec[] = rankLeavesFor(rankFeeLeafEnabled());

/** Pools (the pool catalog), design §3.3. */
export const POOL_LEAVES: readonly LeafSpec[] = [
  leaf('chainId', 'chainId', 'num'),
  leaf('protocol', 'protocol', 'str'),
  leaf('poolId', 'poolId', 'str'),
  leaf('createdAt', 'createdAtTimestamp', 'num'),
  leaf('token0', 'token0.address', 'str'),
  leaf('symbol0', 'token0.symbol', 'str'),
  leaf('token1', 'token1.address', 'str'),
  leaf('symbol1', 'token1.symbol', 'str'),
  leaf('tvl', 'metrics.tvlUsd', 'num'),
  leaf('vol24', 'metrics.volumeUsd24h', 'num'),
  leaf('fees24', 'metrics.feesUsd24h', 'num'),
  leaf('feeApr', 'metrics.feeApr', 'num'),
  leaf('source', 'pricing.source', 'str'),
  leaf('usedFallback', 'pricing.usedFallback', 'bool'),
];

export function leavesOf(model: ReadModelName): readonly LeafSpec[] {
  return model === 'rank' ? RANK_LEAVES : POOL_LEAVES;
}

/** Leaf index by path, per model. */
const INDEX_BY_PATH: Record<ReadModelName, ReadonlyMap<string, number>> = {
  rank: new Map(RANK_LEAVES.map((spec, i) => [spec.path, i])),
  pools: new Map(POOL_LEAVES.map((spec, i) => [spec.path, i])),
};

export function leafIndex(model: ReadModelName, path: string): number {
  return INDEX_BY_PATH[model].get(path) ?? -1;
}

/** Leaf indexes under one top-level object (`metrics` → value, pnl, …), per model. */
export function leavesUnder(model: ReadModelName, top: string): readonly number[] {
  return UNDER[model].get(top) ?? EMPTY;
}

const EMPTY: readonly number[] = [];
const UNDER: Record<ReadModelName, ReadonlyMap<string, readonly number[]>> = {
  rank: groupUnder(RANK_LEAVES),
  pools: groupUnder(POOL_LEAVES),
};

function groupUnder(leaves: readonly LeafSpec[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  leaves.forEach((spec, i) => {
    if (!spec.sub) return;
    const list = out.get(spec.top) ?? [];
    list.push(i);
    out.set(spec.top, list);
  });
  return out;
}

/**
 * The objects whose leaves the engines read (union over both models), with
 * the leaves the change-stream trim keeps from each (§3.1 step 2). A write
 * that `$set`s one of these whole replaces its leaves (§3.3 subtree replace).
 */
export const SUBTREE_LEAVES: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, Set<string>>();
  for (const spec of [...RANK_LEAVES, ...POOL_LEAVES]) {
    if (!spec.sub) continue;
    const set = out.get(spec.top) ?? new Set<string>();
    set.add(spec.sub);
    out.set(spec.top, set);
  }
  return new Map([...out].map(([top, set]) => [top, [...set].sort()]));
})();

/** Top-level document fields the engines read (union over both models). */
export const ENGINE_TOP_FIELDS: readonly string[] = [
  ...new Set([...RANK_LEAVES, ...POOL_LEAVES].map((spec) => spec.top)),
].sort();

/** Shard = one (chainId, protocol) pair, e.g. `1:uniswap-v4`. */
export type ShardKey = string;

export function shardKey(chainId: number, protocol: string): ShardKey {
  return `${chainId}:${protocol}`;
}

export function parseShardKey(key: ShardKey): { chainId: number; protocol: string } {
  const at = key.indexOf(':');
  return { chainId: Number(key.slice(0, at)), protocol: key.slice(at + 1) };
}

/** `uniswap-v4` → `uniswap_v4`, as `CollectionResolver` names collections. */
export function collectionProtocol(protocol: string): string {
  return protocol.replace(/-/g, '_');
}

/** The collection a (model, shard) is fed from. */
export function collectionOf(model: ReadModelName, chainId: number, protocol: string): string {
  return `${chainId}_${collectionProtocol(protocol)}_${model === 'rank' ? 'positions' : 'pools'}`;
}

/** The namespace filter of the change stream: positions and pools shards (not `_position_transactions`). */
export const SHARD_COLLECTION_RX = /_(positions|pools)$/;
