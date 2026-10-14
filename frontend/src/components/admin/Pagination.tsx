'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

/*
 * Pagination for the admin panel's lists — ONE implementation, used by every one
 * of them, because the panel already carries three hand-rolled loading patterns
 * and a fourth divergence was not worth adding.
 *
 * IT SLICES, IT DOES NOT FETCH, and that is a deliberate limit rather than an
 * oversight. Every admin list endpoint takes `limit` and NOTHING ELSE — no
 * `offset`, no cursor, no total (see `pageSize()` in
 * backend/src/payments/admin-payments.controller.ts, which clamps to MAX_PAGE
 * and returns a bare array). So there is no server page 2 to ask for. What these
 * controls page through is the rows the page already holds, which makes the
 * ceiling on what is reachable the FETCH SIZE, exactly as it was before — the
 * `Last 50 / 100 / 200` selectors that were already on these pages are
 * untouched and still the thing that decides how much exists. Paginating a
 * capped fetch does not widen the cap, and the copy under each table still says
 * so. True server paging needs `offset` + a count on six endpoints; that is a
 * backend change and is not what this is.
 *
 * `All` is offered on every list, and it is load-bearing rather than a courtesy:
 * it is byte-for-byte the old behaviour, so nothing that worked before — most
 * of all Cmd+F over a whole list, which is how an operator finds one client in
 * a panel that has no search box — is taken away by this change.
 */

/**
 * `Infinity` is the "All" option: one page holding everything.
 *
 * IT STARTS AT 10, AND THAT IS THE WHOLE DIFFERENCE BETWEEN THIS PAGING AND NO
 * PAGING. The first cut of this file started at 25, which on the real panel
 * meant the controls never appeared: /admin/payments holds 19 invoices,
 * /admin/subscriptions and the clients list are in the same 15–30 range, and
 * `total <= smallest size` hid every one of them. A page size has to be smaller
 * than the lists it is meant to split — 25 was chosen against imagined data and
 * was wrong about all of it. 10 also makes the threshold 10, so anything longer
 * than ten rows gets a pager.
 */
const DEFAULT_PAGE_SIZES = [10, 25, 50, 100, Infinity];

/**
 * For a list inside a panel rather than on a page of its own — a client's keys,
 * their monthly history, a usage breakdown. Starts smaller because the container
 * is ~270px wide inside an expanded clients row, where 25 rows is most of a
 * screen of scrolling to reach the next section of the panel.
 *
 * A caller's `defaultPageSize` MUST be a member of its `pageSizes`, or the
 * select has no option matching its value and the browser shows the first one
 * while the hook slices by another.
 */
export const PANEL_PAGE_SIZES = [10, 25, 50, Infinity];

export interface PaginationState<T> {
  /** The rows for the current page — what the caller maps over. */
  pageItems: T[];
  /** 1-based, already clamped to `lastPage`. */
  page: number;
  lastPage: number;
  pageSize: number;
  pageSizes: number[];
  /** `items.length`, i.e. everything the page fetched — not the server's count. */
  total: number;
  /** 1-based inclusive range of `total` on screen now; `0` / `0` when empty. */
  from: number;
  to: number;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
}

/**
 * Page state over an array the caller already has.
 *
 * `resetKey` is how a filter change gets page 1: pass whatever identifies the
 * query (the same string these pages already build for `useLoad`). It is
 * compared DURING RENDER rather than in an effect, so a narrowed filter never
 * paints one frame of the old page's slice before snapping back.
 *
 * `guard` is for a list whose open row holds something a page change would
 * destroy — the clients list issues an API key that is shown once, and paging
 * away from it is the same silent loss that closing the panel asks about.
 * Return `false` to refuse the change.
 */
export function usePagination<T>(
  items: T[],
  {
    defaultPageSize = 10,
    pageSizes = DEFAULT_PAGE_SIZES,
    resetKey = '',
    guard,
  }: {
    defaultPageSize?: number;
    pageSizes?: number[];
    resetKey?: string;
    guard?: () => boolean;
  } = {},
): PaginationState<T> {
  const [state, setState] = useState({ key: resetKey, page: 1, size: defaultPageSize });

  // A changed `resetKey` means page 1, decided here and not written back: the
  // next setPage/setPageSize stamps the current key, and until then there is
  // nothing to store. The chosen page SIZE survives a filter change on purpose —
  // it is a preference about this screen, not about this query.
  const size = state.size;
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / size));
  // Clamped rather than reset: when a filter shrinks the list from 5 pages to 2
  // while the operator is on page 4, the honest destination is the last page
  // that exists, not the first.
  const page = Math.min(state.key === resetKey ? state.page : 1, lastPage);

  const guardRef = useRef(guard);
  guardRef.current = guard;

  const setPage = useCallback(
    (next: number) => {
      if (guardRef.current && !guardRef.current()) return;
      setState((s) => ({ ...s, key: resetKey, page: Math.max(1, next) }));
    },
    [resetKey],
  );

  const setPageSize = useCallback(
    (nextSize: number) => {
      if (guardRef.current && !guardRef.current()) return;
      // Back to page 1: keeping the index would land on a different set of rows
      // for no reason the operator asked for.
      setState((s) => ({ ...s, key: resetKey, page: 1, size: nextSize }));
    },
    [resetKey],
  );

  /*
   * `All` is branched around the arithmetic, not fed through it: `(1 - 1) *
   * Infinity` is `0 * Infinity`, which is NaN, and a NaN `start` silently turns
   * the whole row range into "NaN–NaN of 120".
   */
  const all = size === Infinity;
  const start = all ? 0 : (page - 1) * size;
  const pageItems = all ? items : items.slice(start, start + size);

  return {
    pageItems,
    page,
    lastPage,
    pageSize: size,
    pageSizes,
    total,
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + pageItems.length,
    setPage,
    setPageSize,
  };
}

