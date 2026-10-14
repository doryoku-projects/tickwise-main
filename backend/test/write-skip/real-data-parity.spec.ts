/*
 * OPT-IN (`WRITE_SKIP_REAL_DATA_URI=mongodb://…/db`): skip `off` against skip
 * `on` over REAL stored positions — the shapes years of builds left behind
 * (legacy leaves, nulls, NaN metrics, missing subdocuments), which no fixture
 * has. Each sampled row is replayed as the next refresh would hand it to
 * `upsertMany` (its own stored sections, the clock-driven leaves restamped),
 * through one repository per mode, over several cycles with the other writers
 * in between; after every cycle the stored documents are compared.
 *
 * It READS `<chainId>_uniswap_v4_positions` of the given database and writes
 * ONLY to a scratch database (`<db>_wsrd_<pid>`), dropped afterwards — on the
 * same server, or on `WRITE_SKIP_REAL_DATA_SCRATCH_URI` when the source has
 * no room (MongoDB refuses an index build under 500 MB of free disk).
 *
 *   WRITE_SKIP_REAL_DATA_URI='mongodb://127.0.0.1:27031/copypools_positions?directConnection=true' \
 *   WRITE_SKIP_REAL_DATA_SHARDS='43114:3000,42161:4000' \
 *     npx vitest run test/write-skip/real-data-parity.spec.ts
 *
 * Two things come out of it:
 *  - `on` (default knobs) must store exactly what `off` stores (the parity
 *    list of `comparable` aside) — the test fails on the first difference;
 *  - the three knobs (`POSITIONS_GAS_REVALUE`, `…_SKIP_AGE`, `…_SKIP_TOLERANCE`)
 *    are measured: decisions per cycle, and how far each one lets a stored
 *    number sit from the skip-off value (printed). Asserted once every row
 *    has just been written whole: `full-write` gas alone stores exactly what
 *    off stores, and with the age bucket only the annualised leaves differ,
 *    by at most 1 %.
 * The replay holds indexer inputs still, so the skip rates are those of a
 * cycle in which only the clock and the ETH price moved, plus the stated
 * share of rows whose price was moved by hand.
 */
import 'reflect-metadata';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PositionsRepository } from '../../src/database/positions.repository.js';
import { sectionOfField } from '../../src/database/position-write-hash.js';
import { PositionSchema } from '../../src/database/schemas/position.schema.js';
import type { NormalizedPosition } from '../../src/subgraph/normalized-position.js';
import { prng } from './support/fixtures.js';
import { comparable, type Doc } from './support/position-sim.js';

const URI = process.env.WRITE_SKIP_REAL_DATA_URI;
const SCRATCH_URI = process.env.WRITE_SKIP_REAL_DATA_SCRATCH_URI;
const PROTOCOL = 'uniswap-v4';
const SHARDS = (process.env.WRITE_SKIP_REAL_DATA_SHARDS ?? '43114:2000')
  .split(',')
  .map((part) => part.trim().split(':'))
  .filter(([chain]) => /^\d+$/.test(chain ?? ''))
  .map(([chain, rows]) => ({ chainId: Number(chain), rows: Math.max(50, Number(rows) || 2000) }));

/** The modes under test: `on` is the parity one; the rest add one knob each. */
const VARIANTS = [
  { tag: 'off', config: undefined },
  { tag: 'on', config: { positionsWriteSkip: 'on' } },
  { tag: 'gas', config: { positionsWriteSkip: 'on', positionsGasRevalue: 'full-write' } },
  { tag: 'gas+age', config: { positionsWriteSkip: 'on', positionsGasRevalue: 'full-write', positionsWriteSkipAge: 'bucket' } },
  {
    tag: 'gas+age+material',
    config: { positionsWriteSkip: 'on', positionsGasRevalue: 'full-write', positionsWriteSkipAge: 'bucket', positionsWriteSkipTolerance: 'material' },
  },
] as const;
type Tag = (typeof VARIANTS)[number]['tag'];

const QUIET = { log: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined };
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A stored row as the adapter would hand it over again: its hashed sections, no bookkeeping, no fee stamp. */
function toNormalized(doc: Doc): NormalizedPosition {
  const out: Doc = {};
  for (const [field, value] of Object.entries(doc)) {
    const section = sectionOfField(field);
    if (section === null || section === 'unhashed' || section === 'f') continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && '_id' in (value as Doc)) {
      const { _id: _dropped, ...rest } = value as Doc;
      out[field] = rest;
    } else {
      out[field] = value;
    }
  }
  return out as unknown as NormalizedPosition;
}

