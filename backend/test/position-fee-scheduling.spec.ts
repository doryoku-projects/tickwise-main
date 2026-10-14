/*
 * PositionFeeRefreshService — scheduling, the shared read budget, the side
 * lanes, the page pipeline and the write pacing (review fixes, 2026-10-03).
 *
 * Pinned here: a side-lane or view drain whose WRITE fails keeps every id it
 * took (and its change block); a view dropped by a full queue starts no
 * cooldown; a tick that outlasts its minute is re-run when it ends instead of
 * losing the slot, and a chain's ticks never start less than MIN_TICK_GAP_MS
 * apart; POSITION_FEE_MAX_PER_TICK is a real ceiling on a round across chains;
 * the next page is measured while the previous one is written, cursors saved in
 * page order and only after their page is persisted; backfill marks have their
 * own lane, drained after the live set, and never crowd it out; side lanes keep
 * draining while there is budget, and while a pass is due take no more wall
 * time than the pass; the write gate books every bucket at the moment a chunk
 * goes out (no bunching) and holds the backfill lane to a share of the rates;
 * the repository's stamp-only fallback is paced BEFORE it is sent; a periodic
 * line reports write-gate waits and warns on saturation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKFILL_WRITE_SHARE, FeeWriteGate } from '../src/sync/fee-write-gate.js';
import {
  BACKFILL_MAX_PER_CHAIN,
  FEE_TICK_INTERVAL_MS,
  GATE_REPORT_MS,
  MIN_TICK_GAP_MS,
  SIDE_DRAIN_WINDOW_MS,
  SIDE_READS_PER_TICK,
  VIEW_QUEUE_MAX_PER_CHAIN,
} from '../src/sync/position-fee-refresh.service.js';
import { positionSalt } from '../src/sync/position-fee-math.js';
import { CHAIN, MIN, PROTO, candidate, makeHarness, recent, rejectedShape, successFor, universe, type FakeCall } from './fee-refresh-harness.js';

const ALL_ONLY = { positionFeeHotIntervalMs: 0 };
const KEY = `${CHAIN}:${PROTO}`;

afterEach(() => {
  vi.useRealTimers();
});

type Internals = {
  dirty: Map<string, Map<string, number>>;
  backfill: Map<string, Map<string, number>>;
  viewed: Map<string, Set<string>>;
  viewCooldown: Map<string, number>;
  lastUsed: Map<string, number>;
  lastAllotted: Map<string, number>;
  wanted: Map<string, boolean>;
  writeGate: FeeWriteGate;
  reportGate: (now?: number) => void;
};
const internals = (s: unknown) => s as Internals;

describe('a drain whose write fails keeps what it took', () => {
  it('live dirty ids, with their change blocks, are back in the set after the aborted tick', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    h.service.markDirty(CHAIN, ['10', '11', '12'], PROTO, new Map([['10', 500], ['11', 600]]));
    h.positions.writeRpcFees.mockRejectedValueOnce(new Error('fee write timed out after 60s (Mongo pool stalled?)'));
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skipped).toMatch(/aborted: fee write timed out/);
    expect(r.measured).toBe(3);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(3);
    expect([...internals(h.service).dirty.get(KEY)!]).toEqual([
      ['10', 500],
      ['11', 600],
      ['12', Number.POSITIVE_INFINITY],
    ]);
    // …and the next tick reads them again.
    const next = await h.service.refreshChain(CHAIN, PROTO);
    expect(next.tiers.dirty).toBe(3);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(0);
  });

  it('backfill-lane ids go back to the backfill lane', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    h.service.markDirty(CHAIN, ['10', '11'], PROTO, new Map([['10', 500]]), { lane: 'backfill' });
    h.positions.writeRpcFees.mockRejectedValueOnce(new Error('boom'));
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.service.backfillSize(CHAIN, PROTO)).toBe(2);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(0);
    expect(internals(h.service).backfill.get(KEY)!.get('10')).toBe(500);
  });

  it('viewed ids are back in the queue (their cooldowns are running, so a re-open could not re-queue them)', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    h.service.markViewed(CHAIN, PROTO, '10');
    h.positions.writeRpcFees.mockRejectedValueOnce(new Error('fee write timed out'));
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.service.viewedSize(CHAIN, PROTO)).toBe(1);
    const next = await h.service.refreshChain(CHAIN, PROTO);
    expect(next.tiers.view).toBe(1);
    expect(h.service.viewedSize(CHAIN, PROTO)).toBe(0);
  });

  it('a viewed id that no longer fits loses its cooldown, so its next open can queue it', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() }, config: { positionFeeViewPerTick: 200 } });
    for (let i = 0; i < VIEW_QUEUE_MAX_PER_CHAIN; i++) h.service.markViewed(CHAIN, PROTO, String(100_000 + i));
    h.positions.writeRpcFees.mockImplementationOnce(async () => {
      // While the drain is writing, opens refill the queue.
      for (let i = 0; i < 200; i++) h.service.markViewed(CHAIN, PROTO, String(200_000 + i));
      throw new Error('boom');
    });
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.service.viewedSize(CHAIN, PROTO)).toBe(VIEW_QUEUE_MAX_PER_CHAIN);
    const first = '100000'; // drained, failed, could not be put back
    expect(internals(h.service).viewed.get(KEY)!.has(first)).toBe(false);
    expect(internals(h.service).viewCooldown.has(`${KEY}:${first}`)).toBe(false);
  });
});

describe('a view dropped by a full queue starts no cooldown', () => {
  it('is not queued and not on cooldown; once the queue drains, the next open queues it', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    for (let i = 0; i < VIEW_QUEUE_MAX_PER_CHAIN; i++) h.service.markViewed(CHAIN, PROTO, String(100_000 + i));
    h.service.markViewed(CHAIN, PROTO, '7');
    expect(internals(h.service).viewed.get(KEY)!.has('7')).toBe(false);
    expect(internals(h.service).viewCooldown.has(`${KEY}:7`)).toBe(false);
    expect(h.warnings().filter((w) => w.includes('view queue') && w.includes('is full'))).toHaveLength(1);
    await h.service.refreshChain(CHAIN, PROTO); // drains 200
    h.service.markViewed(CHAIN, PROTO, '7');
    expect(internals(h.service).viewed.get(KEY)!.has('7')).toBe(true);
    expect(internals(h.service).viewCooldown.has(`${KEY}:7`)).toBe(true);
  });

  it('an open of a position already waiting changes nothing', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = makeHarness();
    h.service.markViewed(CHAIN, PROTO, '7');
    const at = internals(h.service).viewCooldown.get(`${KEY}:7`);
    vi.setSystemTime(Date.now() + 10 * MIN); // cooldown over, still queued
    h.service.markViewed(CHAIN, PROTO, '7');
    expect(h.service.viewedSize(CHAIN, PROTO)).toBe(1);
    expect(internals(h.service).viewCooldown.get(`${KEY}:7`)).toBe(at);
  });
});

describe('a tick that outlasts its minute does not lose the next slot', () => {
  /** Every tick reads one row of a pass that never ends, its multicall taking `ms`; `starts` records each tick's start. */
  function slowTicks(ms: number) {
    const h = makeHarness({
      rows: universe(5000),
      config: { ...ALL_ONLY, positionFeeMaxPerTick: 1 },
      respond: async (c) => {
        await new Promise((r) => setTimeout(r, ms));
        return c.map(successFor);
      },
    });
    const starts: number[] = [];
    const read = h.syncRepo.getFeeCursors.getMockImplementation()!;
    h.syncRepo.getFeeCursors.mockImplementation(async () => {
      starts.push(Date.now());
      return read();
    });
    return { h, starts };
  }

  it('re-runs as soon as the long tick ends, instead of waiting for the slot after next', async () => {
    vi.useFakeTimers();
    const { h, starts } = slowTicks(90_000);
    const t0 = Date.now();
    h.service.onModuleInit(); // one chain: a slot every 60 s
    await vi.advanceTimersByTimeAsync(FEE_TICK_INTERVAL_MS); // slot 1 → tick A (t=60)
    expect(starts.map((s) => s - t0)).toEqual([60_000]);
    await vi.advanceTimersByTimeAsync(FEE_TICK_INTERVAL_MS); // t=120: slot 2, A still running
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000); // t=150: A ends → B starts at once
    expect(starts.map((s) => s - t0)).toEqual([60_000, 150_000]);
    // t=180: slot 3, B still running (it ends at 240) → re-run at 240.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(starts.map((s) => s - t0)).toEqual([60_000, 150_000, 240_000]);
    h.service.onModuleDestroy();
  });

  it('a slot that comes sooner than MIN_TICK_GAP_MS after the last start waits for it, and is not lost', async () => {
    vi.useFakeTimers();
    const { h, starts } = slowTicks(10);
    const t0 = Date.now();
    h.service.onModuleInit();
    // A tick started off-cadence (the BullMQ backstop) 20 s before the first slot.
    await vi.advanceTimersByTimeAsync(40_000);
    void h.service.refreshChain(CHAIN, PROTO);
    await vi.advanceTimersByTimeAsync(20_000); // t=60: slot, only 20 s after that start
    expect(starts.map((s) => s - t0)).toEqual([40_000]);
    await vi.advanceTimersByTimeAsync(MIN_TICK_GAP_MS - 20_000 - 1);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // t = 40 s + MIN_TICK_GAP_MS
    expect(starts.map((s) => s - t0)).toEqual([40_000, 40_000 + MIN_TICK_GAP_MS]);
    h.service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10 * FEE_TICK_INTERVAL_MS);
    expect(starts).toHaveLength(2);
  });

  it('without the module timer (refresh off, or not started) a slot that would re-run or be deferred is dropped', async () => {
    vi.useFakeTimers();
    const slow = slowTicks(90_000);
    void slow.h.service.refreshChain(CHAIN, PROTO);
    await vi.advanceTimersByTimeAsync(10);
    slow.h.service.tickAll(); // while that tick runs
    await vi.advanceTimersByTimeAsync(5 * FEE_TICK_INTERVAL_MS);
    expect(slow.starts).toHaveLength(1);

    const quick = slowTicks(10);
    void quick.h.service.refreshChain(CHAIN, PROTO);
    await vi.advanceTimersByTimeAsync(100);
    quick.h.service.tickAll(); // too soon after that start
    await vi.advanceTimersByTimeAsync(5 * FEE_TICK_INTERVAL_MS);
    expect(quick.starts).toHaveLength(1);
  });

  it('nothing re-runs once the module is destroyed', async () => {
    vi.useFakeTimers();
    const { h, starts } = slowTicks(90_000);
    h.service.onModuleInit();
    await vi.advanceTimersByTimeAsync(2 * FEE_TICK_INTERVAL_MS); // A running, slot 2 pending
    h.service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(5 * FEE_TICK_INTERVAL_MS);
    expect(starts).toHaveLength(1);
  });
});

