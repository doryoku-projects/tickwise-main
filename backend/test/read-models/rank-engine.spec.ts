import { describe, expect, it } from 'vitest';
import { InThreadEngine } from '../../src/read-models/core/engine-runner.js';
import { shardKey } from '../../src/read-models/core/fields.js';
import type { ModelStore } from '../../src/read-models/core/model-store.js';
import { RANK_LEAF, RANK_PERMS } from '../../src/read-models/rank/rank-columns.js';
import { RankEngine, RankUnsupported, type RankShard } from '../../src/read-models/rank/rank-engine.js';
import { compileRankFilter } from '../../src/read-models/rank/rank-query.js';
import { slotOfPid } from '../../src/read-models/rank/rank-perms.js';
import { prng, type Doc } from '../support/mini-mongo.js';
import { buildRankStore, makePositions, OWNERS, oidOf, POOLS, PROTO, touch, upsertRow } from './rank-support.js';

/**
 * The rank engine's generations and derived structures (design §4.6, §6.1,
 * §6.6): after ANY sequence of applied changes the incrementally maintained
 * permutations (A+ membership included), CSRs and holder counts equal a full
 * build over the same rows; holder counts equal an independent `$group`
 * (`countsByPoolIds`' semantics); quarantined fields refuse the queries that
 * read them.
 */

const CHAIN = 1;
const KEY = shardKey(CHAIN, PROTO);

function engineOver(store: ModelStore): RankEngine {
  return new RankEngine({ engine: new InThreadEngine(), source: () => ({ store, shards: [{ chainId: CHAIN, protocol: PROTO }] }), alert: () => undefined });
}

function shardOf(engine: RankEngine): RankShard {
  return engine.current!.shards.get(KEY)!;
}

function snapshot(shard: RankShard) {
  const perms = RANK_PERMS.map((_, p) => Array.from(shard.perms[shard.permCur][p]!.subarray(0, shard.permLen[p])));
  const csr = (c: { order: Uint32Array; start: Uint32Array; keys: number }) => ({ keys: c.keys, start: Array.from(c.start.subarray(0, c.keys + 1)), order: Array.from(c.order.subarray(0, c.start[c.keys])) });
  const holders: Array<[number, number, number, number]> = [];
  for (let k = 1; k <= shard.dict.size; k++) {
    const h = shard.holders;
    if (h.positions[k] || h.holders[k] || h.ambiguous[k]) holders.push([k, h.positions[k]!, h.holders[k]!, h.ambiguous[k]!]);
  }
  return { perms, pool: csr(shard.pools[shard.csrCur]), owner: csr(shard.owners[shard.csrCur]), holders, live: shard.cols.live };
}

/** `countsByPoolIds`' aggregation, computed independently over documents. */
function groupCounts(docs: Doc[], poolId: string): { positionsCount: number; holdersCount: number } | 'ambiguous' | undefined {
  const rows = docs.filter((d) => d.poolId === poolId && d.isActive === true);
  if (rows.length === 0) return undefined;
  const owners = new Set<unknown>();
  for (const row of rows) {
    if (row.owner === undefined || row.owner === null) return 'ambiguous';
    owners.add(row.owner);
  }
  return { positionsCount: rows.length, holdersCount: owners.size };
}

