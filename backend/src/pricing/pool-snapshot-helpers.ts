import type { PoolSnapshot } from '../subgraph/position-adapter.js';

/**
 * Fetch a pool's historical snapshots for derivation pricing. Implemented by
 * the subgraph layer and registered with the pool-ratio price provider at
 * module init — the pricing layer must not take a direct dependency on the
 * subgraph module (would cycle), so it goes through this interface instead.
 */
export interface PoolSnapshotFetcher {
  fetchSnapshots(opts: {
    chainId: number;
    protocol: string;
    poolId: string;
    fromTimestamp: number;
    toTimestamp: number;
  }): Promise<PoolSnapshot[]>;
}

/**
 * Binary-search the rightmost snapshot with `timestamp <= targetTs`. Returns
 * `null` if every snapshot is strictly after the target. Caller falls back to
 * the next pricing path.
 */
export function nearestSnapshotAtOrBefore(
  snapshots: PoolSnapshot[],
  targetTs: number,
): PoolSnapshot | null {
  if (snapshots.length === 0) return null;
  let lo = 0;
  let hi = snapshots.length - 1;
  let candidate: PoolSnapshot | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const snap = snapshots[mid];
    if (!snap) break;
    if (snap.timestamp <= targetTs) {
      candidate = snap;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return candidate;
}