describe('POSITION_FEE_MAX_PER_TICK is a ceiling on the round', () => {
  const CHAINS = [CHAIN, 1, 42161, 43114];
  function fourChains(total = 15_000) {
    return makeHarness({
      config: {
        evmRpcUrls: new Map(CHAINS.map((c) => [c, `http://rpc${c}.local`])),
        enabledIntegrations: CHAINS.map((c) => ({ chainId: c, protocol: PROTO })),
        positionFeeMaxPerTick: total,
      },
    });
  }
  /** Round-robin ticks driven through `allotment` and the bookkeeping a tick does. */
  function simulate(h: ReturnType<typeof makeHarness>, demand: (chain: number, tick: number) => number, ticks: number) {
    const s = internals(h.service);
    const used: Array<{ chain: number; used: number; allot: number }> = [];
    for (let t = 0; t < ticks; t++) {
      const chain = CHAINS[t % CHAINS.length]!;
      const key = `${chain}:${PROTO}`;
      const allot = h.service.allotment(key);
      const want = demand(chain, t);
      const u = Math.min(allot, want);
      s.lastUsed.set(key, u);
      s.lastAllotted.set(key, allot);
      s.wanted.set(key, u >= allot && want > u);
      used.push({ chain, used: u, allot });
    }
    return used;
  }

  it('three busy chains and one idle never read more than the budget in any round (was 1.5×)', () => {
    const h = fourChains();
    const busy = (c: number) => (c === 43114 ? 10 : 1_000_000);
    const ticks = simulate(h, busy, 40);
    for (let i = 0; i + CHAINS.length <= ticks.length; i++) {
      const round = ticks.slice(i, i + CHAINS.length).reduce((a, t) => a + t.used, 0);
      expect(round, `round starting at tick ${i}`).toBeLessThanOrEqual(15_000);
    }
    // Converged: the busy chains split what the idle one leaves; the idle one keeps what it uses.
    const last = ticks.slice(-CHAINS.length);
    for (const t of last.filter((x) => x.chain !== 43114)) expect(t.used).toBeGreaterThanOrEqual(4_990);
    expect(last.find((x) => x.chain === 43114)!.used).toBe(10);
    expect(last.reduce((a, t) => a + t.used, 0)).toBeGreaterThan(14_900);
  });

  it('every chain busy: an equal share each; a chain alone: nearly all of it', () => {
    const all = simulate(fourChains(), () => 1_000_000, 20).slice(-CHAINS.length);
    expect(all.map((t) => t.used)).toEqual([3750, 3750, 3750, 3750]);
    const alone = simulate(fourChains(), (c) => (c === CHAIN ? 1_000_000 : 0), 20).slice(-CHAINS.length);
    expect(alone.find((t) => t.chain === CHAIN)!.used).toBe(15_000);
  });

  it('an idle chain that suddenly needs more gets its share within one round, and the ceiling holds throughout', () => {
    const h = fourChains();
    const burstAt = 40;
    const ticks = simulate(h, (c, t) => (c === 43114 && t < burstAt ? 10 : 1_000_000), 60);
    for (let i = 0; i + CHAINS.length <= ticks.length; i++) {
      expect(ticks.slice(i, i + CHAINS.length).reduce((a, t) => a + t.used, 0)).toBeLessThanOrEqual(15_000);
    }
    const after = ticks.slice(burstAt).filter((t) => t.chain === 43114).map((t) => t.used);
    // Its first tick gets what is left; from its next one, an equal share.
    expect(after[1]).toBe(3750);
  });

  it('a chain that has not ticked yet is reserved its fair share, even while another chain is over its own', () => {
    const three = [CHAIN, 42161, 43114];
    const h = makeHarness({
      config: {
        evmRpcUrls: new Map(three.map((c) => [c, `http://rpc${c}.local`])),
        enabledIntegrations: three.map((c) => ({ chainId: c, protocol: PROTO })),
        positionFeeMaxPerTick: 3000,
      },
    });
    const s = internals(h.service);
    // 42161 took 2000 of the round last tick and wants more; 43114 has not ticked yet.
    s.lastUsed.set(`42161:${PROTO}`, 2000);
    s.lastAllotted.set(`42161:${PROTO}`, 2000);
    s.wanted.set(`42161:${PROTO}`, true);
    expect(h.service.allotment(KEY)).toBe(0); // 3000 − 2000 − 43114's reserved 1000
    s.lastUsed.set(KEY, 0);
    s.lastAllotted.set(KEY, 0);
    s.wanted.set(KEY, true);
    // …so 43114's first tick finds its share waiting.
    expect(h.service.allotment(`43114:${PROTO}`)).toBe(1000);
  });

  it('a tick in flight holds its whole allotment', () => {
    const h = fourChains();
    const s = internals(h.service);
    for (const c of CHAINS) {
      s.lastUsed.set(`${c}:${PROTO}`, 3750);
      s.lastAllotted.set(`${c}:${PROTO}`, 3750);
    }
    (h.service as unknown as { holding: Map<string, number> }).holding.set(`1:${PROTO}`, 7000);
    expect(h.service.allotment(KEY)).toBe(15_000 - 3750 - 3750 - 7000);
  });

  it('a tick records whether it wanted more: all of its allotment used and work left', async () => {
    const h = makeHarness({ rows: universe(50), config: { ...ALL_ONLY, positionFeeMaxPerTick: 20 } });
    await h.service.refreshChain(CHAIN, PROTO);
    expect(internals(h.service).wanted.get(KEY)).toBe(true);
    const idle = makeHarness({ cursors: { hot: recent(), all: recent() }, config: { positionFeeMaxPerTick: 20 } });
    await idle.service.refreshChain(CHAIN, PROTO);
    expect(internals(idle.service).wanted.get(KEY)).toBe(false);
    // Given nothing, with nothing to do: not wanting (else an idle chain would keep cutting the others' shares).
    const zero = makeHarness({ cursors: { hot: recent(), all: recent() } });
    vi.spyOn(zero.service, 'allotment').mockReturnValue(0);
    await zero.service.refreshChain(CHAIN, PROTO);
    expect(internals(zero.service).wanted.get(KEY)).toBe(false);
    zero.service.markViewed(CHAIN, PROTO, '7');
    await zero.service.refreshChain(CHAIN, PROTO);
    expect(internals(zero.service).wanted.get(KEY)).toBe(true);
  });
});

