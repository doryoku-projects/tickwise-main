import { parseShardKey, type ReadModelName, type ShardKey } from './core/fields.js';
import { ShardTable } from './core/row-store.js';
import { RELOAD_SHARE } from './memory-guard.js';
import { RANK_PERMS, RankColumns } from './rank/rank-columns.js';

/**
 * `READ_MODELS_POSITIONS_CAPACITY` (audit C-cap): rows reserved for a
 * positions (rank) table when it is created or loaded from a snapshot.
 *
 *  - `0` / unset: no reservation — a new table starts at 1,024 rows, a loaded
 *    one at 1.5 × its rows + 16, and both grow by doubling.
 *  - a plain number N (unchanged meaning): EVERY positions table reserves N
 *    rows (`max(rows, N)` at load). With 4 tables, 6,000,000 reserves ~4 × the
 *    one table that needs it, and the memory guard counts all of it.
 *  - `chainId:rows,…` (e.g. `4663:6000000,1:600000`): per chain, applied to
 *    each positions table of that chain (one per protocol); a chain not
 *    listed keeps the no-reservation growth above.
 *
 * The env is parsed and validated by `AppConfigService` (garbage fails the
 * boot); this module only resolves the parsed value per shard. The pool
 * catalog's tables are never reserved.
 */
export type PositionsCapacity = number | { readonly perChain: Readonly<Record<number, number>> };

/** A new (empty) table's capacity when nothing is reserved. */
export const DEFAULT_TABLE_CAPACITY = 1024;

/** Rows reserved for the positions table of `shard` (0 = none: default growth). */
export function reservedRows(capacity: PositionsCapacity | undefined, shard: ShardKey): number {
  if (capacity === undefined || capacity === null) return 0;
  const raw = typeof capacity === 'number' ? capacity : capacity.perChain[parseShardKey(shard).chainId];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  const rows = Math.floor(raw);
  return rows > 0 ? rows : 0;
}

/** Capacity of a table created empty (a scan, a delta for a shard with no table). */
export function createCapacity(capacity: PositionsCapacity | undefined, model: ReadModelName, shard: ShardKey): number {
  const reserved = model === 'rank' ? reservedRows(capacity, shard) : 0;
  return reserved > 0 ? reserved : DEFAULT_TABLE_CAPACITY;
}

/** Capacity of a table loaded from a snapshot holding `rows` rows. */
export function loadCapacity(capacity: PositionsCapacity | undefined, model: ReadModelName, shard: ShardKey, rows: number): number {
  const reserved = model === 'rank' ? reservedRows(capacity, shard) : 0;
  return reserved > 0 ? Math.max(rows, reserved) : Math.ceil(rows * (model === 'rank' ? 1.5 : 1.25)) + 16;
}

/** The configured value as the status shows it. */
export function describeCapacity(capacity: PositionsCapacity | undefined):
  | { mode: 'growth' }
  | { mode: 'every_table'; rows: number }
  | { mode: 'per_chain'; perChain: Record<string, number> } {
  if (capacity === undefined || capacity === null) return { mode: 'growth' };
  if (typeof capacity === 'number') {
    const rows = Number.isFinite(capacity) ? Math.floor(capacity) : 0;
    return rows > 0 ? { mode: 'every_table', rows } : { mode: 'growth' };
  }
  const perChain: Record<string, number> = {};
  for (const [chainId, rows] of Object.entries(capacity.perChain)) perChain[chainId] = rows;
  return { mode: 'per_chain', perChain };
}

let rowBytesMemo: number | undefined;
let engineRowBytesMemo: number | undefined;

/**
 * Off-heap bytes one reserved positions row costs in an R1 table (the
 * marginal cost: columns + the oid map, measured on two empty tables).
 */
export function rankRowBytes(): number {
  if (rowBytesMemo === undefined) {
    const small = new ShardTable('rank', '0:probe', 1024).memoryBytes;
    const large = new ShardTable('rank', '0:probe', 2048).memoryBytes;
    rowBytesMemo = Math.max(1, (large - small) / 1024);
  }
  return rowBytesMemo;
}

/**
 * Off-heap bytes one reserved positions row costs in the RANK ENGINE's frozen
 * copy, which `RankEngine.copyShard` sizes from the R1 table's capacity
 * (`max(capacity, slots × 1.1) + 1024`): its `RankColumns`, the A/B sets of
 * `RANK_PERMS` permutations (u32 each) and the A/B pool and owner CSR orders
 * (u32 each). Measured the same way as `rankRowBytes`; ~1.2 × the R1 cost, so
 * a replica running the engine needs ~2.2 × the R1 bytes per reserved row.
 */
export function rankEngineRowBytes(): number {
  if (engineRowBytesMemo === undefined) {
    const cols = (new RankColumns(2048).memoryBytes - new RankColumns(1024).memoryBytes) / 1024;
    const perms = RANK_PERMS.length * 2 * 4;
    const csrs = 2 * 2 * 4;
    engineRowBytesMemo = Math.max(1, cols + perms + csrs);
  }
  return engineRowBytesMemo;
}

export interface CapacityReport {
  configured: ReturnType<typeof describeCapacity>;
  /** Rows reserved per served positions shard (only the shards with a reservation). */
  shards: Record<ShardKey, number>;
  reservedRows: number;
  /** Whether this replica runs the rank engine (its frozen copy is sized from the reservation too). */
  engine: boolean;
  /** R1 table bytes of the reservation, before any row is loaded. */
  r1Mb: number;
  /** The rank engine's copy of the reservation (0 on a replica that runs no engine). */
  engineMb: number;
  /** r1Mb + engineMb: what the reservation alone adds to the bytes the guard counts. */
  estimatedMb: number;
  /** The memory guard's off-heap cap, or null when there is none. */
  capMb: number | null;
  /** The reservation alone exceeds the guard's cap: the guard would unload rank on load. */
  overCap: boolean;
  /**
   * The reservation alone exceeds `RELOAD_SHARE` (70%) of the cap: once the
   * guard sheds rank it can never come back (it reloads only under 70%).
   */
  overReload: boolean;
}

/**
 * What `capacity` reserves across the served positions shards, against the
 * guard's cap. `engine`: this replica runs the rank engine (READ_MODELS_ROLE
 * both / server with rank on), whose copy is sized from the same capacity —
 * the guard counts every ArrayBuffer in the process, so both are counted.
 */
export function capacityReport(
  capacity: PositionsCapacity | undefined,
  rankShards: readonly ShardKey[],
  capBytes: number | undefined,
  engine = true,
): CapacityReport {
  const shards: Record<ShardKey, number> = {};
  let total = 0;
  for (const shard of rankShards) {
    const rows = reservedRows(capacity, shard);
    if (rows <= 0) continue;
    shards[shard] = rows;
    total += rows;
  }
  const r1Bytes = total > 0 ? total * rankRowBytes() : 0;
  const engineBytes = total > 0 && engine ? total * rankEngineRowBytes() : 0;
  const bytes = r1Bytes + engineBytes;
  const capped = capBytes !== undefined && capBytes > 0;
  return {
    configured: describeCapacity(capacity),
    shards,
    reservedRows: total,
    engine,
    r1Mb: Math.round(r1Bytes / 1_048_576),
    engineMb: Math.round(engineBytes / 1_048_576),
    estimatedMb: Math.round(bytes / 1_048_576),
    capMb: capBytes ? Math.round(capBytes / 1_048_576) : null,
    overCap: capped && bytes > capBytes,
    overReload: capped && bytes > capBytes * RELOAD_SHARE,
  };
}