describe('rank engine generations', () => {
  it('keeps permutations, CSRs and holder counts equal to a full build through random changes', async () => {
    const docs = makePositions(5, CHAIN, 800);
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const engine = engineOver(store);
    await engine.tick();
    const rand = prng(17);
    let nextId = 900_000;
    for (let round = 0; round < 25; round++) {
      // inserts
      for (const doc of makePositions(100 + round, CHAIN, 1 + Math.floor(rand() * 15), { idBase: nextId })) {
        docs.push(doc);
        upsertRow(store, CHAIN, doc);
      }
      nextId += 100;
      // key changes with heavy ties, membership changes (value 0 → 5, isActive flips), owner / pool moves
      for (let k = 0; k < 40; k++) {
        const doc = docs[Math.floor(rand() * docs.length)]!;
        const metrics = { ...(doc.metrics as Doc) };
        const r = rand();
        if (r < 0.3) metrics.underlyingValueUsd = [0, 5, 5, NaN, null, -0, Infinity][Math.floor(rand() * 7)];
        else if (r < 0.5) metrics.aprExGas = [1, 1, 2, NaN, null, -Infinity][Math.floor(rand() * 6)];
        else if (r < 0.6) metrics.poolPnlUsd = [0, 0, NaN][Math.floor(rand() * 3)];
        else if (r < 0.75) doc.isActive = !doc.isActive;
        else if (r < 0.85) doc.owner = OWNERS[Math.floor(rand() * OWNERS.length)];
        else if (r < 0.95) doc.poolId = POOLS[Math.floor(rand() * POOLS.length)];
        else doc.createdAtTimestamp = 1_700_000_100;
        doc.metrics = metrics;
        upsertRow(store, CHAIN, doc);
      }
      // deletes
      for (let k = 0; k < 5; k++) {
        const [gone] = docs.splice(Math.floor(rand() * docs.length), 1);
        store.table('rank', KEY)!.delete(oidOf(gone!));
      }
      touch(store);
      await engine.tick();
      const fresh = engineOver(store);
      await fresh.tick();
      const a = snapshot(shardOf(engine));
      const b = snapshot(shardOf(fresh));
      expect(a.live, `round ${round}`).toBe(docs.length);
      expect(a.perms, `round ${round} perms`).toEqual(b.perms);
      expect(a.pool, `round ${round} pool CSR`).toEqual(b.pool);
      expect(a.owner, `round ${round} owner CSR`).toEqual(b.owner);
      expect(a.holders, `round ${round} holders`).toEqual(b.holders);
    }
    expect(engine.swaps).toBeGreaterThanOrEqual(25);
    expect(engine.builds).toBe(1);
  });

  it('rebuilds the CSRs for a generation that only moves owners or pools (no insert, no delete)', async () => {
    const docs = makePositions(8, CHAIN, 400);
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const engine = engineOver(store);
    await engine.tick();
    for (const move of ['owner', 'pool'] as const) {
      for (const doc of docs.slice(0, 30)) {
        if (move === 'owner') doc.owner = OWNERS[(OWNERS.indexOf(doc.owner as string) + 1) % OWNERS.length];
        else doc.poolId = POOLS[(POOLS.indexOf(doc.poolId as string) + 1) % POOLS.length];
        upsertRow(store, CHAIN, doc);
      }
      touch(store);
      const rebuilds = engine.csrRebuilds;
      await engine.tick();
      expect(engine.csrRebuilds, move).toBe(rebuilds + 1);
      const fresh = engineOver(store);
      await fresh.tick();
      const a = snapshot(shardOf(engine));
      const b = snapshot(shardOf(fresh));
      expect(a.pool, `${move}: pool CSR`).toEqual(b.pool);
      expect(a.owner, `${move}: owner CSR`).toEqual(b.owner);
      expect(a.holders, `${move}: holders`).toEqual(b.holders);
    }
  });

  it('a row whose value goes 0 → 5 enters the apr permutation; an isActive flip leaves it', async () => {
    const docs = makePositions(9, CHAIN, 50);
    for (const doc of docs) (doc.metrics as Doc).underlyingValueUsd = 0;
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const engine = engineOver(store);
    await engine.tick();
    const apr = RANK_PERMS.findIndex((p) => p.name === 'apr');
    expect(shardOf(engine).permLen[apr]).toBe(0);
    const doc = docs.find((d) => d.isActive === true)!;
    (doc.metrics as Doc).underlyingValueUsd = 5;
    upsertRow(store, CHAIN, doc);
    touch(store);
    await engine.tick();
    const shard = shardOf(engine);
    expect(shard.permLen[apr]).toBe(1);
    const slot = shard.table.liveSlotOf(oidOf(doc));
    expect(shard.perms[shard.permCur][apr]![0]).toBe(slot);
    doc.isActive = false;
    upsertRow(store, CHAIN, doc);
    touch(store);
    await engine.tick();
    expect(shardOf(engine).permLen[apr]).toBe(0);
  });

  it('finds a slot by canonical positionId (binary search of the pid permutation)', async () => {
    const docs = makePositions(3, CHAIN, 300);
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const engine = engineOver(store);
    await engine.tick();
    const shard = shardOf(engine);
    const pidPerm = shard.perms[shard.permCur][RANK_PERMS.length - 1]!;
    for (const doc of docs.slice(0, 50)) {
      expect(slotOfPid(shard.cols.arrays, pidPerm, shard.permLen[RANK_PERMS.length - 1]!, Number(doc.positionId))).toBe(shard.table.liveSlotOf(oidOf(doc)));
    }
    expect(slotOfPid(shard.cols.arrays, pidPerm, shard.permLen[RANK_PERMS.length - 1]!, 4_000_000_000)).toBe(-1);
  });
});

