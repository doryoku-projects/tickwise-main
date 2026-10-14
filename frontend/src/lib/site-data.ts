/**
 * Server-side getters for the public marketing surface.
 *
 * Separate from `lib/api.ts` (browser, un-cached) and from `lib/portal-api.ts`
 * (bearer token) on purpose: these run inside the server components that own
 * each marketing route's `metadata`, so the numbers arrive in the HTML a
 * crawler reads. They take no token and touch only routes that are public and
 * unmetered — `/v1/stats`, `/v1/plans`, `/v1/chains`, `/health`.
 *
 * Two rules shape every function here.
 *
 * 1. **Never throw.** A marketing page that 500s because the API is down is a
 *    worse outcome than one that renders without a number. Every getter catches
 *    and degrades.
 *
 * 2. **A number returned from this module is a measured number.** Where the API
 *    does not compute something the design asks for — TVL indexed, per-chain
 *    pool counts, a "most popular" plan — the field comes back `undefined` and
 *    the component renders its own unavailable state. Nothing here fills a gap
 *    with a plausible value; see the `MEASURED` notes on each type.
 */

import { API_BASE_URL, type HealthResponse } from './api';
import type { ApiPlan } from './catalog-api';

/**
 * GETs a public endpoint, or returns null.
 *
 * `revalidate` puts each route on ISR rather than making it dynamic, so the
 * marketing pages stay statically served — the SEO requirement — while the
 * numbers stay fresh.
 *
 * `revalidate: 0` opts OUT of caching entirely (`cache: 'no-store'`), which also
 * forces the calling route to be rendered per request. Reserve it for values
 * that must never be stale — see the plan catalogue, which is money.
 *
 * EVERY call is on a deadline. Rule 1 above ("never throw") only ever covered
 * an API that answers wrongly; it did nothing about one that answers SLOWLY,
 * and a hung upstream held the whole page's HTML behind it for as long as the
 * platform's own timeout allowed. `AbortSignal.timeout` turns that into the
 * degraded render this module was always supposed to produce: the getter
 * returns null on expiry and the component draws its unavailable state.
 */
const PUBLIC_GET_TIMEOUT_MS = 2500;

async function publicGet<T>(path: string, revalidate: number): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PUBLIC_GET_TIMEOUT_MS),
      ...(revalidate === 0 ? { cache: 'no-store' as const } : { next: { revalidate } }),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // DNS failure, timeout, abort, malformed JSON — all the same to the caller.
    return null;
  }
}

// ── Plans ───────────────────────────────────────────────────────────────────

/**
 * A plan card as the marketing pages render it.
 *
 * Derived from `GET /v1/plans`, whose money is in MINOR units and whose rate
 * limit is per MINUTE. Both are converted exactly once, here, so no view has to
 * remember which unit it is holding.
 */
export interface Plan {
  id: string;
  name: string;
  /** Whole currency units per month. */
  monthlyPrice: number;
  /** Whole currency units per year. 0 when the plan has no annual price. */
  annualPrice: number;
  /** Units per month. 0 = unlimited. */
  quota: number;
  /** Pre-formatted, e.g. "60 req/min". */
  rateLimit: string;
  /** 0 = unlimited. */
  maxKeys: number;
  allowBrowserKeys: boolean;
  features: string[];
  cta: string;
  /**
   * Renders the "Most popular" badge.
   *
   * ALWAYS FALSE TODAY, and deliberately so: "most popular" is a claim about
   * customers, `GET /v1/plans` carries no such flag, and picking the middle
   * tier to wear the badge would be inventing the claim in the client. The
   * design and the styling are kept intact so the badge lights up the day the
   * plan schema grows the field.
   */
  featured?: boolean;
}

function priceFor(plan: ApiPlan, interval: 'month' | 'year'): number {
  const price = plan.prices?.find((p) => p.interval === interval);
  return price ? price.unitAmountMinor / 100 : 0;
}

function toPlan(plan: ApiPlan): Plan {
  const monthlyPrice = priceFor(plan, 'month');
  return {
    id: plan.key,
    name: plan.name,
    monthlyPrice,
    annualPrice: priceFor(plan, 'year'),
    quota: plan.monthlyUnits,
    // Per MINUTE, and labelled as such. The design source's cards read
    // "5 req/s"; the API's `rateLimitPerMin` is a different unit entirely and
    // printing it beside "/s" would overstate the limit sixtyfold.
    rateLimit: `${plan.rateLimitPerMin.toLocaleString()} req/min`,
    maxKeys: plan.maxApiKeys ?? 0,
    allowBrowserKeys: plan.allowBrowserKeys ?? false,
    features: plan.features ?? [],
    cta: monthlyPrice === 0 ? 'Start free' : `Choose ${plan.name}`,
  };
}

