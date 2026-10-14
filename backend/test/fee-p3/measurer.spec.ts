/*
 * P3.2 measurement (`fee-measurer.ts`): per-chain batch and concurrency, the
 * process-wide in-flight ceiling, one head per page vs per batch,
 * `budgetedFetch` wired as viem's fetchFn (every attempt, retries included),
 * the P3.1 PageFeeReader and the gas-split alert; plus the settings reader
 * whose every default is today's behaviour.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import {
  FeeMeasurer,
  InFlightGate,
  batchSizeFor,
  concurrencyFor,
  resolveFeeP3Settings,
  type FeeP3Settings,
} from '../../src/sync/fee-measurer.js';
import { CHAIN, POOL, Q128, fakeClient, successFor, type FakeCall } from '../fee-refresh-harness.js';

function rows(n: number, over: Partial<{ lastModifyBlock: number; decimals0: number }> = {}) {
  return Array.from({ length: n }, (_, i) => ({
    positionId: String(10 + i),
    tokenId: String(10 + i),
    poolId: POOL,
    tickLower: -600,
    tickUpper: 600,
    decimals0: 6,
    decimals1: 6,
    lastModifyBlock: 0,
    ...over,
  }));
}

function measurer(settings: Partial<FeeP3Settings>, client: ReturnType<typeof fakeClient>['client'], extra: Record<string, unknown> = {}) {
  const config = { evmRpcUrls: new Map([[CHAIN, 'http://rpc.local']]), positionFeeBatchSize: 2, positionFeeConcurrency: 2, ...extra };
  const warn = vi.fn();
  const m = new FeeMeasurer(config as never, undefined, {
    client: () => client as unknown as PublicClient,
    delay: async () => undefined,
    logger: { warn, log: vi.fn(), debug: vi.fn() },
    settings: () => ({ ...resolveFeeP3Settings(config), ...settings }),
  });
  return { m, warn };
}

describe('settings: every default is today', () => {
  it('no P3 getters → batch/concurrency are the globals, head per batch, round budget, mongo candidates, auto signals', () => {
    const s = resolveFeeP3Settings({ positionFeeBatchSize: 200, positionFeeConcurrency: 8 });
    expect(s).toMatchObject({
      batchSize: 200,
      concurrency: 8,
      maxInFlight: 64,
      headPer: 'batch',
      budget: 'round',
      passTargetMs: 480_000,
      candidates: 'mongo',
      loadDocsPerSec: 5_000,
      reconcileMs: 21_600_000,
      reconcileDocsPerSec: 3_000,
      signalsTransport: 'auto',
    });
    expect(s.batchByChain.size).toBe(0);
    expect(batchSizeFor(s, 1)).toBe(200);
    expect(concurrencyFor(s, 4663)).toBe(8);
  });

  it('garbage reads as the default; paces are clamped to their Zod ceilings', () => {
    const s = resolveFeeP3Settings({
      positionFeeHeadPer: 'sometimes',
      positionFeeBudget: 42,
      positionFeeLoadDocsPerSec: 99_999,
      positionFeeReconcileDocsPerSec: 99_999,
      positionFeeCandidates: 'disk',
      positionFeeBatchSizeByChain: '1:400,4663:32,bad,7:0,8:9999',
      positionFeeConcurrencyByChain: new Map([[4663, 80]]),
    });
    expect(s.headPer).toBe('batch');
    expect(s.budget).toBe('round');
    expect(s.candidates).toBe('mongo');
    expect(s.loadDocsPerSec).toBe(8_000);
    expect(s.reconcileDocsPerSec).toBe(5_000);
    expect([...s.batchByChain]).toEqual([
      [1, 400],
      [4663, 32],
      [8, 500],
    ]);
    expect(concurrencyFor(s, 4663)).toBe(64);
  });
});

describe('FeeMeasurer', () => {
  it('head per BATCH (default): one eth_blockNumber per batch, each multicall pinned to its own', async () => {
    const { client, calls } = fakeClient([100, 101, 102, 103]);
    const { m } = measurer({}, client);
    const out = await m.measureRows(CHAIN, rows(6));
    expect(out.rows).toHaveLength(6);
    expect(client.getBlockNumber).toHaveBeenCalledTimes(3);
    expect(new Set(calls.map((c) => c.blockNumber))).toEqual(new Set([100n, 101n, 102n]));
    expect(m.stats(CHAIN).heads).toBe(3);
  });

  it('head per PAGE: ONE eth_blockNumber, every batch of the page pinned to it', async () => {
    const { client, calls } = fakeClient([500, 501, 502]);
    const { m } = measurer({ headPer: 'page' }, client);
    const out = await m.measureRows(CHAIN, rows(7));
    expect(out.rows).toHaveLength(7);
    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.blockNumber === 500n)).toBe(true);
    expect(out.rows.every((r) => r.block === 500)).toBe(true);
  });

  it('head per page: an unreadable head leaves the whole page unanswered (no multicall)', async () => {
    const { client, calls } = fakeClient([1]);
    client.getBlockNumber.mockRejectedValue(new Error('fetch failed'));
    const { m } = measurer({ headPer: 'page' }, client);
    const out = await m.measureRows(CHAIN, rows(4));
    expect(out.unanswered).toHaveLength(4);
    expect(calls).toHaveLength(0);
  });

  it('per-chain batch and concurrency override the globals for that chain only', async () => {
    let active = 0;
    let peak = 0;
    const { client, calls } = fakeClient([1], async (contracts) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return contracts.map(successFor);
    });
    const { m } = measurer({ batchByChain: new Map([[CHAIN, 3]]), concurrencyByChain: new Map([[CHAIN, 4]]) }, client);
    await m.measureRows(CHAIN, rows(24));
    expect(calls.map((c) => c.salts.length)).toEqual(Array(8).fill(3));
    expect(peak).toBe(4);
  });

  it('the process-wide in-flight ceiling holds across chains and measurers', async () => {
    let active = 0;
    let peak = 0;
    const respond = async (contracts: FakeCall[]) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return contracts.map(successFor);
    };
    const a = fakeClient([1], respond);
    const b = fakeClient([1], respond);
    const ma = measurer({ concurrency: 8, maxInFlight: 3 }, a.client).m;
    const mb = measurer({ concurrency: 8, maxInFlight: 3 }, b.client, { evmRpcUrls: new Map([[CHAIN, 'x']]) }).m;
    await Promise.all([ma.measureRows(CHAIN, rows(16)), mb.measureRows(CHAIN, rows(16))]);
    expect(peak).toBe(3);
  });

  it('InFlightGate: FIFO hand-off, never above the limit, idempotent release', async () => {
    const gate = new InFlightGate(() => 2);
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    let third = false;
    const p = gate.acquire().then((r) => {
      third = true;
      return r;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    r1();
    r1();
    const r3 = await p;
    expect(gate.inFlight).toBe(2);
    r2();
    r3();
    expect(gate.inFlight).toBe(0);
    expect(gate.peak).toBe(2);
  });

  it('records the batch latency (EWMA + p95) of answered depth-0 batches', async () => {
    const { client } = fakeClient([1], async (contracts) => {
      await new Promise((r) => setTimeout(r, 20));
      return contracts.map(successFor);
    });
    const { m } = measurer({}, client);
    await m.measureRows(CHAIN, rows(4));
    const st = m.stats(CHAIN);
    expect(st.batches).toBe(2);
    expect(st.latencyEwmaMs).toBeGreaterThanOrEqual(15);
    expect(st.latencyP95Ms).toBeGreaterThanOrEqual(15);
    expect(st.batchSize).toBe(2);
  });

  it('a gas-cut tail is split and raises ONE [alert] fees.gas_split per chain per window', async () => {
    const { client } = fakeClient([1], (contracts, _b, n) =>
      n === 0 ? contracts.map((c, i) => (i < 2 ? successFor(c) : { status: 'failure', error: new Error(`out of gas #${i}`) })) : contracts.map(successFor),
    );
    const { m, warn } = measurer({ batchSize: 4 }, client);
    const out = await m.measureRows(CHAIN, rows(4));
    expect(out.rows).toHaveLength(4);
    expect(m.stats(CHAIN).gasSplits).toBe(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[alert] fees.gas_split'))).toHaveLength(1);
  });

  it('PageFeeReader.measure (P3.1): fees per measured row; stale, reverted and non-v4 rows absent', async () => {
    const { client } = fakeClient([1000], (contracts) =>
      contracts.map((c, i) => (i === 2 || i === 3 ? { status: 'failure', error: new Error(`reverted #${i}`) } : successFor(c))),
    );
    const { m } = measurer({ batchSize: 10 }, client);
    const input = [...rows(3), { ...rows(1)[0]!, positionId: '99', tokenId: '99', lastModifyBlock: 2000 }];
    const got = await m.measure(CHAIN, 'uniswap-v4', input);
    // Row 11 reverted (calls 2,3); row 99's modify (2000) post-dates the reading (1000).
    expect([...got.keys()]).toEqual(['10', '12']);
    expect(got.get('10')).toMatchObject({ fees0: 2, fees1: 3, block: 1000 });
    expect(got.get('10')!.at).toBeInstanceOf(Date);
    expect(await m.measure(CHAIN, 'uniswap-v3', input)).toEqual(new Map());
    expect(await m.measure(1, 'uniswap-v4', input)).toEqual(new Map());
  });

  it('PageFeeReader.measure reads on the BACKFILL lane; the fee ticks on the FEE lane', async () => {
    const { client } = fakeClient([1]);
    const lanes: string[] = [];
    const config = { evmRpcUrls: new Map([[CHAIN, 'http://rpc.local']]), positionFeeBatchSize: 10, positionFeeConcurrency: 1 };
    const m = new FeeMeasurer(config as never, undefined, {
      client: (_c, lane) => {
        lanes.push(lane);
        return client as unknown as PublicClient;
      },
    });
    await m.measure(CHAIN, 'uniswap-v4', rows(2));
    await m.measureRows(CHAIN, rows(2));
    expect(lanes).toEqual(['backfill', 'fee']);
  });

  it('budgetedFetch: every HTTP attempt — the retry included — goes through the factory fetchFn, per lane', async () => {
    const seen: Array<{ lane: string; method: string }> = [];
    const factory = vi.fn((url: string, lane: string) => {
      expect(url).toBe('http://rpc.local');
      return (async (_input: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
        seen.push({ lane, method: String(body.method) });
        return new Response('rate limited', { status: 429 });
      }) as unknown as typeof fetch;
    });
    const config = { evmRpcUrls: new Map([[CHAIN, 'http://rpc.local']]), positionFeeBatchSize: 10, positionFeeConcurrency: 1 };
    const m = new FeeMeasurer(config as never, factory as never, { delay: async () => undefined, logger: { warn: vi.fn(), log: vi.fn(), debug: vi.fn() } });
    const got = await m.measure(CHAIN, 'uniswap-v4', rows(2));
    expect(got.size).toBe(0);
    expect(factory).toHaveBeenCalledWith('http://rpc.local', 'backfill', CHAIN);
    // eth_blockNumber twice (our retry) × viem's retryCount 1 = 4 attempts, all counted.
    expect(seen.filter((s) => s.method === 'eth_blockNumber')).toHaveLength(4);
    expect(seen.every((s) => s.lane === 'backfill')).toBe(true);
    expect(m.rpcBatchFailures(CHAIN)).toBe(2);
  }, 20_000);

  it('owed fees decode exactly as before (interleaved calls, decimals applied)', async () => {
    const { client } = fakeClient([7], (contracts) =>
      contracts.map((c) =>
        c.functionName === 'getFeeGrowthInside'
          ? { status: 'success', result: [5n * Q128, 7n * Q128] }
          : { status: 'success', result: [1_000_000n, 1n * Q128, 2n * Q128] },
      ),
    );
    const { m } = measurer({}, client);
    const out = await m.measureRows(CHAIN, rows(1));
    expect(out.rows[0]).toMatchObject({ fees0: '4', fees1: '5', block: 7 });
  });
});
