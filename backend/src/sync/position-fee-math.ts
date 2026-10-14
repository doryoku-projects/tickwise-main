/*
 * Pure math for the on-chain uncollected-fee refresh (PositionFeeRefreshService).
 * No I/O, so it is pinned directly by test/position-fee-math.spec.ts.
 */

import type { Position } from '../database/schemas/position.schema.js';
import { computePerformanceFromAggregates } from '../positions/position-performance.js';

const Q128 = 1n << 128n;
const MOD_256 = 1n << 256n;

/**
 * Fees owed to a Uniswap v4 position, in RAW token units.
 *
 * v4 computes `feeGrowthInside - feeGrowthInsideLast` inside an `unchecked`
 * block, so the difference WRAPS mod 2^256. A "negative" difference is real,
 * positive fee growth that happened to overflow — it must never be read as 0.
 * The indexer's `calculateUncollectedFees` clamps it to 0, which silently zeroes
 * real fees; this is the v4-faithful version.
 *
 * Out-of-range positions are NOT special-cased: StateView.getFeeGrowthInside
 * already returns the growth inside the range wherever the price is, so the
 * fees a position earned before leaving its range stay owed, exactly as on-chain.
 */
export function owedFeesRaw(
  feeGrowthInsideX128: bigint,
  feeGrowthInsideLastX128: bigint,
  liquidity: bigint,
): bigint {
  if (liquidity <= 0n) return 0n;
  const delta = (((feeGrowthInsideX128 - feeGrowthInsideLastX128) % MOD_256) + MOD_256) % MOD_256;
  return (delta * liquidity) / Q128;
}

/**
 * The v4 PositionManager salt for a position: its tokenId left-padded to
 * bytes32. Same identity relation the indexer's ModifyLiquidity handler uses.
 */
export function positionSalt(tokenId: string | bigint): `0x${string}` {
  const id = typeof tokenId === 'bigint' ? tokenId : BigInt(tokenId);
  if (id < 0n) throw new RangeError(`tokenId must be non-negative, got ${id}`);
  return `0x${id.toString(16).padStart(64, '0')}`;
}

/**
 * Where a served uncollected-fee figure came from — published additively as
 * `metrics.feesSource` on /api and /v1.
 *
 *   onchain    — a StateView measurement taken at or after the last fee-settling
 *                event (`lastModifyBlock`).
 *   indexer    — NO LONGER RETURNED. It labelled the indexer's own fee-sweep
 *                reading, which the indexer stopped carrying (the sweep and its
 *                `totalFeesUncollected0/1` / `feesUpdatedAtBlock` columns are
 *                gone) and the backend stopped selecting. The value stays in this
 *                type, the stored-document enum and the public docs so the API
 *                shape does not break: a stored row written before the change
 *                can still carry it until its next write, and a client's switch
 *                over the four values keeps compiling.
 *   settled    — the position holds no liquidity: the modify that emptied it
 *                settled every fee owed (a v4 modifyLiquidity always does) and
 *                nothing accrues after, so 0 is exact, not a placeholder. A
 *                closed position is never re-read on-chain (the fee job reads
 *                active positions only), so without this it would read
 *                "Pending" forever.
 *   unmeasured — no on-chain reading at or after the last modify: the figure is
 *                a placeholder 0 waiting for the fee job's next read. The
 *                dashboard renders "Pending" for it instead of $0.000.
 */
export type FeesSource = 'onchain' | 'indexer' | 'settled' | 'unmeasured';

/** An on-chain fee measurement stored on a position by the refresh job. */
export interface RpcFees {
  /** Decimal-adjusted token0 fees owed. */
  readonly fees0: number;
  /** Decimal-adjusted token1 fees owed. */
  readonly fees1: number;
  /** The block the measurement's state was read at (its batch's own block). */
  readonly block: number;
  /** When it was taken (`rpcFeesAt`). */
  readonly at?: Date;
}

export interface UncollectedChoice {
  fees0: number;
  fees1: number;
  source: FeesSource;
  /** When the served figure was measured on-chain; null unless `source` is `onchain`. */
  measuredAt: Date | null;
}

/**
 * Which uncollected-fee figure to serve for a position, and what to call it.
 *
 * The ONLY source is the on-chain measurement. The indexer no longer carries an
 * uncollected-fee figure (its fee sweep never completed on the largest chains,
 * zeroed out-of-range positions and clamped a wrapped fee-growth delta to 0), so
 * there is nothing to fall back to: a position with no usable reading is served
 * 0 and labelled `unmeasured`, which the dashboard renders as "Pending".
 *
 * The on-chain figure is served whenever it was taken at or after the position's
 * last FEE-SETTLING event, `lastModifyBlock` — the block of the last
 * ModifyLiquidity, which the indexer writes from that handler only. A v4
 * modifyLiquidity settles fees, so a measurement from before it may describe
 * fees already paid out; in that window the figure is the 0 that modify wrote,
 * called `unmeasured` until the next read — stale-low for at most one interval,
 * never stale-high.
 *
 * It is deliberately NOT keyed on `updatedAtBlock`: an NFT Transfer bumps that
 * column too and settles nothing, so keying on it made a transferred idle
 * position serve 0 forever.
 *
 * A position with no liquidity (`settled`) owes exactly 0 whatever a reading
 * says: its last modify paid every fee out and it accrues nothing.
 */
