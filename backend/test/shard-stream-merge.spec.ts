import { describe, expect, it, vi } from 'vitest';
import { PageLadderService } from '../src/common/cache/page-ladder.js';
import { compareSortValue } from '../src/common/shard-merge.js';
import {
  arraySource,
  fetchDeepPageDocs,
  LADDER_FLUSH_RUNGS,
  rowsAfter,
  seekSegments,
  segmentedSource,
  sortSpecComparator,
  streamMergePage,
  walkDeepPage,
  type DeepShard,
  type MergeSource,
  type SortBoundary,
  type SortSpec,
} from '../src/common/shard-stream-merge.js';
import { matches, miniModel, mongoCompare, mongoSort, prng, type Doc } from './support/mini-mongo.js';

/**
 * Exactness of the deep-page machinery against MongoDB's semantics (modelled
 * independently in `support/mini-mongo.ts`, as measured on the M10 rig).
 */

const CHAINS = [1, 4663, 42161];

const SPECS: Array<{ name: string; spec: SortSpec }> = [
  { name: 'rate sort: number desc, positionId asc (collated)', spec: { field: 'metrics.v', direction: -1, tieField: 'positionId', tieDirection: 1, collated: true } },
  { name: 'number asc, positionId asc (collated)', spec: { field: 'metrics.v', direction: 1, tieField: 'positionId', tieDirection: 1, collated: true } },
  { name: 'nft_id_desc: digit-string field desc, tie desc (collated)', spec: { field: 'tokenId', direction: -1, tieField: 'positionId', tieDirection: -1, collated: true } },
  { name: 'nft_id_asc: digit-string field asc, tie asc (collated)', spec: { field: 'tokenId', direction: 1, tieField: 'positionId', tieDirection: 1, collated: true } },
  { name: 'pools tvl: number desc, poolId asc (uncollated)', spec: { field: 'metrics.tvl', direction: -1, tieField: 'poolId', tieDirection: 1, collated: false } },
  { name: 'pools age: number asc, poolId asc (uncollated)', spec: { field: 'createdAtTimestamp', direction: 1, tieField: 'poolId', tieDirection: 1, collated: false } },
];

/** Every bracket a sort field can hold, with heavy ties. `undefined` = the field is missing. */
const VALUES: unknown[] = [undefined, null, NaN, -Infinity, Infinity, -1, 0, 0, 0.5, 2, 2, 2, 7, '9', '10', '10', '100', '2'];

function setPath(doc: Doc, path: string, value: unknown): void {
  if (value === undefined) return; // missing
  const keys = path.split('.');
  let target = doc;
  for (const key of keys.slice(0, -1)) {
    target[key] = (target[key] as Doc | undefined) ?? {};
    target = target[key] as Doc;
  }
  target[keys[keys.length - 1]!] = value;
}

function at(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => (cur && typeof cur === 'object' ? (cur as Doc)[key] : undefined), doc);
}

/** Per chain, `n` docs with ids unique on the chain but SHARED across chains (cross-chain ties). */
function dataset(spec: SortSpec, seed: number, n: number): Map<number, Doc[]> {
  const rand = prng(seed);
  const out = new Map<number, Doc[]>();
  for (const chainId of CHAINS) {
    const ids = new Set<string>();
    while (ids.size < n) ids.add(String(1 + Math.floor(rand() * n * 2)));
    const docs = [...ids].map((id) => {
      const doc: Doc = { chainId, [spec.tieField]: spec.tieField === 'poolId' ? id : id };
      setPath(doc, spec.field, VALUES[Math.floor(rand() * VALUES.length)]);
      return doc;
    });
    out.set(chainId, docs);
  }
  return out;
}

function sortSpec(spec: SortSpec): Record<string, 1 | -1> {
  return { [spec.field]: spec.direction, [spec.tieField]: spec.tieDirection };
}

