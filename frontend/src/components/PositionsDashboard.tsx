"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  BarChart3,
  Check,
  ChevronDown,
  Copy,
  Database,
  ExternalLink,
  Filter,
  Info,
  Link2,
  MoreVertical,
  RefreshCw,
  Search,
  Share,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import type { FocusEvent, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// TradingView lightweight-charts components are client-only (touch the DOM in
// effects) — load with ssr:false so SSR never evaluates them.
const CandlePriceChart = dynamic(() => import("./charts/CandlePriceChart"), { ssr: false });
const SeriesAreaChart = dynamic(() => import("./charts/SeriesAreaChart"), { ssr: false });
const LiquidityChart = dynamic(() => import("./charts/LiquidityChart"), { ssr: false });
// Loaded dynamically (not a static import) so PoolsDashboard can import the
// shared PositionsTable / PositionDetailPanel from THIS module without creating
// a circular static import.
const PoolsDashboard = dynamic(
  () => import("./PoolsDashboard").then((m) => m.PoolsDashboard),
  { ssr: false },
);
import {
  DEGRADED_DETAIL_RETRY_MS,
  fetchChains,
  fetchHealth,
  fetchLeaderboard,
  fetchLeaderboardCount,
  fetchPositionCharts,
  fetchPositionDetail,
  feesPending,
  isAbortError,
  leaderboardV1Command,
  type ChainMeta,
  type ChartRange,
  type ChartSeriesPoint,
  type HealthResponse,
  type LeaderboardParams,
  type PositionCharts,
  type LeaderboardPosition,
  type LeaderboardResponse,
  type PositionDetail,
  type PositionStatus,
  type RangeFilter,
  type PositionTransaction,
  type ProtocolKey,
  type SortKey,
  type TokenSnapshot,
} from "../lib/api";
import { PARTIAL_CHARTS_RETRY_MS, slicePositionCharts } from "../lib/chart-range";
import { chainInfo, missingChainsNote, explorerTxUrl, registerChains } from "../lib/chains";
import { copyToClipboard } from "../lib/clipboard";
import { filterKey, formatCount, pageCount, useListTotal } from "../lib/list-total";
import {
  formatAge,
  formatCurrency,
  formatPercent,
} from "../lib/format";
import { CopyV1CallButton } from "./CopyV1CallButton";
import { FeeLabel } from "./FeeLabel";
import { HookBadge } from "./HookBadge";
import { OwnerLabel } from "./OwnerLabel";
import { RiskBadges } from "./RiskBadges";
import { revertPositionUrl, revertSupportsChain } from "../lib/revert";

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "apr", label: "APR" },
  { key: "fee_apr", label: "Fee APR" },
  { key: "roi", label: "ROI" },
  { key: "age", label: "Age" },
  { key: "pnl", label: "PnL" },
  { key: "underlying_value", label: "Value" },
  { key: "nft_id_asc", label: "NFT ↑" },
  { key: "nft_id_desc", label: "NFT ↓" },
];

/**
 * APR, fee APR and ROI are rate metrics — dashed once a position is closed
 * (see the row renderer) — so sorting the Closed tab by them orders values
 * nobody can see. They are hidden there and the tab falls back to PnL
 * (decided 2026-10-02: a closed position has no current rate).
 *
 * The backend agrees: `effectiveLeaderboardSort` serves the Closed tab's rate
 * sorts as `pnl` for every caller (/api, /v1, a stale URL), so the old
 * unindexed path (14 s on chain 1 locally, a 503) is unreachable either way.
 */
const CLOSED_HIDDEN_SORTS = new Set<SortKey>(["apr", "fee_apr", "roi"]);

export function sortsForStatus(status: PositionStatus): typeof SORTS {
  return status === "inactive" ? SORTS.filter((s) => !CLOSED_HIDDEN_SORTS.has(s.key)) : SORTS;
}

const PROTOCOLS: Array<{ key: ProtocolKey; label: string; short: string }> = [
  { key: "uniswap-v4", label: "Uniswap v4", short: "v4" },
  { key: "uniswap-v3", label: "Uniswap v3", short: "v3" },
];

// Reference basis for the detail panel's PnL/APR/ROI figures. HOLD is vs-HODL
// (the top-level metrics), USD is the vs-USD companion (`metrics.usd`, absent
// on some positions), ETH is not computed yet.
const PNL_REFS: Array<{
  key: "hold" | "usd" | "eth";
  label: string;
  unavailable: string;
}> = [
  { key: "hold", label: "HOLD", unavailable: "" },
  { key: "usd", label: "USD", unavailable: "No USD basis for this position" },
  { key: "eth", label: "ETH", unavailable: "vs-ETH PnL is not available yet" },
];

// Protocols the API does NOT index. They sit in the picker as a roadmap hint,
// under an explicit heading: the landing page states the indexed list is
// exhaustive, and a merely-greyed row reads as "temporarily unavailable"
// rather than "not supported".
const UNINDEXED_PROTOCOL_LABELS = ["Pancakeswap v3", "Aerodrome"];

// Shown until /v1/chains answers (and the fallback if it fails) — keeps the
// picker rendering the pre-multichain default instead of an empty menu.
const DEFAULT_CHAIN: ChainMeta = {
  chainId: 1,
  slug: "ethereum",
  name: "Ethereum",
  shortName: "ETH",
  explorerUrl: "https://etherscan.io",
  protocols: ["uniswap-v4"],
};

// Only Robinhood Chain carries tokenized equities today; the backend map is the
// source of truth and returns zero rows elsewhere. Hidden on other chains so it
// can never look like a filter that silently does nothing.
const EQUITY_CHAIN_ID = 4663;

// The min-value select commits to the query this long after it last changed:
// arrowing through its options used to fire one leaderboard request per option.
const MIN_VALUE_DEBOUNCE_MS = 300;

// /health feeds only the status line in the info banner, so it polls on its
// own clock rather than gating the table (see the health effect).
const HEALTH_POLL_MS = 60_000;
// A /health that never answers must not stop the poll for good: the next tick
// is scheduled only after this one settles.
const HEALTH_TIMEOUT_MS = 15_000;

/*
 * Deep links to a single position.
 *
 * The detail panel's share button hands out a URL, so the URL has to actually
 * reopen the panel: `?chain=&protocol=&position=` is written with
 * `history.replaceState` while a position is open (no router navigation — the
 * panel is local state, not a route) and read back once on mount.
 */
type PositionRef = { chainId: number; protocol: string; positionId: string };

function positionShareUrl(ref: PositionRef): string {
  const url = new URL("/explore", window.location.origin);
  url.searchParams.set("chain", String(ref.chainId));
  url.searchParams.set("protocol", ref.protocol);
  url.searchParams.set("position", ref.positionId);
  return url.toString();
}