export function chooseUncollected(
  position: { lastModifyBlock: number; settled?: boolean },
  rpc: RpcFees | undefined,
): UncollectedChoice {
  if (position.settled === true) return { fees0: 0, fees1: 0, source: 'settled', measuredAt: null };
  const lastModify = finiteOr0(position.lastModifyBlock);
  if (
    rpc !== undefined &&
    Number.isFinite(rpc.fees0) &&
    Number.isFinite(rpc.fees1) &&
    Number.isFinite(rpc.block) &&
    rpc.block >= lastModify
  ) {
    return { fees0: rpc.fees0, fees1: rpc.fees1, source: 'onchain', measuredAt: rpc.at ?? null };
  }
  return { fees0: 0, fees1: 0, source: 'unmeasured', measuredAt: null };
}

/** Smallest served-fee change the refresh job rewrites the served fields for. */
export const FEE_WRITE_MIN_USD = 0.25;
/** …or this share of the larger of the old and new figure, whichever is more. */
export const FEE_WRITE_MIN_RATIO = 0.01;

/**
 * Whether a fresh measurement moved the served USD figure enough to rewrite the
 * served fields: at least max($0.25, 1% of the larger figure). The `rpcFees*`
 * stamp is written regardless; this only gates the revalue, so APRs do not
 * jitter on dust and a full pass does not recompute ~200k unchanged positions.
 */
export function isMaterialFeeChange(previousUsd: number, nextUsd: number): boolean {
  const prev = finiteOr0(previousUsd);
  const next = finiteOr0(nextUsd);
  const threshold = Math.max(FEE_WRITE_MIN_USD, FEE_WRITE_MIN_RATIO * Math.max(Math.abs(prev), Math.abs(next)));
  return Math.abs(next - prev) >= threshold;
}

/**
 * Pending fees in USD from the STORED gated leg prices (`token{0,1}.priceUsd`,
 * already through every valuation gate at normalize time). A position the
 * valuation guard rejected (`isPriceable: false`) is served 0, exactly as
 * normalize serves it.
 */
export function pendingFeesUsd(
  fees0: number,
  fees1: number,
  price0: number,
  price1: number,
  isPriceable: boolean,
): number {
  if (!isPriceable) return 0;
  return finiteOr0(finiteOr0(fees0) * finiteOr0(price0) + finiteOr0(fees1) * finiteOr0(price1));
}

/** The stored served state the refresh job revalues — what it reads off a position. */
export interface FeeServedState {
  positionId: string;
  isActive: boolean;
  token0: { priceUsd?: number };
  token1: { priceUsd?: number };
  amounts: Partial<Position['amounts']>;
  metrics: Partial<Position['metrics']>;
}

/**
 * Whether a fee leg moved by at least `FEE_WRITE_MIN_RATIO` of the larger of
 * the two token amounts. Any move off or onto 0 counts (it is a 100% move).
 */
export function isMaterialTokenChange(previous: number, next: number): boolean {
  const prev = finiteOr0(previous);
  const cur = finiteOr0(next);
  if (prev === cur) return false;
  return Math.abs(cur - prev) >= FEE_WRITE_MIN_RATIO * Math.max(Math.abs(prev), Math.abs(cur));
}

/**
 * Whether a fresh measurement should rewrite the served fields: always when the
 * served figure is not already on-chain (an `unmeasured` "Pending" must clear
 * on the first read even when it reads 0), otherwise only on a material move.
 *
 * The USD test is blind to a leg it values at $0 — an unpriced token, or every
 * leg of a position the valuation guard rejected. Such a leg is tested in TOKEN
 * units instead (≥ 1% move), or its served amount would freeze at the first
 * write forever: position 10045 kept serving 0 HOOK while the chain owed
 * 2,361 HOOK, because 0 → 2,361 HOOK is a $0 move. The served amount is
 * compared when the candidate carries it; a RAM-store candidate does not
 * (`candidateFromStore`), so it is compared with `previous`, the last
 * on-chain reading — a moved reading then hydrates the document, and this test
 * runs again on the served amount.
 */
