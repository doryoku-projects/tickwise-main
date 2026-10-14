/*
 * API_READ_SHARE: keyless /api reads may take at most that share of the global
 * read budget, so they cannot starve /v1 customers or the sync. A read is
 * keyless when ApiLimitService marked its request (`stats.keyless`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetReadPathMeter } from '../../src/common/cache/read-path-meter.js';
import { ReadBudgetService, ReadBudgetTimeoutError } from '../../src/common/read-budget.js';
import { runInLane, type IndexerRequestStats } from '../../src/subgraph/hyperindex/indexer-context.js';

function clock(start = 0) {
  const state = { now: start, slept: [] as number[] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number) => {
      state.slept.push(ms);
      state.now += ms;
    },
  };
}

const config = (over: Record<string, unknown> = {}) => ({
  readBudgetDocsPerSec: 20_000,
  readBudgetBurstDocs: 20_000,
  leaderboardDeepWalkConcurrency: 2,
  apiReadShare: 0.5,
  ...over,
});

const keylessStats = (): IndexerRequestStats => ({ indexerMs: 0, indexerCalls: 0, queuedMs: 0, keyless: true });
const asKeyless = <T>(fn: () => Promise<T>) => runInLane({ lane: 'interactive', stats: keylessStats() }, fn);
const asKeyed = <T>(fn: () => Promise<T>) => runInLane({ lane: 'interactive', stats: { indexerMs: 0, indexerCalls: 0, queuedMs: 0 } }, fn);

beforeEach(() => resetReadPathMeter());

describe('API_READ_SHARE', () => {
  it('lets a keyless read take half the bucket at once, then makes it wait at half the rate', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config() as never, undefined, c);
    await asKeyless(() => budget.reserve(10_000, { deadlineAt: 5_000, lane: 'deep' }));
    expect(c.state.slept).toEqual([]);
    // The keyless sub-bucket (10,000 deep, 10,000/s) is empty: 10,000 more is a 1 s wait.
    await asKeyless(() => budget.reserve(10_000, { deadlineAt: c.now() + 5_000, lane: 'deep' }));
    expect(c.state.slept).toEqual([1_000]);
  });

  it('leaves everything else the whole rate: a keyed read still takes the full bucket', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config() as never, undefined, c);
    await asKeyed(() => budget.reserve(20_000, { deadlineAt: 5_000, lane: 'deep' }));
    expect(c.state.slept).toEqual([]);
    // No request context at all (a sweep, a warmup): the same.
    const bare = new ReadBudgetService(config() as never, undefined, clock());
    await bare.reserve(20_000, { deadlineAt: 5_000, lane: 'deep' });
  });

  it('keyless reads that exhaust their share leave the shared bucket untouched', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config() as never, undefined, c);
    await asKeyless(() => budget.reserve(10_000, { deadlineAt: 5_000, lane: 'deep' }));
    // Past its share and its deadline: refused by the sub-bucket, nothing taken from the shared one.
    const err = await asKeyless(() => budget.reserve(10_000, { deadlineAt: c.now() + 100, lane: 'deep' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadBudgetTimeoutError);
    // The shared bucket still has the 10,000 the first read left, so a keyed read of that size waits for nothing.
    await asKeyed(() => budget.reserve(10_000, { deadlineAt: c.now() + 100, lane: 'deep' }));
    expect(c.state.slept).toEqual([]);
  });

  it('gives the sub-bucket its tokens back when the shared bucket refuses the read', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config() as never, undefined, c);
    await asKeyed(() => budget.reserve(20_000, { deadlineAt: 5_000, lane: 'deep' })); // the shared bucket is empty
    const err = await asKeyless(() => budget.reserve(5_000, { deadlineAt: c.now() + 10, lane: 'deep' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadBudgetTimeoutError);
    expect((budget as unknown as { localKeyless: { tokens: number } }).localKeyless.tokens).toBe(10_000);
  });

  it('charges a keyless read\'s debt against both buckets', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config() as never, undefined, c);
    await asKeyless(async () => budget.charge(10_000, 'count'));
    await new Promise<void>((resolve) => setImmediate(resolve)); // charge is fire-and-forget
    const state = budget as unknown as { local: { tokens: number }; localKeyless: { tokens: number } };
    expect(state.localKeyless.tokens).toBe(0);
    expect(state.local.tokens).toBe(10_000);
  });

  it('is off at 1, unset or garbage: a keyless read gets the whole bucket as before', async () => {
    for (const apiReadShare of [1, undefined, Number.NaN, 0, 5]) {
      const c = clock();
      const cfg = config({ apiReadShare }) as never as { apiReadShare?: number };
      // The getter's own rule (see AppConfigService.apiReadShare): only (0, 1) counts.
      const effective = typeof apiReadShare === 'number' && Number.isFinite(apiReadShare) && apiReadShare > 0 && apiReadShare < 1 ? apiReadShare : 1;
      cfg.apiReadShare = effective;
      const budget = new ReadBudgetService(cfg as never, undefined, c);
      await asKeyless(() => budget.reserve(20_000, { deadlineAt: 5_000, lane: 'deep' }));
      expect(c.state.slept, String(apiReadShare)).toEqual([]);
    }
  });
});
