import { Logger } from '@nestjs/common';
import { normalizeHooks } from '../common/pool-hooks.js';

/**
 * The hook of each POOL a page of POSITION rows belongs to, read from the pools
 * collection at serve time.
 *
 * Why not on the position document: `fee` reaches a position row because the
 * position sync writes it there, but a field the position sync starts writing
 * only appears on a stored row when that row is next rewritten — and with
 * `POSITIONS_WRITE_SKIP=on` an unchanged row is NOT rewritten, so the badge
 * would need a field backfill across every position of every hooked pool (and
 * the positions read models' rows are projected from those documents). The
 * pools collection already holds `hooks` (pool sync, `PoolUpsert.hooks`), keyed
 * by the unique `(chainId, protocol, poolId)` index, so a page needs ONE `$in`
 * per shard on it, and nothing about a stored position changes.
 *
 * A pool's hook is part of its key, so it can never change for a `poolId`:
 * every pool that exists is remembered for good (a bounded map, oldest out
 * first), hooked or not, and a warm page costs no read at all. A pool the
 * collection does not hold yet (pool sync has not reached it) is NOT
 * remembered as hook-less — it is asked again after `missTtlMs` — so the badge
 * appears once the pool is synced.
 *
 * Never fails a page and never holds one: a failed read, or one slower than
 * `deadlineMs`, serves the rows without the badge for the pools it did not
 * answer (a slow read carries on and fills the map for the next page).
 */
export type PoolHooksLoader = (
  chainId: number,
  protocol: string,
  poolIds: string[],
) => Promise<Array<{ poolId: string; hooks?: string }>>;

export interface PoolHooksCacheOptions {
  /** Remembered pools (default 50,000 — a few MB). */
  maxEntries?: number;
  /** How long a pool the collection did not hold is not asked about again (default 5 min). */
  missTtlMs?: number;
  /** The longest a page waits for the read (default 1.5 s). */
  deadlineMs?: number;
  now?: () => number;
}

const WARN_EVERY_MS = 60_000;

export class PoolHooksCache {
  private readonly logger = new Logger(PoolHooksCache.name);
  /** `chainId:protocol:poolId` → the lower-cased hook, or `null` for a pool without one. */
  private readonly known = new Map<string, string | null>();
  private readonly missingUntil = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly missTtlMs: number;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private lastWarnAt = 0;

  constructor(
    private readonly load: PoolHooksLoader,
    options: PoolHooksCacheOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? 50_000;
    this.missTtlMs = options.missTtlMs ?? 5 * 60_000;
    this.deadlineMs = options.deadlineMs ?? 1_500;
    this.now = options.now ?? Date.now;
  }

  static key(chainId: number, protocol: string, poolId: unknown): string {
    return `${chainId}:${protocol}:${typeof poolId === 'string' ? poolId.toLowerCase() : ''}`;
  }

  /**
   * `key(chainId, protocol, poolId)` → hook address, for the hooked pools among
   * `rows` only. Never rejects.
   */
  async hooksFor(rows: ReadonlyArray<{ chainId: number; protocol: string; poolId: string }>): Promise<Map<string, string>> {
    const nowMs = this.now();
    const wanted = new Map<string, { chainId: number; protocol: string; poolIds: Set<string> }>();
    for (const row of rows) {
      if (typeof row.poolId !== 'string' || row.poolId.length === 0) continue;
      const key = PoolHooksCache.key(row.chainId, row.protocol, row.poolId);
      if (this.known.has(key)) continue;
      if ((this.missingUntil.get(key) ?? 0) > nowMs) continue;
      const shard = `${row.chainId}:${row.protocol}`;
      let entry = wanted.get(shard);
      if (!entry) wanted.set(shard, (entry = { chainId: row.chainId, protocol: row.protocol, poolIds: new Set() }));
      entry.poolIds.add(row.poolId.toLowerCase());
    }
    if (wanted.size > 0) await this.fill([...wanted.values()], nowMs);
    const out = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.poolId !== 'string') continue;
      const key = PoolHooksCache.key(row.chainId, row.protocol, row.poolId);
      const hooks = this.known.get(key);
      if (hooks) out.set(key, hooks);
    }
    return out;
  }

  /** One read per shard, in parallel, raced against the deadline; the reads outlive it and fill the map. */
  private async fill(shards: Array<{ chainId: number; protocol: string; poolIds: Set<string> }>, nowMs: number): Promise<void> {
    const reads = shards.map(async ({ chainId, protocol, poolIds }) => {
      const ids = [...poolIds];
      try {
        const found = await this.load(chainId, protocol, ids);
        const byId = new Map(found.map((doc) => [String(doc.poolId).toLowerCase(), doc.hooks]));
        for (const id of ids) {
          const key = PoolHooksCache.key(chainId, protocol, id);
          if (byId.has(id)) this.remember(key, normalizeStored(byId.get(id)));
          else this.missingUntil.set(key, nowMs + this.missTtlMs);
        }
        this.trimMisses(nowMs);
      } catch (err) {
        this.warn(chainId, protocol, err);
      }
    });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.deadlineMs);
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.all(reads), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private remember(key: string, hooks: string | null): void {
    this.known.set(key, hooks);
    this.missingUntil.delete(key);
    while (this.known.size > this.maxEntries) {
      const oldest = this.known.keys().next();
      if (oldest.done) break;
      this.known.delete(oldest.value);
    }
  }

  private trimMisses(nowMs: number): void {
    if (this.missingUntil.size <= this.maxEntries) return;
    for (const [key, until] of this.missingUntil) if (until <= nowMs) this.missingUntil.delete(key);
    while (this.missingUntil.size > this.maxEntries) {
      const oldest = this.missingUntil.keys().next();
      if (oldest.done) break;
      this.missingUntil.delete(oldest.value);
    }
  }

  private warn(chainId: number, protocol: string, err: unknown): void {
    const at = this.now();
    if (at - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = at;
    this.logger.warn(
      `pool hooks read failed chain=${chainId} protocol=${protocol}: ${(err as Error)?.message ?? String(err)} — served the page without hook badges`,
    );
  }
}

/** A stored `hooks` value: already normalised by pool sync, but never trust the document. */
function normalizeStored(value: unknown): string | null {
  return normalizeHooks(value) ?? null;
}
