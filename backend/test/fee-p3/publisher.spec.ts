/*
 * P3.3 writer hints (`fee-row-hint-publisher.ts`): leases off → straight into
 * this process's store; leases on → XADD batches with MAXLEN on redis-models;
 * a failed XADD bumps the loss counter on redis-state, and a failed INCR is
 * retried before the next publish; nothing at all unless memory candidates;
 * `onFeeReread` always reaches the fee job's backfill lane.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FeeRowHint } from '../../src/database/positions.repository.js';
import {
  FeeRowHintPublisher,
  HINTS_PER_ENTRY,
  HINT_STREAM_MAXLEN,
  decodeEntry,
  decodeHint,
  encodeHint,
  hintLossKey,
  hintStreamKey,
  type FeeHintSink,
} from '../../src/sync/fee-row-hint-publisher.js';
import type { FeeCoordination } from '../../src/sync/fee-signals.js';
import { FakeFeeRedis } from './fake-redis.js';

const CHAIN = 4663;
const PROTO = 'uniswap-v4';

const full: FeeRowHint = {
  positionId: '42',
  isActive: true,
  wAt: 1_700_000_000_123,
  tokenId: '42',
  poolId: `0x${'cd'.repeat(32)}`,
  tickLower: -887220,
  tickUpper: 887220,
  lastModifyBlock: 123456,
  decimals0: 6,
  decimals1: 18,
  price0: 1.0001,
  price1: 2512.5,
  isPriceable: true,
  feesSource: 'onchain',
  pendingFeesUsd: 12.75,
  rpc: { fees0: '1.25', fees1: '0.0001', block: 123460, at: new Date(1_700_000_000_000) },
};

function sink(): FeeHintSink & { applied: FeeRowHint[][]; marks: unknown[][] } {
  const s = {
    applied: [] as FeeRowHint[][],
    marks: [] as unknown[][],
    applyHints: (_c: number, _p: string, rows: readonly FeeRowHint[]) => void s.applied.push([...rows]),
    markDirty: (...a: unknown[]) => void s.marks.push(a),
  };
  return s;
}

describe('hint encoding', () => {
  it('round-trips every field (closures carry only id, isActive, wAt)', () => {
    expect(decodeHint(JSON.parse(JSON.stringify(encodeHint(full))))).toEqual(full);
    const closure: FeeRowHint = { positionId: '9', isActive: false, wAt: 5 };
    expect(decodeHint(JSON.parse(JSON.stringify(encodeHint(closure))))).toEqual(closure);
    expect(JSON.stringify(encodeHint(full)).length).toBeLessThan(400);
  });

  it('malformed entries are skipped, not thrown', () => {
    expect(decodeHint(null)).toBeUndefined();
    expect(decodeHint({ p: 1, w: 1 })).toBeUndefined();
    expect(decodeEntry(['h', 'not json', 'h', JSON.stringify([encodeHint(full), { bad: true }])])).toEqual([full]);
  });
});

describe('FeeRowHintPublisher', () => {
  it('nothing unless POSITION_FEE_CANDIDATES=memory', () => {
    const p = new FeeRowHintPublisher({} as never);
    const s = sink();
    p.attach(s);
    p.onWritten(CHAIN, PROTO, [full]);
    expect(s.applied).toEqual([]);
  });

  it('leases off: straight into the local store, synchronously', () => {
    const p = new FeeRowHintPublisher({ positionFeeCandidates: 'memory' } as never);
    const s = sink();
    p.attach(s);
    p.onWritten(CHAIN, PROTO, [full]);
    expect(s.applied).toEqual([[full]]);
  });

  it('onFeeReread always queues the backfill lane (a re-read request, not a hint)', () => {
    const p = new FeeRowHintPublisher({} as never);
    const s = sink();
    p.attach(s);
    p.onFeeReread(CHAIN, PROTO, ['1', '2']);
    expect(s.marks).toEqual([[CHAIN, ['1', '2'], PROTO, undefined, { lane: 'backfill' }]]);
  });

  describe('leases on', () => {
    function setup() {
      const models = new FakeFeeRedis();
      const state = new FakeFeeRedis();
      const coord: FeeCoordination = { leasesEnabled: true, namespace: 'ns', modelsRedis: async () => models, stateRedis: async () => state };
      const p = new FeeRowHintPublisher({ positionFeeCandidates: 'memory' } as never, coord);
      const s = sink();
      p.attach(s);
      return { models, state, p, s };
    }

    it('XADDs batches of ≤ HINTS_PER_ENTRY rows with MAXLEN ~, nothing applied locally', async () => {
      const { models, p, s } = setup();
      const rows = Array.from({ length: 2 * HINTS_PER_ENTRY + 3 }, (_, i) => ({ ...full, positionId: String(i), tokenId: String(i) }));
      await p.publish(CHAIN, PROTO, rows);
      const xadds = models.calls.filter((c) => c === 'xadd');
      expect(xadds).toHaveLength(3);
      const entries = await models.xrange(hintStreamKey('ns', CHAIN, PROTO), '-', '+', 'COUNT', 10);
      expect(entries.flatMap(([, f]) => decodeEntry(f))).toEqual(rows);
      expect(s.applied).toEqual([]);
      expect(HINT_STREAM_MAXLEN * HINTS_PER_ENTRY).toBeGreaterThanOrEqual(20_000);
    });

    it('onWritten never awaits nor throws (the writer is synchronous)', () => {
      const { p, models } = setup();
      models.failing = true;
      expect(() => p.onWritten(CHAIN, PROTO, [full])).not.toThrow();
    });

    it('a failed XADD bumps the loss counter on redis-state', async () => {
      const { models, state, p } = setup();
      models.failing = true;
      await p.publish(CHAIN, PROTO, [full]);
      expect(await state.get(hintLossKey('ns', CHAIN, PROTO))).toBe('1');
      expect(p.stats.failed).toBe(1);
    });

    it('a failed INCR too: retried before the next publish lands', async () => {
      const { models, state, p } = setup();
      models.failing = true;
      state.failing = true;
      await p.publish(CHAIN, PROTO, [full]);
      expect(p.stats.lossIncrements).toBe(0);
      models.failing = false;
      state.failing = false;
      await p.publish(CHAIN, PROTO, [full]);
      expect(await state.get(hintLossKey('ns', CHAIN, PROTO))).toBe('1');
      await p.publish(CHAIN, PROTO, [full]);
      expect(await state.get(hintLossKey('ns', CHAIN, PROTO))).toBe('1');
    });
  });

  it('a hint-free service: attach is optional (no sink, nothing breaks)', () => {
    const p = new FeeRowHintPublisher({ positionFeeCandidates: 'memory' } as never);
    expect(() => p.onWritten(CHAIN, PROTO, [full])).not.toThrow();
    expect(() => p.onFeeReread(CHAIN, PROTO, ['1'])).not.toThrow();
    void vi;
  });
});
