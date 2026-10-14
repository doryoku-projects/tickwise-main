import { describe, expect, it, vi } from 'vitest';
import {
  PositionsRepository,
  positionWriteInvariantViolations,
  RANKED_NUMERIC_FIELDS,
} from '../src/database/positions.repository.js';

/**
 * Scale plan 1.10: the write-time invariants every exact read path rests on —
 * finite ranked numbers, a boolean `isActive`, and `tokenId === positionId` as
 * a canonical decimal — checked on every position write, with an `[alert]` on
 * violation (and the row written as it is: the alert is the point).
 */

const good = () => ({
  positionId: '424242',
  tokenId: '424242',
  isActive: true,
  createdAtTimestamp: 1_759_000_000,
  metrics: { aprExGas: 1.5, feeApr: 0, roi: -0.2, poolPnlUsd: 12, underlyingValueUsd: 7_850.5 },
});

describe('positionWriteInvariantViolations', () => {
  it('a sound document breaks nothing', () => {
    expect(positionWriteInvariantViolations(good())).toEqual([]);
    expect(positionWriteInvariantViolations({ ...good(), positionId: '0', tokenId: '0' })).toEqual([]);
  });

  it('every ranked numeric field must be a FINITE number (NaN, ±Infinity, null, missing, a string)', () => {
    expect(RANKED_NUMERIC_FIELDS).toEqual([
      'metrics.aprExGas',
      'metrics.feeApr',
      'metrics.roi',
      'metrics.poolPnlUsd',
      'metrics.underlyingValueUsd',
      'createdAtTimestamp',
    ]);
    const doc = good();
    doc.metrics.aprExGas = NaN;
    doc.metrics.roi = Infinity;
    doc.metrics.poolPnlUsd = -Infinity;
    (doc.metrics as Record<string, unknown>).feeApr = null;
    delete (doc.metrics as Record<string, unknown>).underlyingValueUsd;
    (doc as Record<string, unknown>).createdAtTimestamp = '1759000000';
    expect(positionWriteInvariantViolations(doc)).toEqual([
      'metrics.aprExGas:NaN',
      'metrics.feeApr:null',
      'metrics.roi:Infinity',
      'metrics.poolPnlUsd:-Infinity',
      'metrics.underlyingValueUsd:undefined',
      'createdAtTimestamp:string(1759000000)',
    ]);
  });

  it('isActive must be a boolean — the rate sorts and every bg_* reader match `isActive: true` exactly', () => {
    for (const isActive of [1, 'true', null, undefined]) {
      expect(positionWriteInvariantViolations({ ...good(), isActive })).toHaveLength(1);
    }
    expect(positionWriteInvariantViolations({ ...good(), isActive: false })).toEqual([]);
  });

  it('positionId is a canonical decimal and tokenId equals it', () => {
    expect(positionWriteInvariantViolations({ ...good(), positionId: '0424242', tokenId: '0424242' })).toEqual(['positionId:string(0424242)']);
    expect(positionWriteInvariantViolations({ ...good(), positionId: '-1', tokenId: '-1' })).toEqual(['positionId:string(-1)']);
    expect(positionWriteInvariantViolations({ ...good(), positionId: '0x1f', tokenId: '0x1f' })).toEqual(['positionId:string(0x1f)']);
    expect(positionWriteInvariantViolations({ ...good(), positionId: 424242, tokenId: 424242 })).toEqual(['positionId:number(424242)']);
    expect(positionWriteInvariantViolations({ ...good(), tokenId: '424243' })).toEqual(['tokenId≠positionId']);
  });
});

describe('upsertMany checks every row it writes', () => {
  const position = (over: Record<string, unknown> = {}) => ({
    chainId: 1,
    protocol: 'uniswap-v4',
    ...good(),
    token0: { address: '0xa', priceUsd: 1, verified: true },
    token1: { address: '0xb', priceUsd: 1, verified: true },
    amounts: {},
    ...over,
  });

  function repoWithLog() {
    const bulkWrite = vi.fn(async (ops: unknown[]) => ({ upsertedCount: ops.length, modifiedCount: 0 }));
    const model = { find: () => ({ lean: async () => [] }), bulkWrite };
    const repo = new PositionsRepository({ positionModel: () => model } as never, {} as never);
    const warn = vi.fn();
    (repo as unknown as { logger: unknown }).logger = { warn, log: vi.fn(), debug: vi.fn() };
    return { repo, warn, bulkWrite };
  }

  it('alerts once per shard per minute, naming each broken rule with a count and a sample — and still writes the rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { repo, warn, bulkWrite } = repoWithLog();
      const rows = [
        position(),
        position({ positionId: '7', tokenId: '8' }),
        position({ positionId: '9', tokenId: '9', isActive: 'yes' }),
        position({ positionId: '10', tokenId: '10', metrics: { ...good().metrics, aprExGas: NaN } }),
        position({ positionId: '11', tokenId: '11', metrics: { ...good().metrics, aprExGas: NaN } }),
      ];
      await repo.upsertMany(rows as never);
      expect(bulkWrite.mock.calls[0]![0]).toHaveLength(5); // alert only: nothing is dropped
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain('[alert] positions.write_invariant chain=1 protocol=uniswap-v4');
      expect(line).toContain('tokenId≠positionId×1(e.g. 7)');
      expect(line).toContain('isActive:string(yes)×1(e.g. 9)');
      expect(line).toContain('metrics.aprExGas:NaN×2(e.g. 10)');
      await repo.upsertMany(rows as never);
      expect(warn).toHaveBeenCalledTimes(1); // within the minute: quiet
      vi.setSystemTime(Date.now() + 61_000);
      await repo.upsertMany(rows as never);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a clean flush logs nothing', async () => {
    const { repo, warn } = repoWithLog();
    await repo.upsertMany([position(), position({ positionId: '5', tokenId: '5', isActive: false })] as never);
    expect(warn).not.toHaveBeenCalled();
  });
});
