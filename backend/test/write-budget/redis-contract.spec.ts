/*
 * ACQUIRE_SCRIPT against a REAL Redis (opt-in): the Lua must do exactly what
 * its TypeScript reference model (`htbAcquire`) does, step for step, on long
 * random sequences — lanes, units, refusals, observe clamps, lane caps, a
 * missing and a changing rate key, idle gaps.
 *
 *   WRITE_BUDGET_TEST_REDIS_URL=redis://127.0.0.1:6397 npx vitest run test/write-budget/redis-contract.spec.ts
 *
 * Use a THROWAWAY instance: the spec flushes its database before each case.
 * Elapsed time is simulated by moving the stored `ts` back before a call (the
 * script reads Redis TIME), and the model is fed the `ts` the script wrote.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACQUIRE_SCRIPT, MINUTE_TTL_SEC, STATE_TTL_MS, writeBudgetKeys } from '../../src/common/write-budget.js';
import { htbAcquire, htbLongestDebtMs, parseWriteBudgetShares, type HtbState } from '../../src/common/write-budget-model.js';
import { WRITE_LANES, type WriteLane } from '../../src/common/write-lane.js';

const URL = process.env.WRITE_BUDGET_TEST_REDIS_URL;
const keys = writeBudgetKeys('contract');
const MINUTE = keys.minute(1);

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!URL)('write budget Lua (real Redis) = the TS model', () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(URL!, { lazyConnect: false, maxRetriesPerRequest: 1 });
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis.quit();
  });

  async function readState(lane: WriteLane): Promise<HtbState | undefined> {
    const h = await redis.hgetall(keys.state);
    if (h.ts === undefined) return undefined;
    const lanes = {} as Record<WriteLane, number>;
    for (const l of WRITE_LANES) lanes[l] = Number(h[`b:${l}`]);
    const caps: Partial<Record<WriteLane, number>> = {};
    if (h[`c:${lane}`] !== undefined) caps[lane] = Number(h[`c:${lane}`]);
    return { ts: Number(h.ts), g: Number(h.g), lanes, caps };
  }

  async function acquire(lane: WriteLane, units: number, maxWait: number, opts: { fallback: number; laneCap: number; observe: boolean; shares: Record<WriteLane, number> }) {
    const args: string[] = [lane, String(units), String(maxWait), String(opts.fallback), String(opts.laneCap), opts.observe ? '1' : '0', String(STATE_TTL_MS), String(MINUTE_TTL_SEC), String(WRITE_LANES.length)];
    for (const l of WRITE_LANES) args.push(l, String(opts.shares[l]));
    return (await redis.eval(ACQUIRE_SCRIPT, 3, keys.state, keys.rate, MINUTE, ...args)) as [number, string, number, string];
  }

  for (const seed of [1, 7, 42, 99]) {
    it(`random sequence (seed ${seed}): waits, buckets, pool and caps match the model`, async () => {
      const rnd = mulberry32(seed);
      const shares = seed % 2 === 0 ? parseWriteBudgetShares(undefined) : parseWriteBudgetShares('backfill:50,refresh:20');
      let expectedMinute = 0;
      for (let step = 0; step < 300; step++) {
        // the controller moves R now and then (or lets it lapse)
        const r = rnd();
        if (r < 0.05) await redis.del(keys.rate);
        else if (r < 0.15) await redis.set(keys.rate, String(100 + Math.floor(rnd() * 350)), 'PX', 60_000);
        const lane = WRITE_LANES[Math.floor(rnd() * WRITE_LANES.length)]!;
        // simulate idle time by moving the stored clock back
        const before = await redis.hget(keys.state, 'ts');
        if (before !== null) {
          const gap = rnd() < 0.3 ? Math.floor(rnd() * 3000) : Math.floor(rnd() * 50);
          await redis.hset(keys.state, 'ts', String(Number(before) - gap));
        }
        const prev = await readState(lane);
        const stored = Number(await redis.get(keys.rate));
        const fallback = 100;
        const rate = Number.isFinite(stored) && stored > 0 ? stored : fallback;
        const units = Math.round(rnd() * 400 * 1000) / 1000;
        const maxWait = rnd() < 0.3 ? Math.floor(rnd() * 3000) : -1;
        const laneCap = lane === 'backfill' && rnd() < 0.5 ? 100 : 0;
        const observe = rnd() < 0.25;
        const reply = await acquire(lane, units, maxWait, { fallback, laneCap, observe, shares });
        const after = await readState(lane);
        const model = htbAcquire(prev, after!.ts, lane, units, maxWait, { rate, shares, laneCap, observe });
        expect(Math.abs(Number(reply[0]) - model.wait), `step ${step} wait`).toBeLessThanOrEqual(1);
        expect(Number(reply[1])).toBe(rate);
        expect(Number(reply[2])).toBe(Number.isFinite(stored) && stored > 0 ? 1 : 0);
        for (const l of WRITE_LANES) expect(after!.lanes[l], `step ${step} lane ${l}`).toBeCloseTo(model.state.lanes[l], 6);
        expect(after!.g, `step ${step} pool`).toBeCloseTo(model.state.g, 6);
        if (laneCap > 0) expect(after!.caps[lane]).toBeCloseTo(model.state.caps[lane]!, 6);
        if (model.wait >= 0) expectedMinute += units;
        const pttl = await redis.pttl(keys.state);
        const longest = htbLongestDebtMs(model.state, rate, shares);
        expect(pttl).toBeLessThanOrEqual(STATE_TTL_MS + longest + 5);
        expect(pttl).toBeGreaterThan(STATE_TTL_MS + longest - 1000);
      }
      expect(Number(await redis.hget(MINUTE, 'all'))).toBeCloseTo(expectedMinute, 3);
      expect(await redis.ttl(MINUTE)).toBeGreaterThan(MINUTE_TTL_SEC - 5);
    });
  }

  it('a refusal takes nothing and never counts toward the minute counter', async () => {
    const shares = parseWriteBudgetShares(undefined);
    await acquire('pools', 2000, -1, { fallback: 100, laneCap: 0, observe: false, shares });
    const before = await redis.hgetall(keys.state);
    await new Promise((r) => setTimeout(r, 20)); // a real refill (and borrowing) happens before the refusal
    const reply = await acquire('pools', 10, 100, { fallback: 100, laneCap: 0, observe: false, shares });
    expect(Number(reply[0])).toBeLessThan(-100);
    const after = await redis.hgetall(keys.state);
    // Nothing taken: the stored state is exactly the model's REFILL from `before`
    // to the refusal's clock (own share + the idle lanes' overflow repaying the
    // debt — borrowing), never a take.
    const lanes = {} as Record<WriteLane, number>;
    for (const l of WRITE_LANES) lanes[l] = Number(before[`b:${l}`]);
    const model = htbAcquire({ ts: Number(before.ts), g: Number(before.g), lanes, caps: {} }, Number(after.ts), 'pools', 10, 100, {
      rate: 100,
      shares,
      laneCap: 0,
      observe: false,
    });
    expect(model.wait).toBeLessThan(0);
    for (const l of WRITE_LANES) expect(Number(after[`b:${l}`]), l).toBeCloseTo(model.state.lanes[l], 6);
    expect(Number(await redis.hget(MINUTE, 'pools'))).toBe(2000);
  });

  it('an unknown lane is an error, not a silent take', async () => {
    const shares = parseWriteBudgetShares(undefined);
    await expect(acquire('nope' as WriteLane, 1, -1, { fallback: 100, laneCap: 0, observe: false, shares })).rejects.toThrow(/unknown lane/);
  });
});