/** The merged order, by MongoDB's own rules: each shard's sort, then chainId. */
function reference(spec: SortSpec, data: Map<number, Doc[]>): Doc[] {
  return [...data.values()].flat().sort((a, b) => {
    const byField = mongoCompare(at(a, spec.field), at(b, spec.field), spec.collated) * spec.direction;
    if (byField !== 0) return byField;
    const byId = mongoCompare(a[spec.tieField], b[spec.tieField], spec.collated) * spec.tieDirection;
    if (byId !== 0) return byId;
    return (a.chainId as number) - (b.chainId as number);
  });
}

const key = (doc: Doc, spec: SortSpec) => `${doc.chainId}:${String(doc[spec.tieField])}`;

/** A shard source that runs the real seek against the mini-mongo model. */
function mongoShard(spec: SortSpec, chainId: number, docs: Doc[], hooks: Parameters<typeof miniModel>[1] = {}): DeepShard<Doc> {
  const { model } = miniModel(docs, hooks);
  return {
    chainId,
    open: (boundary, needed) =>
      segmentedSource<Doc>(chainId, seekSegments(spec, boundary, chainId), needed, async (segment, limit) => {
        let q = model
          .find(segment ? { chainId, $and: [segment] } : { chainId })
          .select({ _id: 0, chainId: 1, [spec.tieField]: 1, [spec.field]: 1 })
          .sort(sortSpec(spec));
        if (spec.collated) q = (q as { collation: (c: unknown) => typeof q }).collation({ locale: 'en', numericOrdering: true });
        const cursor = (q as unknown as { limit: (n: number) => { lean: () => { cursor: () => { next(): Promise<Doc | null>; close(): Promise<unknown> } } } })
          .limit(limit)
          .lean()
          .cursor();
        return { cursor, first: await cursor.next() };
      }),
  };
}

describe('compareSortValue reproduces the order MongoDB 8.0 sorts mixed values in', () => {
  it('null = missing < NaN < -Infinity < numbers < +Infinity < strings (the A6 fix: +Infinity is the TOP)', () => {
    // Measured on m10-3 with $documents + $sort ascending.
    const verified = [null, undefined, NaN, -Infinity, -1, 0, 5, Infinity, '10', '9'];
    const shuffled = [5, '9', Infinity, null, 0, NaN, '10', -Infinity, undefined, -1];
    // Wrapped: Array#sort moves bare `undefined` elements to the end WITHOUT
    // calling the comparator, which would test JavaScript, not the comparator.
    const sorted = shuffled
      .map((v) => ({ v }))
      .sort((a, b) => compareSortValue(a.v, b.v, false) || (a.v === null ? -1 : b.v === null ? 1 : 0))
      .map((w) => w.v);
    expect(sorted.map(String)).toEqual(verified.map(String));
    // Collated, digit strings by magnitude ('9' < '10'), as numericOrdering does.
    expect(compareSortValue('9', '10', true)).toBe(-1);
    expect(compareSortValue('9', '10', false)).toBe(1);
    // +Infinity above every finite number, in both directions of a sort.
    expect(compareSortValue(Infinity, 1e308, true)).toBe(1);
    expect(compareSortValue(-Infinity, NaN, true)).toBe(1);
  });

  it('agrees with the independent mini-mongo comparator on every pair of bracket values', () => {
    for (const collated of [true, false]) {
      for (const a of VALUES) {
        for (const b of VALUES) {
          expect(Math.sign(compareSortValue(a, b, collated)), `${String(a)} vs ${String(b)}`).toBe(
            Math.sign(mongoCompare(a, b, collated)),
          );
        }
      }
    }
  });
});

describe('seekSegments filters survive Mongoose casting (the NaN 500 on the M10 rig)', () => {
  it('every bracket\'s segments cast through the real PositionSchema, NaN included', async () => {
    const mongoose = (await import('mongoose')).default;
    const { PositionSchema } = await import('../src/database/schemas/position.schema.js');
    const Model = mongoose.models.SeekCastProbe ?? mongoose.model('SeekCastProbe', PositionSchema);
    const spec: SortSpec = { field: 'metrics.poolPnlUsd', direction: -1, tieField: 'positionId', tieDirection: 1, collated: true };
    for (const value of [null, NaN, -Infinity, 5, Infinity]) {
      for (const chainId of [1, 43114]) {
        for (const segment of seekSegments(spec, { value, id: '42', chainId: 43114 }, chainId)) {
          expect(() => Model.find(segment ?? {}).cast(Model)).not.toThrow();
        }
      }
    }
  });
});