/**
 * The sellable plan catalogue. Empty when the API is unreachable — the pricing
 * page says so rather than printing a bundled price list, because a stale or
 * invented price is the one thing a pricing page must never show.
 */
export async function getPublicPlans(): Promise<Plan[]> {
  /*
   * UN-CACHED, deliberately — this is the one fetch here that reads straight
   * from the database on every request.
   *
   * Plan price, quota, rate limit and key ceiling are all admin-editable and
   * apply to live metering IMMEDIATELY, so ANY cache lets /pricing advertise a
   * price nobody is charged any more. It was on a 1-hour ISR and that is exactly
   * what happened: the price was changed to $49 and the page kept saying $1,
   * while the portal — which reads the same catalogue un-cached from the browser
   * — correctly said $49. Two surfaces, one catalogue, two answers about money.
   *
   * The cost is that /pricing renders per request instead of being prerendered.
   * That is the right trade for a price: a stale number here is a false claim,
   * and the page already refuses to print a bundled fallback for the same
   * reason. Every other fetch in this file stays on ISR.
   */
  const live = await publicGet<{ plans: ApiPlan[] }>('/v1/plans', 0);
  if (!live || !Array.isArray(live.plans)) return [];
  return live.plans.map(toPlan);
}

/**
 * The same catalogue for the LANDING PAGE ONLY, on a short ISR window.
 *
 * `getPublicPlans()` above is un-cached because /pricing is the page a customer
 * reads to decide what to pay, and the $1-vs-$49 incident is what that comment
 * is about. Nothing here weakens that: /pricing and the portal still call it and
 * still render per request.
 *
 * The landing page is a different job. It shows three cards — tier name, quota,
 * and a `$X/mo` note — as a teaser under a "See pricing" button, and buying that
 * teaser's freshness cost the ENTIRE ROUTE its cacheability: one `no-store` in
 * the tree marks `/` dynamic, so every visitor on a phone waited out a
 * function invocation plus an upstream round trip before the first byte of HTML.
 * That is the single largest mobile cost on the page, paid for a figure that is
 * repeated, authoritatively and un-cached, one click away.
 *
 * 60 seconds bounds the exposure: a plan repriced in the admin panel is correct
 * on /pricing and in the portal immediately and correct here within a minute.
 * If that window ever needs to be zero, the fix is `revalidateTag` fired from
 * the admin save path — NOT restoring `no-store` here, which would silently
 * make `/` dynamic again.
 */
export async function getLandingPlans(): Promise<Plan[]> {
  const live = await publicGet<{ plans: ApiPlan[] }>('/v1/plans', 60);
  if (!live || !Array.isArray(live.plans)) return [];
  return live.plans.map(toPlan);
}

export interface UnitCost {
  /** Printed as it appears in the docs, e.g. "GET /v1/pools". */
  endpoint: string;
  /** The metering key the API actually charges against, e.g. "v1.pools.list". */
  routeKey: string;
  units: number;
  note: string;
}

/**
 * `routeKey` → the request a reader can actually copy.
 *
 * The API meters by an opaque key (`v1.positions.charts`); the pricing and docs
 * tables are read by somebody deciding what a call will cost them, and
 * "v1.positions.charts" is not something they can type. The mapping lives here,
 * once, rather than in each table. An unrecognised key falls through to itself
 * — a new metered route shows up priced but unformatted, which is a great deal
 * better than not showing up at all.
 */
const ROUTE_PATHS: Record<string, string> = {
  'v1.positions.list': 'GET /v1/positions',
  'v1.positions.detail': 'GET /v1/positions/{chainId}/{protocol}/{id}',
  'v1.positions.charts': 'GET /v1/positions/{chainId}/{protocol}/{id}/charts',
  'v1.pools.list': 'GET /v1/pools',
  'v1.pools.detail': 'GET /v1/pools/{chainId}/{protocol}/{id}',
  'v1.pools.charts': 'GET /v1/pools/{chainId}/{protocol}/{id}/charts',
  'v1.chains': 'GET /v1/chains',
  'v1.protocols': 'GET /v1/protocols',
};

