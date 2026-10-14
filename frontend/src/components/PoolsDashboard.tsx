"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  BarChart3,
  Database,
  ExternalLink,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const SeriesAreaChart = dynamic(() => import("./charts/SeriesAreaChart"), { ssr: false });
// SeriesKind values accepted by SeriesAreaChart
type SeriesKind = "currency" | "percent";
const LiquidityChart = dynamic(() => import("./charts/LiquidityChart"), { ssr: false });
const CandlePriceChart = dynamic(() => import("./charts/CandlePriceChart"), { ssr: false });

import {
  fetchTopPools,
  fetchTopPoolsCount,
  fetchPoolCharts,
  fetchLeaderboard,
  fetchLeaderboardCount,
  fetchPositionDetail,
  isAbortError,
  topPoolsV1Command,
  type ChartRange,
  type LeaderboardParams,
  type LeaderboardPool,
  type LeaderboardPosition,
  type LeaderboardResponse,
  type PoolCharts,
  type PoolsResponse,
  type PoolSortKey,
  type PositionDetail,
  type ProtocolKey,
  type SortKey,
  type TokenSnapshot,
  type TopPoolsParams,
} from "../lib/api";
import {
  compactAddress,
  formatAge,
  formatCurrency,
  formatPercent,
} from "../lib/format";
import { CopyV1CallButton } from "./CopyV1CallButton";
import { FeeLabel } from "./FeeLabel";
import { HookBadge } from "./HookBadge";
import { RiskBadges } from "./RiskBadges";
import { PARTIAL_CHARTS_RETRY_MS, slicePoolCharts } from "../lib/chart-range";
import { chainInfo, missingChainsNote } from "../lib/chains";
import {
  filterKey,
  formatCount,
  pageCount,
  useListTotal,
  type ListTotal,
} from "../lib/list-total";
import { revertPoolUrl, revertSupportsChain } from "../lib/revert";
import { PositionDetailPanel, PositionsTable } from "./PositionsDashboard";

const POOL_SORTS: Array<{ key: PoolSortKey; label: string }> = [
  { key: "tvl", label: "TVL" },
  { key: "volume", label: "Volume" },
  { key: "fees", label: "Fees" },
  { key: "fee_apr", label: "Fee APR" },
  { key: "age", label: "Age" },
];

const CHART_RANGES: ChartRange[] = ["30d", "60d", "90d", "180d", "all"];
type PoolSeriesKey = "volume" | "tvl" | "fees" | "feeApr";
const SERIES_TABS: Array<{ key: PoolSeriesKey; label: string }> = [
  { key: "volume", label: "Volume" },
  { key: "tvl", label: "TVL" },
  { key: "fees", label: "Fees" },
  { key: "feeApr", label: "Fee APR" },
];

// Only Robinhood Chain carries tokenized equities today; the backend map is the
// source of truth and returns zero rows for any other chain. The control is
// hidden elsewhere so it can never look like a filter that silently does nothing.
const EQUITY_CHAIN_ID = 4663;

/*
 * The pool modal's positions list is FETCHED in fixed pages of this size and
 * SHOWN in pages of `perPage`, which is measured from the chart column and
 * settles only after the charts load. Fetching `limit: perPage` refetched the
 * list every time that measurement moved; now a settling `perPage` re-slices
 * rows already in hand. 25 is the most `perPage` can ever be, so a visible
 * page spans at most two fetched pages.
 */
const POOL_POSITIONS_FETCH_LIMIT = 25;