describe('the page pipeline: page N+1 is measured while page N is written', () => {
  const rows = universe(5000);
  const salt = (i: number) => positionSalt(rows[i]!.c.tokenId);

  const pageOf = new Map(rows.map((r, i) => [r.c.positionId, Math.floor(i / 2000)] as const));

  function pipelined(respond?: (c: FakeCall[]) => unknown[]) {
    /** Pages with a write in flight right now, and the most there ever were at once. */
    const writing = new Map<number, number>();
    const track = { maxPagesWriting: 0 };
    const h = makeHarness({
      rows,
      // 6000: the third page asks for 2000, gets the last 1000 — the pass ends this tick.
      config: { ...ALL_ONLY, positionFeeBatchSize: 200, positionFeeConcurrency: 8, positionFeeMaxPerTick: 6000 },
      respond: (c) => {
        h.events.push(`mc:${String(c[1]!.args[4])}`);
        return respond ? respond(c) : c.map(successFor);
      },
    });
    h.positions.writeRpcFees.mockImplementation(async (_c: number, _p: string, w: Array<{ positionId: string }>) => {
      const page = pageOf.get(w[0]!.positionId) ?? -1;
      writing.set(page, (writing.get(page) ?? 0) + 1);
      track.maxPagesWriting = Math.max(track.maxPagesWriting, writing.size);
      h.events.push(`write-start:${w[0]!.positionId}`);
      await new Promise((r) => setTimeout(r, 1000));
      h.events.push(`write-end:${w[w.length - 1]!.positionId}`);
      h.writes.push(w as never);
      const left = writing.get(page)! - 1;
      if (left === 0) writing.delete(page);
      else writing.set(page, left);
      return { matched: w.length, modified: w.length };
    });
    return Object.assign(h, { track });
  }

  it('overlaps, saves each cursor after its page is written and before the next page writes, and loses nothing', async () => {
    vi.useFakeTimers();
    const h = pipelined();
    const run = h.service.refreshChain(CHAIN, PROTO);
    await vi.runAllTimersAsync();
    await run;
    const at = (e: string) => h.events.indexOf(e);
    const page2FirstMeasure = at(`mc:${salt(2000)}`);
    const page1LastWriteEnd = at(`write-end:${rows[1999]!.c.positionId}`);
    const save1 = at(`save:all:${rows[1999]!.c.tokenId}`);
    const page2FirstWrite = h.events.findIndex((e) => e.startsWith('write-start:') && rows.findIndex((r) => r.c.positionId === e.slice(12)) >= 2000);
    expect(page2FirstMeasure).toBeGreaterThan(-1);
    // Page 2 was measured while page 1 was still being written…
    expect(page2FirstMeasure).toBeLessThan(page1LastWriteEnd);
    // …page 1's cursor saved only once its writes were done, and before page 2 wrote anything.
    expect(save1).toBeGreaterThan(page1LastWriteEnd);
    expect(save1).toBeLessThan(page2FirstWrite);
    const saves = h.events.filter((e) => e.startsWith('save:'));
    expect(saves).toEqual([`save:all:${rows[1999]!.c.tokenId}`, `save:all:${rows[3999]!.c.tokenId}`, 'save:all:']);
    const ids = h.written().map((w) => w.positionId);
    expect(new Set(ids).size).toBe(5000);
    expect(h.tallies.all).toMatchObject({ scanned: 5000, measured: 5000, written: 5000 });
    expect(h.log.mock.calls.map(String).find((l) => l.includes('all pass'))).toMatch(/scanned=5000 measured=5000 written=5000/);
    // Never two pages' writes in flight at once.
    expect(h.track.maxPagesWriting).toBe(1);
  });

  it('the last page of a pass is settled before a new pass can start (the pass line keeps its own start)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = makeHarness({
      rows: universe(10),
      // Due again the moment it finishes: a new pass starts in the same tick.
      config: { ...ALL_ONLY, positionFeeFullIntervalMs: 1, positionFeeMaxPerTick: 25 },
      respond: (c) => {
        vi.setSystemTime(Date.now() + 1000);
        return c.map(successFor);
      },
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.finished).toEqual(['all', 'all']);
    const lines = h.log.mock.calls.map(String).filter((l) => l.includes('all pass'));
    expect(lines).toHaveLength(2);
    // 10 rows in batches of 2: five calls, one second each.
    for (const l of lines) expect(l).toMatch(/finished in 5s scanned=10 measured=10/);
  });

  it('a tick that aborts while a page is still being written waits for that write (and its cursor save) before it returns', async () => {
    vi.useFakeTimers();
    const h = pipelined();
    const read = h.positions.findFeeRefreshCandidates.getMockImplementation()!;
    let n = 0;
    h.positions.findFeeRefreshCandidates.mockImplementation(async (...a: Parameters<typeof read>) => {
      if (n++ === 1) throw new Error('page read failed'); // the read-ahead of page 2
      return read(...a);
    });
    const run = h.service.refreshChain(CHAIN, PROTO);
    let savesWhenReturned = -1;
    void run.then(() => {
      savesWhenReturned = h.syncRepo.saveFeeCursor.mock.calls.length;
    });
    await vi.runAllTimersAsync();
    const r = await run;
    expect(r.skipped).toMatch(/aborted: page read failed/);
    expect(savesWhenReturned).toBe(1);
    expect(h.store.all.cursor).toBe(rows[1999]!.c.tokenId);
  });

  it('a page held back while the previous page is still being written: that page’s cursor is saved, the held one’s is not', async () => {
    vi.useFakeTimers();
    const E = Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError', status: 503 });
    const h = pipelined((c) => (String(c[1]!.args[4]) === salt(2000) ? rejectedShape(c, E) : c.map(successFor)));
    const run = h.service.refreshChain(CHAIN, PROTO);
    await vi.runAllTimersAsync();
    const r = await run;
    expect(r.heldBack).toBe('all');
    expect(h.events.filter((e) => e.startsWith('save:'))).toEqual([`save:all:${rows[1999]!.c.tokenId}`]);
    expect(h.store.all.cursor).toBe(rows[1999]!.c.tokenId);
    expect(h.tallies.all).toMatchObject({ scanned: 2000, measured: 2000 });
    // Page 1 was written in full before the tick ended…
    expect(new Set(h.written().map((w) => w.positionId)).size).toBeGreaterThanOrEqual(2000);
    // …and before the held page's measured rows were.
    expect(h.track.maxPagesWriting).toBe(1);
  });

  it('a write that fails while the next page is being measured aborts the tick without saving that page', async () => {
    vi.useFakeTimers();
    const h = pipelined();
    h.positions.writeRpcFees.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 1000));
      throw new Error('fee write timed out');
    });
    const run = h.service.refreshChain(CHAIN, PROTO);
    await vi.runAllTimersAsync();
    const r = await run;
    expect(r.skipped).toMatch(/aborted: fee write timed out/);
    expect(h.syncRepo.saveFeeCursor).not.toHaveBeenCalled();
  });
});