/** Per-endpoint unit costs from `GET /v1/pricing/units`. Empty on failure. */
export async function getPublicUnitCosts(): Promise<UnitCost[]> {
  const live = await publicGet<{
    units: Array<{ routeKey: string; cost: number; description?: string | null }>;
  }>('/v1/pricing/units', 3600);
  if (!live || !Array.isArray(live.units)) return [];
  return live.units.map((u) => ({
    endpoint: ROUTE_PATHS[u.routeKey] ?? u.routeKey,
    routeKey: u.routeKey,
    units: u.cost,
    // A zero-cost route is unmetered, and the seeded label alone ("List
    // chains (metadata)") does not say so — the design's own table carried
    // "Free · unmetered" in that column.
    note: u.cost === 0 ? `${u.description ?? ''} · free, unmetered`.trim() : (u.description ?? ''),
  }));
}

// ── Headline metrics ────────────────────────────────────────────────────────

/**
 * The landing page's proof numbers.
 *
 * Every field is optional and each card renders its own placeholder, rather
 * than the whole block being all-or-nothing: three measured numbers beside one
 * honest dash is better than four dashes, and the alternative — withholding
 * pools and positions because TVL cannot be computed — hides data we do have.
 *
 * MEASURED: `poolsTracked`, `positionsTracked`, `activePositions`,
 * `tvlIndexedUsd`, `indexingLagMinutes` — all from `GET /v1/stats`.
 * NOT AVAILABLE: `aprEthUsdcPct`, `feeAprPct`, `volume24hUsd`. There is no
 * headline-pool endpoint, and picking a pool client-side to represent "the"
 * APR would be choosing which number to advertise. They stay undefined.
 */
export interface PublicStats {
  poolsTracked?: number;
  positionsTracked?: number;
  activePositions?: number;
  indexingLagMinutes?: number;
  tvlIndexedUsd?: number;
  aprEthUsdcPct?: number;
  feeAprPct?: number;
  volume24hUsd?: number;
}

export interface RawChainStats {
  chainId: number;
  protocol: string;
  pools: number;
  positions: number;
  activePositions: number;
  tvlUsd: number;
  indexedUpToTimestamp: number | null;
}

interface RawStats {
  pools: number;
  positions: number;
  activePositions: number;
  /** Summed gated pool TVL. See the note on the backend's `PublicChainStats`. */
  tvlUsd: number;
  /** ISO timestamp of the indexer head, or null when nothing is indexed. */
  indexedTo: string | null;
  byChain?: RawChainStats[];
}

/** Whole minutes between `iso` and now, floored at 0. Null if unparseable. */
function minutesSince(iso: string | null): number | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  return Math.max(0, Math.round((Date.now() - then) / 60_000));
}

/** Keeps only the numbers the response actually carried. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function getPublicStats(): Promise<PublicStats | null> {
  const live = await publicGet<RawStats>('/v1/stats', 60);
  if (!live) return null;
  return {
    poolsTracked: num(live.pools),
    positionsTracked: num(live.positions),
    activePositions: num(live.activePositions),
    tvlIndexedUsd: num(live.tvlUsd),
    indexingLagMinutes: minutesSince(live.indexedTo),
  };
}

// ── Per-chain coverage ──────────────────────────────────────────────────────

/**
 * What the landing page's coverage panel and /status print per chain.
 *
 * MEASURED: `indexingLagMinutes`, from `/health`'s per-integration indexer
 * head. NOT AVAILABLE: `tvlUsd` and `pools` — `/v1/stats` totals the corpus
 * across every shard and does not break it down, so a per-chain figure would
 * have to be guessed.
 */
export interface ChainMetrics {
  tvlUsd?: number;
  pools?: number;
  activePositions?: number;
  indexingLagMinutes?: number;
  /**
   * The block picture, preferred over minutes for display.
   *
   * "~0 min behind" is ambiguous on a chain with 1-second blocks — it reads as
   * a rounding artefact rather than a measurement. A block delta is exact and
   * is the unit the indexer actually works in.
   */
  indexedBlock?: number;
  chainHeadBlock?: number;
  /** `chainHeadBlock` is the backend's estimate (`/health` chainHeadEstimated), not a live reading. */
  chainHeadEstimated?: boolean;
  lagBlocks?: number;
}

/** Keyed by chain NAME as the panel labels it — "Ethereum", "Avalanche". */
export type ChainMetricsMap = Record<string, ChainMetrics>;

interface RawChain {
  chainId: number;
  name: string;
  shortName: string;
  protocols: string[];
}

