import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { getAmountsForLiquidity, getSqrtRatioAtTick } from '../../src/pricing/tick-math.js';
import { crossCheckAllowlistedPair, tickMathAmounts } from '../../src/subgraph/adapters/envio.adapter.js';
import { asJson, FIXED_NOW, NORMALIZE_CASES, normalizeCase, type NormalizeCase } from './normalize-fixtures.js';

/**
 * Fix 3 (`POSITION_AMOUNTS_SOURCE=tickmath`) and the allowlisted-pair
 * cross-check (rides `PRICE_QUOTE_GUARD=on`, fix 1) on the position path.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => vi.useRealTimers());

const byName = (fragment: string): NormalizeCase => {
  const c = NORMALIZE_CASES.find((x) => x.name.includes(fragment));
  if (!c) throw new Error(`no fixture ${fragment}`);
  return c;
};

function expectedTickMath(c: NormalizeCase): { amount0: number; amount1: number } {
  const decimals = (id: string) => c.tokens.find((t) => t.id === id)!.decimals;
  const d0 = decimals(c.pool.token0Id);
  const d1 = decimals(c.pool.token1Id);
  const sqrt = c.pool.sqrtPriceX96 && c.pool.sqrtPriceX96 !== '0' ? BigInt(c.pool.sqrtPriceX96) : getSqrtRatioAtTick(c.pool.tick);
  const raw = getAmountsForLiquidity(sqrt, Number(c.raw.tickLower), Number(c.raw.tickUpper), BigInt(String(c.raw.liquidity)));
  return { amount0: Number(raw.amount0) / 10 ** d0, amount1: Number(raw.amount1) / 10 ** d1 };
}

describe('POSITION_AMOUNTS_SOURCE=tickmath', () => {
  const TICKMATH = { positionAmountsSource: 'tickmath' };

  it('recomputes an open position from liquidity, range and the pool price (frozen launchpad LP)', async () => {
    const c = byName('frozen indexer amounts');
    const indexer = await normalizeCase(c);
    const tick = await normalizeCase(c, TICKMATH);
    const want = expectedTickMath(c);
    expect(Number(tick.amounts.amount0)).toBeCloseTo(want.amount0, 9);
    expect(Number(tick.amounts.amount1)).toBe(want.amount1);
    // Out of range above: all token0, nothing of token1 — the indexer still says 8B token1.
    expect(Number(tick.amounts.amount1)).toBe(0);
    expect(Number(indexer.amounts.amount1)).toBe(8_000_000_000);
    expect(tick.metrics.underlyingValueUsd).toBeCloseTo(want.amount0 * 3000, 6);
    expect(tick.metrics.underlyingValueUsd).not.toBe(indexer.metrics.underlyingValueUsd);
  });

  it('recomputes an in-range position and leaves every non-amount field as the indexer path computes it', async () => {
    const c = byName('dynamic-fee pool');
    const indexer = asJson(await normalizeCase(c)) as Record<string, any>;
    const tick = asJson(await normalizeCase(c, TICKMATH)) as Record<string, any>;
    const want = expectedTickMath(c);
    expect(Number(tick.amounts.amount0)).toBeCloseTo(want.amount0, 12);
    expect(Number(tick.amounts.amount1)).toBeCloseTo(want.amount1, 6);
    expect(want.amount0).toBeGreaterThan(0);
    expect(want.amount1).toBeGreaterThan(0);
    const strip = (p: Record<string, any>) => ({
      ...p,
      amounts: { ...p.amounts, amount0: 0, amount1: 0 },
      metrics: { ...p.metrics, underlyingValueUsd: 0, nominalValueUsd: 0 },
    });
    expect(strip(tick)).toEqual(strip(indexer));
  });

  it('keeps a closed position on the indexer amounts', async () => {
    const c = byName('closed position');
    expect(asJson(await normalizeCase(c, TICKMATH))).toEqual(asJson(await normalizeCase(c)));
  });

  it('keeps a row that is not open (closed stamp or isActive false) on the indexer amounts even with liquidity left', async () => {
    const c = byName('dynamic-fee pool');
    for (const over of [{ closedAtTimestamp: '1769000000' }, { isActive: false }]) {
      const notOpen: NormalizeCase = { ...c, raw: { ...c.raw, ...over } };
      const tick = await normalizeCase(notOpen, TICKMATH);
      expect(tick.amounts.amount0, JSON.stringify(over)).toBe('0.4');
      expect(tick.amounts.amount1, JSON.stringify(over)).toBe('1500');
    }
  });

  it('reads the current tick when the pool has no sqrtPrice', async () => {
    const c = byName('missing sqrtPrice');
    const tick = await normalizeCase(c, TICKMATH);
    const want = expectedTickMath(c);
    expect(Number(tick.amounts.amount0)).toBeCloseTo(want.amount0, 12);
    expect(Number(tick.amounts.amount1)).toBeCloseTo(want.amount1, 6);
  });

  it('keeps the indexer amounts when the pool row has neither sqrtPrice nor tick (never valued at tick 0)', async () => {
    const c = byName('missing sqrtPrice');
    for (const tick of [undefined, null, '']) {
      const blind: NormalizeCase = { ...c, pool: { ...c.pool, sqrtPriceX96: '0', tick: tick as never } };
      const out = await normalizeCase(blind, TICKMATH);
      expect(out.amounts.amount0, String(tick)).toBe('0.4');
      expect(out.amounts.amount1, String(tick)).toBe('1500');
    }
    // A REAL tick 0 is still a price the tick math reads.
    const zero: NormalizeCase = { ...c, pool: { ...c.pool, sqrtPriceX96: '0', tick: 0 }, raw: { ...c.raw, tickLower: -600, tickUpper: 600 } };
    const atZero = await normalizeCase(zero, TICKMATH);
    expect(atZero.amounts.amount0).not.toBe('0.4');
    expect(Number(atZero.amounts.amount0)).toBeGreaterThan(0);
  });

  it('falls back to the indexer amounts when the range cannot be read', async () => {
    const c = byName('dynamic-fee pool');
    const broken: NormalizeCase = { ...c, raw: { ...c.raw, tickLower: 5, tickUpper: 5 } };
    const tick = await normalizeCase(broken, TICKMATH);
    expect(tick.amounts.amount0).toBe('0.4');
    expect(tick.amounts.amount1).toBe('1500');
    const outside: NormalizeCase = { ...c, raw: { ...c.raw, tickLower: -900_000, tickUpper: 10 } };
    const out = await normalizeCase(outside, TICKMATH);
    expect(out.amounts.amount0).toBe('0.4');
  });

  it('an unknown value is the indexer (today)', async () => {
    const c = byName('frozen indexer amounts');
    expect(asJson(await normalizeCase(c, { positionAmountsSource: 'TICKMATH ' }))).toEqual(asJson(await normalizeCase(c)));
  });

  it('tickMathAmounts guards the tick math', () => {
    const real = { positionAmounts: (i: never) => PricingService.prototype.positionAmounts.call(undefined, i) };
    const base = { liquidity: '1000', tickLower: -60, tickUpper: 60, sqrtPriceX96: getSqrtRatioAtTick(0).toString(), currentTick: 0, decimals0: 0, decimals1: 0 };
    expect(tickMathAmounts(real as never, base)).not.toBeNull();
    expect(tickMathAmounts(real as never, { ...base, tickLower: 60, tickUpper: -60 })).toBeNull();
    expect(tickMathAmounts(real as never, { ...base, tickLower: 1.5 })).toBeNull();
    expect(tickMathAmounts({ positionAmounts: () => { throw new Error('x'); } } as never, base)).toBeNull();
    expect(tickMathAmounts({ positionAmounts: () => null } as never, base)).toBeNull();
    expect(tickMathAmounts({ positionAmounts: () => ({ amount0: NaN, amount1: 1 }) } as never, base)).toBeNull();
    expect(tickMathAmounts({ positionAmounts: () => ({ amount0: -1, amount1: 1 }) } as never, base)).toBeNull();
  });
});

describe('allowlisted-pair cross-check (PRICE_QUOTE_GUARD=on)', () => {
  const GUARD = { priceQuoteGuard: 'on' };

  /** Both legs marked single-source by the pricing layer's stored consensus (explicit `false`). */
  const single = (c: NormalizeCase, over: Record<string, unknown> = {}): NormalizeCase => ({
    ...c,
    prices: { ...c.prices, token0Corroborated: false, token1Corroborated: false, ...over } as never,
  });

  it('collapses AERGO/HPP: the single-source inflated HPP quote is lowered and the pool cannot back it', async () => {
    const c = byName('AERGO/HPP');
    const off = await normalizeCase(single(c));
    const on = await normalizeCase(single(c), GUARD);
    expect(off.metrics.underlyingValueUsd).toBeGreaterThan(100_000_000);
    expect(on.metrics.underlyingValueUsd).toBe(0);
    expect(on.token1.priceUsd).toBe(0);
    expect(on.metrics.unrealizableLeg).toBe(true);
  });

  it('flags the leg it zeroed, on either side', async () => {
    const c = byName('AERGO/HPP');
    // HPP alone single-source: lowered, then unbacked by the 0.0418 AERGO the pool holds.
    const hppOnly = single(c, { token0Corroborated: true });
    const a = await normalizeCase(hppOnly, GUARD);
    expect(a.token1.priceUsd).toBe(0);
    expect(a.token0.priceUsd).toBe(0.0512);
    expect(a.metrics.unrealizableLeg).toBe(true);
    // AERGO alone single-source, against an HPP side holding (almost) nothing.
    const aergoOnly: NormalizeCase = { ...single(c, { token1Corroborated: true }), stats: { ...c.stats, totalValueLockedToken1: 0.00001 } };
    const b = await normalizeCase(aergoOnly, GUARD);
    expect(b.token0.priceUsd).toBe(0);
    expect(b.token1.priceUsd).toBe(31_374.54);
    expect(b.metrics.unrealizableLeg).toBe(true);
  });

  it('leaves a leg with NO evidence alone (unswept / pricing attaches none): never zeroed on a guess', async () => {
    const c = byName('AERGO/HPP');
    // Review finding: nothing populated the evidence, so EVERY allowlisted
    // pair was treated as single-source and corroborated legs were zeroed.
    expect(asJson(await normalizeCase(c, GUARD))).toEqual(asJson(await normalizeCase(c)));
    for (const over of [{ token0Corroborated: undefined }, { token1Corroborated: undefined }]) {
      const half = single(c, over);
      const on = await normalizeCase(half, GUARD);
      // Only the leg explicitly marked single-source is checked.
      if ('token0Corroborated' in over) {
        expect(on.token1.priceUsd, 'HPP still checked').toBe(0);
        expect(on.token0.priceUsd).toBe(0.0512);
      } else {
        // AERGO alone is checked, and passes against the (unchecked) HPP side.
        expect(on.token0.priceUsd).toBe(0.0512);
        expect(on.token1.priceUsd, 'HPP has no evidence: untouched').toBe(31_374.54);
        expect(asJson(on)).toEqual(asJson(await normalizeCase(c)));
      }
    }
  });

  it('leaves a pair of corroborated quotes alone', async () => {
    const c = byName('AERGO/HPP');
    const corroborated: NormalizeCase = { ...c, prices: { ...c.prices, token0Corroborated: true, token1Corroborated: true } as never };
    expect(asJson(await normalizeCase(corroborated, GUARD))).toEqual(asJson(await normalizeCase(c)));
  });

  it('keeps the real BTC.b/cbBTC position (consistent pool, real reserves)', async () => {
    const c = byName('BTC.b/cbBTC');
    expect(asJson(await normalizeCase(c, GUARD))).toEqual(asJson(await normalizeCase(c)));
  });

  it('does not touch pairs that are not two allowlisted legs', async () => {
    for (const fragment of ['USDC/RPC market value', 'seeded pool', 'quoteless', 'closed position', 'corrupt']) {
      const c = byName(fragment);
      expect(asJson(await normalizeCase(c, GUARD)), fragment).toEqual(asJson(await normalizeCase(c)));
    }
  });

  describe('crossCheckAllowlistedPair', () => {
    const base = {
      vp0: 1,
      vp1: 1,
      trust0: 'verified' as const,
      trust1: 'verified' as const,
      ratio: 1,
      corroborated0: false,
      corroborated1: false,
      open: true,
      reserve0: 10_000,
      reserve1: 10_000,
      floorUsd: 1000,
    };

    it('passes a consistent, backed pair through', () => {
      expect(crossCheckAllowlistedPair(base)).toEqual({ vp0: 1, vp1: 1, derived0: false, derived1: false, unrealizable0: false, unrealizable1: false });
    });

    it('lowers the leg above its pool-implied price, never raises one', () => {
      const r = crossCheckAllowlistedPair({ ...base, vp1: 100 });
      expect(r.vp1).toBe(1);
      expect(r.derived1).toBe(true);
      expect(r.vp0).toBe(1);
      const r0 = crossCheckAllowlistedPair({ ...base, vp0: 100 });
      expect(r0.vp0).toBe(1);
      expect(r0.derived0).toBe(true);
      // Within the divergence band: unchanged.
      expect(crossCheckAllowlistedPair({ ...base, vp1: 4.9 }).vp1).toBe(4.9);
      // Far BELOW its pool-implied price: never raised (on either side).
      const low1 = crossCheckAllowlistedPair({ ...base, vp1: 0.01, corroborated0: true });
      expect(low1.vp1).toBe(0.01);
      expect(low1.derived1).toBe(false);
      const low0 = crossCheckAllowlistedPair({ ...base, vp0: 0.01, corroborated1: true });
      expect(low0.vp0).toBe(0.01);
      expect(low0.derived0).toBe(false);
    });

    it('never lowers a corroborated leg', () => {
      const r = crossCheckAllowlistedPair({ ...base, vp1: 100, corroborated1: true });
      expect(r.vp1).toBe(100);
      expect(r.derived1).toBe(false);
    });

    it('a pool with no usable ratio cannot corroborate a single-source leg', () => {
      const r = crossCheckAllowlistedPair({ ...base, ratio: Number.NaN, corroborated0: true });
      expect(r.vp0).toBe(1);
      expect(r.vp1).toBe(0);
    });

    it('zeroes a single-source leg the other side cannot back (open positions, known reserves)', () => {
      const r = crossCheckAllowlistedPair({ ...base, reserve0: 5 });
      expect(r.vp1).toBe(0);
      expect(r.unrealizable1).toBe(true);
      expect(r.vp0).toBe(1);
      // Unknown reserves, a closed position or a disabled floor: unchanged.
      expect(crossCheckAllowlistedPair({ ...base, reserve0: undefined }).vp1).toBe(1);
      expect(crossCheckAllowlistedPair({ ...base, reserve0: 5, open: false }).vp1).toBe(1);
      expect(crossCheckAllowlistedPair({ ...base, reserve0: 5, floorUsd: 0 }).vp1).toBe(1);
      // A corroborated leg is not subject to the floor.
      expect(crossCheckAllowlistedPair({ ...base, reserve0: 5, corroborated1: true }).vp1).toBe(1);
    });

    it('applies only to two allowlisted (verified) legs', () => {
      for (const [trust0, trust1] of [
        ['anchor', 'verified'],
        ['verified', 'anchor'],
        ['anchor', 'anchor'],
        ['verified', 'unverified'],
        ['unverified', 'unverified'],
      ] as const) {
        const r = crossCheckAllowlistedPair({ ...base, trust0, trust1, vp1: 100, reserve0: 5 });
        expect(r.vp1, `${trust0}/${trust1}`).toBe(100);
      }
    });
  });
});