/** Today's normalize stamps (the leaves that move with every walk). */
function restamp(p: NormalizedPosition): NormalizedPosition {
  const nowSec = Math.floor(Date.now() / 1000);
  const end = p.closedAtTimestamp && p.closedAtTimestamp > p.createdAtTimestamp ? p.closedAtTimestamp : nowSec;
  const out = { ...p } as NormalizedPosition;
  if (p.metrics && typeof p.metrics === 'object') out.metrics = { ...p.metrics, ageSeconds: Math.max(0, end - p.createdAtTimestamp) };
  if (p.pricing && typeof p.pricing === 'object') out.pricing = { ...p.pricing, pricedAt: new Date() };
  return out;
}

function flatten(value: unknown, path: string, into: Map<string, unknown>): void {
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value) && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Doc)) flatten(v, path ? `${path}.${k}` : k, into);
    return;
  }
  into.set(path, value);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function sameLeaf(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

interface LeafDrift {
  rows: number;
  maxRel: number;
  maxAbs: number;
  nonNumeric: number;
}

/** Per leaf path: rows that differ, and the largest relative and absolute distance of a number. */
function drift(a: Doc | undefined, b: Doc | undefined, into: Map<string, LeafDrift>): boolean {
  const fa = new Map<string, unknown>();
  const fb = new Map<string, unknown>();
  flatten(a, '', fa);
  flatten(b, '', fb);
  let differs = false;
  for (const path of new Set([...fa.keys(), ...fb.keys()])) {
    const x = fa.get(path);
    const y = fb.get(path);
    if (sameLeaf(x, y)) continue;
    differs = true;
    const row = into.get(path) ?? { rows: 0, maxRel: 0, maxAbs: 0, nonNumeric: 0 };
    row.rows++;
    const nx = asNumber(x);
    const ny = asNumber(y);
    if (nx !== undefined && ny !== undefined) {
      const scale = Math.max(Math.abs(nx), Math.abs(ny));
      row.maxRel = Math.max(row.maxRel, scale === 0 ? 0 : Math.abs(nx - ny) / scale);
      row.maxAbs = Math.max(row.maxAbs, Math.abs(nx - ny));
    } else {
      row.nonNumeric++;
    }
    into.set(path, row);
  }
  return differs;
}

describe.skipIf(!URI)('write-skip on REAL stored positions (opt-in)', () => {
  let source: mongoose.Connection;
  let scratch: mongoose.Connection;
  let scratchServer: mongoose.Connection | undefined;

  beforeAll(async () => {
    source = await mongoose.createConnection(URI!).asPromise();
    scratchServer = SCRATCH_URI ? await mongoose.createConnection(SCRATCH_URI).asPromise() : undefined;
    scratch = (scratchServer ?? source).useDb(`${source.name}_wsrd_${process.pid}`);
  });
  afterAll(async () => {
    vi.useRealTimers();
    await scratch?.dropDatabase().catch(() => undefined);
    await scratchServer?.close();
    await source?.close();
  });

  for (const { chainId, rows } of SHARDS) {
    it(`chain ${chainId}: ${rows} real rows — on stores what off stores; the knobs measured`, async () => {
      const coll = source.collection(`${chainId}_uniswap_v4_positions`);
      const activeFilter = { chainId, protocol: PROTOCOL, isActive: true };
      const totalActive = await coll.countDocuments(activeFilter, { hint: 'bg_active_walk', maxTimeMS: 120_000 });
      const wantActive = Math.min(totalActive, Math.round(rows * 0.9));
      // Three slices of the active set (start, middle, end of the index), then some closed rows.
      const slice = Math.ceil(wantActive / 3);
      const offsets = [0, Math.max(0, Math.floor((totalActive - slice) / 2)), Math.max(0, totalActive - slice)];
      const byId = new Map<string, Doc>();
      for (const offset of offsets) {
        const part = await coll.find(activeFilter, { hint: 'bg_active_walk', maxTimeMS: 300_000 }).skip(offset).limit(slice).toArray();
        for (const doc of part) byId.set(String(doc.positionId), doc as Doc);
      }
      const closed = await coll
        .find({ chainId, protocol: PROTOCOL, isActive: false }, { maxTimeMS: 300_000 })
        .limit(Math.max(10, rows - byId.size))
        .toArray();
      for (const doc of closed) byId.set(String(doc.positionId), doc as Doc);
      const stored = [...byId.values()];
      expect(stored.length).toBeGreaterThan(0);

      // One scratch collection + repository per mode, each seeded with the rows exactly as stored.
      const sides = new Map<Tag, { model: mongoose.Model<unknown>; repo: PositionsRepository }>();
      for (const variant of VARIANTS) {
        const name = `c${chainId}_${variant.tag.replace(/\W+/g, '_')}`;
        const model = scratch.model(name, PositionSchema.clone(), name) as unknown as mongoose.Model<unknown>;
        await model.init();
        for (let i = 0; i < stored.length; i += 1000) await model.collection.insertMany(stored.slice(i, i + 1000) as never[], { ordered: false });
        const repo = new PositionsRepository({ positionModel: () => model, hintUnusable: () => true } as never, {} as never, variant.config as never);
        (repo as unknown as { logger: unknown }).logger = QUIET;
        sides.set(variant.tag, { model, repo });
      }

      const inputs = new Map<string, NormalizedPosition>(stored.map((doc) => [String(doc.positionId), toNormalized(doc)]));
      const actives = stored.filter((d) => d.isActive === true).map((d) => String(d.positionId));
      const rand = prng(chainId);
      // The ETH price the stored gas valuation implies (median), so the first cycle does not move gas by itself.
      const implied = stored
        .map((d) => Number((d.metrics as Doc | undefined)?.totalGasCostUsd) / Number((d.amounts as Doc | undefined)?.totalGasCostEth))
        .filter((v) => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
      let ethPrice = implied.length > 0 ? implied[Math.floor(implied.length / 2)]! : 4000;

      const readAll = async (tag: Tag): Promise<Map<string, Doc>> => {
        const docs = (await sides.get(tag)!.model.collection.find({}).toArray()) as Doc[];
        return new Map(docs.map((d) => [String(d.positionId), d]));
      };
      const seen = new Map<Tag, Record<string, number>>();
      const decisionsSince = (tag: Tag): Record<string, number> => {
        const shard = sides.get(tag)!.repo.writeSkipStatus().shards[`${chainId}:${PROTOCOL}`];
        const now: Record<string, number> = { insert: 0, full: 0, section: 0, skip: 0 };
        if (shard) for (const k of Object.keys(now)) now[k] = (shard.total.decisions as Record<string, number>)[k]! + (shard.window.decisions as Record<string, number>)[k]!;
        const before = seen.get(tag) ?? { insert: 0, full: 0, section: 0, skip: 0 };
        seen.set(tag, now);
        return Object.fromEntries(Object.keys(now).map((k) => [k, now[k]! - before[k]!]));
      };

      const report: Array<Record<string, unknown>> = [];
      const driftReport: Array<Record<string, unknown>> = [];
      /** The last cycle's distance from skip off, per knob set. */
      const lastDrift = new Map<Tag, { rows: number; paths: Map<string, LeafDrift> }>();
      const cycle = async (label: string, ids: readonly string[]): Promise<void> => {
        const batch = ids.map((id) => restamp(inputs.get(id)!));
        for (const { repo } of sides.values()) {
          for (let i = 0; i < batch.length; i += 1000) await repo.upsertMany(batch.slice(i, i + 1000), { aggregates: { ethPriceNow: ethPrice } });
        }
        const off = await readAll('off');
        // Parity: `on` at its default knobs stores exactly what `off` stores.
        const on = await readAll('on');
        expect(on.size, `${label}: row count`).toBe(off.size);
        for (const [id, doc] of off) {
          expect(comparable(on.get(id)), `${label}: chain ${chainId} position ${id}`).toEqual(comparable(doc));
        }
        for (const variant of VARIANTS) {
          if (variant.tag === 'off') continue;
          const d = decisionsSince(variant.tag);
          const updates = d.full! + d.section! + d.skip!;
          report.push({
            cycle: label,
            mode: variant.tag,
            rows: ids.length,
            full: d.full,
            section: d.section,
            skip: d.skip,
            'skipped %': updates > 0 ? Math.round((1000 * d.skip!) / updates) / 10 : 0,
          });
          if (variant.tag === 'on') continue;
          const other = await readAll(variant.tag);
          const paths = new Map<string, LeafDrift>();
          let rowsDiffer = 0;
          for (const [id, doc] of off) if (drift(comparable(doc), comparable(other.get(id)), paths)) rowsDiffer++;
          lastDrift.set(variant.tag, { rows: rowsDiffer, paths });
          const worst = [...paths.entries()].sort((a, b) => b[1].rows - a[1].rows || b[1].maxAbs - a[1].maxAbs).slice(0, 7);
          driftReport.push({
            cycle: label,
            mode: variant.tag,
            'rows differing': rowsDiffer,
            'leaves: rows / max abs / max rel': worst
              .map(([p, v]) => `${p.replace(/^metrics\./, 'm.').replace(/^amounts\./, 'a.')} ×${v.rows} ${v.maxAbs.toPrecision(2)} ${(100 * v.maxRel).toPrecision(2)}%${v.nonNumeric ? ' (non-numeric)' : ''}`)
              .join(' | '),
          });
        }
      };

      vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
      const all = [...inputs.keys()];

      await cycle('1 first write (no hash yet)', all);

      vi.setSystemTime(Date.now() + 30 * MIN);
      await cycle('2 +30 min, nothing moved', actives);

      vi.setSystemTime(Date.now() + 30 * MIN);
      ethPrice *= 1.004;
      await cycle('3 +30 min, ETH +0.4 %', actives);

      // The fee job between two refreshes: stamp-only on some rows, a served write on others.
      const feeRows = actives.filter(() => rand() < 0.08);
      for (const [tag, { repo, model }] of sides) {
        const current = new Map(
          ((await model.collection.find({ positionId: { $in: feeRows } }, { projection: { positionId: 1, updatedAt: 1, lastModifyBlock: 1 } }).toArray()) as Doc[]).map(
            (d) => [String(d.positionId), d],
          ),
        );
        const writes = feeRows.map((id, i) => {
          const doc = current.get(id);
          const block = Number(doc?.lastModifyBlock ?? 0) + 1_000 + i;
          return i % 2 === 0
            ? { positionId: id, fees0: '0.000123', fees1: '4.5', block }
            : {
                positionId: id,
                fees0: '0.000456',
                fees1: '7.5',
                block,
                served: { 'metrics.pendingFeesUsd': 16.5, 'amounts.totalFeesUncollectedUsd': '16.5', 'metrics.feesSource': 'onchain' },
                version: doc?.updatedAt as Date,
              };
        });
        const res = await repo.writeRpcFees(chainId, PROTOCOL, writes);
        expect(res.matched, `fee writes matched (${tag})`).toBe(feeRows.length);
      }
      vi.setSystemTime(Date.now() + 30 * MIN);
      await cycle(`4 +30 min, after fee writes on ${feeRows.length} rows`, actives);

      // A price move on a third of the rows that hold value.
      let moved = 0;
      for (const id of actives) {
        const p = inputs.get(id)!;
        const value = Number(p.metrics?.underlyingValueUsd ?? 0);
        if (!(value > 0) || rand() >= 0.33) continue;
        moved++;
        inputs.set(id, {
          ...p,
          token0: { ...p.token0, priceUsd: Number(p.token0?.priceUsd ?? 0) * 1.003 },
          metrics: { ...p.metrics, underlyingValueUsd: value * 1.0015, nominalValueUsd: Number(p.metrics?.nominalValueUsd ?? value) * 1.0015 },
        } as NormalizedPosition);
      }
      vi.setSystemTime(Date.now() + 30 * MIN);
      await cycle(`5 +30 min, price moved on ${moved} rows`, actives);

      vi.setSystemTime(Date.now() + 30 * MIN);
      await cycle('6 +30 min, nothing moved', actives);

      vi.setSystemTime(Date.now() + 8 * HOUR);
      await cycle('7 +8 h (forced rewrite of valued rows)', actives);

      vi.setSystemTime(Date.now() + 26 * HOUR);
      await cycle('8 +26 h (forced rewrite of every row)', all);
      vi.useRealTimers();

      // Every row has just been written whole. `full-write` gas alone: nothing is left behind.
      expect(lastDrift.get('gas')?.rows, 'gas=full-write after a full write of every row').toBe(0);
      // With the age bucket: only the annualised leaves sit off the skip-off value, by at most 1 %
      // (and `aprWarmup` on a row whose bucketed age has not crossed the warm-up line yet).
      for (const tag of ['gas+age', 'gas+age+material'] as const) {
        for (const [path, leaf] of lastDrift.get(tag)?.paths ?? []) {
          if (path === 'metrics.aprWarmup') continue;
          expect(path, `${tag}: a leaf outside the annualised set differs`).toMatch(/^metrics\.(apr|aprExGas|feeApr|poolApr)$/);
          expect(leaf.nonNumeric, `${tag}: ${path}`).toBe(0);
          expect(leaf.maxRel, `${tag}: ${path}`).toBeLessThanOrEqual(0.0101);
        }
      }

      for (const { repo } of sides.values()) {
        const shard = repo.writeSkipStatus().shards[`${chainId}:${PROTOCOL}`];
        if (!shard) continue;
        expect(shard.total.sectionErrors + shard.window.sectionErrors, 'section ops the server refused').toBe(0);
      }

      console.log(`\n=== chain ${chainId}: ${stored.length} real rows (${actives.length} open), ${totalActive} open in the shard ===`);
      console.table(report);
      console.table(driftReport);
    }, 3_600_000);
  }
});