/**
 * The short, human label the coverage panel and the status page key on.
 *
 * `/v1/chains` returns registry names — "Ethereum Mainnet", "Avalanche
 * C-Chain" — and the design's node labels are the bare chain. Trimming the
 * network qualifier here keeps the mapping in one place rather than in each
 * component's lookup.
 */
function chainLabel(name: string): string {
  // "Chain" is stripped too so "Robinhood Chain" reads as "Robinhood", matching
  // the bare-chain convention of the existing nodes rather than being the one
  // label carrying a network qualifier.
  return name.replace(/\s+(Mainnet|C-Chain|Chain)$/i, '');
}

export async function getChainMetrics(): Promise<ChainMetricsMap | null> {
  const [chains, health, stats] = await Promise.all([
    publicGet<RawChain[]>('/v1/chains', 3600),
    publicGet<HealthResponse>('/health', 15),
    publicGet<RawStats>('/v1/stats', 60),
  ]);
  if (!chains || chains.length === 0) return null;

  const map: ChainMetricsMap = {};
  for (const chain of chains) {
    /*
     * A chain can carry more than one protocol shard, so the corpus figures are
     * SUMMED across them and the freshness figures take the FRESHEST — a
     * protocol that is behind must not drag the chain's headline backwards,
     * whereas its pools and positions genuinely add to the chain's total.
     */
    let tvlUsd: number | undefined;
    let pools: number | undefined;
    let activePositions: number | undefined;
    for (const shard of stats?.byChain ?? []) {
      if (shard.chainId !== chain.chainId) continue;
      tvlUsd = (tvlUsd ?? 0) + shard.tvlUsd;
      pools = (pools ?? 0) + shard.pools;
      activePositions = (activePositions ?? 0) + shard.activePositions;
    }

    let minutes: number | undefined;
    let indexedBlock: number | undefined;
    // A live head beats an estimated one: the max is taken over live readings
    // first, and an estimate is shown only when no integration has a live head.
    let liveHead: number | undefined;
    let estimatedHead: number | undefined;
    let lagBlocks: number | undefined;
    for (const integration of health?.integrations ?? []) {
      if (integration.chainId !== chain.chainId) continue;
      const seconds = integration.indexedUpToTimestamp;
      if (typeof seconds === 'number' && seconds > 0) {
        const m = Math.max(0, Math.round((Date.now() - seconds * 1000) / 60_000));
        if (minutes === undefined || m < minutes) minutes = m;
      }
      if (typeof integration.lagBlocks === 'number') {
        if (lagBlocks === undefined || integration.lagBlocks < lagBlocks) {
          lagBlocks = integration.lagBlocks;
        }
      }
      if (typeof integration.indexedBlock === 'number') {
        indexedBlock = Math.max(indexedBlock ?? 0, integration.indexedBlock);
      }
      if (typeof integration.chainHeadBlock === 'number') {
        if (integration.chainHeadEstimated === true) {
          estimatedHead = Math.max(estimatedHead ?? 0, integration.chainHeadBlock);
        } else {
          liveHead = Math.max(liveHead ?? 0, integration.chainHeadBlock);
        }
      }
    }
    const chainHeadBlock = liveHead ?? estimatedHead;

    map[chainLabel(chain.name)] = {
      tvlUsd,
      pools,
      activePositions,
      indexingLagMinutes: minutes,
      indexedBlock,
      chainHeadBlock,
      chainHeadEstimated: liveHead === undefined && estimatedHead !== undefined ? true : undefined,
      lagBlocks,
    };
  }
  return map;
}

// ── Coverage matrix ─────────────────────────────────────────────────────────

/**
 * One row of the /status and /docs/coverage tables.
 *
 * Derived from `/v1/chains`, not authored: a chain with an enabled integration
 * is servable, one without is registered but dark. The design source hard-coded
 * Arbitrum and Optimism rows reading "indexed, not servable" — a claim about
 * chains this deployment does not index at all.
 */
export interface CoverageRow {
  chain: string;
  chainId: number;
  protocol: string;
  label: string;
  servable: boolean;
  /**
   * Minutes behind the chain head. From `/health`'s `lagSeconds` (lag in blocks ×
   * the chain's block time); from `indexedUpToTimestamp` only when the backend
   * does not send `lagSeconds` at all. `lagSeconds: null` → undefined.
   */
  lagMinutes?: number;
  /**
   * The block picture from `/health`, surfaced separately because the two
   * halves fail INDEPENDENTLY: `chainHeadBlock` comes from DeFiLlama and
   * `indexedBlock` from the indexer, so a dead indexer still leaves a real
   * chain head to show. Reporting only a derived "lag unavailable" threw away
   * the half we had.
   */
  indexedBlock?: number;
  chainHeadBlock?: number;
  /**
   * `chainHeadBlock` (and the lag with it) is the backend's estimate from its
   * last good DeFiLlama reading (`/health` chainHeadEstimated, ≤ 15 min), not
   * a live reading — rendered "~N (estimated)".
   */
  chainHeadEstimated?: boolean;
  lagBlocks?: number;
  /** The backend's own verdict: healthy | degraded | unhealthy | not_deployed. */
  health?: string;
}