describe('the backfill lane', () => {
  it('has its own cap: a full backfill lane drops backfill marks only, never a live change', () => {
    const h = makeHarness();
    const ids = Array.from({ length: BACKFILL_MAX_PER_CHAIN + 5 }, (_, i) => String(1_000_000 + i));
    h.service.markDirty(CHAIN, ids, PROTO, undefined, { lane: 'backfill' });
    expect(h.service.backfillSize(CHAIN, PROTO)).toBe(BACKFILL_MAX_PER_CHAIN);
    expect(h.warnings()).toContainEqual(expect.stringContaining(`backfill queue ${KEY} is full (${BACKFILL_MAX_PER_CHAIN}); 5 backfilled positions`));
    h.service.markDirty(CHAIN, ['7'], PROTO, new Map([['7', 9999]]));
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(1);
  });

  it('a live change to a position the backfill lane holds moves it to the live set, keeping the later block', () => {
    const h = makeHarness();
    h.service.markDirty(CHAIN, ['7', '8'], PROTO, new Map([['7', 500], ['8', 500]]), { lane: 'backfill' });
    h.service.markDirty(CHAIN, ['7'], PROTO, new Map([['7', 400]]));
    expect(h.service.backfillSize(CHAIN, PROTO)).toBe(1);
    expect(internals(h.service).dirty.get(KEY)!.get('7')).toBe(500);
    // A backfill mark of a position the live set holds leaves it there.
    h.service.markDirty(CHAIN, ['7'], PROTO, new Map([['7', 900]]), { lane: 'backfill' });
    expect(h.service.backfillSize(CHAIN, PROTO)).toBe(1);
    expect(internals(h.service).dirty.get(KEY)!.get('7')).toBe(900);
  });

  it('a full live set still leaves a backfill-queued position queued (in the backfill lane)', () => {
    const h = makeHarness();
    h.service.markDirty(CHAIN, ['7'], PROTO, new Map([['7', 500]]), { lane: 'backfill' });
    h.service.markDirty(CHAIN, Array.from({ length: 50_000 }, (_, i) => String(1_000_000 + i)), PROTO);
    h.service.markDirty(CHAIN, ['7'], PROTO, new Map([['7', 800]]));
    expect(internals(h.service).backfill.get(KEY)!.get('7')).toBe(800);
  });

  it('is drained only after the live set, and its writes take the backfill lane of the write gate', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    const lanes: string[] = [];
    const acquire = internals(h.service).writeGate.acquire.bind(internals(h.service).writeGate);
    vi.spyOn(internals(h.service).writeGate, 'acquire').mockImplementation(async (w, s, lane = 'main') => {
      lanes.push(lane);
      return acquire(w, s, lane);
    });
    h.service.markDirty(CHAIN, ['20', '21'], PROTO, undefined, { lane: 'backfill' });
    h.service.markDirty(CHAIN, ['10'], PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    const reads = h.positions.findFeeRefreshCandidatesByIds.mock.calls.map((c) => c[2]);
    expect(reads).toEqual([['10'], ['20', '21']]);
    expect(r.tiers).toMatchObject({ dirty: 1, backfill: 2 });
    expect(lanes).toEqual(['main', 'backfill']);
  });
});