describe('seekSegments is exact: the segments list precisely the rows after a boundary', () => {
  for (const { name, spec } of SPECS) {
    it(name, () => {
      for (const seed of [1, 2, 3]) {
        const data = dataset(spec, seed, 40);
        const merged = reference(spec, data);
        for (let k = 0; k < merged.length; k++) {
          const doc = merged[k]!;
          const boundary: SortBoundary = { value: at(doc, spec.field) ?? null, id: String(doc[spec.tieField]), chainId: doc.chainId as number };
          const after = merged.slice(k + 1);
          for (const chainId of CHAINS) {
            const docs = data.get(chainId)!;
            const viaSegments = seekSegments(spec, boundary, chainId).flatMap((segment) =>
              mongoSort(
                docs.filter((d) => !segment || matches(d, segment, spec.collated)),
                sortSpec(spec),
                spec.collated,
              ),
            );
            const expected = after.filter((d) => d.chainId === chainId).map((d) => key(d, spec));
            expect(viaSegments.map((d) => key(d, spec)), `seed ${seed} k ${k} chain ${chainId}`).toEqual(expected);
            // …and the in-memory twin the uncollated shapes use agrees.
            const sorted = mongoSort(docs, sortSpec(spec), spec.collated);
            expect(rowsAfter(spec, sorted, boundary, chainId).map((d) => key(d as Doc, spec))).toEqual(expected);
          }
        }
      }
    });
  }

  it('from the top: one segment, no extra filter', () => {
    expect(seekSegments(SPECS[0]!.spec, null, 1)).toEqual([undefined]);
  });

  it('refuses a boundary no seek can express (an object), rather than guessing', () => {
    expect(() => seekSegments(SPECS[0]!.spec, { value: { a: 1 }, id: '1', chainId: 1 }, 1)).toThrow(/unsupported/);
  });
});