const PROTOCOL_LABELS: Record<string, string> = {
  'uniswap-v4': 'Uniswap v4',
  'uniswap-v3': 'Uniswap v3',
};

/**
 * The pure mapper, exported because the SERVER renders the first paint and the
 * BROWSER re-renders it on a poll (see app/status/status-rows.tsx).
 *
 * Both sides have to produce byte-identical rows or the page would visibly
 * rearrange itself the first time the poll landed — so there is one function
 * rather than one per side. It takes data and returns rows; the fetching, and
 * the caching that differs between the two, stays with the caller.
 */
export function buildCoverageRows(
  chains: RawChain[] | null,
  health: HealthResponse | null,
): CoverageRow[] {
  // Shape-checked, not just null-checked: a 200 whose body is valid JSON of the
  // wrong shape (a proxy's notice, a deploy mid-rollout) used to THROW here, and
  // because this mapper runs at build time, on every ISR regeneration AND in the
  // browser poll, one such response failed a deploy's prerender and — unguarded in
  // the client — ended live updates. A body we cannot read is the same as no body.
  if (!Array.isArray(chains)) return [];
  const integrations = Array.isArray(health?.integrations) ? health.integrations : [];

  const rows: CoverageRow[] = [];
  for (const chain of chains) {
    const label = chainLabel(chain.name);
    const protocols = Array.isArray(chain.protocols) ? chain.protocols : [];
    if (protocols.length === 0) {
      rows.push({ chain: label, chainId: chain.chainId, protocol: '', label, servable: false });
      continue;
    }
    for (const protocol of protocols) {
      const integration = integrations.find(
        (i) => i.chainId === chain.chainId && i.protocol === protocol,
      );
      const seconds = integration?.indexedUpToTimestamp;
      // Prefer the block-derived lag: the timestamp comes from a slow indexer scan
      // that is missing most of the time on every chain but mainnet, which is why
      // the "~N days" line used to come and go. The timestamp is only the fallback,
      // for a backend that does not send `lagSeconds` yet — the field ABSENT. An
      // explicit `null` means "lag unknown" (e.g. no chain head this refresh), and
      // the row already says "lag unavailable"; printing the age of the newest
      // ModifyLiquidity event under that would be a different number in disguise.
      const lagSeconds = integration?.lagSeconds;
      rows.push({
        chain: label,
        chainId: chain.chainId,
        protocol,
        label: `${label} · ${PROTOCOL_LABELS[protocol] ?? protocol}`,
        servable: true,
        lagMinutes:
          lagSeconds === undefined
            ? typeof seconds === 'number' && seconds > 0
              ? Math.max(0, Math.round((Date.now() - seconds * 1000) / 60_000))
              : undefined
            : typeof lagSeconds === 'number' && lagSeconds >= 0
              ? Math.round(lagSeconds / 60)
              : undefined,
        indexedBlock: integration?.indexedBlock ?? undefined,
        chainHeadBlock: integration?.chainHeadBlock ?? undefined,
        chainHeadEstimated:
          integration?.chainHeadEstimated === true && typeof integration.chainHeadBlock === 'number'
            ? true
            : undefined,
        lagBlocks: integration?.lagBlocks ?? undefined,
        health: integration?.status,
      });
    }
  }
  return rows;
}

/**
 * Server-side coverage, for the first paint.
 *
 * `/health` is fetched with a SHORT revalidate: the status page's whole subject
 * is freshness, and a page cached for an hour saying "0 blocks behind" is the
 * kind of claim it exists to avoid. The chain list can be cached hard — a chain
 * is enabled by a deploy, not by a block.
 */
export async function getCoverage(): Promise<CoverageRow[]> {
  const [chains, health] = await Promise.all([
    publicGet<RawChain[]>('/v1/chains', 3600),
    publicGet<HealthResponse>('/health', 15),
  ]);
  return buildCoverageRows(chains, health);
}