/**
 * The control. Design-token markup, which works on both halves of the panel:
 * the converted pages are Tailwind already, and the legacy `.admin-*` pages
 * render inside the layout's `tw` subtree, so the tokens resolve there too.
 *
 * IT RENDERS NOTHING FOR A LIST TOO SHORT TO SPLIT AT ALL. That is what makes
 * it safe to attach to a list that is usually short — by-endpoint usage, a
 * client's two subscriptions — without spending a row of chrome to say "1 / 1".
 * See the threshold below for why it is not "one page on screen".
 */
export function Pagination<T>({
  state,
  label,
  /** Scrolled into view on a page change, so page 2 starts at the top of page 2. */
  scrollTo,
  /**
   * The hairline above the control. TRUE for a table that ends flush against the
   * card edge — the rule is that table's bottom border. FALSE under an
   * `.admin-table`, where every row already draws its own bottom hairline and
   * one more would be a second line a few pixels under it. A prop rather than a
   * `border-t-0` override in `className`: two same-specificity utilities are
   * settled by stylesheet order, not by class order (see the note in
   * lib/utils.ts about `cn()`'s conflict groups), so the override is not
   * reliably the winner.
   */
  divider = true,
  className = '',
}: {
  state: PaginationState<T>;
  /** Plural noun for the rows, e.g. `clients`. Used in the count and the a11y name. */
  label: string;
  scrollTo?: React.RefObject<HTMLElement | null>;
  divider?: boolean;
  className?: string;
}) {
  const { page, lastPage, pageSize, pageSizes, total, from, to, setPage, setPageSize } = state;

  /*
   * Hidden only when the list CANNOT be split — shorter than the smallest size
   * on offer. NOT `lastPage <= 1`, which was the first version of this line and
   * was a trap: picking `All` makes the list one page, `lastPage <= 1` then
   * unmounts the control, and the size select goes with it — so there is no way
   * back to 25 per page short of reloading the route. The same applies to a
   * 30-row list at 50 per page. Anything long enough to be paged keeps its
   * control, even while it happens to be showing everything.
   */
  const smallest = Math.min(...pageSizes.filter((n) => Number.isFinite(n)));
  if (total <= smallest) return null;

  // The control sits BELOW the table, so a page change without this leaves the
  // viewport at the bottom of the new page — reading as though nothing moved.
  // `nearest` rather than `start`: it scrolls only when the top is actually off
  // screen, so short tables do not jump.
  function go(next: number) {
    setPage(next);
    scrollTo?.current?.scrollIntoView({ block: 'nearest' });
  }

  const control =
    'h-8 rounded-md border border-input bg-surface px-2 text-xs text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <nav
      aria-label={`${label} pagination`}
      className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${
        divider ? 'border-t border-border/60' : ''
      } ${className}`}
    >
      {/* Announced on change, because for a screen reader the page turning is
          otherwise silent — the table's rows are simply different now. */}
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {from}–{to} of {total} {label}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={control}
          value={String(pageSize)}
          onChange={(e) => setPageSize(Number(e.target.value))}
          aria-label={`${label} per page`}
        >
          {pageSizes.map((n) => (
            <option key={String(n)} value={String(n)}>
              {n === Infinity ? 'All' : `${n} per page`}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`${control} inline-flex items-center gap-1 pl-1.5`}
            onClick={() => go(page - 1)}
            disabled={page <= 1}
            aria-label={`Previous page of ${label}`}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Prev
          </button>
          {/* Not a numbered strip: these lists top out at four pages of a
              server-capped fetch, so a run of page buttons would be wider than
              the two it replaces and no faster to use. */}
          <span className="px-1 font-mono text-xs text-muted-foreground">
            {page} / {lastPage}
          </span>
          <button
            type="button"
            className={`${control} inline-flex items-center gap-1 pr-1.5`}
            onClick={() => go(page + 1)}
            disabled={page >= lastPage}
            aria-label={`Next page of ${label}`}
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </nav>
  );
}
