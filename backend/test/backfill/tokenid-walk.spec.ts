/*
 * The tokenId range walk (`BACKFILL_PAGING=tokenid`, design §6.2-1) against a
 * fake indexer with the real translator's ordering.
 *
 * The failure class this exists for is a SILENT skip (the 2026-09-14 offset
 * bug dropped half of mainnet and reported success), so the core spec is
 * coverage: every row exactly once, gaps, the exact range edges, a dense range,
 * rows minted during the walk; then the guards — overflow paging, the
 * contiguous cursor under out-of-order preparation and slow flushes, the
 * shutdown stop, tick/sqrtPrice never cached, the price deadline, and P3.1.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexer, graphqlRequestMock, WETH } from './fake-indexer.js';

let indexer = new FakeIndexer();
vi.mock('graphql-request', async () => {
  const mod = await import('./fake-indexer.js');
  return mod.graphqlRequestMock(() => indexer);
});
void graphqlRequestMock;

const { EnvioAdapter, runRangePipeline, mergeFeeReadings, clampRangeSize, normalizeTokenIdString, plainDecimal, feeStampString } = await import(
  '../../src/subgraph/adapters/envio.adapter.js'
);
type Adapter = InstanceType<typeof EnvioAdapter>;
type NormalizedPosition = import('../../src/subgraph/normalized-position.js').NormalizedPosition;
type TokenIdRangeStats = import('../../src/subgraph/position-adapter.js').TokenIdRangeStats;
const { isTokenIdEdgeQueryError } = await import('../../src/subgraph/position-adapter.js');

const integration = {
  chainId: 1,
  protocol: 'uniswap-v4',
  dialect: 'hyperindex',
  enabled: true,
  subgraphUrl: 'http://envio.local/v1/graphql',
} as never;

function pricingStub(over: Partial<Record<string, unknown>> = {}) {
  return {
    prefetchPrices: vi.fn(async () => undefined),
    seedLastKnown: vi.fn(async () => 0),
    pricePool: vi.fn(async () => ({
      token0Usd: 1,
      token1Usd: 1,
      source: 'external',
      usedFallback: false,
      token0Confidence: 'anchor',
      token1Confidence: 'anchor',
    })),
    ...over,
  };
}

function makeAdapter(opts: { pricing?: unknown; feeReader?: unknown; storedFees?: Map<string, unknown> } = {}): Adapter {
  const positionsRepo = { findRpcFees: vi.fn(async () => opts.storedFees ?? new Map()) };
  return new EnvioAdapter(
    (opts.pricing ?? pricingStub()) as never,
    { findByIds: async () => [] } as never,
    { minRealMarketBackingUsd: 1000 } as never,
    positionsRepo as never,
    opts.feeReader as never,
  ) as Adapter;
}

interface Collected {
  positions: NormalizedPosition[];
  ranges: Array<{ from: string; to: string; index: number }>;
  cursors: string[];
  stats: TokenIdRangeStats[];
}

async function walk(
  adapter: Adapter,
  over: Partial<Parameters<Adapter['walkTokenIdRanges']>[0]> = {},
  onRangeHook?: (index: number) => Promise<void> | void,
) {
  const got: Collected = { positions: [], ranges: [], cursors: [], stats: [] };
  const result = await adapter.walkTokenIdRanges({
    integration,
    fromTokenId: '0',
    lookahead: 0,
    pipeline: false,
    priceWaitMs: 5_000,
    feeRead: false,
    onRange: async (positions, range, stats) => {
      await onRangeHook?.(range.index);
      got.positions.push(...positions);
      got.ranges.push(range);
      got.stats.push(stats);
      return positions.length;
    },
    onCursor: async (next) => {
      got.cursors.push(next);
    },
    ...over,
  });
  return { result, got };
}

function ids(positions: NormalizedPosition[]): number[] {
  return positions.map((p) => Number(p.positionId)).sort((a, b) => a - b);
}

beforeEach(() => {
  indexer = new FakeIndexer();
});

describe('coverage', () => {
  it('returns every row exactly once — gaps, exact range edges (0, 998, 999, 1997, 1998) and the last id', async () => {
    const all = [0, 1, 2, 500, 998, 999, 1000, 1500, 1997, 1998, 1999, 2600, 4001];
    indexer.positions = all.map((t, i) => ({ tokenId: t, createdAt: 1_000 + i }));
    const { result, got } = await walk(makeAdapter());
    expect(ids(got.positions)).toEqual(all);
    expect(new Set(got.positions.map((p) => p.positionId)).size).toBe(all.length);
    expect(result.completed).toBe(true);
    expect(result.rows).toBe(all.length);
    // ranges of 999 ids from 0 through the highest tokenId (4001 → 5 ranges)
    expect(got.ranges.map((r) => r.from)).toEqual(['0', '999', '1998', '2997', '3996']);
    expect(result.nextTokenId).toBe('4995');
  });

  it('a dense range (exactly 999 rows) is ONE request — not an overflow', async () => {
    indexer.positions = Array.from({ length: 999 }, (_, i) => ({ tokenId: i, createdAt: 10 + i }));
    const { got } = await walk(makeAdapter());
    expect(got.positions).toHaveLength(999);
    expect(indexer.count('PositionsByTokenId')).toBe(1);
    expect(got.stats[0]?.overflowPages).toBe(0);
  });

  it('positions minted during the walk beyond the highest tokenId are walked (max re-read once)', async () => {
    indexer.positions = [{ tokenId: 5, createdAt: 100 }];
    indexer.afterRangePage = (from) => {
      if (from === '0' && !indexer.positions.some((p) => p.tokenId === 2500)) {
        indexer.positions.push({ tokenId: 2500, createdAt: 200 });
      }
    };
    const { result, got } = await walk(makeAdapter());
    expect(ids(got.positions)).toEqual([5, 2500]);
    expect(result.completed).toBe(true);
    // initial max + the one re-read when the walk passed it (+ one more after it grew)
    expect(indexer.count('TokenIdEdge')).toBe(2);
  });

  it('an empty chain completes without walking', async () => {
    const { result, got } = await walk(makeAdapter());
    expect(result.completed).toBe(true);
    expect(got.ranges).toHaveLength(0);
  });

  it('a resume starts at the stored cursor (rows below it are not re-read)', async () => {
    indexer.positions = [10, 1200, 2100].map((t) => ({ tokenId: t, createdAt: t }));
    const { got } = await walk(makeAdapter(), { fromTokenId: '999' });
    expect(ids(got.positions)).toEqual([1200, 2100]);
    expect(got.ranges[0]?.from).toBe('999');
  });
});

describe('range overflow', () => {
  it('a FULL page (more rows than ids) alerts and pages the range until short — nothing dropped', async () => {
    indexer.positions = [
      ...Array.from({ length: 600 }, (_, i) => ({ tokenId: i, createdAt: i, duplicate: 1 })), // 1,200 rows in range 0
    ];
    const adapter = makeAdapter();
    const warn = vi.spyOn((adapter as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    const { got } = await walk(adapter);
    expect(got.stats[0]?.overflowPages).toBe(1);
    expect(warn.mock.calls.some(([m]) => String(m).includes('[alert] backfill.range_overflow'))).toBe(true);
    // every tokenId present (duplicates collapse to one row per tokenId)
    expect(new Set(got.positions.map((p) => p.positionId)).size).toBe(600);
    expect(indexer.count('PositionsByTokenId')).toBe(2);
  });
});

describe('the ordered writer and the contiguous cursor', () => {
  it('lookahead with the FIRST range slowest: written and cursored strictly in order', async () => {
    indexer.positions = [1, 1001, 2001, 3001, 4001].map((t) => ({ tokenId: t, createdAt: t }));
    indexer.rangeDelayMs.set('0', 60);
    const { got } = await walk(makeAdapter(), { lookahead: 3 });
    expect(got.ranges.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(got.cursors).toEqual(got.ranges.map((r) => r.to));
    // the slow range did not hold the others' preparation back: range 1's page
    // was requested before range 0 (delayed) got to its pools request
    const page1 = indexer.calls.findIndex(
      (c) => c.op === 'PositionsByTokenId' && (c.variables.where as { tokenId_gte: string }).tokenId_gte === '999',
    );
    const firstPools = indexer.calls.findIndex((c) => c.op === 'Pools');
    expect(page1).toBeGreaterThan(-1);
    expect(page1).toBeLessThan(firstPools);
  });

  it('a slow flush: the cursor never passes a range that is not written', async () => {
    indexer.positions = [1, 1001, 2001, 3001].map((t) => ({ tokenId: t, createdAt: t }));
    const written = new Set<number>();
    let violations = 0;
    const adapter = makeAdapter();
    await adapter.walkTokenIdRanges({
      integration,
      fromTokenId: '0',
      lookahead: 3,
      pipeline: false,
      priceWaitMs: 5_000,
      feeRead: false,
      onRange: async (positions, range) => {
        if (range.index === 1) await new Promise((r) => setTimeout(r, 40));
        written.add(range.index);
        return positions.length;
      },
      onCursor: async (next) => {
        const idx = Number(BigInt(next) / 999n) - 1;
        for (let i = 0; i <= idx; i++) if (!written.has(i)) violations += 1;
      },
    });
    expect(violations).toBe(0);
    expect([...written].sort()).toEqual([0, 1, 2, 3]);
  });

  it('a failed flush stops the walk; the cursor stays at the last written range', async () => {
    indexer.positions = [1, 1001, 2001].map((t) => ({ tokenId: t, createdAt: t }));
    const cursors: string[] = [];
    await expect(
      makeAdapter().walkTokenIdRanges({
        integration,
        fromTokenId: '0',
        lookahead: 2,
        pipeline: false,
        priceWaitMs: 5_000,
        feeRead: false,
        onRange: async (positions, range) => {
          if (range.index === 1) throw new Error('bulkWrite failed');
          return positions.length;
        },
        onCursor: async (next) => {
          cursors.push(next);
        },
      }),
    ).rejects.toThrow('bulkWrite failed');
    expect(cursors).toEqual(['999']);
  });

  it('shutdown: stops between ranges, reports aborted, cursor at the last written range', async () => {
    indexer.positions = [1, 1001, 2001, 3001, 4001, 5001].map((t) => ({ tokenId: t, createdAt: t }));
    const ctl = new AbortController();
    const { result, got } = await walk(makeAdapter(), { signal: ctl.signal, lookahead: 2 }, (index) => {
      if (index === 1) ctl.abort();
    });
    expect(result.aborted).toBe(true);
    expect(result.completed).toBe(false);
    expect(got.ranges.map((r) => r.index)).toEqual([0, 1]);
    expect(result.nextTokenId).toBe('1998');
    expect(got.cursors).toEqual(['999', '1998']);
    // and no NEW range was fetched after the stop: lookahead 2 had ranges 1–3
    // in flight while range 1 was written; range 4 (3996) must never start
    const froms = indexer.calls
      .filter((c) => c.op === 'PositionsByTokenId')
      .map((c) => (c.variables.where as { tokenId_gte: string }).tokenId_gte);
    expect(froms).toEqual(['0', '999', '1998', '2997']);
  });
});

describe('runRangePipeline', () => {
  it('lookahead 0 is serial: prepare, write, prepare, write', async () => {
    const log: string[] = [];
    let n = 0;
    await runRangePipeline<number, number>({
      next: async () => (n < 3 ? n++ : null),
      prepare: async (r) => {
        log.push(`p${r}`);
        return r;
      },
      write: async (r) => {
        log.push(`w${r}`);
      },
      lookahead: 0,
    });
    expect(log).toEqual(['p0', 'w0', 'p1', 'w1', 'p2', 'w2']);
  });

  it('a failed prepare rejects the walk; an abandoned one is not an unhandled rejection', async () => {
    let n = 0;
    await expect(
      runRangePipeline<number, number>({
        next: async () => (n < 4 ? n++ : null),
        prepare: async (r) => {
          if (r === 0) {
            await new Promise((res) => setTimeout(res, 10));
            throw new Error('indexer down');
          }
          if (r === 2) throw new Error('also down (abandoned)');
          return r;
        },
        write: async () => undefined,
        lookahead: 3,
      }),
    ).rejects.toThrow('indexer down');
  });
});

describe('pool dynamic fields are never cached (pipeline on)', () => {
  it('a tick change between ranges reaches the next range’s normalize; tokens are asked for once', async () => {
    indexer.positions = [1, 1001, 2001].map((t) => ({ tokenId: t, createdAt: t }));
    indexer.tickStepPerRangePools = 10; // 20, 30, 40 for the three ranges
    const { got } = await walk(makeAdapter(), { pipeline: true });
    const ticks = got.positions.sort((a, b) => Number(a.positionId) - Number(b.positionId)).map((p) => p.currentTick);
    expect(ticks).toEqual([20, 30, 40]);
    expect(indexer.count('RangePools')).toBe(3);
    expect(indexer.count('Pools')).toBe(0);
    expect(indexer.count('PoolStats')).toBe(0);
    expect(indexer.count('Tokens')).toBe(1);
  });
});

describe('the price deadline (pipeline on)', () => {
  it('normalize proceeds after BACKFILL_PRICE_WAIT_MS with what is cached, never blocking on the fetch', async () => {
    indexer.positions = [{ tokenId: 1, createdAt: 1 }];
    const pricing = pricingStub({ prefetchPrices: vi.fn(() => new Promise(() => undefined)) });
    const started = Date.now();
    const { got, result } = await walk(makeAdapter({ pricing }), { pipeline: true, priceWaitMs: 30 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.completed).toBe(true);
    expect(got.stats[0]?.priceDeadlineHit).toBe(true);
    expect(pricing.seedLastKnown).toHaveBeenCalledTimes(1);
    expect((pricing.pricePool as ReturnType<typeof vi.fn>).mock.calls.every((c) => c[1]?.cacheOnly === true)).toBe(true);
  });

  it('prefetches still running past their deadline are capped (no pile-up on a slow provider)', async () => {
    indexer.positions = Array.from({ length: 10 }, (_, i) => ({ tokenId: i * 1000 + 1, createdAt: i + 1 }));
    const pricing = pricingStub({ prefetchPrices: vi.fn(() => new Promise(() => undefined)) });
    const { result, got } = await walk(makeAdapter({ pricing }), { pipeline: true, priceWaitMs: 1 });
    expect(result.completed).toBe(true);
    expect(got.ranges.length).toBeGreaterThanOrEqual(10);
    // 4 background prefetches + lookahead 0
    expect(pricing.prefetchPrices).toHaveBeenCalledTimes(4);
    expect(got.stats.every((s) => s.priceDeadlineHit)).toBe(true);
  });

  it('…and a prefetch that finishes frees its slot (every range gets one)', async () => {
    indexer.positions = Array.from({ length: 10 }, (_, i) => ({ tokenId: i * 1000 + 1, createdAt: i + 1 }));
    const pricing = pricingStub();
    await walk(makeAdapter({ pricing }), { pipeline: true, priceWaitMs: 1_000 });
    expect((pricing.prefetchPrices as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(10);
    expect((pricing.seedLastKnown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('pipeline off: waits for the prefetch, prices with the normal (one-argument) call', async () => {
    indexer.positions = [{ tokenId: 1, createdAt: 1 }];
    const pricing = pricingStub();
    await walk(makeAdapter({ pricing }), { pipeline: false });
    expect(pricing.seedLastKnown).not.toHaveBeenCalled();
    expect((pricing.pricePool as ReturnType<typeof vi.fn>).mock.calls.every((c) => c.length === 1)).toBe(true);
  });
});

describe('P3.1 — the fee reading inside the walk', () => {
  const at = new Date('2026-10-04T00:00:00Z');

  it('measures ACTIVE rows only, and stamps exactly the rows whose fresh reading is served', async () => {
    indexer.positions = [
      { tokenId: 1, createdAt: 1, lastModifyBlock: 50 },
      { tokenId: 2, createdAt: 2, lastModifyBlock: 50 },
      { tokenId: 3, createdAt: 3, isActive: false },
      { tokenId: 4, createdAt: 4, lastModifyBlock: 500 }, // reading older than the last settle → refused
      { tokenId: 5, createdAt: 5, lastModifyBlock: 50 }, // stored reading is newer → kept, no stamp
    ];
    const measured: string[][] = [];
    const feeReader = {
      measure: vi.fn(async (_c: number, _p: string, rows: Array<{ positionId: string; decimals0: number }>) => {
        measured.push(rows.map((r) => r.positionId));
        return new Map(
          ['1', '4', '5'].map((id) => [id, { fees0: 0.5, fees1: 2, block: 100, at }]),
        );
      }),
    };
    const storedFees = new Map([['5', { fees0: 9, fees1: 9, block: 150, at }]]);
    const { got } = await walk(makeAdapter({ feeReader, storedFees }), { feeRead: true });
    expect(measured).toEqual([['1', '2', '4', '5']]); // row 3 is closed: never measured
    const byId = new Map(got.positions.map((p) => [p.positionId, p]));
    expect(byId.get('1')).toMatchObject({ rpcFeesUncollected0: '0.5', rpcFeesUncollected1: '2', rpcFeesBlock: 100, rpcFeesAt: at });
    expect(byId.get('1')?.metrics.feesSource).toBe('onchain');
    expect(byId.get('2')?.rpcFeesBlock).toBeUndefined(); // not read (absent from the reader's answer)
    expect(byId.get('4')?.rpcFeesBlock).toBeUndefined(); // refused by chooseUncollected
    expect(byId.get('5')?.rpcFeesBlock).toBeUndefined(); // the stored, newer reading wins
    expect(byId.get('5')?.amounts.totalFeesUncollected0).toBe('9');
    expect(got.stats[0]?.feesMeasured).toBe(1);
  });

  it('a reader that throws stamps nothing and does not fail the walk', async () => {
    indexer.positions = [{ tokenId: 1, createdAt: 1 }];
    const feeReader = { measure: vi.fn(async () => Promise.reject(new Error('rpc down'))) };
    const { got, result } = await walk(makeAdapter({ feeReader }), { feeRead: true });
    expect(result.completed).toBe(true);
    expect(got.positions[0]?.rpcFeesBlock).toBeUndefined();
  });

  it('a reader that never answers is abandoned after ONE deadline: no stamp, the walk completes, the signal aborts', async () => {
    indexer.positions = [{ tokenId: 1, createdAt: 1, lastModifyBlock: 1 }];
    let signal: AbortSignal | undefined;
    const feeReader = {
      measure: vi.fn((_c: number, _p: string, _r: unknown, opts?: { signal?: AbortSignal }) => {
        signal = opts?.signal;
        return new Promise(() => undefined); // a hanging RPC
      }),
    };
    const adapter = makeAdapter({ feeReader });
    adapter.pageFeeReadDeadlineMs = 25;
    const t0 = Date.now();
    const { got, result } = await walk(adapter, { feeRead: true });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(result.completed).toBe(true);
    expect(got.positions[0]?.rpcFeesBlock).toBeUndefined();
    expect(got.positions[0]?.metrics.feesSource).not.toBe('onchain');
    expect(signal?.aborted).toBe(true);
  });

  it('an answer inside the deadline is used and its signal is NOT aborted; a late rejection is swallowed', async () => {
    indexer.positions = [{ tokenId: 1, createdAt: 1, lastModifyBlock: 1 }];
    let signal: AbortSignal | undefined;
    const feeReader = {
      measure: vi.fn(async (_c: number, _p: string, _r: unknown, opts?: { signal?: AbortSignal }) => {
        signal = opts?.signal;
        return new Map([['1', { fees0: 1, fees1: 1, block: 9, at }]]);
      }),
    };
    const { got } = await walk(makeAdapter({ feeReader }), { feeRead: true });
    expect(got.positions[0]?.rpcFeesBlock).toBe(9);
    expect(signal?.aborted).toBe(false);

    // late rejection: rejects AFTER the deadline fired — must not surface as an unhandled rejection
    indexer.positions = [{ tokenId: 2, createdAt: 2, lastModifyBlock: 1 }];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const late = { measure: vi.fn(() => new Promise((_r, rej) => setTimeout(() => rej(new Error('late boom')), 40))) };
      const adapter = makeAdapter({ feeReader: late });
      adapter.pageFeeReadDeadlineMs = 5;
      const res = await walk(adapter, { feeRead: true });
      expect(res.got.positions[0]?.rpcFeesBlock).toBeUndefined();
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('stamps a plain decimal for tiny fees: the exact reader string when given, else never exponent form', async () => {
    indexer.positions = [
      { tokenId: 1, createdAt: 1, lastModifyBlock: 1 },
      { tokenId: 2, createdAt: 2, lastModifyBlock: 1 },
    ];
    const exact0 = '0.000000123456789012345678'; // more digits than a double holds
    const feeReader = {
      measure: vi.fn(async () =>
        new Map<string, unknown>([
          ['1', { fees0: Number(exact0), fees1: 1.2e-7, block: 9, at, fees0Exact: exact0, fees1Exact: '0.00000012' }],
          ['2', { fees0: 1.2e-7, fees1: 2e21, block: 9, at }], // no exact strings (an older reader)
        ]),
      ),
    };
    const { got } = await walk(makeAdapter({ feeReader }), { feeRead: true });
    const byId = new Map(got.positions.map((p) => [p.positionId, p]));
    expect(byId.get('1')).toMatchObject({ rpcFeesUncollected0: exact0, rpcFeesUncollected1: '0.00000012' });
    expect(byId.get('2')).toMatchObject({ rpcFeesUncollected0: '0.00000012', rpcFeesUncollected1: '2000000000000000000000' });
    // what F's candidate store accepts (fee-candidate-store.ts DECIMAL)
    for (const p of got.positions) {
      expect(p.rpcFeesUncollected0).toMatch(/^\d+(\.\d+)?$/);
      expect(p.rpcFeesUncollected1).toMatch(/^\d+(\.\d+)?$/);
    }
  });

  it('plainDecimal / feeStampString', () => {
    expect(plainDecimal(0)).toBe('0');
    expect(plainDecimal(123.45)).toBe('123.45');
    expect(plainDecimal(1.2e-7)).toBe('0.00000012');
    expect(plainDecimal(1e-7)).toBe('0.0000001');
    expect(plainDecimal(1.5e21)).toBe('1500000000000000000000');
    expect(plainDecimal(1.2345e22)).toBe('12345000000000000000000');
    for (const n of [1.2e-7, 3.14159e-12, 9.87654321e25, 5e-324]) expect(Number(plainDecimal(n))).toBe(n);
    expect(feeStampString('0.5', 0.5)).toBe('0.5');
    expect(feeStampString('0.6', 0.5)).toBe('0.5'); // disagrees with the served number → the number wins
    expect(feeStampString('1.2e-7', 1.2e-7)).toBe('0.00000012'); // not a plain decimal
    expect(feeStampString(undefined, 2)).toBe('2');
    const big = '1234567890123456789.123456';
    expect(feeStampString(big, Number(big))).toBe(big); // exact beats the lossy number
    expect(plainDecimal(Number(big))).not.toBe(big);
  });

  it('flag off: the reader is never called', async () => {
    indexer.positions = [{ tokenId: 1, createdAt: 1 }];
    const feeReader = { measure: vi.fn(async () => new Map()) };
    await walk(makeAdapter({ feeReader }), { feeRead: false });
    expect(feeReader.measure).not.toHaveBeenCalled();
  });

  it('mergeFeeReadings: higher block wins, a tie goes to the fresh reading', () => {
    const stored = new Map([
      ['a', { fees0: 1, fees1: 1, block: 10 }],
      ['b', { fees0: 1, fees1: 1, block: 30 }],
    ]);
    const fresh = new Map([
      ['a', { fees0: 2, fees1: 2, block: 10 }],
      ['b', { fees0: 2, fees1: 2, block: 20 }],
      ['c', { fees0: 3, fees1: 3, block: 5 }],
    ]);
    const { fees, freshIds } = mergeFeeReadings(stored, fresh);
    expect([...freshIds].sort()).toEqual(['a', 'c']);
    expect(fees.get('b')?.block).toBe(30);
  });

  it('mergeFeeReadings: a fresh reading without `at` gets the merge time; one with `at` keeps it', () => {
    const now = new Date('2026-10-04T08:00:00Z');
    const own = new Date('2026-10-04T07:59:00Z');
    const fresh = new Map<string, { fees0: number; fees1: number; block: number; at?: Date }>([
      ['a', { fees0: 1, fees1: 1, block: 10 }],
      ['b', { fees0: 1, fees1: 1, block: 10, at: own }],
    ]);
    const { fees } = mergeFeeReadings(new Map(), fresh as never, now);
    expect(fees.get('a')?.at).toEqual(now);
    expect(fees.get('b')?.at).toBe(own);
    expect(fresh.get('a')?.at).toBeUndefined(); // the reader's map is not mutated
  });
});

describe('the offset walk (fetchPositions) — fee read and shutdown', () => {
  it('feeRead on a backfill page stamps the measured rows', async () => {
    indexer.positions = [{ tokenId: 7, createdAt: 7, lastModifyBlock: 1 }];
    const feeReader = { measure: vi.fn(async () => new Map([['7', { fees0: 1, fees1: 1, block: 9 }]])) };
    const res = await makeAdapter({ feeReader }).fetchPositions({
      integration,
      cursorTimestamp: 0,
      pageSize: 1000,
      maxPages: 1,
      mode: 'backfill',
      feeRead: true,
      skipPrefetch: true,
    });
    expect(res.positions[0]?.rpcFeesBlock).toBe(9);
    // a reading without `at`: the served label and the stored stamp name ONE instant
    const p = res.positions[0] as unknown as { rpcFeesAt?: Date; metrics: { feesSource?: string; feesMeasuredAt?: Date | null } };
    expect(p.metrics.feesSource).toBe('onchain');
    expect(p.metrics.feesMeasuredAt).toBeInstanceOf(Date);
    expect(p.metrics.feesMeasuredAt).toEqual(p.rpcFeesAt);
  });

  it('a backfill page with a reader bound but NO feeRead option reads nothing (production leaves the key absent)', async () => {
    indexer.positions = [{ tokenId: 7, createdAt: 7, lastModifyBlock: 1 }];
    const feeReader = { measure: vi.fn(async () => new Map([['7', { fees0: 1, fees1: 1, block: 9 }]])) };
    const res = await makeAdapter({ feeReader }).fetchPositions({
      integration,
      cursorTimestamp: 0,
      pageSize: 1000,
      maxPages: 1,
      mode: 'backfill',
      skipPrefetch: true,
    });
    expect(feeReader.measure).not.toHaveBeenCalled();
    expect(res.positions[0]?.rpcFeesBlock).toBeUndefined();
  });

  it('an aborted signal fetches nothing more and reports hasMore', async () => {
    indexer.positions = [{ tokenId: 7, createdAt: 7 }];
    const ctl = new AbortController();
    ctl.abort();
    const res = await makeAdapter().fetchPositions({
      integration,
      cursorTimestamp: 0,
      pageSize: 1000,
      maxPages: 0,
      mode: 'backfill',
      signal: ctl.signal,
    });
    expect(res.hasMore).toBe(true);
    expect(indexer.count('Positions')).toBe(0);
  });
});

describe('findFirstTokenIdCreatedSince (offset-run conversion)', () => {
  it('is the MINIMUM tokenId among rows created at/after the cursor — a late-liquidity low tokenId included', async () => {
    indexer.positions = [
      { tokenId: 1, createdAt: 100 },
      { tokenId: 3, createdAt: 500 }, // late first liquidity
      { tokenId: 900, createdAt: 400 },
      { tokenId: 901, createdAt: 600 },
    ];
    expect(await makeAdapter().findFirstTokenIdCreatedSince(integration, 450)).toBe('3');
    expect(await makeAdapter().findFirstTokenIdCreatedSince(integration, 10_000)).toBeNull();
  });
});

describe('pageFeeReaderBound', () => {
  it('is false without a PAGE_FEE_READER, true with one', () => {
    expect(makeAdapter().pageFeeReaderBound()).toBe(false);
    expect(makeAdapter({ feeReader: { measure: vi.fn() } }).pageFeeReaderBound()).toBe(true);
  });
});

describe('tokenId edge reads that fail', () => {
  it('the conversion lookup throws a TokenIdEdgeQueryError (the caller falls back to the offset walk)', async () => {
    indexer.positions = [{ tokenId: 1, createdAt: 100 }];
    indexer.failWhen = (op) => op === 'TokenIdEdge';
    const err = await makeAdapter()
      .findFirstTokenIdCreatedSince(integration, 50)
      .catch((e: unknown) => e);
    expect(isTokenIdEdgeQueryError(err)).toBe(true);
  });

  it('the walk start (highest tokenId) throws a TokenIdEdgeQueryError before any range', async () => {
    indexer.positions = [{ tokenId: 1, createdAt: 100 }];
    indexer.failWhen = (op) => op === 'TokenIdEdge';
    const err = await walk(makeAdapter(), { pipeline: false }).catch((e: unknown) => e);
    expect(isTokenIdEdgeQueryError(err)).toBe(true);
    expect(indexer.count('PositionsByTokenId')).toBe(0);
  });

  it('a failed END re-read ends the walk cleanly (the tail covers new mints)', async () => {
    indexer.positions = [
      { tokenId: 1, createdAt: 100 },
      { tokenId: 2, createdAt: 101 },
    ];
    indexer.failWhen = (op, n) => op === 'TokenIdEdge' && n >= 1;
    const { got } = await walk(makeAdapter(), { pipeline: false });
    expect(got.positions.map((p) => p.positionId).sort()).toEqual(['1', '2']);
  });
});

describe('helpers', () => {
  it('range size is capped at 999 (a full 1000-row page must prove an overflow)', () => {
    expect(clampRangeSize(undefined)).toBe(999);
    expect(clampRangeSize(5_000)).toBe(999);
    expect(clampRangeSize(100)).toBe(100);
    expect(clampRangeSize(0)).toBe(999);
  });
  it('a cursor string is canonical decimal, anything else is 0', () => {
    expect(normalizeTokenIdString('00042')).toBe('42');
    expect(normalizeTokenIdString('-1')).toBe('0');
    expect(normalizeTokenIdString(undefined)).toBe('0');
  });
  it('whitelist-derived verified still applies through the run token cache', async () => {
    indexer.positions = [{ tokenId: 1, createdAt: 1 }];
    const { got } = await walk(makeAdapter(), { pipeline: true });
    expect(got.positions[0]?.token0.address).toBe(WETH);
    expect(got.positions[0]?.token0.verified).toBe(true);
  });
});