describe('rank engine holder counts (countsByPoolIds semantics)', () => {
  it('equals an independent $group: open positions, distinct BINARY owners, absent = 0/0, null owner → ambiguous', async () => {
    const docs = makePositions(21, CHAIN, 1_200);
    // A null-owner active row makes its pool ambiguous (`$addToSet` keeps null, skips missing).
    const nullOwner = docs.find((d) => d.isActive === true)!;
    nullOwner.owner = null;
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const engine = engineOver(store);
    await engine.tick();
    const got = engine.holderCounts(CHAIN, PROTO, [...POOLS.map((p) => p.toUpperCase()), '0xnosuchpool'])!;
    expect(got).toBeDefined();
    for (const pool of POOLS) {
      const want = groupCounts(docs, pool);
      if (want === 'ambiguous') {
        expect(got.ambiguous).toContain(pool);
        expect(got.counts.has(pool)).toBe(false);
      } else if (want === undefined) {
        expect(got.counts.has(pool), pool).toBe(false);
      } else {
        expect(got.counts.get(pool), pool).toEqual(want);
      }
    }
    expect(got.ambiguous).toEqual([nullOwner.poolId]);
    // Collation-equal owners are DIFFERENT holders here (no collation on the $group).
    const pool = POOLS[0]!;
    const owners = new Set(docs.filter((d) => d.poolId === pool && d.isActive === true).map((d) => d.owner));
    if (owners.has(OWNERS[0]) && owners.has(OWNERS[1]) && pool !== nullOwner.poolId) expect(got.counts.get(pool)!.holdersCount).toBe(owners.size);
  });

  it('refuses a shard whose isActive / owner / poolId is quarantined', async () => {
    const docs = makePositions(22, CHAIN, 100);
    docs[0]!.isActive = 'true';
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const engine = engineOver(store);
    await engine.tick();
    expect(engine.holderCounts(CHAIN, PROTO, [POOLS[0]!])).toBeUndefined();
  });
});

describe('rank engine quarantine and refusals', () => {
  async function answerFor(docs: Doc[], filter: Record<string, unknown>, shape: 'ranked' | 'owner' | 'pool' | 'lookup', perm: string, reverse = false) {
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const engine = engineOver(store);
    await engine.tick();
    const compiled = compileRankFilter({ chainId: CHAIN, protocol: PROTO, ...filter }, CHAIN, PROTO, shape);
    if (!compiled.ok) throw new Error(compiled.reason);
    return engine.answer([{ key: KEY, plan: compiled.plan, excluded: [] }], { perm: RANK_PERMS.findIndex((p) => p.name === perm), reverse });
  }

  it('an odd isActive refuses every query reading isActive, and only those', async () => {
    const docs = makePositions(30, CHAIN, 200);
    docs[3]!.isActive = 'true';
    await expect(answerFor(docs, { isActive: true }, 'ranked', 'pnl')).rejects.toThrow(RankUnsupported);
    await expect(answerFor(docs, {}, 'ranked', 'pnl')).resolves.toBeDefined();
  });

  it('tokenId ≠ positionId refuses the nft sorts and the lookup, not the other sorts', async () => {
    const docs = makePositions(31, CHAIN, 200);
    docs[5]!.tokenId = '999999999';
    await expect(answerFor(docs, {}, 'ranked', 'pid')).rejects.toThrow(/quarantine/);
    await expect(answerFor(docs, { $or: [{ positionId: '1' }, { tokenId: '1' }] }, 'lookup', 'pnl')).rejects.toThrow(/quarantine/);
    await expect(answerFor(docs, {}, 'ranked', 'age')).resolves.toBeDefined();
  });

  it('a null positionId refuses everything (no order, no row fetch); a non-canonical one too', async () => {
    const a = makePositions(32, CHAIN, 50);
    a[1]!.positionId = null;
    await expect(answerFor(a, {}, 'ranked', 'age')).rejects.toThrow(/quarantine/);
    const b = makePositions(33, CHAIN, 50);
    b[1]!.positionId = '007';
    b[1]!.tokenId = '007';
    await expect(answerFor(b, {}, 'ranked', 'age')).rejects.toThrow(/quarantine/);
  });

  it('collated fields outside the ckey domain refuse the collated shapes only', async () => {
    const docs = makePositions(34, CHAIN, 100);
    docs[2]!.owner = `0x${'1'.repeat(300)}`; // a digit run past ICU's 254-digit chunk
    await expect(answerFor(docs, { owner: OWNERS[3]!.toLowerCase() }, 'owner', 'pnl')).rejects.toThrow(/quarantine/);
    await expect(answerFor(docs, { poolId: POOLS[3]!, owner: OWNERS[3]!.toLowerCase() }, 'pool', 'pnl')).resolves.toBeDefined();
    const ctrl = makePositions(35, CHAIN, 100);
    ctrl[2]!.owner = 'ab\u0001cd'; // non-printable: R1's quarantine
    await expect(answerFor(ctrl, { owner: OWNERS[3]!.toLowerCase() }, 'owner', 'pnl')).rejects.toThrow(/quarantine/);
  });

  it('refuses a ranked rate sort whose filter does not imply A+ (a direct caller asking Closed + apr)', async () => {
    const docs = makePositions(36, CHAIN, 100);
    await expect(answerFor(docs, { isActive: false }, 'ranked', 'apr')).rejects.toThrow('rate_sort_without_aplus');
    await expect(answerFor(docs, { isActive: true, 'metrics.underlyingValueUsd': { $gt: 0 } }, 'ranked', 'apr')).resolves.toBeDefined();
  });

  it('a positionId change rebuilds the shard (slots keep their id within an instance)', async () => {
    const docs = makePositions(37, CHAIN, 50);
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const alerts: string[] = [];
    const engine = new RankEngine({ engine: new InThreadEngine(), source: () => ({ store, shards: [{ chainId: CHAIN, protocol: PROTO }] }), alert: (name) => alerts.push(name) });
    await engine.tick();
    const before = shardOf(engine).instance;
    docs[0]!.positionId = '123456789';
    docs[0]!.tokenId = '123456789';
    upsertRow(store, CHAIN, docs[0]!);
    touch(store);
    await engine.tick();
    expect(shardOf(engine).instance).not.toBe(before);
    expect(alerts).toContain('read_models.rank_rebuild');
    expect(RANK_LEAF.positionId).toBeGreaterThanOrEqual(0);
  });
});