describe('streamMergePage', () => {
  const spec = SPECS[0]!.spec;
  const compare = sortSpecComparator(spec) as (a: Doc, b: Doc) => number;
  const sortedByChain = (data: Map<number, Doc[]>) =>
    new Map([...data].map(([chainId, docs]) => [chainId, mongoSort(docs, sortSpec(spec), true)]));

  it('equals the old window merge for every shallow page (top page × limit per shard, merged, sliced)', async () => {
    const data = sortedByChain(dataset(spec, 7, 400));
    for (const limit of [10, 25, 50, 100]) {
      for (let page = 1; page * limit <= 1000; page += 3) {
        // The pre-change all-chains read, verbatim: each shard's top page × limit
        // (+1), merged by the comparator then chainId, sliced to the page.
        const shards = [...data].map(([chainId, docs]) => ({ chainId, rows: docs.slice(0, page * limit + 1) }));
        const old = shards
          .flatMap((shard) => shard.rows.slice(0, page * limit))
          .sort((a, b) => compare(a, b) || (a.chainId as number) - (b.chainId as number));
        const oldPage = old.slice((page - 1) * limit, page * limit).map((d) => key(d, spec));
        const oldHasMore = old.length > page * limit || shards.some((shard) => shard.rows.length > page * limit);

        const result = await streamMergePage<Doc>({
          sources: [...data].map(([chainId, docs]) => arraySource(chainId, docs)),
          compare,
          start: { offset: 0, counts: {} },
          skip: (page - 1) * limit,
          take: limit + 1,
        });
        expect(result.rows.slice(0, limit).map((r) => key(r.row, spec)), `page ${page} × ${limit}`).toEqual(oldPage);
        expect(result.rows.length > limit).toBe(oldHasMore);
      }
    }
  });

  it('keeps only the page: rows before it are counted and dropped, and the rest of the shards are never read', async () => {
    const data = sortedByChain(dataset(spec, 8, 2_000));
    const read = new Map<number, number>();
    const sources: MergeSource<Doc>[] = [...data].map(([chainId, docs]) => {
      const inner = arraySource(chainId, docs);
      return {
        chainId,
        next: async () => {
          read.set(chainId, (read.get(chainId) ?? 0) + 1);
          return inner.next();
        },
        close: () => inner.close(),
      };
    });
    const result = await streamMergePage<Doc>({ sources, compare, start: { offset: 0, counts: {} }, skip: 3_000, take: 26 });
    expect(result.rows).toHaveLength(26);
    expect(result.walked).toBe(3_026);
    // Each shard was read at most one row past what the merge consumed from it.
    const total = [...read.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(3_026 + CHAINS.length);
  });

  it('reserves the read budget before it reads, then per slice, never more than the walk needs', async () => {
    const data = sortedByChain(dataset(spec, 9, 3_000));
    const order: string[] = [];
    const reserve = vi.fn(async (rows: number) => {
      order.push(`reserve:${rows}`);
    });
    const sources = [...data].map(([chainId, docs]) => {
      const inner = arraySource(chainId, docs);
      return { chainId, next: async () => (order.push('read'), inner.next()), close: () => inner.close() };
    });
    await streamMergePage<Doc>({ sources, compare, start: { offset: 0, counts: {} }, skip: 4_500, take: 26, reserve, slice: 2_000 });
    expect(order[0]).toBe('reserve:2000'); // before the first read
    const reserved = reserve.mock.calls.reduce((sum, [rows]) => sum + rows, 0);
    expect(reserved).toBe(4_526); // 2000 + 2000 + 526: exactly what the walk needed
  });

  it('yields to the event loop while it walks (bounded slices, no long block)', async () => {
    const data = sortedByChain(dataset(spec, 10, 4_000));
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    let tickedBeforeEnd = false;
    const sources = [...data].map(([chainId, docs]) => {
      const inner = arraySource(chainId, docs);
      return {
        chainId,
        next: async () => {
          if (ticked) tickedBeforeEnd = true;
          return inner.next();
        },
        close: () => inner.close(),
      };
    });
    await streamMergePage<Doc>({ sources, compare, start: { offset: 0, counts: {} }, skip: 10_000, take: 2, yieldEvery: 1_000 });
    expect(tickedBeforeEnd).toBe(true);
  });

  it('drops a shard that fails MID-WALK and re-anchors the page on the others', async () => {
    const data = sortedByChain(dataset(spec, 11, 600));
    const failing = 4663;
    const sources = [...data].map(([chainId, docs]) => {
      const inner = arraySource(chainId, docs);
      let n = 0;
      return {
        chainId,
        next: async () => {
          if (chainId === failing && ++n > 150) throw new Error('shard down');
          return inner.next();
        },
        close: () => inner.close(),
      };
    });
    const skip = 700;
    const result = await streamMergePage<Doc>({ sources, compare, start: { offset: 0, counts: {} }, skip, take: 51 });
    const others = reference(spec, new Map([...data].filter(([chainId]) => chainId !== failing)));
    expect(result.missingChains).toEqual([failing]);
    expect(result.rows.map((r) => key(r.row, spec))).toEqual(others.slice(skip, skip + 51).map((d) => key(d, spec)));
  });

  it('a drop while the page is ALREADY FILLING moves its kept rows that now fall before `skip` into the counted prefix', async () => {
    const data = sortedByChain(dataset(spec, 12, 600));
    const failing = 4663;
    const sources = [...data].map(([chainId, docs]) => {
      const inner = arraySource(chainId, docs);
      let n = 0;
      return {
        chainId,
        next: async () => {
          if (chainId === failing && ++n > 150) throw new Error('shard down');
          return inner.next();
        },
        close: () => inner.close(),
      };
    });
    // The failure lands around merged index ~450: inside [300, 600), with rows kept.
    const result = await streamMergePage<Doc>({ sources, compare, start: { offset: 0, counts: {} }, skip: 300, take: 300 });
    const others = reference(spec, new Map([...data].filter(([chainId]) => chainId !== failing)));
    expect(result.rows.map((r) => key(r.row, spec))).toEqual(others.slice(300, 600).map((d) => key(d, spec)));
  });

  it('throws only when every shard fails', async () => {
    const boom = new Error('down');
    const failing = (chainId: number): MergeSource<Doc> => ({ chainId, next: async () => Promise.reject(boom), close: async () => undefined });
    await expect(
      streamMergePage<Doc>({ sources: CHAINS.map(failing), compare, start: { offset: 0, counts: {} }, skip: 0, take: 5 }),
    ).rejects.toBe(boom);
  });
});

describe('walkDeepPage over real seeks (mini-mongo) with the page ladder', () => {
  for (const { name, spec } of [SPECS[0]!, SPECS[2]!, SPECS[4]!]) {
    it(`${name}: any deep page from any rung equals the merged order`, async () => {
      const data = dataset(spec, 21, 1_500);
      const merged = reference(spec, data);
      let now = 1_000_000;
      const ladder = new PageLadderService(undefined, undefined, () => now);
      const shards = () => [...data].map(([chainId, docs]) => mongoShard(spec, chainId, docs));
      const page = async (skip: number, limit: number) =>
        walkDeepPage<Doc>({ shards: shards(), spec, skip, limit, ladder: { store: ladder, key: 'q' }, now: () => now });

      // A first deep visit walks from the top and records rungs as it goes.
      const first = await page(2_500, 25);
      expect(first.from).toBe(0);
      expect(first.rows.slice(0, 25).map((r) => key(r.row, spec))).toEqual(merged.slice(2_500, 2_525).map((d) => key(d, spec)));
      // Next page: starts exactly where the last one ended (the served-page rung).
      const next = await page(2_525, 25);
      expect(next.from).toBe(2_525);
      expect(next.walked).toBe(26);
      expect(next.rows.slice(0, 25).map((r) => key(r.row, spec))).toEqual(merged.slice(2_525, 2_550).map((d) => key(d, spec)));
      // Previous page / a jump back: from the nearest 1,000-row rung.
      const back = await page(1_700, 50);
      expect(back.from).toBe(1_000);
      expect(back.rows.slice(0, 50).map((r) => key(r.row, spec))).toEqual(merged.slice(1_700, 1_750).map((d) => key(d, spec)));
      // Past the end: everything after the deepest rung, and the exact total.
      const end = await page(merged.length + 10, 25);
      expect(end.rows).toHaveLength(0);
      expect(end.exhausted).toBe(true);
      expect(end.position).toBe(merged.length);
      // A rung older than the staleness budget (45 s) is not trusted: from the top again.
      now += 46_000;
      const cold = await page(2_525, 25);
      expect(cold.from).toBe(0);
      expect(cold.rows.slice(0, 25).map((r) => key(r.row, spec))).toEqual(merged.slice(2_525, 2_550).map((d) => key(d, spec)));
    });
  }

  it('a shard failing after the walk started from a rung: the others are re-walked from the top (exact), and nothing is recorded', async () => {
    const spec = SPECS[0]!.spec;
    const data = dataset(spec, 22, 1_200);
    const ladder = new PageLadderService();
    const record = vi.spyOn(ladder, 'record');
    await walkDeepPage<Doc>({
      shards: [...data].map(([chainId, docs]) => mongoShard(spec, chainId, docs)),
      spec,
      skip: 2_000,
      limit: 25,
      ladder: { store: ladder, key: 'q' },
    });
    expect(record).toHaveBeenCalledTimes(1);
    const failing = 42161;
    const result = await walkDeepPage<Doc>({
      shards: [...data].map(([chainId, docs]) =>
        mongoShard(spec, chainId, docs, chainId === failing ? { fail: () => new Error('shard down') } : {}),
      ),
      spec,
      skip: 2_100,
      limit: 25,
      ladder: { store: ladder, key: 'q' },
    });
    // The rung (2,025) was for all three chains; without one of them the page is
    // offset 2,100 of the OTHERS' merged order (as a shallow partial page is),
    // which a walk capped at the rung's distance cannot reach — so it restarts
    // from the top over the shards still answering.
    expect(result.from).toBe(0);
    expect(result.missingChains).toEqual([failing]);
    const others = reference(spec, new Map([...data].filter(([chainId]) => chainId !== failing)));
    expect(result.rows.slice(0, 25).map((r) => key(r.row, spec))).toEqual(others.slice(2_100, 2_125).map((d) => key(d, spec)));
    expect(record).toHaveBeenCalledTimes(1); // the partial walk recorded no rung
  });

  it('a mid-walk failure records ONLY the rungs passed while every shard answered — and they are exact', async () => {
    const spec = SPECS[0]!.spec;
    const data = dataset(spec, 24, 1_500);
    const merged = reference(spec, data);
    const ladder = new PageLadderService();
    const record = vi.spyOn(ladder, 'record');
    const result = await walkDeepPage<Doc>({
      shards: [...data].map(([chainId, docs]) =>
        mongoShard(spec, chainId, docs, chainId === 4663 ? { failAfter: () => 900 } : {}),
      ),
      spec,
      skip: 3_500,
      limit: 25,
      ladder: { store: ladder, key: 'q' },
    });
    expect(result.missingChains).toEqual([4663]);
    // 4663 failed after its 900th row, past merged offset 2,000: the rungs at
    // 1,000 and 2,000 describe all three chains and are kept; none after the drop.
    const recorded = record.mock.calls.flatMap(([, rungs]) => rungs).map((r) => r.offset);
    expect(recorded).toEqual([1_000, 2_000]);
    // Every kept rung is exact for the full shard set: a healthy walk from one
    // lands on the true merged order.
    const healthy = await walkDeepPage<Doc>({
      shards: [...data].map(([chainId, docs]) => mongoShard(spec, chainId, docs)),
      spec,
      skip: 2_100,
      limit: 25,
      ladder: { store: ladder, key: 'q' },
    });
    expect(healthy.from).toBe(2_000);
    expect(healthy.rows.slice(0, 25).map((r) => key(r.row, spec))).toEqual(merged.slice(2_100, 2_125).map((d) => key(d, spec)));
  });

  it('a walk that THROWS (its deadline) still records every rung it passed, so the retry starts there', async () => {
    const spec = SPECS[0]!.spec;
    const data = dataset(spec, 26, 2_000);
    const merged = reference(spec, data);
    const ladder = new PageLadderService();
    let reserved = 0;
    const deadline = new Error('read budget: deep would wait 100 ms, past its deadline');
    await expect(
      walkDeepPage<Doc>({
        shards: [...data].map(([chainId, docs]) => mongoShard(spec, chainId, docs)),
        spec,
        skip: 5_000,
        limit: 25,
        ladder: { store: ladder, key: 'q' },
        // The budget runs dry after ~3,000 rows: the request's deadline.
        reserve: async (rows) => {
          reserved += rows;
          if (reserved > 3_000) throw deadline;
        },
      }),
    ).rejects.toBe(deadline);
    const retry = await walkDeepPage<Doc>({
      shards: [...data].map(([chainId, docs]) => mongoShard(spec, chainId, docs)),
      spec,
      skip: 5_000,
      limit: 25,
      ladder: { store: ladder, key: 'q' },
    });
    // The second reservation (rows 2,000+) was refused: rung 2,000 had been passed.
    expect(retry.from).toBe(2_000);
    expect(retry.rows.slice(0, 25).map((r) => key(r.row, spec))).toEqual(merged.slice(5_000, 5_025).map((d) => key(d, spec)));
  });

  it('publishes its rungs as it goes (every LADDER_FLUSH_RUNGS), not only at the end', async () => {
    const spec = SPECS[0]!.spec;
    const data = dataset(spec, 27, 12_000);
    const ladder = new PageLadderService();
    const record = vi.spyOn(ladder, 'record');
    await walkDeepPage<Doc>({
      shards: [...data].map(([chainId, docs]) => mongoShard(spec, chainId, docs)),
      spec,
      skip: 34_000,
      limit: 10,
      ladder: { store: ladder, key: 'q' },
    });
    const batches = record.mock.calls.map(([, rungs]) => rungs.length);
    expect(batches[0]).toBe(LADDER_FLUSH_RUNGS);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(35); // 34 every-1,000 rungs + the page's far edge (34,010)
  });

  it('a derived rung inherits its start rung\'s age (`at`) — a walk from the top is stamped with its own start', async () => {
    const spec = SPECS[0]!.spec;
    const data = dataset(spec, 28, 1_500);
    let now = 1_000_000;
    const ladder = new PageLadderService(undefined, undefined, () => now);
    const record = vi.spyOn(ladder, 'record');
    const shards = () => [...data].map(([chainId, docs]) => mongoShard(spec, chainId, docs));
    const top = await walkDeepPage<Doc>({ shards: shards(), spec, skip: 2_000, limit: 25, ladder: { store: ladder, key: 'q' }, now: () => now });
    expect(top.anchorAt).toBe(1_000_000);
    now += 30_000;
    const next = await walkDeepPage<Doc>({ shards: shards(), spec, skip: 2_025, limit: 25, ladder: { store: ladder, key: 'q' }, now: () => now });
    expect(next.from).toBe(2_025);
    expect(next.anchorAt).toBe(1_000_000); // NOT 1,030,000: its prefix count is the first walk's
    expect(record.mock.calls.at(-1)![1].every((r) => r.at === 1_000_000)).toBe(true);
    // So 45 s after the FIRST walk the chain is no longer trusted, however recently it was extended.
    now = 1_000_000 + 45_001;
    const later = await walkDeepPage<Doc>({ shards: shards(), spec, skip: 2_050, limit: 25, ladder: { store: ladder, key: 'q' }, now: () => now });
    expect(later.from).toBe(0);
    expect(later.anchorAt).toBe(now);
  });

  it('an AGED rung starts a page only when no trusted start is within freshReach, and says how old the offsets are', async () => {
    const spec = SPECS[0]!.spec;
    const data = dataset(spec, 29, 1_500);
    const merged = reference(spec, data);
    let now = 1_000_000;
    const ladder = new PageLadderService(undefined, undefined, () => now);
    const shards = () => [...data].map(([chainId, docs]) => mongoShard(spec, chainId, docs));
    await walkDeepPage<Doc>({ shards: shards(), spec, skip: 4_000, limit: 25, ladder: { store: ladder, key: 'q' }, now: () => now });
    now += 120_000; // every rung is now aged (> 45 s)
    const aged = await walkDeepPage<Doc>({
      shards: shards(),
      spec,
      skip: 4_200,
      limit: 25,
      ladder: { store: ladder, key: 'q' },
      freshReach: 1_000,
      agedMaxMs: 600_000,
      now: () => now,
    });
    expect(aged.from).toBe(4_025);
    expect(aged.anchorAt).toBe(1_000_000);
    expect(aged.rows.slice(0, 25).map((r) => key(r.row, spec))).toEqual(merged.slice(4_200, 4_225).map((d) => key(d, spec)));
    // Without agedMaxMs an aged rung is never used.
    const plain = await walkDeepPage<Doc>({ shards: shards(), spec, skip: 4_200, limit: 25, ladder: { store: ladder, key: 'q' }, freshReach: 1_000, now: () => now });
    expect(plain.from).toBe(0);
    now += 46_000; // (that walk's rungs are now aged too)
    // Within reach of the top: the trusted (fresh) walk wins over the aged rung.
    const fresh = await walkDeepPage<Doc>({
      shards: shards(),
      spec,
      skip: 4_200,
      limit: 25,
      ladder: { store: ladder, key: 'q' },
      freshReach: 10_000,
      agedMaxMs: 600_000,
      now: () => now,
    });
    expect(fresh.from).toBe(0);
    expect(fresh.anchorAt).toBe(now);
  });

  it('settles the walk\'s database time against what it reserved (charge), per slice and at the end', async () => {
    const spec = SPECS[0]!.spec;
    const data = dataset(spec, 30, 2_000);
    let now = 0;
    const charges: Array<[number, number]> = [];
    const shards = [...data].map(([chainId, docs]) => {
      const inner = mongoShard(spec, chainId, docs);
      return {
        chainId,
        open: (boundary: SortBoundary | null, needed: number) => {
          const source = inner.open(boundary, needed);
          return { chainId, next: async () => ((now += 1), source.next()), close: () => source.close() };
        },
      };
    });
    await walkDeepPage<Doc>({
      shards,
      spec,
      skip: 4_500,
      limit: 10,
      reserve: async () => undefined,
      charge: (ms, rows) => charges.push([ms, rows]),
      now: () => now,
    });
    // One settlement before every further reservation (2 more after the first) and one at the end.
    expect(charges.length).toBe(3);
    expect(charges.reduce((sum, [, rows]) => sum + rows, 0)).toBe(4_511);
    // Every source read cost 1 ms on this clock: rows consumed + the heads and the read-ahead.
    expect(charges.reduce((sum, [ms]) => sum + ms, 0)).toBeGreaterThanOrEqual(4_511);
  });

  it('ignores a rung the store returns past the offset, or for another shard set (defence against a bad store)', async () => {
    const spec = SPECS[0]!.spec;
    const data = dataset(spec, 25, 600);
    const merged = reference(spec, data);
    for (const bad of [
      { offset: 1_500, at: Date.now(), value: 0, id: '1', chainId: 1, counts: { 1: 500, 4663: 500, 42161: 500 } },
      { offset: 900, at: Date.now(), value: 0, id: '1', chainId: 1, counts: { 1: 900 } },
    ]) {
      const store = { nearest: async () => bad, record: vi.fn() };
      const result = await walkDeepPage<Doc>({
        shards: [...data].map(([c, d]) => mongoShard(spec, c, d)),
        spec,
        skip: 1_000,
        limit: 20,
        ladder: { store, key: 'q' },
      });
      expect(result.from).toBe(0);
      expect(result.rows.slice(0, 20).map((r) => key(r.row, spec))).toEqual(merged.slice(1_000, 1_020).map((d) => key(d, spec)));
    }
  });

  it('holds the caller\'s long-walk slot only once it knows the walk is long', async () => {
    const spec = SPECS[0]!.spec;
    const data = dataset(spec, 23, 600);
    const slot = vi.fn(<T>(_needed: number, run: () => Promise<T>) => run());
    await walkDeepPage<Doc>({ shards: [...data].map(([c, d]) => mongoShard(spec, c, d)), spec, skip: 1_200, limit: 10, slot });
    expect(slot).toHaveBeenCalledWith(1_211, expect.any(Function));
  });
});

describe('segmentedSource', () => {
  it('never reads more than `needed` rows in total, across segments', async () => {
    const opened: number[] = [];
    const source = segmentedSource<number>(1, [{ a: 1 }, { b: 1 }], 5, async (_segment, limit) => {
      opened.push(limit);
      const rows = [1, 2, 3];
      let i = 0;
      return { cursor: { next: async () => (i < rows.length ? rows[i++]! : null), close: async () => undefined }, first: rows[i++]! };
    });
    const got: number[] = [];
    for (let row = await source.next(); row !== null; row = await source.next()) got.push(row);
    expect(got).toEqual([1, 2, 3, 1, 2]);
    expect(opened).toEqual([5, 2]); // the second segment is asked only for what is left
  });
});