// Mirrors the open position into the address bar (and clears it on close) so
// copying from the browser is equivalent to using the share button.
function syncPositionUrl(ref: PositionRef | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (ref) {
    url.searchParams.set("chain", String(ref.chainId));
    url.searchParams.set("protocol", ref.protocol);
    url.searchParams.set("position", ref.positionId);
  } else {
    url.searchParams.delete("chain");
    url.searchParams.delete("protocol");
    url.searchParams.delete("position");
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function readPositionUrl(): PositionRef | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const positionId = params.get("position");
  const chainId = Number(params.get("chain"));
  const protocol = params.get("protocol");
  if (!positionId || !protocol || !Number.isFinite(chainId) || chainId <= 0) {
    return null;
  }
  if (!PROTOCOLS.some((item) => item.key === protocol)) return null;
  return { chainId, protocol, positionId };
}

export function PositionsDashboard() {
  const [viewMode, setViewMode] = useState<"positions" | "pools" | "stocks">("positions");
  const [sort, setSort] = useState<SortKey>("apr");
  const [protocol, setProtocol] = useState<ProtocolKey>("uniswap-v4");
  // null = "All chains" (the default landing view) — the backend merges every
  // enabled chain's shard; a number restricts to that one chain.
  const [chainId, setChainId] = useState<number | null>(null);
  const [chains, setChains] = useState<ChainMeta[]>([DEFAULT_CHAIN]);
  /*
   * Which picker is open, if any — one variable for both, so two menus can
   * never be open at once.
   *
   * They used to open on CSS `:hover, :focus-within` with a pair of "closed"
   * flags layered on top for click-to-close. Clicking a trigger leaves it
   * focused, so :focus-within pinned that menu open after the pointer left;
   * hovering the other trigger then opened the second on top of it, and the two
   * panels overlapped. Holding openness in React state makes that
   * unrepresentable: opening one is the same assignment that closes the other.
   */
  const [openMenu, setOpenMenu] = useState<"chain" | "protocol" | null>(null);
  // The pickers' shared container — the outside-tap listener below asks it
  // whether a pointerdown landed on either picker or its open panel.
  const clusterRef = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState(1);
  /*
   * Two values for one control: `minValueDraft` is what the select shows and
   * changes on every option, `minValueUsd` is what the table is fetched with
   * and follows it MIN_VALUE_DEBOUNCE_MS later (see the effect below). The
   * status select sets both at once, because a status change is one decision,
   * not a stream of them — debouncing it would fetch the new status with the
   * old floor first.
   */
  const [minValueUsd, setMinValueUsd] = useState(500);
  const [minValueDraft, setMinValueDraft] = useState(500);
  const [positionStatus, setPositionStatus] =
    useState<PositionStatus>("active");
  // Default to IN-RANGE positions — the actively-earning set is the useful
  // landing view; "All ranges" / "Out of range" stay one click away.
  const [rangeFilter, setRangeFilter] = useState<RangeFilter>("in");
  // Default OFF since 2026-10-06 (it was ON): the landing view is the trusted
  // set, like the Pools page's own risky toggle. Off sends includeRisky=false,
  // which hides open positions with no reliable price, a zero value or an
  // implausible APR/ROI — and, on the APR / ROI / PnL sorts (the default is
  // APR), open positions whose performance is still pending
  // (`metrics.performanceReady`). Ticking it drops those guards, as before.
  // It never shows positions in pools with a static fee of 5% or more (the
  // backend's HONEYPOT_FEE_FILTER hides them on ranked and pool lists either
  // way; with HONEYPOT_FEE_ANCHOR_EXEMPT a pool of two config anchors is
  // shown either way) or tokens in the spam / no-real-market exclusion set. Not in the URL: like the
  // other filters it resets on reload. The backend's landing-view warmup
  // (`LANDING_FILTERS` in leaderboard-warmup.service.ts) mirrors this default.
  const [includeRisky, setIncludeRisky] = useState(false);
  const [equityOnly, setEquityOnly] = useState(false);
  const [search, setSearch] = useState("");
  /*
   * What the search box is asking for, which decides WHERE the search runs:
   *
   *   id    digits only        → server-side `positionId` (exact)
   *   owner 0x + 40 hex        → server-side `owner` (exact, every page)
   *   text  anything else      → client-side substring match, and the API has
   *                              no symbol search, so it can only see the page
   *                              already loaded
   *
   * The distinction has to be visible in the UI, not just here: a text search
   * that quietly filtered 25 loaded rows while the pager still read "2 / 305"
   * looked like a broken pager. `searchScope` below is what the results line
   * renders from.
   */
  const trimmedSearch = search.trim();
  const searchKind: "none" | "id" | "owner" | "text" = !trimmedSearch
    ? "none"
    : /^\d+$/.test(trimmedSearch)
      ? "id"
      : /^0x[0-9a-fA-F]{40}$/.test(trimmedSearch)
        ? "owner"
        : "text";
  // The debounced server-side half of the above (empty for text searches), so
  // typing doesn't fire a fetch per keystroke.
  const [serverSearch, setServerSearch] = useState<{
    positionId?: string;
    owner?: string;
  }>({});
  /*
   * The page on screen, together with the exact params it was fetched with.
   * The pending-count lookup must ask about THIS page's filter: while the next
   * filter's page loads, the old page stays up, and pairing its `totalPending`
   * with the newly selected filter would count a filter whose own page may come
   * back already counted.
   */
  const [loaded, setLoaded] = useState<{
    data: LeaderboardResponse;
    params: LeaderboardParams;
  } | null>(null);
  const data = loaded?.data ?? null;
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [selected, setSelected] = useState<LeaderboardPosition | null>(null);
  const [detail, setDetail] = useState<PositionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the Refresh button: re-runs the list effect and the health poll
  // with unchanged filters.
  const [reloadNonce, setReloadNonce] = useState(0);
  /*
   * The detail request behind the open panel (row click or deep link). A newer
   * open or a close aborts the one before it, so A-then-B can never paint A's
   * detail into B's panel, and the abandoned request stops on the server too.
   */
  const detailAbortRef = useRef<AbortController | null>(null);

  const listParams = useMemo<LeaderboardParams>(
    () => ({
      chainId,
      protocol,
      sort,
      page,
      limit: 25,
      activeOnly: positionStatus === "active",
      status: positionStatus,
      range: rangeFilter,
      minValueUsd,
      minPoolTvl: positionStatus === "active" ? 1000 : 0,
      includeRisky,
      assetClass: equityOnly ? ('equity' as const) : undefined,
      positionId: serverSearch.positionId,
      owner: serverSearch.owner,
    }),
    [
      chainId,
      protocol,
      sort,
      page,
      positionStatus,
      rangeFilter,
      includeRisky,
      equityOnly,
      minValueUsd,
      serverSearch.positionId,
      serverSearch.owner,
    ],
  );

  // One request per filter state; a newer filter (or Refresh, or unmount)
  // aborts the one in flight instead of letting it finish on the server and
  // race the newer response to the table.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchLeaderboard(listParams, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setLoaded({ data: next, params: listParams });
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

  // The size of the result set, when the page came back without one.
  const listTotal = useListTotal(
    data?.pagination,
    loaded ? filterKey(loaded.params) : "",
    (signal) =>
      loaded
        ? fetchLeaderboardCount(loaded.params, signal)
        : Promise.reject(new Error("no page loaded")),
    // A page missing a chain shows no all-chains count (it would include that chain's rows).
    (data?.missingChains?.length ?? 0) > 0,
  );
  const totalPages = pageCount(listTotal, data?.pagination.limit ?? 25);
  const totalLabel = data ? formatCount(listTotal.total, listTotal.capped) : "0";

  /*
   * /health on its own clock. It used to share a Promise.all with the
   * leaderboard, so the table could not render until /health answered — and a
   * cold /health waits on indexer probes for up to 10 s. It feeds only the
   * status line in the info banner, so it now loads beside the table, re-polls
   * every minute (skipped while the tab is hidden), and a failure keeps the
   * last reading rather than raising an error over a table that loaded fine.
   */
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const tick = async () => {
      if (first || document.visibilityState !== "hidden") {
        first = false;
        const attempt = new AbortController();
        const cancel = () => attempt.abort();
        controller.signal.addEventListener("abort", cancel);
        const deadline = setTimeout(cancel, HEALTH_TIMEOUT_MS);
        try {
          const next = await fetchHealth(attempt.signal);
          if (!controller.signal.aborted) setHealth(next);
        } catch {
          /* keep the last reading */
        } finally {
          clearTimeout(deadline);
          controller.signal.removeEventListener("abort", cancel);
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(tick, HEALTH_POLL_MS);
    };
    void tick();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [reloadNonce]);

  // Commit the min-value select to the query once it has settled.
  useEffect(() => {
    if (minValueDraft === minValueUsd) return;
    const handle = setTimeout(() => {
      setMinValueUsd(minValueDraft);
      setPage(1);
    }, MIN_VALUE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [minValueDraft, minValueUsd]);

  // Enabled chains for the picker (chains whose integration env is unset come
  // back with protocols:[] and are hidden). Fetch once; on failure keep the
  // Ethereum default so the dashboard behaves exactly as pre-multichain.
  useEffect(() => {
    const controller = new AbortController();
    fetchChains(controller.signal)
      .then((all) => {
        if (controller.signal.aborted) return;
        registerChains(all); // feed the chain-info registry (chips, explorer links)
        const enabled = all.filter((c) => c.protocols.length > 0);
        if (enabled.length > 0) setChains(enabled);
      })
      .catch(() => {
        /* keep DEFAULT_CHAIN */
      });
    return () => controller.abort();
  }, []);

  // Unmounting the dashboard abandons whatever detail request is in flight.
  useEffect(() => () => detailAbortRef.current?.abort(), []);

  // Debounce an id / owner search into the server query. Any change resets to
  // page 1: a search applied while sitting on page 2 of the UNFILTERED result
  // set was the other half of the confusing pager — the filtered set is a new
  // result set and has its own page 1.
  useEffect(() => {
    const next =
      searchKind === "id"
        ? { positionId: trimmedSearch }
        : searchKind === "owner"
          ? { owner: trimmedSearch.toLowerCase() }
          : {};
    if (
      next.positionId === serverSearch.positionId &&
      next.owner === serverSearch.owner
    ) {
      return;
    }
    const handle = setTimeout(() => {
      setServerSearch(next);
      setPage(1);
    }, 350);
    return () => clearTimeout(handle);
  }, [trimmedSearch, searchKind, serverSearch.positionId, serverSearch.owner]);

  // A text search also restarts at page 1 — it filters whatever page is
  // loaded, so staying on page 7 would search page 7 alone for no stated
  // reason. Separate from the debounce above because it must not wait on it.
  useEffect(() => {
    if (searchKind === "text") setPage(1);
  }, [searchKind]);

  /*
   * The client-side half. Only runs for a text search: an id / owner search is
   * already exact at the API, and re-filtering its rows here would be a second,
   * invisible filter over a set that is by definition complete.
   */
  const filteredPositions = useMemo(() => {
    const positions = data?.positions ?? [];
    if (searchKind !== "text") return positions;
    const term = trimmedSearch.toLowerCase();
    return positions.filter((position) => {
      return [
        position.positionId,
        position.tokenId,
        position.owner,
        position.poolId,
        position.token0.symbol,
        position.token1.symbol,
      ].some((value) => value.toLowerCase().includes(term));
    });
  }, [data?.positions, searchKind, trimmedSearch]);

  // Protocols at least one enabled chain actually serves, straight from
  // /v1/chains (the same fetch that feeds the chain picker). Anything else 400s
  // "Unsupported protocol" at the API, so it is listed under an explicit
  // "not indexed yet" heading rather than as a selectable (or merely greyed)
  // option.
  const enabledProtocols = useMemo(
    () => new Set(chains.flatMap((c) => c.protocols)),
    [chains],
  );

  const servedProtocols = useMemo(
    () => PROTOCOLS.filter((item) => enabledProtocols.has(item.key)),
    [enabledProtocols],
  );

  const unindexedProtocolLabels = useMemo(
    () => [
      ...PROTOCOLS.filter((item) => !enabledProtocols.has(item.key)).map(
        (item) => item.label,
      ),
      ...UNINDEXED_PROTOCOL_LABELS,
    ],
    [enabledProtocols],
  );

  const selectedProtocol =
    PROTOCOLS.find((item) => item.key === protocol) ?? PROTOCOLS[0];
  const selectedChain =
    chainId === null
      ? null // All chains
      : (chains.find((c) => c.chainId === chainId) ?? DEFAULT_CHAIN);

  /*
   * The open/close behaviour both pickers share. Hover opens and leaving
   * closes, which is what the CSS did; focus and Escape are handled here too,
   * because `:focus-within` is what pinned a menu open after a click and it is
   * gone now. `relatedTarget` is where focus is going — a blur inside the same
   * wrap (trigger → menu item) must not close what the user is tabbing into,
   * so only a blur that lands outside closes the menu.
   *
   * `pointerType === "mouse"` is what makes the pickers work on a phone, and
   * the reason they did not: a tap on a touch screen fires the compatibility
   * mouse events too, mouseenter FIRST, so the hover handler opened the menu
   * and the click that immediately followed read it as already-open and
   * toggled it shut. The pickers were unopenable on a phone — pointerenter
   * carries the device that caused it, so hover-to-open is now scoped to an
   * actual mouse and a tap only ever runs the click handler.
   *
   * The `:focus-visible` guard covers the same collision for focus: Chrome
   * matches it on a button only for KEYBOARD focus, so a tap's focus does not
   * open a menu the following click would close.
   */
  const menuWrapProps = (menu: "chain" | "protocol") => ({
    onPointerEnter: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse") setOpenMenu(menu);
    },
    onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse") setOpenMenu(null);
    },
    onFocus: (event: FocusEvent<HTMLDivElement>) => {
      if (event.target.matches(":focus-visible")) setOpenMenu(menu);
    },
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpenMenu(null);
    },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") setOpenMenu(null);
    },
  });

  /*
   * Tapping anywhere else closes the open picker. On a mouse, leaving the wrap
   * closes it and a blur covers the keyboard; a touch tap outside does neither
   * — it fires no mouseleave, and tapping non-interactive page furniture moves
   * no focus — so without this the menu stayed open until the user tapped the
   * trigger again.
   */
  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (!clusterRef.current?.contains(target)) setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openMenu]);

  // Claims the detail slot for a new request, aborting whichever held it.
  const claimDetailRequest = () => {
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    return controller;
  };

  // Releases the slot if this request still holds it. `detailLoading` then
  // reads "is ANY detail request still in flight", so a superseded request
  // finishing late never clears the spinner of the one that replaced it.
  const releaseDetailRequest = (controller: AbortController) => {
    if (detailAbortRef.current === controller) detailAbortRef.current = null;
    setDetailLoading(detailAbortRef.current !== null);
  };

  const openPosition = async (position: LeaderboardPosition) => {
    const controller = claimDetailRequest();
    setSelected(position);
    setDetail(null);
    setDetailLoading(true);
    syncPositionUrl({
      chainId: position.chainId,
      protocol: position.protocol,
      positionId: position.positionId,
    });
    try {
      const nextDetail = await fetchPositionDetail(
        {
          chainId: position.chainId,
          protocol: position.protocol as ProtocolKey,
          positionId: position.positionId,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setDetail({ ...nextDetail, rank: position.rank });
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      releaseDetailRequest(controller);
    }
  };

  const closePosition = () => {
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;
    setDetailLoading(false);
    setSelected(null);
    setDetail(null);
    syncPositionUrl(null);
  };

  /*
   * Open the shared position on first paint. The detail response carries every
   * field the summary does (`PositionDetail extends Omit<LeaderboardPosition,
   * 'rank'>`), so it doubles as `summary` here — a deep link doesn't know the
   * leaderboard rank the row would have had. Chain and protocol follow the link
   * too, so the table behind the panel matches it.
   */
  useEffect(() => {
    const ref = readPositionUrl();
    if (!ref) return;
    // Same slot as a row click, so clicking a row while the link is still
    // loading supersedes it instead of being overwritten by it.
    const controller = claimDetailRequest();
    setChainId(ref.chainId);
    setProtocol(ref.protocol as ProtocolKey);
    setDetailLoading(true);
    fetchPositionDetail(
      {
        chainId: ref.chainId,
        protocol: ref.protocol as ProtocolKey,
        positionId: ref.positionId,
      },
      controller.signal,
    )
      .then((nextDetail) => {
        if (controller.signal.aborted) return;
        const rank = nextDetail.rank ?? 0;
        setSelected({ ...nextDetail, rank });
        setDetail({ ...nextDetail, rank });
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setError(err instanceof Error ? err.message : String(err));
        syncPositionUrl(null);
      })
      .finally(() => releaseDetailRequest(controller));
    return () => controller.abort();
    // Mount-only: the URL is read once, on first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * No `<main>` and no `AppNav` of its own any more: /explore renders this
   * inside `MarketingShell`, which supplies the site-wide header, footer and
   * the `main` landmark. Keeping either here produced two nav bars and nested
   * `<main>` elements, and the dashboard was the last public page still
   * wearing the old Tickwise chrome instead of the shared one.
   */
  return (
    <>
      <section className="positionsPage">
        <header className="pageHeader">
          <div>
            {/*
              Token classes rather than bare tags: `.pageHeader h1` in
              layer(legacy) pins 23px and inherits weight 400, and the tw-bridge
              rule for it sets only family, tracking and colour. Utilities win
              over layer(legacy), so this is what lifts the title to the same
              Sora 600 / 2.25rem every other page uses.
            */}
            {/*
              Responsive, not fixed: `text-4xl` is 36px, which on a 375px phone
              filled the screen next to a 16px subtitle and pushed the table
              below the fold. The desktop size is unchanged from `sm:` up.
            */}
            <h1 className="font-display text-[1.625rem] sm:text-4xl font-semibold tracking-tight">
              {viewMode === "stocks"
                ? "Tokenized stocks"
                : viewMode === "pools"
                ? "Pools"
                : positionStatus === "inactive"
                  ? "Closed positions"
                  : positionStatus === "all"
                    ? "All positions"
                    : "Open positions"}
            </h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              {viewMode === "stocks"
                ? "Pools with a tokenized-equity leg on Robinhood Chain"
                : viewMode === "pools"
                  ? "Top liquidity pools by TVL"
                  : statusSummary(positionStatus, minValueUsd)}
            </p>
          </div>

          <div className="viewTabs">
            <button
              className={viewMode === "positions" ? "active" : ""}
              onClick={() => setViewMode("positions")}
            >
              Positions
            </button>
            <button
              className={viewMode === "pools" ? "active" : ""}
              onClick={() => setViewMode("pools")}
            >
              Pools
            </button>
            {chains.some((c) => c.chainId === EQUITY_CHAIN_ID) && (
              <button
                className={viewMode === "stocks" ? "active" : ""}
                onClick={() => setViewMode("stocks")}
              >
                Stocks
              </button>
            )}
          </div>

          <div className="controlCluster" ref={clusterRef}>
            <div
              className={openMenu === "chain" ? "dropdownWrap menuOpen" : "dropdownWrap"}
              {...menuWrapProps("chain")}
            >
              <button
                className="dropdownButton"
                aria-haspopup="menu"
                aria-expanded={openMenu === "chain"}
                onClick={() => setOpenMenu(openMenu === "chain" ? null : "chain")}
              >
                <span className={selectedChain ? "chainIcon" : "chainIcon all"}>
                  {selectedChain ? selectedChain.name.charAt(0).toUpperCase() : "ALL"}
                </span>
                {selectedChain ? selectedChain.name : "All chains"}
                <ChevronDown size={15} />
              </button>
              <div className="protocolMenu">
                <button
                  className={chainId === null ? "active" : ""}
                  onClick={() => {
                    setChainId(null);
                    setPage(1);
                    setOpenMenu(null);
                  }}
                >
                  <span className="chainIcon all">ALL</span>
                  All chains
                  <span className="checkBox">
                    {chainId === null ? <Check size={15} /> : null}
                  </span>
                </button>
                {chains.map((c) => (
                  <button
                    key={c.chainId}
                    className={chainId === c.chainId ? "active" : ""}
                    onClick={() => {
                      setChainId(c.chainId);
                      setPage(1);
                      setOpenMenu(null);
                    }}
                  >
                    <span className="chainIcon">{c.name.charAt(0).toUpperCase()}</span>
                    {c.name}
                    <span className="checkBox">
                      {chainId === c.chainId ? <Check size={15} /> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div
              className={openMenu === "protocol" ? "dropdownWrap menuOpen" : "dropdownWrap"}
              {...menuWrapProps("protocol")}
            >
              <button
                className="dropdownButton"
                aria-haspopup="menu"
                aria-expanded={openMenu === "protocol"}
                onClick={() => setOpenMenu(openMenu === "protocol" ? null : "protocol")}
              >
                <span className="protocolIcon">U</span>
                {selectedProtocol.label}
                <ChevronDown size={15} />
              </button>
              <div className="protocolMenu">
                {servedProtocols.map((item) => (
                  <button
                    key={item.key}
                    className={protocol === item.key ? "active" : ""}
                    onClick={() => {
                      setProtocol(item.key);
                      setPage(1);
                      setOpenMenu(null);
                    }}
                  >
                    <span className="protocolIcon">{item.label.charAt(0)}</span>
                    {item.label}
                    <span className="checkBox">
                      {protocol === item.key ? <Check size={15} /> : null}
                    </span>
                  </button>
                ))}
                {unindexedProtocolLabels.length > 0 ? (
                  <>
                    <div
                      style={{
                        padding: "8px 9px 2px",
                        fontSize: 11,
                        fontWeight: 800,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "var(--tk-muted)",
                      }}
                    >
                      Not indexed yet
                    </div>
                    {unindexedProtocolLabels.map((label) => (
                      <button
                        key={label}
                        disabled
                        title={`${label} is not indexed — the API rejects it`}
                      >
                        <span className="protocolIcon muted">
                          {label.charAt(0)}
                        </span>
                        {label}
                        <span className="checkBox" />
                      </button>
                    ))}
                  </>
                ) : null}
              </div>
            </div>
            {/*
              A label for the toolbar below, not a control. It was a
              `.dropdownButton` with no onClick sitting third in a row of two
              working pickers — same height, same border, same fill, and it did
              nothing when clicked. Every filter it names is already on the
              toolbar directly underneath, so there is no menu for it to open;
              the fix is to stop it claiming there is one. `aria-hidden` because
              the funnel plus the word adds nothing a screen reader wants read
              out ahead of the real controls.
            */}
            <span className="filtersLabel" aria-hidden="true">
              filters
              <Filter size={15} />
            </span>
          </div>
        </header>

        {viewMode === "pools" ? (
          <PoolsDashboard chainId={chainId} protocol={protocol} />
        ) : null}

        {/*
          Stocks reuses the pools view wholesale, with the asset class forced and
          the chain pinned to the one that has tokenized equities. Pinning the
          chain matters: the tab is meaningless under "All chains", and leaving
          the picker in charge would let it silently render an empty table.
        */}
        {viewMode === "stocks" ? (
          <PoolsDashboard chainId={EQUITY_CHAIN_ID} protocol={protocol} forceAssetClass="equity" />
        ) : null}

        {viewMode === "positions" ? <>
        <div className="revertToolbar">
          <label className="searchControl">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search token, pool, owner, position"
            />
          </label>
          <label className="compactSelect">
            <select
              value={minValueDraft}
              // Committed (and the page reset) by the debounce effect.
              onChange={(event) => setMinValueDraft(Number(event.target.value))}
            >
              <option value={0}>Any value</option>
              <option value={500}>$500+</option>
              <option value={1000}>$1K+</option>
              <option value={10000}>$10K+</option>
            </select>
          </label>
          <label className="compactSelect">
            <select
              value={positionStatus}
              onChange={(event) => {
                const nextStatus = event.target.value as PositionStatus;
                setPositionStatus(nextStatus);
                // Same batch as the status, so this stays ONE fetch.
                if (nextStatus === "inactive" && CLOSED_HIDDEN_SORTS.has(sort)) setSort("pnl");
                // Draft and committed value together, so this is ONE fetch
                // and any pending debounced value is superseded, not applied.
                const nextMinValue =
                  nextStatus !== "active"
                    ? 0
                    : minValueDraft === 0
                      ? 500
                      : minValueDraft;
                setMinValueDraft(nextMinValue);
                setMinValueUsd(nextMinValue);
                setPage(1);
              }}
            >
              <option value="active">Open</option>
              <option value="inactive">Closed</option>
              <option value="all">All</option>
            </select>
          </label>
          <label className="compactSelect">
            <select
              value={rangeFilter}
              onChange={(event) => {
                setRangeFilter(event.target.value as RangeFilter);
                setPage(1);
              }}
            >
              <option value="all">All ranges</option>
              <option value="in">In range</option>
              <option value="out">Out of range</option>
            </select>
          </label>
          <label
            className="miniToggle"
            title="Also show risky positions: positions without a reliable price, a zero value or an implausible APR or ROI, and (on the APR, ROI and PnL sorts) positions whose performance is still being worked out. Pools with a fee of 5% or more (unless both tokens are majors) and spam tokens stay hidden either way."
          >
            <input
              type="checkbox"
              checked={includeRisky}
              onChange={(event) => {
                setIncludeRisky(event.target.checked);
                setPage(1);
              }}
            />
            risky
          </label>
          {(chainId === EQUITY_CHAIN_ID || chainId === null) && (
            <label className="miniToggle" title="Positions in pools with a tokenized-equity leg">
              <input
                type="checkbox"
                checked={equityOnly}
                onChange={(event) => {
                  setEquityOnly(event.target.checked);
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
          <CopyV1CallButton getCommand={() => leaderboardV1Command(listParams)} />
        </div>

        <div className="sortStrip" aria-label="Leaderboard sorts">
          {sortsForStatus(positionStatus).map((item) => (
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

        {/* Freshness is stated in exactly one voice across the site: the
            landing hero, the footer and the pricing FAQ all say the same two
            numbers, because they answer the same question and this page is
            linked from all three. Positions re-price on the 5-minute sync tick
            (POSITIONS_SYNC_INTERVAL_MS); the hourly figure is on-chain fee
            state, not the whole dataset. */}
        <div className="infoBanner">
          <Info size={16} />
          Positions re-price roughly every 5 minutes; on-chain fee state
          refreshes about hourly on Ethereum. Values may slightly differ from
          live market conditions.
          <span>
            {health?.status ?? "checking"} · {health?.integrations.length ?? 0}{" "}
            integrations
            {(() => {
              const indexedTo = health?.integrations.find(
                (i) => i.indexedUpToTimestamp
              )?.indexedUpToTimestamp;
              return indexedTo
                ? ` · data indexed to ${new Date(indexedTo * 1000).toLocaleDateString()}`
                : "";
            })()}
          </span>
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
            <TableSkeleton />
          ) : trimmedSearch && filteredPositions.length === 0 ? (
            /*
              Search-specific empty state. The table's generic "No positions —
              run sync or adjust filters" is wrong advice here: for a text
              search nothing on THIS page matched (other pages may), and for an
              id / owner search the API found nothing at all under the current
              filters.
            */
            <div className="emptyState">
              <Search size={22} />
              <strong>No match for “{trimmedSearch}”</strong>
              <span>
                {searchKind === "text"
                  ? `Nothing on page ${page} matches. Token and pool search covers the loaded page only — search an NFT ID or a wallet address to search every position.`
                  : "No position matches under the current filters. Widen the value, status or range filters, or turn on risky pools."}
              </span>
              <button className="clearSearch" onClick={() => setSearch("")}>
                Clear search
              </button>
            </div>
          ) : (
            <PositionsTable
              positions={filteredPositions}
              protocolShort={selectedProtocol.short}
              currentSort={sort}
              hideRateSorts={positionStatus === "inactive"}
              onSort={(nextSort) => {
                setSort(nextSort);
                setPage(1);
              }}
              onSelect={(position) => void openPosition(position)}
            />
          )}
        </section>

        {/*
          Results line + pager. The pager used to render unconditionally and
          read "2 / 305" next to a table showing one row, because a text search
          filters the loaded page while `pagination` describes the UNFILTERED
          server result set. Now the line says which of the two is being
          counted, and the pager is hidden when there is only one page to walk.

          The total can arrive after the page ("…" until the count lands, "N+"
          when it hit the backend cap), so whether there IS another page comes
          from `hasMore` — exact, because the backend reads one row past the
          page — never from the total.
        */}
        {loading ? null : (
          <div className="pagination">
            <span className="resultsNote">
              {searchKind === "text" ? (
                <>
                  {filteredPositions.length} of {data?.positions.length ?? 0} on
                  this page match “{trimmedSearch}”
                  <em>
                    token and pool search covers the loaded page only — search an
                    NFT ID or a wallet address to search every position
                  </em>
                </>
              ) : searchKind === "none" ? (
                `${totalLabel} positions`
              ) : (
                `${totalLabel} ${
                  data && listTotal.total === 1 && !listTotal.capped
                    ? "position matches"
                    : "positions match"
                } “${trimmedSearch}”`
              )}
            </span>
            {page > 1 || data?.pagination.hasMore || (totalPages ?? 1) > 1 ? (
              <span className="pageControls">
                <button
                  className="iconButton"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  aria-label="Previous page"
                >
                  <ArrowLeft size={17} />
                </button>
                <span>
                  page {page} of {formatCount(totalPages, listTotal.capped)}
                </span>
                <button
                  className="iconButton"
                  disabled={!data?.pagination.hasMore}
                  onClick={() => setPage((value) => value + 1)}
                  aria-label="Next page"
                >
                  <ArrowRight size={17} />
                </button>
              </span>
            ) : null}
          </div>
        )}
        </> : null}
      </section>

      {viewMode === "positions" && selected ? (
        <PositionDetailPanel
          summary={selected}
          detail={detail}
          loading={detailLoading}
          protocolShort={selectedProtocol.short}
          onClose={closePosition}
        />
      ) : null}
    </>
  );
}

export function PositionsTable({
  positions,
  protocolShort,
  currentSort,
  onSort,
  onSelect,
  hideRateSorts = false,
}: {
  positions: LeaderboardPosition[];
  protocolShort: string;
  currentSort: SortKey;
  onSort: (sort: SortKey) => void;
  onSelect: (position: LeaderboardPosition) => void;
  /** Closed tab: APR / fee APR / ROI headers are labels, not sort buttons. */
  hideRateSorts?: boolean;
}) {
  if (positions.length === 0) {
    return (
      <div className="emptyState">
        <Database size={22} />
        <strong>No positions</strong>
        <span>Run sync or adjust filters.</span>
      </div>
    );
  }

  return (
    <div className="tableWrap">
      <table className="positionsTable">
        <thead>
          <tr>
            <th>pool/fee tier</th>
            <NftIdHeader currentSort={currentSort} onSort={onSort} />
            <th>owner</th>
            <SortableHeader
              label="pool assets"
              sortKey="underlying_value"
              currentSort={currentSort}
              onSort={onSort}
            />
            <SortableHeader
              label="PnL"
              sortKey="pnl"
              currentSort={currentSort}
              onSort={onSort}
            />
            {hideRateSorts ? (
              <th>APR</th>
            ) : (
              <SortableHeader
                label="APR"
                sortKey="apr"
                currentSort={currentSort}
                onSort={onSort}
              />
            )}
            {hideRateSorts ? (
              <th>fee APR</th>
            ) : (
              <SortableHeader
                label="fee APR"
                sortKey="fee_apr"
                currentSort={currentSort}
                onSort={onSort}
              />
            )}
            {hideRateSorts ? (
              <th>ROI</th>
            ) : (
              <SortableHeader
                label="ROI"
                sortKey="roi"
                currentSort={currentSort}
                onSort={onSort}
              />
            )}
            <SortableHeader
              label="age"
              sortKey="age"
              currentSort={currentSort}
              onSort={onSort}
            />
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => {
            const performanceReady =
              position.metrics.performanceReady !== false;
            const leaderboardPnl =
              position.metrics.poolPnlUsd ?? position.metrics.pnlUsd;
            const leaderboardApr =
              position.metrics.aprExGas ??
              position.metrics.poolApr ??
              position.metrics.apr;
            const aprWarmup = position.metrics.aprWarmup === true;
            const aprWarmupTitle = aprWarmup
              ? "APR is skewed by short position age"
              : undefined;
            // APR/fee-APR/ROI are rate metrics — dashed once a position is closed
            // or holds no current pooled value (annualized rates aren't meaningful
            // with nothing left in range). PnL still shows.
            const isClosed =
              position.isActive === false ||
              !(position.metrics.underlyingValueUsd > 0);
            const aprReady = performanceReady && !isClosed;
            const priceUnavailable = isPriceUnavailable(position.metrics);
            return (
              <tr
                key={`${position.protocol}-${position.positionId}`}
                className={
                  position.metrics.inRange === false
                    ? "outOfRangeRow"
                    : undefined
                }
                onClick={() => onSelect(position)}
              >
                <td className="poolCellTd">
                  <div className="poolCell">
                    <span className="pairIcons">
                      <TokenIcon token={position.token0} compact />
                      <TokenIcon token={position.token1} compact />
                    </span>
                    <strong>
                      {position.token0.symbol}/{position.token1.symbol}
                    </strong>
                    <FeeLabel fee={position.fee} />
                    <HookBadge hooks={position.hooks} customAccounting={position.customAccounting} />
                    <span className="versionPill">{protocolShort}</span>
                    <span className="chainPill" title={chainInfo(position.chainId).name}>
                      {chainInfo(position.chainId).shortName}
                    </span>
                    {position.metrics.inRange === false ? (
                      <span className="outBadge">OUT</span>
                    ) : null}
                    <RiskBadges risk={position.risk} />
                  </div>
                </td>
                <td className="mono accent" data-label="NFT id">
                  {position.tokenId}
                </td>
                <td className="mono accent" data-label="owner">
                  <OwnerLabel owner={position.owner} />
                </td>
                <td className="mono" data-label="pool assets">
                  {priceUnavailable ? (
                    <span className="pendingMetric" title="No price available for a token in this position yet">
                      price unavailable
                    </span>
                  ) : (
                    formatCurrency(position.metrics.underlyingValueUsd)
                  )}
                </td>
                <td
                  data-label="PnL"
                  className={
                    performanceReady
                      ? leaderboardPnl >= 0
                        ? "positive mono"
                        : "negative mono"
                      : "pendingMetric mono"
                  }
                >
                  {performanceReady
                    ? formatCurrency(leaderboardPnl)
                    : "–"}
                </td>
                <td
                  data-label="APR"
                  className={
                    aprReady
                      ? leaderboardApr >= 0
                        ? "positive mono"
                        : "negative mono"
                      : "pendingMetric mono"
                  }
                  title={aprWarmupTitle}
                >
                  {aprReady ? formatPercent(leaderboardApr) : "–"}
                  {aprReady && aprWarmup ? (
                    <span className="aprWarmupBadge">*</span>
                  ) : null}
                </td>
                <td
                  data-label="fee APR"
                  className={aprReady ? "mono" : "pendingMetric mono"}
                  title={aprWarmupTitle}
                >
                  {aprReady ? formatPercent(position.metrics.feeApr) : "–"}
                  {aprReady && aprWarmup ? (
                    <span className="aprWarmupBadge">*</span>
                  ) : null}
                </td>
                <td
                  data-label="ROI"
                  className={
                    aprReady
                      ? position.metrics.roi >= 0
                        ? "positive mono"
                        : "negative mono"
                      : "pendingMetric mono"
                  }
                >
                  {aprReady ? formatPercent(position.metrics.roi) : "–"}
                </td>
                <td className="mono" data-label="age">
                  {formatAge(position.metrics.ageSeconds)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PositionDetailPanel({
  summary,
  detail,
  loading,
  protocolShort,
  onClose,
}: {
  summary: LeaderboardPosition;
  detail: PositionDetail | null;
  loading: boolean;
  protocolShort: string;
  onClose: () => void;
}) {
  /*
   * Header actions. Refresh re-fetches this position's detail (and its charts)
   * without touching the parent's leaderboard state, so it works identically
   * whether the panel was opened from the positions table or from a pool's
   * position list. The refetched detail is stamped with the positionId it
   * belongs to: the panel is not remounted per position, so an override from a
   * previously-viewed position must not leak into the next one. It is also
   * stamped with the parent `detail` it superseded (`base`): when the parent
   * fetches a NEWER detail for the same position (reopened A → B → A while
   * the panel stayed mounted), that one wins — an override never outlives the
   * answer it was newer than.
   */
  const [refreshed, setRefreshed] = useState<
    { positionId: string; detail: PositionDetail; base: PositionDetail | null } | null
  >(null);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped by refresh; part of the charts effect's deps so a refresh re-pulls
  // the chart series too, not just the metrics.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [openActions, setOpenActions] = useState<"ref" | "more" | null>(null);
  // Transient confirmation for the copy/share actions ("Link copied").
  const [toast, setToast] = useState<string | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  // The refresh in flight, if any: a second click, a switch to another
  // position, or closing the panel aborts it.
  const refreshAbortRef = useRef<AbortController | null>(null);

  const liveDetail =
    refreshed && refreshed.positionId === summary.positionId && refreshed.base === detail
      ? refreshed.detail
      : detail;
  const position = liveDetail ?? summary;
  const amounts = liveDetail?.amounts ?? summary.amounts;
  const transactions = liveDetail?.transactions ?? [];
  const token0Amount = toNumber(amounts?.amount0);
  const token1Amount = toNumber(amounts?.amount1);
  const deposited0 = toNumber(amounts?.depositedToken0);
  const deposited1 = toNumber(amounts?.depositedToken1);
  const withdrawn0 = toNumber(amounts?.withdrawnToken0);
  const withdrawn1 = toNumber(amounts?.withdrawnToken1);
  const diff0 = toNumber(amounts?.diffToken0);
  const diff1 = toNumber(amounts?.diffToken1);
  const uncollected0 = toNumber(amounts?.totalFeesUncollected0);
  const uncollected1 = toNumber(amounts?.totalFeesUncollected1);
  const collected0 = toNumber(amounts?.totalFeesCollected0);
  const collected1 = toNumber(amounts?.totalFeesCollected1);
  const totalFeesUsd =
    position.metrics.totalFeesUsd ?? position.metrics.pendingFeesUsd;
  const collectedFeesUsd = position.metrics.collectedFeesUsd ?? 0;
  const uncollectedFeesUsd = position.metrics.pendingFeesUsd;
  // Not read on-chain since the last settle: the figure is a placeholder 0, so
  // say "Pending" instead of a $0.000 that reads as "earns nothing".
  const uncollectedPending = feesPending(position.metrics);
  const uncollectedFeesLabel = uncollectedPending ? "Pending" : formatCurrency(uncollectedFeesUsd);
  const uncollectedPendingTitle = uncollectedPending
    ? "Measured on-chain about every 30 minutes"
    : undefined;
  const performanceReady = position.metrics.performanceReady !== false;
  const aprWarmup = position.metrics.aprWarmup === true;
  const ageDays = Math.max(position.metrics.ageSeconds / 86400, 1);
  // Rate metrics (APR / fee APR / pool APR / ROI) are dashed when there's no
  // cost basis (performanceReady === false), the position is closed, or it holds
  // no current pooled value — an annualized rate isn't meaningful with nothing
  // left in range. PnL / divergence / fees still show.
  const isClosed =
    position.isActive === false || !(position.metrics.underlyingValueUsd > 0);
  const aprReady = performanceReady && !isClosed;
  // Partial transaction history: pooled assets and uncollected fees are populated
  // by the adapter even when cashflow-derived PnL/APR can't be computed.
  const partialHistory =
    !performanceReady &&
    (position.metrics.underlyingValueUsd > 0 || uncollectedFeesUsd > 0);
  const pendingNote = partialHistory
    ? "partial transaction history"
    : undefined;
  const aprNote = aprWarmup ? "skewed by short age" : pendingNote;
  const priceUnavailable = isPriceUnavailable(position.metrics);
  // A held leg priced from a single/unlisted source (not consensus/anchor) →
  // the value is real but lower-confidence. Note it when we DO show a value.
  const lowConfidencePrice =
    !priceUnavailable &&
    position.metrics.underlyingValueUsd > 0 &&
    [
      { amt: token0Amount, conf: position.token0.priceConfidence },
      { amt: token1Amount, conf: position.token1.priceConfidence },
    ].some((l) => l.amt > 0 && l.conf !== undefined && !["anchor", "external-verified"].includes(l.conf));
  const nominalNote = lowConfidencePrice
    ? "price from a single / unverified source"
    : undefined;
  // Show "price unavailable" instead of $0.000 when a held leg couldn't be priced.
  const pooledAssetsValue = priceUnavailable
    ? "price unavailable"
    : formatCurrency(position.metrics.underlyingValueUsd);
  const decimals0 = position.token0.decimals;
  const decimals1 = position.token1.decimals;
  const minPrice = tickToHumanPrice(position.tickLower, decimals0, decimals1);
  const maxPrice = tickToHumanPrice(position.tickUpper, decimals0, decimals1);
  const currentPrice = tickToHumanPrice(
    position.currentTick,
    decimals0,
    decimals1,
  );
  const rangeLabel = position.metrics.inRange ? "In Range" : "Out of Range";

  // Prices-in toggle: default quotes token1-per-token0 (e.g. USDC per ETH);
  // selecting token0 inverts (and swaps min/max so min stays < max).
  const [priceInverted, setPriceInverted] = useState(false);
  const safeInvert = (value: number) => (value > 0 ? 1 / value : 0);
  const dispCurrent = priceInverted ? safeInvert(currentPrice) : currentPrice;
  const dispMin = priceInverted ? safeInvert(maxPrice) : minPrice;
  const dispMax = priceInverted ? safeInvert(minPrice) : maxPrice;
  const quoteLabel = priceInverted
    ? `${position.token0.symbol} per ${position.token1.symbol}`
    : `${position.token1.symbol} per ${position.token0.symbol}`;

  // Reference basis for PnL/APR/ROI. HOLD (default) = vs-HODL (top-level
  // metrics); USD = vs-USD companion (`metrics.usd`); ETH disabled until
  // vs-ETH PnL is implemented.
  const [pnlRef, setPnlRef] = useState<"hold" | "usd" | "eth">("hold");

  // "expand charts": drops the two-column detail grid to one column, so the
  // charts take the panel's full width and the metrics column reflows beneath
  // them (nothing is hidden). The chart boxes also grow — every chart here is
  // autoSize / ResizeObserver-driven, so they re-fit without a remount.
  const [chartsExpanded, setChartsExpanded] = useState(false);

  // Close whichever header menu is open on an outside pointer press or Escape.
  // `pointerdown` (not click) so the menu is gone before a click lands on
  // whatever is underneath it.
  useEffect(() => {
    if (!openActions) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) {
        setOpenActions(null);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpenActions(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openActions]);

  const showToast = useCallback((message: string) => {
    setToast(message);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const handle = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(handle);
  }, [toast]);

  const refresh = useCallback(async () => {
    setOpenActions(null);
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setRefreshing(true);
    try {
      const next = await fetchPositionDetail(
        {
          chainId: summary.chainId,
          protocol: summary.protocol as ProtocolKey,
          positionId: summary.positionId,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setRefreshed({
        positionId: summary.positionId,
        detail: { ...next, rank: next.rank ?? summary.rank },
        base: detail,
      });
      setRefreshNonce((value) => value + 1);
      showToast("Updated");
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      showToast(err instanceof Error ? `Refresh failed: ${err.message}` : "Refresh failed");
    } finally {
      // Only the newest refresh owns the spinner: one superseded by a second
      // click must not clear it while its replacement is still running.
      if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
      setRefreshing(refreshAbortRef.current !== null);
    }
  }, [summary.chainId, summary.protocol, summary.positionId, summary.rank, detail, showToast]);

  // A refresh belongs to the position it was started for: switching position
  // (the panel is not remounted per position) or closing the panel drops it.
  useEffect(
    () => () => {
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
    },
    [summary.positionId],
  );

  /*
   * A detail whose transaction list came back incomplete — still loading at the
   * backend's 1.5 s wait (`transactionsDegraded`), or only its newest page while
   * a busy position's full history is walked behind the answer
   * (`transactionsPartial`) — is asked for ONCE more after
   * DEGRADED_DETAIL_RETRY_MS. The backend finishes the list into its cache, so
   * the second answer is normally complete; a second incomplete answer is left
   * as it is (Refresh is still there). "Once" is per position and per Refresh,
   * and is spent only when the follow-up actually fires, so a re-render before
   * then does not lose it. A NEWER parent detail (the position reopened while
   * the panel stayed mounted) gets its own retry: the slot remembers the detail
   * it was spent on. Silent: no toast, and a failed follow-up keeps what is on
   * screen.
   */
  const detailRetriedRef = useRef<{ slot: string; base: PositionDetail | null } | null>(null);
  const liveIncomplete =
    liveDetail?.transactionsDegraded === true || liveDetail?.transactionsPartial === true;
  useEffect(() => {
    if (!liveIncomplete) return;
    const slot = `${summary.chainId}:${summary.protocol}:${summary.positionId}:${refreshNonce}`;
    const spent = detailRetriedRef.current;
    if (spent && spent.slot === slot && spent.base === detail) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      detailRetriedRef.current = { slot, base: detail };
      fetchPositionDetail(
        {
          chainId: summary.chainId,
          protocol: summary.protocol as ProtocolKey,
          positionId: summary.positionId,
        },
        controller.signal,
      )
        .then((next) => {
          if (controller.signal.aborted) return;
          setRefreshed({
            positionId: summary.positionId,
            detail: { ...next, rank: next.rank ?? summary.rank },
            base: detail,
          });
        })
        .catch(() => {
          /* aborted (closed / switched) or failed: keep the incomplete list */
        });
    }, DEGRADED_DETAIL_RETRY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [liveIncomplete, summary.chainId, summary.protocol, summary.positionId, summary.rank, refreshNonce, detail]);

  const copyLink = useCallback(async () => {
    setOpenActions(null);
    const url = positionShareUrl({
      chainId: summary.chainId,
      protocol: summary.protocol,
      positionId: summary.positionId,
    });
    showToast((await copyToClipboard(url)) ? "Link copied" : "Copy failed");
  }, [summary.chainId, summary.protocol, summary.positionId, showToast]);

  /*
   * Share hands the link to the OS sheet where one exists (mobile, Safari) and
   * falls back to the clipboard everywhere else. A dismissed sheet rejects with
   * AbortError — that is a user cancelling, not a failure, so it stays silent.
   */
  const share = useCallback(async () => {
    const url = positionShareUrl({
      chainId: summary.chainId,
      protocol: summary.protocol,
      positionId: summary.positionId,
    });
    const title = `${summary.token0.symbol}/${summary.token1.symbol} position #${summary.tokenId}`;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        /* sharing unavailable at runtime — fall through to the clipboard */
      }
    }
    showToast((await copyToClipboard(url)) ? "Link copied" : "Copy failed");
  }, [
    summary.chainId,
    summary.protocol,
    summary.positionId,
    summary.tokenId,
    summary.token0.symbol,
    summary.token1.symbol,
    showToast,
  ]);

  const copyValue = useCallback(
    async (label: string, value: string) => {
      setOpenActions(null);
      showToast((await copyToClipboard(value)) ? `${label} copied` : "Copy failed");
    },
    [showToast],
  );

  /*
   * Detail charts (pool price + liquidity distribution + position series) from
   * the backend /charts endpoint. Fetched ONCE per open (and per Refresh) at
   * range=all; the range buttons slice that payload client-side, anchored to
   * the newest point (lib/chart-range.ts), so switching range sends no request.
   */
  const [chartRange, setChartRange] = useState<ChartRange>("all");
  const [allCharts, setAllCharts] = useState<PositionCharts | null>(null);
  // Which computed position-series tab is shown in the main chart.
  const [seriesTab, setSeriesTab] = useState<SeriesKey>("pnl");
  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    setAllCharts(null);
    const load = (followUp: boolean) =>
      fetchPositionCharts(
        {
          chainId: position.chainId,
          protocol: position.protocol as ProtocolKey,
          positionId: position.positionId,
          range: "all",
        },
        controller.signal,
      )
        .then((c) => {
          if (controller.signal.aborted) return;
          setAllCharts(c);
          // Inputs still loading at the backend's deadline land in its cache:
          // ask once more rather than leave empty sections up for the whole open.
          if (c.partial && !followUp) retry = setTimeout(() => void load(true), PARTIAL_CHARTS_RETRY_MS);
        })
        .catch(() => {
          // Aborted (closed / switched / refreshed) or failed: nothing to show
          // from this request. A failed follow-up keeps the partial charts.
          if (!controller.signal.aborted && !followUp) setAllCharts(null);
        });
    void load(false);
    return () => {
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [position.chainId, position.protocol, position.positionId, refreshNonce]);
  const charts = useMemo(
    () => (allCharts ? slicePositionCharts(allCharts, chartRange) : null),
    [allCharts, chartRange],
  );

  const m = position.metrics;
  const usdBasis = m.usd;
  const refView =
    pnlRef === "usd" && usdBasis
      ? {
          totalPnl: usdBasis.pnlUsd,
          totalApr: usdBasis.apr,
          feeApr: usdBasis.feeApr,
          poolPnl: usdBasis.poolPnlUsd,
          poolApr: usdBasis.aprExGas,
          roi: usdBasis.roi,
          divergence: usdBasis.divergenceLossUsd,
        }
      : {
          totalPnl: m.pnlHodl ?? m.pnlUsd,
          totalApr: m.apr,
          feeApr: m.feeApr,
          poolPnl: m.poolPnlUsd ?? m.pnlUsd,
          poolApr: m.poolApr ?? m.aprExGas ?? m.apr,
          roi: m.roi,
          divergence: m.divergenceLossUsd ?? 0,
        };

  return (
    <div className="detailOverlay" onClick={onClose}>
      <section className="positionDetail" onClick={(event) => event.stopPropagation()}>
        <div className="detailAccent" />
        <header className="detailHero">
          <div className="pairTitle">
            <div className="pairIcons">
              <TokenIcon token={position.token0} />
              <TokenIcon token={position.token1} />
            </div>
            <div>
              <h2>
                {position.token0.symbol}/{position.token1.symbol}
              </h2>
              <div className="titleMeta">
                <FeeLabel fee={position.fee} />
                <HookBadge hooks={position.hooks} customAccounting={position.customAccounting} />
                <span className="chainIcon" title={chainInfo(position.chainId).name}>
                  {chainInfo(position.chainId).name.charAt(0).toUpperCase()}
                </span>
                <span className="chainPill">{chainInfo(position.chainId).shortName}</span>
                <span className="versionPill">{protocolShort}</span>
                <span
                  className={
                    position.metrics.inRange
                      ? "rangeStatusPill in"
                      : "rangeStatusPill out"
                  }
                >
                  {rangeLabel}
                </span>
                <RiskBadges risk={position.risk} />
                {loading ? <span>loading details</span> : null}
              </div>
            </div>
          </div>
          {/*
            A native <select> used to sit here inside a <label> next to a
            decorative chevron. Only the select's own text box opened it —
            clicking "ref" or the chevron did nothing, because a label click
            focuses a select without opening its popup. It is a button + menu
            now, on the same state machine as the chain/protocol pickers, so the
            whole control (chevron included) opens the list.
          */}
          <div className="detailActions" ref={actionsRef}>
            <div
              className={
                openActions === "ref" ? "detailMenuWrap menuOpen" : "detailMenuWrap"
              }
            >
              <button
                className="miniButton refTrigger"
                aria-haspopup="menu"
                aria-expanded={openActions === "ref"}
                onClick={() =>
                  setOpenActions(openActions === "ref" ? null : "ref")
                }
              >
                <span className="refLabel">ref</span>
                {PNL_REFS.find((item) => item.key === pnlRef)?.label}
                <ChevronDown size={14} />
              </button>
              <div className="detailMenu" role="menu">
                {PNL_REFS.map((item) => {
                  const disabled =
                    item.key === "eth" || (item.key === "usd" && !usdBasis);
                  return (
                    <button
                      key={item.key}
                      role="menuitemradio"
                      aria-checked={pnlRef === item.key}
                      className={pnlRef === item.key ? "active" : ""}
                      disabled={disabled}
                      title={disabled ? item.unavailable : undefined}
                      onClick={() => {
                        setPnlRef(item.key);
                        setOpenActions(null);
                      }}
                    >
                      <span>{item.label}</span>
                      {pnlRef === item.key ? <Check size={15} /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
            <button
              className="iconButton"
              onClick={() => void share()}
              aria-label="Share this position"
              title="Share this position"
            >
              <Share size={16} />
            </button>
            <div
              className={
                openActions === "more" ? "detailMenuWrap menuOpen" : "detailMenuWrap"
              }
            >
              <button
                className="iconButton"
                aria-haspopup="menu"
                aria-expanded={openActions === "more"}
                aria-label="More actions"
                title="More actions"
                onClick={() =>
                  setOpenActions(openActions === "more" ? null : "more")
                }
              >
                <MoreVertical size={16} />
              </button>
              <div className="detailMenu wide" role="menu">
                <button
                  role="menuitem"
                  disabled={refreshing}
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={15} className={refreshing ? "spinning" : undefined} />
                  <span>{refreshing ? "Refreshing…" : "Refresh data"}</span>
                </button>
                <button role="menuitem" onClick={() => void copyLink()}>
                  <Link2 size={15} />
                  <span>Copy link</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => void copyValue("NFT ID", position.tokenId)}
                >
                  <Copy size={15} />
                  <span>Copy NFT ID</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => void copyValue("Owner", position.owner)}
                >
                  <Copy size={15} />
                  <span>Copy owner address</span>
                </button>
                {revertSupportsChain(position.chainId) ? (
                  <a
                    role="menuitem"
                    href={revertPositionUrl(
                      position.chainId,
                      position.protocol,
                      position.tokenId,
                    )}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setOpenActions(null)}
                  >
                    <ExternalLink size={15} />
                    <span>Open on Revert</span>
                  </a>
                ) : null}
              </div>
            </div>
            <button className="iconButton closeButton" onClick={onClose} aria-label="Close">
              <X size={17} />
            </button>
            <span className="actionToastAnchor">
              {toast ? (
                <span className="actionToast" role="status">
                  {toast}
                </span>
              ) : null}
            </span>
          </div>
        </header>

        <section className="heroStats">
          <RangeMini
            inRange={position.metrics.inRange}
            minPrice={dispMin}
            maxPrice={dispMax}
            currentPrice={dispCurrent}
            token0Symbol={position.token0.symbol}
            token1Symbol={position.token1.symbol}
          />
          <HeroMetric
            label="pooled assets"
            value={pooledAssetsValue}
            note={nominalNote}
          />
          <HeroMetric
            label="total PnL"
            value={performanceReady ? formatCurrency(refView.totalPnl) : "–"}
            tone={
              performanceReady
                ? refView.totalPnl >= 0
                  ? "positive"
                  : "negative"
                : undefined
            }
            note={performanceReady ? undefined : pendingNote}
          />
          <HeroMetric
            label="total APR"
            value={aprReady ? formatPercent(refView.totalApr) : "–"}
            tone={
              aprReady
                ? refView.totalApr >= 0
                  ? "positive"
                  : "negative"
                : undefined
            }
            note={!performanceReady ? pendingNote : isClosed ? undefined : aprNote}
          />
          <HeroMetric
            label="fee APR"
            value={aprReady ? formatPercent(refView.feeApr) : "–"}
            tone={
              aprReady
                ? refView.feeApr >= 0
                  ? "positive"
                  : "negative"
                : undefined
            }
            note={!performanceReady ? pendingNote : isClosed ? undefined : aprNote}
          />
          <HeroMetric
            label="uncollected fees"
            value={uncollectedFeesLabel}
            title={uncollectedPendingTitle}
          />
        </section>

        <div className="detailDivider" />

        <section
          className={chartsExpanded ? "detailGrid chartsExpanded" : "detailGrid"}
        >
          <div className="chartColumn">
            <div className="chartToolbar">
              <span>prices in</span>
              <button
                className={priceInverted ? "active" : ""}
                onClick={() => setPriceInverted(true)}
              >
                {position.token0.symbol}
              </button>
              <button
                className={priceInverted ? "" : "active"}
                onClick={() => setPriceInverted(false)}
              >
                {position.token1.symbol}
              </button>
              <button
                className={chartsExpanded ? "expandButton active" : "expandButton"}
                aria-pressed={chartsExpanded}
                onClick={() => setChartsExpanded((value) => !value)}
              >
                {chartsExpanded ? "collapse charts" : "expand charts"}
              </button>
            </div>
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
              <SeriesHeaderStat
                series={charts?.positionSeries?.[seriesTab] ?? null}
                tab={SERIES_TABS.find((t) => t.key === seriesTab)!}
              />
              <span className="rangeButtons">
                {CHART_RANGES.map((r) => (
                  <button
                    key={r.key}
                    className={chartRange === r.key ? "active" : ""}
                    onClick={() => setChartRange(r.key)}
                  >
                    {r.label}
                  </button>
                ))}
              </span>
            </div>

            {!charts ? (
              <ChartSkeleton />
            ) : charts.positionSeries && charts.positionSeries[seriesTab].length > 1 ? (
              <div className="tvChartBox">
                <SeriesAreaChart
                  points={charts.positionSeries[seriesTab]}
                  kind={SERIES_TABS.find((t) => t.key === seriesTab)!.kind}
                />
              </div>
            ) : (
              <div className="emptyChart">
                <BarChart3 size={20} />
                <span>Not enough history for this series</span>
              </div>
            )}

            <h3>Liquidity distribution</h3>
            {!charts ? (
              <ChartSkeleton liq />
            ) : charts.liquidityDistribution.ticks.length > 0 ? (
              <div className="tvChartBox liqBox">
                <LiquidityChart
                  dist={charts.liquidityDistribution}
                  inverted={priceInverted}
                  token0Symbol={position.token0.symbol}
                  token1Symbol={position.token1.symbol}
                  token0PriceUsd={position.token0.priceUsd}
                  token1PriceUsd={position.token1.priceUsd}
                  tickSpacing={position.tickSpacing}
                />
              </div>
            ) : (
              <div className="emptyChart">
                <BarChart3 size={20} />
                <span>No liquidity data</span>
              </div>
            )}

            <h3>
              {priceInverted
                ? `${position.token1.symbol}/${position.token0.symbol}`
                : `${position.token0.symbol}/${position.token1.symbol}`}{" "}
              price
            </h3>
            {!charts ? (
              <ChartSkeleton />
            ) : charts.poolPrice.length > 1 ? (
              <div className="tvChartBox">
                <CandlePriceChart
                  points={charts.poolPrice}
                  inverted={priceInverted}
                  token0Symbol={position.token0.symbol}
                  token1Symbol={position.token1.symbol}
                  minPrice={minPrice}
                  maxPrice={maxPrice}
                  currentPrice={currentPrice}
                />
              </div>
            ) : (
              <div className="emptyChart">
                <BarChart3 size={20} />
                <span>No price data</span>
              </div>
            )}
          </div>

          <div className="dataColumn">
            <Section title="Performance">
              <DataRow
                label="pool PnL"
                value={performanceReady ? formatCurrency(refView.poolPnl) : "–"}
                note="excluding gas"
                tone={
                  performanceReady
                    ? refView.poolPnl >= 0
                      ? "positive"
                      : "negative"
                    : undefined
                }
              />
              <DataRow
                label="pool APR"
                value={aprReady ? formatPercent(refView.poolApr) : "–"}
                note={aprReady ? (aprNote ?? "excluding gas") : isClosed ? "excluding gas" : undefined}
                tone={
                  aprReady
                    ? refView.poolApr >= 0
                      ? "positive"
                      : "negative"
                    : undefined
                }
              />
              <DataRow
                label="ROI"
                value={aprReady ? formatPercent(refView.roi) : "–"}
                tone={
                  aprReady
                    ? refView.roi >= 0
                      ? "positive"
                      : "negative"
                    : undefined
                }
              />
              <DataRow
                label="divergence loss"
                value={
                  performanceReady
                    ? formatCurrency(refView.divergence)
                    : "–"
                }
              />
              <DataRow
                label="gas costs"
                value={
                  performanceReady
                    ? `${formatFixed(toNumber(amounts?.totalGasCostEth), 8)} ETH`
                    : "–"
                }
                note={
                  performanceReady
                    ? formatCurrency(position.metrics.totalGasCostUsd ?? 0)
                    : undefined
                }
              />
            </Section>

            <Section title="Fees">
              <DataRow
                label="total fees"
                value={formatCurrency(totalFeesUsd)}
                extra={`${formatTokenAmount(collected0 + uncollected0)} ${position.token0.symbol}`}
                extra2={`${formatTokenAmount(collected1 + uncollected1)} ${position.token1.symbol}`}
              />
              <DataRow
                label="uncollected fees"
                value={uncollectedFeesLabel}
                title={uncollectedPendingTitle}
                // The token amounts are the same placeholder zeros while pending.
                extra={uncollectedPending ? undefined : `${formatTokenAmount(uncollected0)} ${position.token0.symbol}`}
                extra2={uncollectedPending ? undefined : `${formatTokenAmount(uncollected1)} ${position.token1.symbol}`}
              />
              <DataRow
                label="avg daily fees"
                value={formatCurrency(totalFeesUsd / ageDays)}
                extra={`${formatTokenAmount((collected0 + uncollected0) / ageDays)} ${position.token0.symbol}`}
                extra2={`${formatTokenAmount((collected1 + uncollected1) / ageDays)} ${position.token1.symbol}`}
              />
              <DataRow
                label="collected fees"
                value={formatCurrency(collectedFeesUsd)}
                extra={`${formatTokenAmount(collected0)} ${position.token0.symbol}`}
                extra2={`${formatTokenAmount(collected1)} ${position.token1.symbol}`}
              />
              <DataRow label="reinvested fees" value={formatCurrency(0)} />
            </Section>

            <Section title="Assets and Range">
              <DataRow
                label="current price"
                value={formatCompactNumber(dispCurrent)}
                note={quoteLabel}
                badge={position.metrics.inRange ? "IN-RANGE" : "OUT"}
              />
              <DataRow
                label="limit prices"
                value={`${formatCompactNumber(dispMin)} <-> ${formatCompactNumber(dispMax)}`}
              />
              <DataRow
                label="current assets"
                value={pooledAssetsValue}
                note={nominalNote}
                extra={`${formatTokenAmount(token0Amount)} ${position.token0.symbol}`}
                extra2={`${formatTokenAmount(token1Amount)} ${position.token1.symbol}`}
              />
              <DataRow
                label="invested assets"
                value={formatCurrency(position.metrics.investedUsd)}
                extra={`${formatTokenAmount(deposited0)} ${position.token0.symbol}`}
                extra2={`${formatTokenAmount(deposited1)} ${position.token1.symbol}`}
              />
              <DataRow
                label="diffs"
                value={formatCurrency(position.metrics.diffUsd ?? 0)}
                extra={`${formatSignedToken(diff0)} ${position.token0.symbol}`}
                extra2={`${formatSignedToken(diff1)} ${position.token1.symbol}`}
                tone={
                  (position.metrics.diffUsd ?? 0) >= 0 ? "positive" : "negative"
                }
              />
              <DataRow
                label="withdrawn"
                value={formatCurrency(position.metrics.withdrawnUsd ?? 0)}
                extra={`${formatTokenAmount(withdrawn0)} ${position.token0.symbol}`}
                extra2={`${formatTokenAmount(withdrawn1)} ${position.token1.symbol}`}
              />
            </Section>

            <Section title="Rewards">
              <DataRow
                label="unclaimed rewards"
                value={formatCurrency(
                  position.metrics.unclaimedRewardsUsd ?? 0,
                )}
              />
              <DataRow
                label="claimed rewards"
                value={formatCurrency(position.metrics.claimedRewardsUsd ?? 0)}
              />
            </Section>

            <Section title="Metadata">
              <DataRow
                label="position age"
                value={formatAge(position.metrics.ageSeconds)}
              />
              <DataRow
                label="NFT ID"
                value={position.tokenId}
                href={
                  revertSupportsChain(position.chainId)
                    ? revertPositionUrl(position.chainId, position.protocol, position.tokenId)
                    : undefined
                }
                extra={
                  <>
                    Owner <OwnerLabel owner={position.owner} />
                  </>
                }
              />
            </Section>

            <Section
              title={`${position.token0.symbol}/${position.token1.symbol} pool overview`}
            >
              <DataRow
                label={`price ${position.token0.symbol}`}
                value={formatCompactNumber(position.token0.priceUsd)}
                note="USD"
                spark={charts?.poolOverview.price0}
              />
              <DataRow
                label={`price ${position.token1.symbol}`}
                value={formatCompactNumber(position.token1.priceUsd)}
                note="USD"
                spark={charts?.poolOverview.price1}
              />
              <DataRow
                label="fees/TVL"
                value={formatPercent(
                  (charts?.poolOverviewCurrent?.feesTvl ??
                    ((position.poolStats?.tvlUsd ?? 0) > 0
                      ? (position.poolStats?.totalFeesUsd ?? 0) /
                        (position.poolStats?.tvlUsd ?? 1)
                      : 0)) * 100,
                )}
                spark={charts?.poolOverview.feesTvl}
              />
              <DataRow
                label="TVL"
                value={formatCurrency(
                  charts?.poolOverviewCurrent?.tvl ?? position.poolStats?.tvlUsd ?? 0,
                )}
                spark={charts?.poolOverview.tvl}
              />
              <DataRow
                label="volume"
                value={formatCurrency(
                  charts?.poolOverviewCurrent?.volume ?? position.poolStats?.volumeUsd ?? 0,
                )}
                spark={charts?.poolOverview.volume}
              />
              <DataRow
                label="fees"
                value={formatCurrency(
                  charts?.poolOverviewCurrent?.fees ?? position.poolStats?.totalFeesUsd ?? 0,
                )}
                spark={charts?.poolOverview.fees}
              />
              <DataRow
                label="price divergence"
                value={formatPercent(position.poolStats?.priceDivergence ?? 0)}
                spark={charts?.poolOverview.divergence}
              />
            </Section>
          </div>
        </section>

        <footer className="positionLogs">
          <div className="logActions">
            <button disabled>Deposit</button>
            <button disabled>Withdraw</button>
            <button disabled>Collect fees</button>
            <button disabled>Move range</button>
            <button disabled>Compound</button>
            <span />
            <button className="active">Simulator</button>
            <button className="active">Logs</button>
          </div>

          <h3>Position logs</h3>
          <p>These are all the transactions associated with this position.</p>
          <div className="logTabs">
            <button className="active">Cash flows</button>
            <button disabled>Compoundings</button>
            <button disabled>Rewards</button>
          </div>
          {loading ? (
            <LogsSkeleton />
          ) : (
            <TransactionTable
              chainId={position.chainId}
              transactions={transactions}
              transactionsDegraded={liveDetail?.transactionsDegraded}
              transactionsPartial={liveDetail?.transactionsPartial === true}
              token0Symbol={position.token0.symbol}
              token1Symbol={position.token1.symbol}
            />
          )}
        </footer>
      </section>
    </div>
  );
}

function TokenIcon({
  token,
  compact = false,
}: {
  token: TokenSnapshot;
  compact?: boolean;
}) {
  // `logoURI` is resolved + HEAD-verified server-side (TokenLogoService), so we
  // render it directly: shimmer until it loads, fade in, fall to text initials
  // only if it errors or the backend found no logo (logoURI null).
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [token.logoURI]);

  const initials = token.symbol.slice(0, compact ? 1 : 3).toUpperCase();
  const src = token.logoURI && !failed ? token.logoURI : null;

  // Cache-hit images (esp. memory cache on reload) can fire load/error before
  // React attaches the event handlers — the callback ref reads `complete` off
  // the DOM to catch those, otherwise the skeleton sticks forever.
  const syncFromDom = (el: HTMLImageElement | null) => {
    if (!el || !el.complete) return;
    if (el.naturalWidth > 0) setLoaded(true);
    else setFailed(true);
  };

  // Three states: skeleton while the logo loads → image once it loads →
  // initials only when the fetch fails (or there's no logo URL at all).
  return (
    <span
      className={compact ? "tokenBadge compact" : "tokenBadge"}
      title={token.symbol}
    >
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
      {src ? (
        loaded ? null : <span className="tokenBadgeSkeleton" aria-hidden />
      ) : (
        initials
      )}
    </span>
  );
}

function SortableHeader({
  label,
  sortKey,
  currentSort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  currentSort: SortKey;
  onSort: (sort: SortKey) => void;
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

function NftIdHeader({
  currentSort,
  onSort,
}: {
  currentSort: SortKey;
  onSort: (sort: SortKey) => void;
}) {
  const active = currentSort === "nft_id_asc" || currentSort === "nft_id_desc";
  const nextSort = currentSort === "nft_id_asc" ? "nft_id_desc" : "nft_id_asc";
  return (
    <th>
      <button
        className={active ? "sortHeader active" : "sortHeader"}
        onClick={() => onSort(nextSort)}
      >
        NFT id
        <ArrowDown
          size={13}
          className={currentSort === "nft_id_asc" ? "sortIconAsc" : ""}
        />
      </button>
    </th>
  );
}

function RangeMini({
  inRange,
  minPrice,
  maxPrice,
  currentPrice,
  token0Symbol,
  token1Symbol,
}: {
  inRange: boolean;
  minPrice: number;
  maxPrice: number;
  currentPrice: number;
  token0Symbol: string;
  token1Symbol: string;
}) {
  const priceRange = Math.max(maxPrice - minPrice, 0);
  const currentPct =
    priceRange > 0
      ? Math.min(
          100,
          Math.max(0, ((currentPrice - minPrice) / priceRange) * 100),
        )
      : 50;
  const currentMarkerPct = inRange
    ? currentPct
    : currentPrice < minPrice
      ? 0
      : 100;
  const activeLeft = inRange ? 0 : currentPrice < minPrice ? 8 : 72;
  const activeWidth = inRange ? 100 : 20;
  const details = [
    `MIN price: ${formatCompactNumber(minPrice)}`,
    `MAX price: ${formatCompactNumber(maxPrice)}`,
    `Current: ${formatCompactNumber(currentPrice)}`,
  ];

  return (
    <div className={inRange ? "rangeMini in" : "rangeMini out"}>
      <span>range</span>
      <div className="rangeTrack" tabIndex={0}>
        <i />
        <b style={{ left: `${activeLeft}%`, width: `${activeWidth}%` }} />
        <em style={{ left: `${currentMarkerPct}%` }} />
        <strong className="rangeTooltip">
          {details.map((line) => (
            <small key={line}>{line}</small>
          ))}
          <small>
            {token1Symbol} per {token0Symbol}
          </small>
        </strong>
      </div>
      <small>{inRange ? "in range" : "out of range"}</small>
    </div>
  );
}

// True when we genuinely couldn't price a held leg (data gap) — distinct from a
// real $0. The UI shows "price unavailable" instead of a misleading "$0.000".
// Covers the adapter flag AND a read-path rejection (isPriceable=false).
function isPriceUnavailable(metrics: {
  priceUnavailable?: boolean;
  isPriceable?: boolean;
}): boolean {
  return metrics.priceUnavailable === true || metrics.isPriceable === false;
}

function HeroMetric({
  label,
  value,
  tone,
  note,
  title,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
  note?: string;
  /** Hover text on the value. */
  title?: string;
}) {
  return (
    <div className="heroMetric">
      <span>{label}</span>
      <strong className={tone} title={title}>{value}</strong>
      {note ? <em className="heroMetricNote">{note}</em> : null}
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

function DataRow({
  label,
  value,
  href,
  note,
  extra,
  extra2,
  tone,
  badge,
  spark,
  title,
}: {
  label: string;
  value: string;
  href?: string;
  note?: string;
  /** A node, not a string, so the NFT ID row can carry `<OwnerLabel>`. */
  extra?: ReactNode;
  extra2?: string;
  tone?: "positive" | "negative";
  badge?: string;
  spark?: ChartSeriesPoint[];
  /** Hover text on the value. */
  title?: string;
}) {
  return (
    <div className="dataRow">
      <span>{label}</span>
      <strong className={tone} title={title}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" title="Open on revert.finance">
            {value}
          </a>
        ) : (
          value
        )}
      </strong>
      <em>
        {spark && spark.length > 1 ? (
          <Sparkline points={spark} />
        ) : badge ? (
          <b>{badge}</b>
        ) : (
          note
        )}
      </em>
      <code>{extra}</code>
      <code>{extra2}</code>
    </div>
  );
}

/** Rows per page in the position log. */
const LOGS_PAGE_SIZE = 15;

function TransactionTable({
  chainId,
  transactions,
  transactionsDegraded,
  transactionsPartial,
  token0Symbol,
  token1Symbol,
}: {
  chainId: number;
  transactions: PositionTransaction[];
  transactionsDegraded?: boolean;
  /** Only the newest page: older history is still loading in the backend. */
  transactionsPartial?: boolean;
  token0Symbol: string;
  token1Symbol: string;
}) {
  // Chain-dynamic gas label + explorer base (ETH/etherscan on mainnet,
  // AVAX/snowtrace on Avalanche, …).
  const chain = chainInfo(chainId);
  const [page, setPage] = useState(0);

  /*
   * NEWEST FIRST. The API returns ascending by timestamp, which put a two-year-old
   * mint at the top and buried today's activity hundreds of rows down. Sorted on a
   * copy — mutating the prop array would reorder the caller's data.
   */
  const ordered = useMemo(
    () => [...transactions].sort((a, b) => toNumber(b.timestamp) - toNumber(a.timestamp)),
    [transactions],
  );

  const pageCount = Math.max(1, Math.ceil(ordered.length / LOGS_PAGE_SIZE));
  // Clamp rather than reset: re-opening a position with fewer txs than the page
  // you were on would otherwise render an empty table.
  const current = Math.min(page, pageCount - 1);
  const start = current * LOGS_PAGE_SIZE;
  const visible = ordered.slice(start, start + LOGS_PAGE_SIZE);

  if (transactions.length === 0) {
    // An empty list means one of two different things and they must not read
    // the same: the endpoint now returns 200 with an empty array when the
    // upstream indexer failed, so "synced yet" would state a fact we do not
    // have. Only claim there is no history when we actually loaded the list.
    return (
      <div className="logsEmpty">
        {transactionsDegraded
          ? "Transaction history is temporarily unavailable — the indexer did not respond. Nothing is missing from this position; try again shortly."
          : "No position transactions synced yet."}
      </div>
    );
  }

  return (
    <div className="logsTableWrap">
      {transactionsPartial ? (
        // The list is a busy position's NEWEST page; the panel asks again
        // shortly, and a complete answer replaces it.
        <p className="logsNote" role="status">
          Showing the newest {formatCount(transactions.length, false)} transactions — loading earlier history.
        </p>
      ) : null}
      <table className="logsTable">
        <thead>
          <tr>
            <th>date</th>
            <th>type</th>
            <th>{token0Symbol} amount</th>
            <th>{token1Symbol} amount</th>
            <th>HODL value</th>
            <th>gas cost</th>
            <th>tx hash</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((tx) => {
            const hodlValue = toNumber(tx.historicalValueUsd);
            return (
              <tr key={tx.transactionId}>
                <td>{formatDate(tx.timestamp)}</td>
                <td className={txTypeClass(tx.type)}>
                  {formatTxType(tx.type)}
                </td>
                <td>
                  {formatTokenAmount(toNumber(tx.amount0))} {token0Symbol}
                </td>
                <td>
                  {formatTokenAmount(toNumber(tx.amount1))} {token1Symbol}
                </td>
                <td>{formatCurrency(hodlValue)}</td>
                <td>
                  <span className="stackedValue">
                    <strong>
                      {formatFixed(tx.gasCostEth, 8)} {chain.nativeSymbol}
                    </strong>
                    <small>{formatCurrency(tx.gasCostUsd)}</small>
                  </span>
                </td>
                <td>
                  {explorerTxUrl(chainId, tx.txHash) ? (
                    <a
                      href={explorerTxUrl(chainId, tx.txHash)!}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {compactHash(tx.txHash)}
                    </a>
                  ) : (
                    <span>{compactHash(tx.txHash)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {pageCount > 1 && (
        <nav className="logsPager" aria-label="Position log pages">
          <button
            type="button"
            onClick={() => setPage(0)}
            disabled={current === 0}
            aria-label="First page"
          >
            ««
          </button>
          <button
            type="button"
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
            aria-label="Previous page"
          >
            ‹ prev
          </button>
          <span className="logsPagerInfo">
            {start + 1}–{Math.min(start + LOGS_PAGE_SIZE, ordered.length)} of {ordered.length}
          </span>
          <button
            type="button"
            onClick={() => setPage(current + 1)}
            disabled={current >= pageCount - 1}
            aria-label="Next page"
          >
            next ›
          </button>
          <button
            type="button"
            onClick={() => setPage(pageCount - 1)}
            disabled={current >= pageCount - 1}
            aria-label="Last page"
          >
            »»
          </button>
        </nav>
      )}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="skeletonRows">
      {Array.from({ length: 16 }).map((_, index) => (
        <div className="skeletonRow" key={index} />
      ))}
    </div>
  );
}

// Shimmer placeholder shown in a chart slot while `charts` is still loading.
// Bar silhouette (sized to the real chart box) reads as "a chart is coming",
// not a flat grey block; reuses the shared `shimmer` keyframes.
function ChartSkeleton({ liq = false }: { liq?: boolean }) {
  const bars = liq
    ? [62, 90, 74, 96, 68, 88, 60, 92, 56, 82, 70, 84]
    : [38, 52, 46, 66, 58, 78, 70, 90, 64, 82, 56, 74, 48, 86];
  return (
    <div className={`tvChartBox${liq ? " liqBox" : ""}`} aria-hidden>
      <div className="chartSkeleton">
        {bars.map((h, index) => (
          <span key={index} style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  );
}

function LogsSkeleton() {
  return (
    <div className="logsSkeleton" aria-hidden>
      {Array.from({ length: 8 }).map((_, index) => (
        <div className="logsSkeletonRow" key={index} />
      ))}
    </div>
  );
}

type SeriesKey = "pnl" | "assetsValue" | "apr" | "feeApr" | "divLoss";

const SERIES_TABS: {
  key: SeriesKey;
  label: string;
  kind: "currency" | "percent";
}[] = [
  { key: "pnl", label: "PnL", kind: "currency" },
  { key: "assetsValue", label: "Assets value", kind: "currency" },
  { key: "apr", label: "APR", kind: "percent" },
  { key: "feeApr", label: "Fees APR", kind: "percent" },
  { key: "divLoss", label: "Div. loss", kind: "currency" },
];

const CHART_RANGES: { key: ChartRange; label: string }[] = [
  { key: "30d", label: "30d" },
  { key: "60d", label: "60d" },
  { key: "90d", label: "90d" },
  { key: "180d", label: "180d" },
  { key: "all", label: "All" },
];

// Header above the position-series chart: "Total {metric} {value} (↑{delta}) 24h".
function SeriesHeaderStat({
  series,
  tab,
}: {
  series: ChartSeriesPoint[] | null;
  tab: { label: string; kind: "currency" | "percent" };
}) {
  if (!series || series.length < 1) {
    return <span className="seriesHeaderLabel">Total {tab.label} —</span>;
  }
  const last = series[series.length - 1].value;
  const prev = series.length > 1 ? series[series.length - 2].value : last;
  const delta = last - prev;
  const fmt = (v: number) => (tab.kind === "percent" ? formatPercent(v) : formatCurrency(v));
  const up = delta >= 0;
  return (
    <span className="seriesHeaderStat">
      <span className="seriesHeaderLabel">Total {tab.label}</span>
      <strong className={last >= 0 ? "positive" : "negative"}>{fmt(last)}</strong>
      <span className={up ? "seriesDeltaUp" : "seriesDeltaDown"}>
        ({up ? "↑" : "↓"}
        {fmt(Math.abs(delta))}) 24h
      </span>
    </span>
  );
}

// Compact trend sparkline for the pool-overview rows.
function Sparkline({ points }: { points: ChartSeriesPoint[] }) {
  const vals = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || Math.abs(max) || 1;
  const W = 112;
  const H = 22;
  const stepX = W / (points.length - 1);
  const coords = points.map((p, i) => {
    const v = Number.isFinite(p.value) ? p.value : min;
    const y = H - 2 - ((v - min) / span) * (H - 4);
    return `${(i * stepX).toFixed(1)},${y.toFixed(1)}`;
  });
  const first = vals[0] ?? 0;
  const last = vals[vals.length - 1] ?? 0;
  const color = last >= first ? "var(--green-soft)" : "var(--red)";
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
    >
      <path
        d={`M ${coords.join(" L ")}`}
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
        style={{ fill: "none", stroke: color }}
      />
    </svg>
  );
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(digits);
}

function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value)) return "0.000";
  const abs = Math.abs(value);
  if (abs >= 1) {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });
  }
  // Sub-1 amounts (e.g. fee fractions) keep wider precision so we don't lose signal.
  return value.toFixed(8);
}

function formatSignedToken(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatTokenAmount(value)}`;
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const abs = Math.abs(value);
  // Extreme magnitudes (full-range positions can hit ~1e50 / ~1e-50) → compact
  // scientific `m×10^e` instead of a 50-digit comma string or "0.000000000000".
  if (abs >= 1e9 || abs < 1e-6) {
    const [m, e] = value.toExponential(3).split("e");
    return `${parseFloat(m)}×10^${Number(e)}`;
  }
  if (abs >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  // 6 significant digits for sub-1 values — never collapse a nonzero to "0".
  return value.toPrecision(6).replace(/0+$/, "").replace(/\.$/, "");
}

function tickToHumanPrice(
  tick: number,
  decimals0: number,
  decimals1: number,
): number {
  if (!Number.isFinite(tick)) return 0;
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

/**
 * The min-value filter is a whole-dollar threshold picked from a dropdown, not
 * a measured amount. `formatCurrency` carries three fixed decimals for sub-cent
 * token values, which renders the 500 threshold as "$500.000" — five hundred
 * thousand to anyone who reads "." as a thousands separator. Thresholds print
 * with no decimals and a grouped thousands separator instead.
 */
const THRESHOLD_USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatThresholdUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  return THRESHOLD_USD_FORMATTER.format(value);
}

function statusSummary(status: PositionStatus, minValueUsd: number): string {
  const valueText =
    minValueUsd > 0
      ? ` with over ${formatThresholdUsd(minValueUsd)} in pooled assets`
      : "";
  if (status === "inactive") return `Showing closed positions${valueText}.`;
  if (status === "all") return `Showing open and closed positions${valueText}.`;
  return `Only showing open positions${valueText}.`;
}

function compactHash(value: string): string {
  if (!value) return "";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatTxType(value: string): string {
  if (value === "COLLECT_FEES") return "Fees Collected";
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function txTypeClass(value: string): string {
  if (value === "COLLECT_FEES") return "txTypeFees";
  if (value === "WITHDRAW") return "txTypeWithdraw";
  return "positive";
}