describe('side lanes drain while there is budget', () => {
  it('with no pass due, one tick drains 3000 queued changes, not 1000', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() }, config: { positionFeeMaxPerTick: 15_000 } });
    h.service.markDirty(CHAIN, Array.from({ length: 3000 }, (_, i) => String(100_000 + i)), PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.dirty).toBe(3000);
    expect(h.positions.findFeeRefreshCandidatesByIds).toHaveBeenCalledTimes(3);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(0);
  });

  it('rows skipped as fresh do not end the drain; at most SIDE_READS_PER_TICK Mongo reads a tick', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() }, config: { positionFeeMaxPerTick: 15_000 } });
    const fresh = { fees0: '1', fees1: '1', block: 5000, at: new Date() };
    h.positions.findFeeRefreshCandidatesByIds.mockImplementation(async (_c: number, _p: string, ids: string[]) =>
      ids.map((id) => candidate(id, { lastModifyBlock: 1, rpc: fresh })),
    );
    const n = (SIDE_READS_PER_TICK + 5) * 1000;
    const ids = Array.from({ length: n }, (_, i) => String(100_000 + i));
    h.service.markDirty(CHAIN, ids, PROTO, new Map(ids.map((id) => [id, 10] as const)), { lane: 'backfill' });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidatesByIds).toHaveBeenCalledTimes(SIDE_READS_PER_TICK);
    expect(r.skippedFresh).toBe(SIDE_READS_PER_TICK * 1000);
    expect(h.client.multicall).not.toHaveBeenCalled();
    expect(h.service.backfillSize(CHAIN, PROTO)).toBe(5000);
  });

  it(`no side drain starts more than ${SIDE_DRAIN_WINDOW_MS / 1000} s into a tick, so views and live changes are not held behind a backlog`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = makeHarness({
      cursors: { hot: recent(), all: recent() },
      config: { positionFeeMaxPerTick: 15_000, positionFeeBatchSize: 1000 },
      respond: (c) => {
        vi.setSystemTime(Date.now() + 35_000); // one drain of never-measured rows: 35 s
        return c.map(successFor);
      },
    });
    h.service.markDirty(CHAIN, Array.from({ length: 3000 }, (_, i) => String(100_000 + i)), PROTO, undefined, { lane: 'backfill' });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    // Drains start at 0 s and 35 s; the third would start at 70 s.
    expect(r.tiers.backfill).toBe(2000);
    expect(h.service.backfillSize(CHAIN, PROTO)).toBe(1000);
  });

  it('a drain that left rows unanswered ends the side drains for the tick', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() }, config: { positionFeeMaxPerTick: 15_000 } });
    h.client.getBlockNumber.mockRejectedValue(new Error('rpc down'));
    h.service.markDirty(CHAIN, Array.from({ length: 3000 }, (_, i) => String(100_000 + i)), PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidatesByIds).toHaveBeenCalledTimes(1);
    expect(r.unanswered).toBe(1000);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(3000);
  });

  it('a pass that finishes mid-tick releases the side share: the side lanes get the rest of the tick', async () => {
    const h = makeHarness({ rows: universe(500), config: { ...ALL_ONLY, positionFeeMaxPerTick: 3000 } });
    h.service.markDirty(CHAIN, Array.from({ length: 2500 }, (_, i) => String(100_000 + i)), PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.finished).toEqual(['all']);
    expect(r.tiers).toMatchObject({ all: 500, dirty: 2500 });
  });

  it('while a pass is due, the side lanes take no more wall time than the pass', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const rows = universe(6000);
    const tierSalts = new Set(rows.map((r) => positionSalt(r.c.tokenId)));
    const h = makeHarness({
      rows,
      config: { ...ALL_ONLY, positionFeeMaxPerTick: 6000, positionFeeBatchSize: 200, positionFeeConcurrency: 1 },
      respond: (c) => {
        // A side batch (never-measured backfill rows: ~all served writes) costs 8 s; a tier batch 0.2 s.
        vi.setSystemTime(Date.now() + (tierSalts.has(String(c[1]!.args[4])) ? 200 : 8_000));
        return c.map(successFor);
      },
    });
    h.service.markDirty(CHAIN, Array.from({ length: 3000 }, (_, i) => String(100_000 + i)), PROTO, undefined, { lane: 'backfill' });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    // One drain at the start (40 s); the pass then has the rest of the tick:
    // its 5000 rows take 5 s, never catching up, so no further drain.
    expect(r.tiers).toMatchObject({ backfill: 1000, all: 5000 });
    expect(h.service.backfillSize(CHAIN, PROTO)).toBe(2000);
  });
});