export function PoolsDashboard({
  chainId,
  protocol,
  forceAssetClass,
}: {
  chainId: number | null;
  protocol: ProtocolKey;
  /**
   * Pins the asset class, for the Stocks tab. When set, the `stocks` toggle is
   * hidden — the tab IS the filter, so offering a control that cannot change
   * anything would just read as broken.
   */
  forceAssetClass?: 'equity';
}) {
  const [sort, setSort] = useState<PoolSortKey>("tvl");
  const [page, setPage] = useState(1);
  const [minTvlUsd, setMinTvlUsd] = useState(10000);
  const [includeRisky, setIncludeRisky] = useState(false);
  const [equityOnly, setEquityOnly] = useState(false);
  const assetClass = forceAssetClass ?? (equityOnly ? ('equity' as const) : undefined);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // The page on screen plus the params that produced it — the pending-count
  // lookup must describe THIS page, not the filter selected while the next
  // one loads (same reasoning as PositionsDashboard).
  const [loaded, setLoaded] = useState<{ data: PoolsResponse; params: TopPoolsParams } | null>(
    null,
  );
  const data = loaded?.data ?? null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LeaderboardPool | null>(null);
  // Bumped by the Refresh button to re-run the list effect with unchanged filters.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const listParams = useMemo<TopPoolsParams>(() => {
    // A search query is a direct lookup — relax the TVL floor and the risky
    // gate so a searched token/pool is always findable (a non-allowlisted
    // pool like USDC/RPC stores tvlUsd=0 + risky and is otherwise invisible
    // under the default "$10K+ TVL" + non-risky view).
    const searching = Boolean(debouncedSearch);
    return {
      chainId,
      protocol,
      sort,
      page,
      limit: 25,
      minTvlUsd: searching ? 0 : minTvlUsd,
      includeRisky: searching ? true : includeRisky,
      assetClass,
      search: debouncedSearch || undefined,
    };
  }, [sort, page, minTvlUsd, includeRisky, assetClass, debouncedSearch, chainId, protocol]);

  // One request per filter state. A newer one (or Refresh, or unmount) aborts
  // the one in flight, which is also what keeps a slow earlier response from
  // landing on top of a newer one.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchTopPools(listParams, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setLoaded({ data: result, params: listParams });
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [listParams, reloadNonce]);

  // The size of the result set when the page came back without one ("…"
  // until the count lands, "N+" when it hit the backend cap). `hasMore` alone
  // decides whether Next is enabled.
  const poolsTotal = useListTotal(
    data?.pagination,
    loaded ? filterKey(loaded.params) : "",
    (signal) =>
      loaded
        ? fetchTopPoolsCount(loaded.params, signal)
        : Promise.reject(new Error("no page loaded")),
    // A page missing a chain shows no all-chains count (it would include that chain's rows).
    (data?.missingChains?.length ?? 0) > 0,
  );
  const poolsTotalPages = pageCount(poolsTotal, data?.pagination.limit ?? 25);

  const pools = data?.pools ?? [];

  return (
    <>
      <div className="revertToolbar">
        <label className="searchControl">
          <Search size={15} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search token or pool address"
          />
        </label>
        <label className="compactSelect">
          <select
            value={minTvlUsd}
            onChange={(e) => {
              setMinTvlUsd(Number(e.target.value));
              setPage(1);
            }}
          >
            <option value={0}>Any TVL</option>
            <option value={10000}>$10K+ TVL</option>
            <option value={100000}>$100K+ TVL</option>
            <option value={1000000}>$1M+ TVL</option>
          </select>
        </label>
        <label className="miniToggle">
          <input
            type="checkbox"
            checked={includeRisky}
            onChange={(e) => {
              setIncludeRisky(e.target.checked);
              setPage(1);
            }}
          />
          risky
        </label>
        {!forceAssetClass && (chainId === EQUITY_CHAIN_ID || chainId === null) && (
          <label className="miniToggle" title="Pools with a tokenized-equity leg">
            <input
              type="checkbox"
              checked={equityOnly}
              onChange={(e) => {
                setEquityOnly(e.target.checked);
                setPage(1);
              }}
            />
            stocks
          </label>
        )}
        <button
          className="iconButton"
          onClick={() => setReloadNonce((value) => value + 1)}
          aria-label="Refresh"
        >
          <RefreshCw size={16} />
        </button>
        <CopyV1CallButton getCommand={() => topPoolsV1Command(listParams)} />
      </div>

      <div className="sortStrip" aria-label="Pool sorts">
        {POOL_SORTS.map((item) => (
          <button
            key={item.key}
            className={sort === item.key ? "active" : ""}
            onClick={() => {
              setSort(item.key);
              setPage(1);
            }}
          >
            <ArrowUpDown size={14} />
            {item.label}
          </button>
        ))}
      </div>

      {error ? <div className="notice error">{error}</div> : null}
      {/* An all-chains page served without some chains (`partial`): muted, not the
          red notice — the page is valid for the chains it shows. */}
      {missingChainsNote(data?.missingChains) ? (
        <div className="listNote" role="status">
          {missingChainsNote(data?.missingChains)}
        </div>
      ) : null}

      <section className="positionsTablePanel">
        {loading ? (
          <PoolsTableSkeleton />
        ) : (
          <PoolsTable
            pools={pools}
            currentSort={sort}
            onSort={(s) => { setSort(s); setPage(1); }}
            onSelect={setSelected}
          />
        )}
      </section>

      <div className="pagination">
        <button
          className="iconButton"
          disabled={page <= 1}
          onClick={() => setPage((v) => Math.max(1, v - 1))}
          aria-label="Previous page"
        >
          <ArrowLeft size={17} />
        </button>
        <span>
          {page} / {data ? formatCount(poolsTotalPages, poolsTotal.capped) : 1}
        </span>
        <button
          className="iconButton"
          disabled={!data?.pagination.hasMore}
          onClick={() => setPage((v) => v + 1)}
          aria-label="Next page"
        >
          <ArrowRight size={17} />
        </button>
      </div>

      {selected ? (
        <PoolDetailPanel
          pool={selected}
          protocol={protocol}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function PoolsTable({
  pools,
  currentSort,
  onSort,
  onSelect,
}: {
  pools: LeaderboardPool[];
  currentSort: PoolSortKey;
  onSort: (sort: PoolSortKey) => void;
  onSelect: (pool: LeaderboardPool) => void;
}) {
  if (pools.length === 0) {
    return (
      <div className="emptyState">
        <Database size={22} />
        <strong>No pools</strong>
        <span>Run pool sync or adjust filters.</span>
      </div>
    );
  }

  return (
    <div className="tableWrap">
      <table className="positionsTable">
        <thead>
          <tr>
            <th>pool / fee</th>
            <PoolSortableHeader label="TVL" sortKey="tvl" currentSort={currentSort} onSort={onSort} />
            <PoolSortableHeader label="24h volume" sortKey="volume" currentSort={currentSort} onSort={onSort} />
            <th>24h vol/TVL</th>
            <PoolSortableHeader label="24h fees" sortKey="fees" currentSort={currentSort} onSort={onSort} />
            <PoolSortableHeader label="fee APR" sortKey="fee_apr" currentSort={currentSort} onSort={onSort} />
            <PoolSortableHeader label="age" sortKey="age" currentSort={currentSort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {pools.map((pool) => {
            const ageSecs = Math.floor(Date.now() / 1000) - pool.createdAtTimestamp;
            // Computed client-side so rows synced before the backend metric
            // existed still show it.
            const volTvl = pool.metrics.tvlUsd > 0
              ? (pool.metrics.volumeUsd24h / pool.metrics.tvlUsd) * 100
              : 0;
            return (
              <tr
                key={pool.poolId}
                onClick={() => onSelect(pool)}
              >
                <td className="poolCellTd">
                  <div className="poolCell">
                    <span className="pairIcons">
                      <TokenIcon token={pool.token0} compact />
                      <TokenIcon token={pool.token1} compact />
                    </span>
                    <strong>{pool.token0.symbol}/{pool.token1.symbol}</strong>
                    <FeeLabel fee={pool.fee} dynamic={pool.isDynamicFee} />
                    <HookBadge hooks={pool.hooks} customAccounting={pool.customAccounting} />
                    <span className="chainPill" title={chainInfo(pool.chainId).name}>
                      {chainInfo(pool.chainId).shortName}
                    </span>
                    <RiskBadges risk={pool.risk} />
                  </div>
                </td>
                {/* `data-label` is what the ≤640px card layout renders as each
                    value's caption (`td::before { content: attr(data-label) }`).
                    Without it the pool cards were six unlabelled numbers. */}
                <td className="mono" data-label="TVL">{formatCurrency(pool.metrics.tvlUsd)}</td>
                <td className="mono" data-label="24h volume">{formatCurrency(pool.metrics.volumeUsd24h)}</td>
                <td className="mono" data-label="24h vol/TVL">{formatPercent(volTvl)}</td>
                <td className="mono" data-label="24h fees">{formatCurrency(pool.metrics.feesUsd24h)}</td>
                <td className="mono" data-label="fee APR">{formatPercent(pool.metrics.feeApr)}</td>
                <td className="mono" data-label="age">{formatAge(ageSecs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PoolDetailPanel({
  pool,
  protocol,
  onClose,
}: {
  pool: LeaderboardPool;
  protocol: ProtocolKey;
  onClose: () => void;
}) {
  // The range=all payload, fetched once per pool; `charts` below is the
  // selected range cut out of it client-side (lib/chart-range.ts).
  const [allCharts, setAllCharts] = useState<PoolCharts | null>(null);
  /*
   * "all", matching PositionsDashboard.
   *
   * The backend's windows are wall-clock (`nowSec - days * DAY`,
   * charts.service.ts) and the indexer is months behind head — its newest
   * PoolDayData is 2026-03-13 on mainnet — so a server-side "30d" started
   * after the last data point and rendered EMPTY. The modal therefore fetches
   * range=all once and slices it client-side, anchored to the newest data
   * point: 30d/60d/90d/180d show the last N days of data that exist, and a
   * range switch sends no request.
   */
  const [chartRange, setChartRange] = useState<ChartRange>("all");
  const [seriesTab, setSeriesTab] = useState<PoolSeriesKey>("volume");

  // In-pool positions list (paginated),
  // fetched in POOL_POSITIONS_FETCH_LIMIT pages and keyed by fetched-page
  // number. `key` names the (pool, sort) the pages belong to, so a sort change
  // can never show rows from the previous sort's pages.
  const [posPages, setPosPages] = useState<{
    key: string;
    pages: Record<number, LeaderboardResponse>;
  }>({ key: "", pages: {} });
  const [posPage, setPosPage] = useState(1);
  const [posSort, setPosSort] = useState<SortKey>("underlying_value");
  const [posLoading, setPosLoading] = useState(true);
  // Row-click opens our position detail, stacked above this pool modal.
  const [selectedPosition, setSelectedPosition] = useState<LeaderboardPosition | null>(null);
  const [posDetail, setPosDetail] = useState<PositionDetail | null>(null);
  const [posDetailLoading, setPosDetailLoading] = useState(false);
  // The open position's detail request; a newer click or a close aborts it,
  // so clicking A then B can never paint A's detail into B's panel.
  const posDetailAbortRef = useRef<AbortController | null>(null);

  // The positions list lives in the right column beside the (tall) charts. On
  // desktop we size the page so the list ends ~where the charts end — never
  // overflowing past them — and paginate the rest. On mobile the columns stack
  // and the list sits at the bottom, so a fixed page size is fine.
  const chartColRef = useRef<HTMLDivElement | null>(null);
  const posListRef = useRef<HTMLDivElement | null>(null);
  const [perPage, setPerPage] = useState(6);

  // Layout effect (runs before paint) so perPage is measured before the first
  // render shows a page. It no longer gates a fetch — the list is fetched in
  // fixed POOL_POSITIONS_FETCH_LIMIT pages and only SLICED by perPage — so a
  // re-measure after the charts load re-slices rows already in hand. Deps
  // exclude the list: the chart column height (which sets `avail`) is decoupled
  // from it by `.poolGrid { align-items: start }` + fixed-height chart boxes,
  // so list mutations never change the measurement.
  useLayoutEffect(() => {
    const recompute = () => {
      const isMobile = window.matchMedia("(max-width: 1120px)").matches;
      if (isMobile) {
        setPerPage(12);
        return;
      }
      const chart = chartColRef.current;
      const list = posListRef.current;
      if (!chart || !list) return;
      const CARD = 128; // approx height of one position card incl. gap
      const PAGINATION = 48;
      const avail = chart.getBoundingClientRect().bottom - list.getBoundingClientRect().top - PAGINATION;
      const n = Math.floor(avail / CARD);
      setPerPage(Math.max(3, Math.min(25, Number.isFinite(n) && n > 0 ? n : 6)));
    };
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [allCharts, pool.poolId]);

  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    setAllCharts(null);
    const load = (followUp: boolean) =>
      fetchPoolCharts(
        { chainId: pool.chainId, protocol, poolId: pool.poolId, range: "all" },
        controller.signal,
      )
        .then((c) => {
          if (controller.signal.aborted) return;
          setAllCharts(c);
          // A partial answer completes into the backend's cache: ask once more.
          if (c.partial && !followUp) retry = setTimeout(() => void load(true), PARTIAL_CHARTS_RETRY_MS);
        })
        .catch(() => { /* charts unavailable, or aborted on close / pool switch */ });
    void load(false);
    return () => {
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [pool.poolId, protocol, pool.chainId]);
  const charts = useMemo(
    () => (allCharts ? slicePoolCharts(allCharts, chartRange) : null),
    [allCharts, chartRange],
  );

  // The list query minus its page — what every fetched page and the count share.
  const posParams = useMemo<LeaderboardParams>(
    () => ({
      chainId: pool.chainId,
      protocol,
      sort: posSort,
      page: 1,
      limit: POOL_POSITIONS_FETCH_LIMIT,
      activeOnly: true,
      status: "active",
      minValueUsd: 0,
      includeRisky: true,
      poolId: pool.poolId,
    }),
    [pool.chainId, protocol, posSort, pool.poolId],
  );
  const posKey = filterKey(posParams);
  const fetchedPages = posPages.key === posKey ? posPages.pages : {};

  // The visible page is rows [offset, offset + perPage) of the result set,
  // which lie in fetched pages firstPage..lastPage (at most two, since
  // perPage never exceeds the fetch limit).
  const offset = (posPage - 1) * perPage;
  const firstPage = Math.floor(offset / POOL_POSITIONS_FETCH_LIMIT) + 1;
  const lastPage = Math.floor((offset + perPage - 1) / POOL_POSITIONS_FETCH_LIMIT) + 1;

  useEffect(() => {
    const missing: number[] = [];
    for (let p = firstPage; p <= lastPage; p++) {
      // Past the end of the result set: the page before already said so.
      if (fetchedPages[p - 1] && !fetchedPages[p - 1]!.pagination.hasMore) break;
      if (!fetchedPages[p]) missing.push(p);
    }
    if (missing.length === 0) {
      setPosLoading(false);
      return;
    }
    const controller = new AbortController();
    setPosLoading(true);
    Promise.all(
      missing.map((p) =>
        fetchLeaderboard({ ...posParams, page: p }, controller.signal).then((r) => {
          if (controller.signal.aborted) return;
          setPosPages((prev) => ({
            key: posKey,
            pages: { ...(prev.key === posKey ? prev.pages : {}), [p]: r },
          }));
        }),
      ),
    )
      .catch(() => { /* positions unavailable, or aborted */ })
      .finally(() => { if (!controller.signal.aborted) setPosLoading(false); });
    return () => controller.abort();
    // `fetchedPages` is read, not watched: a page landing must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posKey, firstPage, lastPage]);

  /*
   * The rows for the visible page, or null while a page they need is still in
   * flight. While null the previous rows stay up (`shownRows`), matching the
   * old behaviour of keeping the last response on screen until the next lands.
   */
  const windowRows = useMemo(() => {
    const rows: LeaderboardPosition[] = [];
    for (let i = offset; i < offset + perPage; i++) {
      const p = Math.floor(i / POOL_POSITIONS_FETCH_LIMIT) + 1;
      const fetched = fetchedPages[p];
      if (!fetched) {
        const previous = fetchedPages[p - 1];
        if (previous && !previous.pagination.hasMore) break; // end of results
        return null;
      }
      const row = fetched.positions[i % POOL_POSITIONS_FETCH_LIMIT];
      if (!row) break; // end of results
      rows.push(row);
    }
    return rows;
  }, [fetchedPages, offset, perPage]);
  const shownRowsRef = useRef<LeaderboardPosition[] | null>(null);
  if (windowRows) shownRowsRef.current = windowRows;
  const shownRows = windowRows ?? shownRowsRef.current;

  // Whether a row exists past the visible page. Exact: the fetched page that
  // would hold it either holds it or not; when that row would OPEN a page not
  // fetched yet, the page before it carries the backend's exact `hasMore`.
  const posHasNext = (() => {
    const end = offset + perPage;
    const p = Math.floor(end / POOL_POSITIONS_FETCH_LIMIT) + 1;
    const fetched = fetchedPages[p];
    if (fetched) return end % POOL_POSITIONS_FETCH_LIMIT < fetched.positions.length;
    if (end % POOL_POSITIONS_FETCH_LIMIT === 0) {
      return fetchedPages[p - 1]?.pagination.hasMore ?? false;
    }
    return false; // the page that would hold it is still loading
  })();

  const posPagination = fetchedPages[firstPage]?.pagination ?? fetchedPages[1]?.pagination;
  const posTotalLive = useListTotal(posPagination, posKey, (signal) =>
    fetchLeaderboardCount(posParams, signal),
  );
  // A sort change empties `fetchedPages` until its first page lands; keep the
  // last count up meanwhile (a re-sort never changes how many rows match),
  // as the old single-response state did.
  const lastPosTotalRef = useRef<ListTotal | null>(null);
  if (posPagination) lastPosTotalRef.current = posTotalLive;
  const posTotal = posPagination ? posTotalLive : lastPosTotalRef.current;
  const posTotalPages = posTotal ? pageCount(posTotal, perPage) : null;

  // Closing the modal (or switching pool) abandons the open position's detail.
  useEffect(
    () => () => {
      posDetailAbortRef.current?.abort();
      posDetailAbortRef.current = null;
    },
    [pool.poolId],
  );

  const openPosition = (position: LeaderboardPosition) => {
    // A newer click aborts the request before it, so if the user quickly
    // clicks A then B, A's late resolve can never clobber B's detail.
    posDetailAbortRef.current?.abort();
    const controller = new AbortController();
    posDetailAbortRef.current = controller;
    setSelectedPosition(position);
    setPosDetail(null);
    setPosDetailLoading(true);
    fetchPositionDetail(
      {
        chainId: position.chainId,
        protocol: position.protocol as ProtocolKey,
        positionId: position.positionId,
      },
      controller.signal,
    )
      .then((d) => { if (!controller.signal.aborted) setPosDetail({ ...d, rank: position.rank }); })
      .catch((err) => { if (isAbortError(err)) return; /* detail unavailable */ })
      .finally(() => {
        if (posDetailAbortRef.current !== controller) return; // superseded
        posDetailAbortRef.current = null;
        setPosDetailLoading(false);
      });
  };

  const closePosition = () => {
    posDetailAbortRef.current?.abort();
    posDetailAbortRef.current = null;
    setPosDetailLoading(false);
    setSelectedPosition(null);
    setPosDetail(null);
  };

  const positions = shownRows ?? [];
  const ageSecs = Math.floor(Date.now() / 1000) - pool.createdAtTimestamp;
  const seriesData = charts?.poolSeries[seriesTab] ?? [];
  const seriesKind: SeriesKind = seriesTab === "feeApr" ? "percent" : "currency";

  // Build liquidity dist shape compatible with LiquidityChart (needs tickLower/tickUpper).
  // From the unsliced payload: the distribution is the latest state, whatever
  // the range, so a range switch must not hand the chart a new object.
  const dist = useMemo(() => {
    if (!allCharts) return null;
    const ticks = allCharts.liquidityDistribution.ticks;
    const currentTick = allCharts.liquidityDistribution.currentTick;
    const firstTick = ticks[0]?.tickIdx ?? currentTick - 5000;
    const lastTick = ticks[ticks.length - 1]?.tickIdx ?? currentTick + 5000;
    return {
      currentTick,
      tickLower: firstTick,
      tickUpper: lastTick,
      ticks,
    };
  }, [allCharts]);

  return (
    <>
      <div className="detailOverlay" onClick={onClose}>
      <section className="positionDetail" onClick={(e) => e.stopPropagation()}>
        <div className="detailAccent" />
        <header className="detailHero">
          <div className="pairTitle">
            <div className="pairIcons">
              <TokenIcon token={pool.token0} />
              <TokenIcon token={pool.token1} />
            </div>
            <div>
              <h2>{pool.token0.symbol}/{pool.token1.symbol}</h2>
              <div className="titleMeta">
                <FeeLabel fee={pool.fee} dynamic={pool.isDynamicFee} />
                <HookBadge hooks={pool.hooks} customAccounting={pool.customAccounting} />
                <span className="chainIcon" title={chainInfo(pool.chainId).name}>
                  {chainInfo(pool.chainId).name.charAt(0).toUpperCase()}
                </span>
                <span className="chainPill">{chainInfo(pool.chainId).shortName}</span>
                <span className="versionPill">
                  {protocol === "uniswap-v3" ? "v3" : "v4"}
                </span>
                <RiskBadges risk={pool.risk} />
                {posTotal && (posTotal.total !== null || posTotal.pending) ? (
                  <span>
                    {formatCount(posTotal.total, posTotal.capped)} position
                    {posTotal.total === 1 && !posTotal.capped ? "" : "s"}
                  </span>
                ) : null}
                {revertSupportsChain(pool.chainId) ? (
                  <a
                    className="poolIdLink"
                    href={revertPoolUrl(pool.chainId, pool.protocol, pool.poolId)}
                    target="_blank"
                    rel="noreferrer"
                    title={`${pool.poolId} — open on revert.finance`}
                  >
                    <span className="mono">{compactAddress(pool.poolId)}</span>
                    <ExternalLink size={12} />
                  </a>
                ) : (
                  <span className="poolIdLink" title={pool.poolId}>
                    <span className="mono">{compactAddress(pool.poolId)}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="detailActions">
            <button className="iconButton closeButton" onClick={onClose} aria-label="Close">
              <X size={17} />
            </button>
          </div>
        </header>

        <section className="heroStats">
          <HeroMetric label="TVL" value={formatCurrency(pool.metrics.tvlUsd)} />
          <HeroMetric label="24h volume" value={formatCurrency(pool.metrics.volumeUsd24h)} />
          <HeroMetric label="24h fees" value={formatCurrency(pool.metrics.feesUsd24h)} />
          <HeroMetric label="fee APR" value={formatPercent(pool.metrics.feeApr)} />
          <HeroMetric label="age" value={formatAge(ageSecs)} />
        </section>

        <div className="detailDivider" />

        <section className="detailGrid poolGrid">
          <div className="chartColumn" ref={chartColRef}>
            <div className="chartTabs">
              {SERIES_TABS.map((tab) => (
                <button
                  key={tab.key}
                  className={seriesTab === tab.key ? "active" : ""}
                  onClick={() => setSeriesTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="seriesHeader">
              <span />
              <span className="rangeButtons">
                {CHART_RANGES.map((r) => (
                  <button
                    key={r}
                    className={chartRange === r ? "active" : ""}
                    onClick={() => setChartRange(r)}
                  >
                    {r}
                  </button>
                ))}
              </span>
            </div>

            {/* Every chart slot keeps its fixed box height in ALL states
                (loading / loaded / empty) so the column height — and therefore
                the computed positions page size — never shifts on chart load. */}
            <div className="tvChartBox">
              {!charts ? (
                <span className="chartLoading">Loading…</span>
              ) : seriesData.length > 1 ? (
                <SeriesAreaChart points={seriesData} kind={seriesKind} />
              ) : (
                <span className="chartLoading">
                  <BarChart3 size={20} />
                  Not enough history for this series
                </span>
              )}
            </div>

            <h3>Liquidity distribution</h3>
            <div className="tvChartBox liqBox">
              {!charts ? (
                <span className="chartLoading">Loading…</span>
              ) : dist && dist.ticks.length > 0 ? (
                <LiquidityChart
                  dist={dist}
                  inverted={false}
                  showRange={false}
                  token0Symbol={pool.token0.symbol}
                  token1Symbol={pool.token1.symbol}
                  token0PriceUsd={pool.token0.priceUsd}
                  token1PriceUsd={pool.token1.priceUsd}
                  tickSpacing={pool.tickSpacing}
                />
              ) : (
                <span className="chartLoading">
                  <BarChart3 size={20} />
                  No liquidity data
                </span>
              )}
            </div>

            <h3>{pool.token0.symbol}/{pool.token1.symbol} price</h3>
            <div className="tvChartBox">
              {/* Pools have no position range, so pass 0 bounds → no MIN/MAX/
                  current overlay lines (CandlePriceChart only draws lines for
                  values > 0). Candlesticks only. */}
              {!charts ? (
                <span className="chartLoading">Loading…</span>
              ) : charts.poolPrice.length > 1 ? (
                <CandlePriceChart
                  points={charts.poolPrice}
                  inverted={false}
                  token0Symbol={pool.token0.symbol}
                  token1Symbol={pool.token1.symbol}
                  minPrice={0}
                  maxPrice={0}
                  currentPrice={0}
                />
              ) : (
                <span className="chartLoading">
                  <BarChart3 size={20} />
                  No price data
                </span>
              )}
            </div>
          </div>

          <div className="dataColumn">
            <Section title="Pool overview">
              <DataRow label="TVL" value={formatCurrency(pool.metrics.tvlUsd)} />
              <DataRow label="24h volume" value={formatCurrency(pool.metrics.volumeUsd24h)} />
              <DataRow label="7d volume" value={formatCurrency(pool.metrics.volumeUsd7d)} />
              <DataRow label="24h fees" value={formatCurrency(pool.metrics.feesUsd24h)} />
              <DataRow label="7d fees" value={formatCurrency(pool.metrics.feesUsd7d)} />
              <DataRow label="fee APR" value={formatPercent(pool.metrics.feeApr)} />
              <DataRow label="transactions" value={pool.metrics.txCount.toLocaleString()} />
              <DataRow
                label="current price"
                value={formatCompact(pool.metrics.currentPrice)}
                note={`${pool.token1.symbol} per ${pool.token0.symbol}`}
              />
              <DataRow label="age" value={formatAge(ageSecs)} />
            </Section>

            <Section title="Open positions in this pool">
              <div className="poolPositions" ref={posListRef}>
                {posLoading && !shownRows ? (
                  <PoolsTableSkeleton />
                ) : (
                  <PositionsTable
                    positions={positions}
                    protocolShort={protocol === "uniswap-v3" ? "v3" : "v4"}
                    currentSort={posSort}
                    onSort={(s) => {
                      setPosSort(s);
                      setPosPage(1);
                    }}
                    onSelect={openPosition}
                  />
                )}
                <div className="pagination">
                  <button
                    className="iconButton"
                    disabled={posPage <= 1}
                    onClick={() => setPosPage((v) => Math.max(1, v - 1))}
                    aria-label="Previous page"
                  >
                    <ArrowLeft size={17} />
                  </button>
                  <span>
                    {posPage} /{" "}
                    {posTotal ? formatCount(posTotalPages, posTotal.capped) : 1}
                  </span>
                  <button
                    className="iconButton"
                    disabled={!posHasNext}
                    onClick={() => setPosPage((v) => v + 1)}
                    aria-label="Next page"
                  >
                    <ArrowRight size={17} />
                  </button>
                </div>
              </div>
            </Section>
          </div>
        </section>
      </section>
      </div>
      {selectedPosition ? (
        <div className="poolPositionDetailLayer">
          <PositionDetailPanel
            summary={selectedPosition}
            detail={posDetail}
            loading={posDetailLoading}
            protocolShort={protocol === "uniswap-v3" ? "v3" : "v4"}
            onClose={closePosition}
          />
        </div>
      ) : null}
    </>
  );
}

// ─── Shared sub-components ───────────────────────────────────────────────────

function PoolSortableHeader({
  label,
  sortKey,
  currentSort,
  onSort,
}: {
  label: string;
  sortKey: PoolSortKey;
  currentSort: PoolSortKey;
  onSort: (sort: PoolSortKey) => void;
}) {
  const active = currentSort === sortKey;
  return (
    <th>
      <button
        className={active ? "sortHeader active" : "sortHeader"}
        onClick={() => onSort(sortKey)}
      >
        {label}
        <ArrowDown size={13} />
      </button>
    </th>
  );
}

function TokenIcon({ token, compact = false }: { token: TokenSnapshot; compact?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setLoaded(false); setFailed(false); }, [token.logoURI]);
  const initials = token.symbol.slice(0, compact ? 1 : 3).toUpperCase();
  const src = token.logoURI && !failed ? token.logoURI : null;
  // Cache-hit images can fire load/error before React attaches the handlers —
  // the callback ref reads `complete` off the DOM so the skeleton can't stick.
  const syncFromDom = (el: HTMLImageElement | null) => {
    if (!el || !el.complete) return;
    if (el.naturalWidth > 0) setLoaded(true);
    else setFailed(true);
  };
  return (
    <span className={compact ? "tokenBadge compact" : "tokenBadge"} title={token.symbol}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          ref={syncFromDom}
          src={src}
          alt=""
          loading="lazy"
          style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : null}
      {src ? (loaded ? null : <span className="tokenBadgeSkeleton" aria-hidden />) : initials}
    </span>
  );
}

function HeroMetric({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
  return (
    <div className="heroMetric">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dataSection">
      <h3>{title}</h3>
      <div>{children}</div>
    </section>
  );
}

function DataRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="dataRow">
      <span>{label}</span>
      <strong>{value}</strong>
      {note ? <em>{note}</em> : null}
    </div>
  );
}

function PoolsTableSkeleton() {
  return (
    <div className="skeletonRows">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i} className="skeletonRow" />
      ))}
    </div>
  );
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "–";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  if (value < 0.001) return value.toExponential(3);
  return value.toPrecision(5);
}
