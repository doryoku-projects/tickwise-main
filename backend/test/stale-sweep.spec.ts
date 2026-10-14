/*
 * The refresh's stale sweep, bounded (2026-10-03).
 *
 * It used to be ONE `updateMany` with every seen id in a `$nin` — past the
 * 16 MB BSON limit at ~800k actives — plus a `staleMisses >= max` updateMany
 * that fetched every active document. Now the active ids stream through a
 * covered, hinted query and are diffed in Node; misses are updated in `$in`
 * chunks of at most 500, the close step on the same chunk.
 */
import { describe, expect, it, vi } from 'vitest';
import { PositionsRepository, STALE_SWEEP_CHUNK } from '../src/database/positions.repository.js';
import { USER_READ_PREFERENCE } from '../src/database/user-read.js';

interface Row {
  positionId: string;
  isActive: boolean;
  staleMisses: number;
}

function shard(rows: Row[], opts: { hintMissing?: boolean } = {}) {
  const finds: Array<{ filter: unknown; projection: unknown; hint?: string; read?: unknown; batchSize?: number }> = [];
  const updates: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const model = {
    find: vi.fn((filter: unknown, projection: unknown) => {
      const call: (typeof finds)[number] = { filter, projection };
      finds.push(call);
      const q = {
        read: (rp: unknown) => ((call.read = rp), q),
        hint: (h: string) => ((call.hint = h), q),
        lean: () => q,
        cursor: ({ batchSize }: { batchSize: number }) => {
          call.batchSize = batchSize;
          const snapshot = rows.filter((r) => r.isActive).map((r) => ({ positionId: r.positionId }));
          return {
            async *[Symbol.asyncIterator]() {
              if (opts.hintMissing && call.hint) {
                throw Object.assign(new Error('hint provided does not correspond to an existing index'), {
                  code: 2,
                  codeName: 'BadValue',
                });
              }
              yield* snapshot;
            },
          };
        },
      };
      return q;
    }),
    updateMany: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      updates.push({ filter, update });
      const ids = new Set(((filter.positionId as { $in?: string[] })?.$in ?? []) as string[]);
      const min = (filter.staleMisses as { $gte?: number } | undefined)?.$gte;
      let modified = 0;
      for (const r of rows) {
        if (!ids.has(r.positionId) || r.isActive !== true) continue;
        if (min !== undefined && r.staleMisses < min) continue;
        const inc = (update.$inc as { staleMisses?: number } | undefined)?.staleMisses;
        if (inc) r.staleMisses += inc;
        if ((update.$set as { isActive?: boolean } | undefined)?.isActive === false) r.isActive = false;
        modified += 1;
      }
      return { modifiedCount: modified, matchedCount: modified };
    }),
  };
  const repo = new PositionsRepository({ positionModel: () => model } as never);
  return { repo, model, finds, updates };
}

const actives = (n: number, misses = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ positionId: String(1000 + i), isActive: true, staleMisses: misses }));

describe('markMissingStale', () => {
  it('streams the active ids through a covered, hinted read on a secondary', async () => {
    const { repo, finds } = shard(actives(10));

    await repo.markMissingStale(1, 'uniswap-v4', new Set(['1000']), 3);

    expect(finds).toHaveLength(1);
    expect(finds[0]).toMatchObject({
      // Exactly `isActive: true`: the partial index qualifies only for it.
      filter: { chainId: 1, protocol: 'uniswap-v4', isActive: true },
      // positionId only, no _id → answered from the index keys (covered).
      projection: { _id: 0, positionId: 1 },
      hint: 'bg_active_walk',
      read: USER_READ_PREFERENCE,
    });
    expect(finds[0]!.batchSize).toBeGreaterThan(0);
  });

  it('increments ONLY the ids the refresh did not see, in $in chunks of at most 500 — never a $nin', async () => {
    const rows = actives(1234);
    const seen = new Set(rows.slice(0, 100).map((r) => r.positionId));
    const { repo, updates } = shard(rows);

    await repo.markMissingStale(1, 'uniswap-v4', seen, 3);

    const incs = updates.filter((u) => u.update.$inc);
    expect(incs.map((u) => (u.filter.positionId as { $in: string[] }).$in.length)).toEqual([500, 500, 134]);
    expect(STALE_SWEEP_CHUNK).toBe(500);
    for (const u of updates) {
      expect(JSON.stringify(u.filter)).not.toContain('$nin');
      expect(u.filter).toMatchObject({ chainId: 1, protocol: 'uniswap-v4', isActive: true });
      expect((u.filter.positionId as { $in: string[] }).$in.length).toBeLessThanOrEqual(500);
    }
    expect(rows.slice(0, 100).every((r) => r.staleMisses === 0)).toBe(true);
    expect(rows.slice(100).every((r) => r.staleMisses === 1)).toBe(true);
  });

  it('closes a missed row that reaches the threshold, and only that one; returns how many it closed', async () => {
    const rows: Row[] = [
      { positionId: '1', isActive: true, staleMisses: 0 }, // seen
      { positionId: '2', isActive: true, staleMisses: 2 }, // third miss → closed
      { positionId: '3', isActive: true, staleMisses: 0 }, // first miss
      { positionId: '4', isActive: true, staleMisses: 2 }, // seen: never closed, whatever its count
    ];
    const { repo, updates } = shard(rows);

    const closed = await repo.markMissingStale(1, 'uniswap-v4', new Set(['1', '4']), 3);

    expect(closed).toBe(1);
    expect(rows.map((r) => [r.positionId, r.isActive, r.staleMisses])).toEqual([
      ['1', true, 0],
      ['2', false, 3],
      ['3', true, 1],
      ['4', true, 2],
    ]);
    // The close step is bounded to the chunk it just moved.
    const close = updates.find((u) => (u.update.$set as { isActive?: boolean })?.isActive === false)!;
    expect(close.filter).toMatchObject({ isActive: true, staleMisses: { $gte: 3 }, positionId: { $in: ['2', '3'] } });
    expect(close.update).toMatchObject({ $set: { txSyncStatus: 'pending' }, $unset: { txFinalizedAt: '', txLastError: '' } });
  });

  it('does nothing when the refresh saw nothing', async () => {
    const { repo, model } = shard(actives(5));
    expect(await repo.markMissingStale(1, 'uniswap-v4', new Set(), 3)).toBe(0);
    expect(model.find).not.toHaveBeenCalled();
    expect(model.updateMany).not.toHaveBeenCalled();
  });

  it('writes nothing when every active row was seen', async () => {
    const rows = actives(20);
    const { repo, model } = shard(rows);
    await repo.markMissingStale(1, 'uniswap-v4', new Set(rows.map((r) => r.positionId)), 3);
    expect(model.updateMany).not.toHaveBeenCalled();
  });

  it('walks unhinted when the shard lacks bg_active_walk, counting each miss once', async () => {
    const rows = actives(3);
    const { repo, finds } = shard(rows, { hintMissing: true });

    await repo.markMissingStale(1, 'uniswap-v4', new Set(['1000']), 3);

    expect(finds.map((f) => f.hint)).toEqual(['bg_active_walk', undefined]);
    expect(rows.map((r) => r.staleMisses)).toEqual([0, 1, 1]);
  });
});