describe('the write gate: one scheduler', () => {
  it('a chunk held back by the served bucket does not leave credit for a later plain chunk (no bunching)', async () => {
    // Both arrive at t = 0; the clock stands still while they wait.
    const gate = new FeeWriteGate(() => ({ all: 40, served: 25 }), () => 0, async () => undefined);
    const [a, b] = await Promise.all([gate.acquire(100, 100), gate.acquire(60, 0)]);
    expect(a).toBe(3000); // 100 served writes at 25/s, from one second of credit
    expect(b).toBe(4500); // 60 more at 40/s AFTER A went out — not at 3000 alongside it
  });

  it('consecutive sends are spaced by at least each chunk’s own cost at the all-writes rate', async () => {
    const gate = new FeeWriteGate(() => ({ all: 40, served: 25 }), () => 0, async () => undefined);
    const chunks = Array.from({ length: 30 }, (_, i) => ({ n: 20 + ((i * 37) % 81), s: i % 3 === 0 ? 50 : i % 3 === 1 ? 0 : 10 }));
    const sends = await Promise.all(chunks.map((c) => gate.acquire(c.n, Math.min(c.s, c.n))));
    for (let i = 1; i < sends.length; i++) expect(sends[i]! - sends[i - 1]!).toBeGreaterThanOrEqual(Math.floor((chunks[i]!.n / 40) * 1000));
  });

  it(`holds the backfill lane to ${BACKFILL_WRITE_SHARE * 100}% of both rates, still counting against the shared buckets`, async () => {
    const gate = new FeeWriteGate(() => ({ all: 40, served: 25 }), () => 0, async () => undefined);
    expect(await gate.acquire(100, 100, 'backfill')).toBe(7000); // 100 at 12.5/s served, from one second of credit
    // A main chunk queued after it waits for the shared buckets it used.
    expect(await gate.acquire(40, 0)).toBe(8000);
    const main = new FeeWriteGate(() => ({ all: 40, served: 25 }), () => 0, async () => undefined);
    expect(await main.acquire(100, 100)).toBe(3000);
  });
});

