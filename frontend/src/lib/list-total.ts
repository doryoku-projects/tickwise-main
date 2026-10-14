import { useEffect, useRef, useState } from 'react';
import type { ListCount, ListPagination } from './api';

/**
 * The size of a list result set, for a page that no longer waits on its count.
 *
 * The list routes answer with `total: null, totalPending: true` when the
 * backend has not counted that filter yet (a cold count can take seconds, and
 * it used to be on the page's critical path). This hook then asks the matching
 * `/count` route — ONCE per filter, not once per page: paging through a result
 * set does not change its size, so page 2 reuses page 1's count, and a count
 * already in flight for the same filter is never started twice. Switching
 * filter aborts the count nobody needs any more.
 *
 * `hasMore` on the page is exact, so the pager never depends on this: it only
 * decides what the "N positions" / "page X of Y" text says while the count is
 * outstanding ("…"), and whether a capped count reads "N+".
 *
 * The `/count` routes never fail: a count the backend has not finished yet
 * answers `pending: true`. That answer is not stored — the hook asks again
 * after `COUNT_REPOLL_MS`, at most `COUNT_REPOLLS` times, and then waits for
 * the next list response like a failed count.
 *
 * A PARTIAL page (an all-chains page that left out a chain whose shard
 * failed: `partial` + `missingChains`) never asks: the `/count` route counts
 * every enabled chain, so its number — or one cached for the same filter from
 * a complete page — would include rows the page cannot show. Such a page shows
 * only a total it carries itself (the backend's, over the chains on it), else
 * none.
 */

/** Delay before re-asking a `/count` route that answered `pending`. */
export const COUNT_REPOLL_MS = 3_000;
/** Re-asks after the first `pending` answer (4 requests at most per filter). */
export const COUNT_REPOLLS = 3;

export interface ListTotal {
  /** Null while not known — pending, or the count request failed. */
  total: number | null;
  /** The count stopped at the backend cap: `total` is a floor, render "N+". */
  capped: boolean;
  /** No total yet. A failed count stays here too, until the next list response retries it. */
  pending: boolean;
}

/** A session visits a handful of filters; this only bounds a pathological one. */
const MAX_CACHED = 50;

const UNKNOWN: ListTotal = { total: null, capped: false, pending: false };

/**
 * `pagination` and `countKey` MUST describe the same request — pass the key of
 * the filter that produced the page on screen, not of the filter currently
 * selected. While a new filter's page is loading the old page is still
 * displayed, and pairing its `totalPending` with the new key would fire a count
 * for a filter whose own page may well come back with a total.
 */
export function useListTotal(
  pagination: ListPagination | null | undefined,
  countKey: string,
  fetchCount: (signal: AbortSignal) => Promise<ListCount>,
  /** The page on screen left out a chain (`partial`): no `/count` follow-up, no cached full-set count. */
  partial = false,
): ListTotal {
  const fetchRef = useRef(fetchCount);
  fetchRef.current = fetchCount;
  const [counts, setCounts] = useState<ReadonlyMap<string, ListCount>>(() => new Map());
  const inFlight = useRef<{ key: string; controller: AbortController; timer?: ReturnType<typeof setTimeout> } | null>(
    null,
  );

  useEffect(() => {
    // A count for a filter that is no longer on screen is wasted work.
    if (inFlight.current && inFlight.current.key !== countKey) {
      inFlight.current.controller.abort();
      if (inFlight.current.timer) clearTimeout(inFlight.current.timer);
      inFlight.current = null;
    }
    if (!pagination || partial) return;

    if (pagination.total !== null && !pagination.totalPending) {
      // A page that came back counted: remember it, so a later page of the
      // same filter that lands after the backend's count cache lapsed still
      // has a number to show.
      const known = counts.get(countKey);
      const capped = pagination.totalCapped === true;
      if (!known || known.total !== pagination.total || known.capped !== capped) {
        setCounts((prev) => remember(prev, countKey, { total: pagination.total as number, capped }));
      }
      return;
    }

    if (!pagination.totalPending || counts.has(countKey)) return;
    if (inFlight.current?.key === countKey) return; // single-flight

    const controller = new AbortController();
    const slot: { key: string; controller: AbortController; timer?: ReturnType<typeof setTimeout> } = {
      key: countKey,
      controller,
    };
    inFlight.current = slot;
    const ask = (repolls: number): void => {
      fetchRef.current(controller.signal)
        .then((count) => {
          if (controller.signal.aborted) return;
          if (count.pending || count.total === null) {
            // Not counted yet. Ask again shortly — a bounded number of times;
            // the backend keeps counting meanwhile and the next answer is
            // normally the number. The slot stays held, so nothing else asks.
            if (repolls < COUNT_REPOLLS) {
              slot.timer = setTimeout(() => {
                if (inFlight.current === slot && !controller.signal.aborted) ask(repolls + 1);
              }, COUNT_REPOLL_MS);
              return;
            }
            if (inFlight.current === slot) inFlight.current = null;
            return;
          }
          setCounts((prev) => remember(prev, countKey, count));
          if (inFlight.current === slot) inFlight.current = null;
        })
        .catch(() => {
          // Aborted (filter changed, unmounted) or failed. Nothing is stored for
          // either, so the next list response for this filter — a page change,
          // Refresh — asks again: retries follow the user and never loop on
          // their own. Meanwhile the pager still works from `hasMore`.
          if (inFlight.current === slot) inFlight.current = null;
        });
    };
    ask(0);
    // `counts` is read, not watched: a resolved count must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countKey, pagination, partial]);

  useEffect(
    () => () => {
      inFlight.current?.controller.abort();
      if (inFlight.current?.timer) clearTimeout(inFlight.current.timer);
      inFlight.current = null;
    },
    [],
  );

  if (!pagination) return UNKNOWN;
  if (pagination.total !== null && !pagination.totalPending) {
    return { total: pagination.total, capped: pagination.totalCapped === true, pending: false };
  }
  if (partial) return UNKNOWN;
  const cached = counts.get(countKey);
  if (cached && cached.total !== null) return { total: cached.total, capped: cached.capped, pending: false };
  return { total: null, capped: false, pending: true };
}

function remember(
  prev: ReadonlyMap<string, ListCount>,
  key: string,
  count: ListCount,
): ReadonlyMap<string, ListCount> {
  const next = new Map(prev);
  next.delete(key); // re-insert last, so the oldest entry is the one evicted
  next.set(key, count);
  while (next.size > MAX_CACHED) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/** Pages needed to show `total` rows at `perPage`; null while the total is unknown. */
export function pageCount(total: ListTotal, perPage: number): number | null {
  if (total.total === null) return null;
  return Math.max(1, Math.ceil(total.total / Math.max(1, perPage)));
}

/**
 * How a total reads on screen: "…" while it is outstanding, "N+" when the
 * count hit the cap (a floor, never the size), else the number as-is.
 */
export function formatCount(value: number | null, capped: boolean): string {
  if (value === null) return '…';
  return capped ? `${value}+` : String(value);
}

/**
 * The cache key for a filter: its params minus `page` and `limit`, which
 * change what is shown and never how many rows match.
 */
export function filterKey(params: object): string {
  const { page: _page, limit: _limit, ...filter } = params as Record<string, unknown>;
  return JSON.stringify(filter);
}
