/*
 * P2.3 read-time overlay (design §4.6). Pure: no clock, no I/O.
 *
 * With `POSITIONS_WRITE_SKIP=on` an unchanged position is not rewritten, so
 * three SERVED fields that today move on every normalize stop moving on the
 * stored row:
 *  - `metrics.ageSeconds` — computed here instead, EXACTLY as the adapter's
 *    normalize does: (closedAt when it is after createdAt, else now) −
 *    createdAt, floored at 0. For a closed row that equals the stored value.
 *  - `lastSyncedAt` and `pricing.pricedAt` ("verified / priced against the
 *    indexer at") — for an ACTIVE row with `staleMisses == 0` only, the later
 *    of the stored value and the shard's `lastCleanRefreshAt` (the START of the
 *    latest refresh whose stale sweep ran to completion). Such a row was seen
 *    by that refresh — a row it did not see has `staleMisses > 0` after the
 *    sweep and keeps its stored time. A missing stored value is not invented.
 *
 * With skip `off` / `shadow` the stored values are as fresh as today, so
 * nothing is overlaid; `staleMisses` (projected only for this, see
 * `PositionsRepository.listProjection`) is stripped in every mode. The input
 * row is never mutated (window-cache rows are shared between requests); a
 * Date stays a Date and an ISO string (a row reloaded from a Redis snapshot)
 * stays a string.
 */

export interface ServedClockContext {
  /** `POSITIONS_WRITE_SKIP`; the overlay applies only to `on`. */
  mode: string;
  /** Now, in ms (the request's clock). */
  nowMs: number;
  /** The shard's `SyncRepository.lastCleanRefreshAt` (undefined / null = unknown: no time overlay). */
  lastCleanRefreshAt?: Date | null;
}

/** The fields the overlay reads; any other field passes through untouched. */
export interface ServedClockRow {
  isActive?: unknown;
  createdAtTimestamp?: unknown;
  closedAtTimestamp?: unknown;
  staleMisses?: unknown;
  lastSyncedAt?: unknown;
  metrics?: unknown;
  pricing?: unknown;
}

/** The adapter's age rule (`envio.adapter.ts` normalize), at `nowMs`. Undefined when `createdAt` is not a number. */
export function servedAgeSeconds(createdAtTimestamp: unknown, closedAtTimestamp: unknown, nowMs: number): number | undefined {
  if (typeof createdAtTimestamp !== 'number' || !Number.isFinite(createdAtTimestamp)) return undefined;
  const closedAt = typeof closedAtTimestamp === 'number' && Number.isFinite(closedAtTimestamp) ? closedAtTimestamp : null;
  const end = closedAt && closedAt > createdAtTimestamp ? closedAt : Math.floor(nowMs / 1000);
  return Math.max(0, end - createdAtTimestamp);
}

function timeOf(value: unknown): number | undefined {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : undefined;
  }
  if (typeof value === 'string' && value !== '') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/** The later of `stored` and `floor`, in `stored`'s own representation. Missing / unparsable `stored` stays as is. */
function laterOf(stored: unknown, floorMs: number): unknown {
  const t = timeOf(stored);
  if (t === undefined || t >= floorMs) return stored;
  return stored instanceof Date ? new Date(floorMs) : new Date(floorMs).toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/** The row as served (see the file comment). Returns the SAME object when there is nothing to change. */
export function applyServedClockOverlay<T extends ServedClockRow>(row: T, ctx: ServedClockContext): T {
  const hasStale = Object.prototype.hasOwnProperty.call(row, 'staleMisses');
  if (ctx.mode !== 'on') {
    if (!hasStale) return row;
    const { staleMisses: _drop, ...rest } = row;
    return rest as T;
  }

  const patch: Record<string, unknown> = {};
  const age = servedAgeSeconds(row.createdAtTimestamp, row.closedAtTimestamp, ctx.nowMs);
  if (age !== undefined && isObject(row.metrics) && row.metrics.ageSeconds !== age) {
    patch.metrics = { ...row.metrics, ageSeconds: age };
  }

  const floorMs = timeOf(ctx.lastCleanRefreshAt ?? undefined);
  const staleMisses = typeof row.staleMisses === 'number' ? row.staleMisses : 0;
  if (floorMs !== undefined && row.isActive === true && staleMisses === 0) {
    const synced = laterOf(row.lastSyncedAt, floorMs);
    if (synced !== row.lastSyncedAt) patch.lastSyncedAt = synced;
    if (isObject(row.pricing)) {
      const priced = laterOf(row.pricing.pricedAt, floorMs);
      if (priced !== row.pricing.pricedAt) patch.pricing = { ...row.pricing, pricedAt: priced };
    }
  }
  if (!hasStale && Object.keys(patch).length === 0) return row;
  const out: Record<string, unknown> = { ...row, ...patch };
  delete out.staleMisses;
  return out as T;
}

/** `applyServedClockOverlay` over a page; the same array when no row changed. */
export function applyServedClockOverlayAll<T extends ServedClockRow>(rows: readonly T[], ctx: ServedClockContext): T[] {
  let changed = false;
  const out = rows.map((row) => {
    const next = applyServedClockOverlay(row, ctx);
    if (next !== row) changed = true;
    return next;
  });
  return changed ? out : (rows as T[]);
}