export function needsServedWrite(
  stored: FeeServedState,
  fees0: number,
  fees1: number,
  previous?: { fees0: string | number; fees1: string | number },
): boolean {
  if (stored.metrics?.feesSource !== 'onchain') return true;
  const priceable = stored.metrics?.isPriceable !== false;
  const price0 = finiteOr0(stored.token0?.priceUsd);
  const price1 = finiteOr0(stored.token1?.priceUsd);
  const next = pendingFeesUsd(fees0, fees1, price0, price1, priceable);
  if (isMaterialFeeChange(finiteOr0(stored.metrics?.pendingFeesUsd), next)) return true;
  const blindLegMoved = (blind: boolean, served: unknown, prior: unknown, fees: number): boolean => {
    if (!blind) return false;
    const base = served !== undefined && served !== null ? served : prior;
    // Neither the served amount nor a prior reading: nothing to compare with.
    if (base === undefined || base === null) return false;
    return isMaterialTokenChange(Number(base), fees);
  };
  return (
    blindLegMoved(!priceable || price0 <= 0, stored.amounts?.totalFeesUncollected0, previous?.fees0, fees0) ||
    blindLegMoved(!priceable || price1 <= 0, stored.amounts?.totalFeesUncollected1, previous?.fees1, fees1)
  );
}

/**
 * The `$set` paths that put a fresh measurement into the SERVED fields, without
 * waiting for an indexer re-normalize: the uncollected token amounts, pending
 * fees USD, and then the aggregate performance (`computePerformanceFromAggregates`
 * — apr / feeApr / aprExGas / poolPnlUsd / totalFeesUsd …), i.e. exactly what
 * normalize + the aggregate recompute would store for the same inputs.
 *
 * Gas is valued at the ETH price the LAST recompute used (stored
 * `totalGasCostUsd / totalGasCostEth`), so the job needs no price lookup and
 * changes nothing but the fee terms. When that ratio is unknown for a position
 * that paid gas, the performance block is left to the next recompute and only
 * the fee figures (and `totalFeesUsd`, by the same delta) move — recomputing
 * with gas at $0 would publish an APR that ignores gas.
 */
export function revalueServedFees(
  stored: FeeServedState,
  measurement: { fees0: number; fees1: number; measuredAt: Date },
): Record<string, unknown> {
  const isPriceable = stored.metrics?.isPriceable !== false;
  const price0 = finiteOr0(stored.token0?.priceUsd);
  const price1 = finiteOr0(stored.token1?.priceUsd);
  const pending = pendingFeesUsd(measurement.fees0, measurement.fees1, price0, price1, isPriceable);

  const set: Record<string, unknown> = {
    'amounts.totalFeesUncollected0': String(finiteOr0(measurement.fees0)),
    'amounts.totalFeesUncollected1': String(finiteOr0(measurement.fees1)),
    'amounts.totalFeesUncollectedUsd': String(pending),
    'metrics.pendingFeesUsd': pending,
    'metrics.feesSource': 'onchain' satisfies FeesSource,
    'metrics.feesMeasuredAt': measurement.measuredAt,
  };

  const gasEth = finiteOr0(Number(stored.amounts?.totalGasCostEth ?? 0));
  const gasUsd = finiteOr0(stored.metrics?.totalGasCostUsd);
  const ethPriceNow = gasEth > 0 && gasUsd > 0 ? gasUsd / gasEth : 0;
  if (gasEth > 0 && ethPriceNow <= 0) {
    // Keep whatever convention the stored total used (collected + pending when
    // performance is ready, pending alone when not) by moving it by the delta.
    const previousPending = finiteOr0(stored.metrics?.pendingFeesUsd);
    set['metrics.totalFeesUsd'] = finiteOr0(finiteOr0(stored.metrics?.totalFeesUsd) - previousPending + pending);
    return set;
  }

  const update = computePerformanceFromAggregates(
    {
      ...stored,
      metrics: { ...stored.metrics, pendingFeesUsd: pending },
    } as unknown as Position,
    { ethPriceNow },
  );
  for (const [key, value] of Object.entries(update.metrics)) set[`metrics.${key}`] = value;
  for (const [key, value] of Object.entries(update.amounts)) {
    // The recompute echoes the token-unit cash flows it was GIVEN — the copies
    // read with this snapshot. Re-`$set`ting them can only revert a normalize
    // that landed since; they are the indexer's to write, never this job's.
    if (SNAPSHOT_CASH_FLOW_FIELDS.has(key)) continue;
    set[`amounts.${key}`] = value;
  }
  return set;
}

/** Token-unit cash-flow aggregates: inputs to the revalue, never its output. */
const SNAPSHOT_CASH_FLOW_FIELDS: ReadonlySet<string> = new Set([
  'depositedToken0',
  'depositedToken1',
  'withdrawnToken0',
  'withdrawnToken1',
  'totalFeesCollected0',
  'totalFeesCollected1',
  'totalGasCostEth',
]);

function finiteOr0(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