describe('the stamp-only fallback is paced before it is sent', () => {
  it('the service hands the repository a driver timeout and a fallback hook that waits on the gate', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    const acquire = vi.spyOn(internals(h.service).writeGate, 'acquire');
    h.positions.writeRpcFees.mockImplementationOnce(async (_c: number, _p: string, w: unknown[], _at: Date, opts: { timeoutMs?: number; beforeFallback?: (n: number) => Promise<void> }) => {
      expect(opts.timeoutMs).toBe(60_000);
      await opts.beforeFallback!(1);
      return { matched: w.length, modified: w.length, served: 0 };
    });
    h.service.markDirty(CHAIN, ['9'], PROTO);
    await h.service.refreshChain(CHAIN, PROTO);
    expect(acquire.mock.calls).toEqual([
      [1, 1, 'main'],
      [1, 0, 'main'],
    ]);
  });
});

describe('the write-gate report', () => {
  it('one line per window when writes waited; a warning when they waited longer than the window', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = makeHarness({ config: { positionFeeMaxWritesPerSec: 40, positionFeeMaxServedWritesPerSec: 25 } });
    const s = internals(h.service);
    s.reportGate(); // opens the window
    s.writeGate.waitedMs += 30_000;
    vi.setSystemTime(Date.now() + GATE_REPORT_MS - 1);
    s.reportGate();
    expect(h.log).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    s.reportGate();
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/write gate: chunks waited 30s in total over the last 10 min \(5% of wall time.*all=40\/s served=25\/s/));
    s.writeGate.waitedMs += GATE_REPORT_MS + 60_000;
    vi.setSystemTime(Date.now() + GATE_REPORT_MS);
    s.reportGate();
    expect(h.warnings().find((w) => w.includes('write gate'))).toMatch(/saturated/);
    // A quiet window says nothing.
    vi.setSystemTime(Date.now() + GATE_REPORT_MS);
    h.log.mockClear();
    h.warn.mockClear();
    s.reportGate();
    expect(h.log).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });
});