describe('rank engine refusal() and the swap gate', () => {
  async function engineWith(docs: Doc[]) {
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const engine = engineOver(store);
    await engine.tick();
    return engine;
  }
  function input(filter: Record<string, unknown>, shape: 'ranked' | 'owner' | 'pool' | 'lookup' = 'ranked') {
    const compiled = compileRankFilter({ chainId: CHAIN, protocol: PROTO, ...filter }, CHAIN, PROTO, shape);
    if (!compiled.ok) throw new Error(compiled.reason);
    return [{ key: KEY, plan: compiled.plan, excluded: [] }];
  }
  const perm = (name: string) => RANK_PERMS.findIndex((p) => p.name === name);

  it('refusal() answers exactly what answer() would refuse, without a pass', async () => {
    const docs = makePositions(40, CHAIN, 200);
    docs[3]!.isActive = 'true';
    const engine = await engineWith(docs);
    expect(engine.refusal(input({ isActive: true }), perm('pnl'), false)).toMatch(/^quarantine:/);
    expect(engine.refusal(input({}), perm('pnl'), false)).toBeUndefined();
    expect(engine.refusal(input({ isActive: false }), perm('apr'), true)).toMatch(/^quarantine:|rate_sort_without_aplus/);
    // a shard the generation does not hold
    expect(engine.refusal([{ ...input({})[0]!, key: shardKey(999, PROTO) }], perm('pnl'), false)).toBe('shard_not_built');
    await expect(engine.answer(input({ isActive: true }), { perm: perm('pnl'), reverse: false }, { materialize: false })).rejects.toThrow(RankUnsupported);
  });

  it('a pass waits for a swap in progress at most its acquire wait, then is refused as an overload', async () => {
    const engine = await engineWith(makePositions(41, CHAIN, 50));
    let open!: () => void;
    (engine as unknown as { gate?: Promise<void> }).gate = new Promise<void>((resolve) => (open = resolve));
    const started = Date.now();
    await expect(engine.acquire(80)).rejects.toMatchObject({ name: 'EngineOverloadError', reason: 'deadline' });
    expect(Date.now() - started).toBeLessThan(1_000);
    // a gate that opens within the wait lets the pass in
    const entering = engine.acquire(1_000);
    (engine as unknown as { gate?: Promise<void> }).gate = undefined;
    open();
    await expect(entering).resolves.toBeDefined();
    engine.release();
  });
});
