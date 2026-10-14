#!/usr/bin/env node
// Removes the legacy `rawSubgraph` field from stored positions.
//
// WHY. Every position used to store the raw indexer row it was built from
// (~0.7–0.8 KB of a ~3.1 KB document) and nothing ever read it back. Since
// 2026-10-06 the backend no longer writes it and `$unset`s it on every FULL
// write (`PositionsRepository.positionUpdate`), so a position the refresh still
// touches loses it by itself. A CLOSED position is never written again, and
// closed rows are most of every shard (≈ 89% on 4663), so they keep the field
// until this script removes it.
//
// WHAT IT DOES. Per `{chainId}_{protocol}_positions` shard: walks `_id` in
// ascending batches (ids only, on a secondary) and sends ONE
// `updateMany({_id in range, rawSubgraph exists}, {$unset: {rawSubgraph: ''}})`
// per batch through the raw driver. It changes nothing else: no hashed
// write-skip section (`rawSubgraph` is unhashed, so `wh` stays valid), no
// `updatedAt` (the fee job's version guard is untouched), no served field. The
// read models' change stream sees each update and drops it as a no-op (the
// field is not a model leaf).
//
// COST — read this before `--apply` on production. Each matched document is
// rewritten, and a closed document is cold: it is read from disk into a 512 MB
// cache on the M10, evicting warmer pages. So the run is PACED
// (`--docs-per-sec`, counted on documents SCANNED), waits for a majority
// acknowledgement on every batch (replication back-pressure), and STOPS when a
// batch takes longer than `--slow-batch-ms`. Run it off-peak, never during a
// backfill or a deploy. It is safe to stop (Ctrl-C) and resume at any time:
// re-running is idempotent, and `--after=<_id>` skips what was already walked.
//
// ORDER. Deploy the backend build that stops writing the field FIRST. Until
// then an older build puts the field back on every position it writes. Closed
// rows are not affected by that (nothing writes them), so the default
// `--scope=closed` is correct either way; `--scope=all` refuses to run while
// recently synced positions still carry the field.
//
// Dry run by default. It reads a random sample per shard and prints how many
// rows carry the field, the bytes it holds and how long `--apply` would take.
//
// Usage: node scripts/positions-raw-subgraph-cleanup.mjs                 (dry run)
//        …--apply                              (closed positions, every shard)
//        …--apply --shard=4663                 (one shard)
//        …--apply --docs-per-sec=100           (slower; default 200, max 1000)
//        …--apply --max-docs=20000             (stop after scanning this many — a trial run)
//        …--apply --shard=4663 --after=<_id>   (resume one shard after this _id)
//        …--apply --scope=all                  (also open positions; only after the deploy)
// Non-local: MONGODB_URI=… node scripts/positions-raw-subgraph-cleanup.mjs
// (deliberately NO dotenv: a stray `.env` must not silently point this at prod)
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

export const KNOWN_FLAGS = [
  '--apply',
  '--shard=<chainId>',
  '--scope=closed|all',
  '--docs-per-sec=<n>',
  '--batch=<n>',
  '--max-docs=<n>',
  '--after=<_id>',
  '--slow-batch-ms=<n>',
];
export const SHARD_COLLECTION_PATTERN = /^\d+_[a-z0-9_]+_positions$/;
export const DEFAULTS = Object.freeze({ docsPerSec: 200, batch: 500, slowBatchMs: 15_000, sample: 2_000 });
/** Hard ceilings: a typo must not turn a paced walk into a flood. */
export const LIMITS = Object.freeze({ docsPerSec: 1_000, batch: 1_000 });
/** A position synced this recently that still carries the field means the running backend still writes it. */
export const RECENT_SYNC_MS = 2 * 60 * 60_000;

function positiveInt(arg, prefix, max) {
  const raw = arg.slice(prefix.length);
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${prefix}<n> expects a positive whole number, got "${raw}"`);
  const value = Number(raw);
  if (max !== undefined && value > max) throw new Error(`${prefix}${raw} is above the limit of ${max}`);
  return value;
}

export function parseArgs(argv) {
  const flags = {
    apply: false,
    shard: undefined,
    scope: 'closed',
    docsPerSec: DEFAULTS.docsPerSec,
    batch: DEFAULTS.batch,
    maxDocs: undefined,
    after: undefined,
    slowBatchMs: DEFAULTS.slowBatchMs,
  };
  const unknown = [];
  for (const arg of argv) {
    if (arg === '--apply') flags.apply = true;
    else if (arg.startsWith('--shard=')) {
      const raw = arg.slice('--shard='.length);
      if (!/^\d+$/.test(raw)) throw new Error(`--shard expects a numeric chainId (e.g. --shard=4663), got "${raw}"`);
      flags.shard = Number(raw);
    } else if (arg.startsWith('--scope=')) {
      const raw = arg.slice('--scope='.length);
      if (raw !== 'closed' && raw !== 'all') throw new Error(`--scope expects closed or all, got "${raw}"`);
      flags.scope = raw;
    } else if (arg.startsWith('--docs-per-sec=')) flags.docsPerSec = positiveInt(arg, '--docs-per-sec=', LIMITS.docsPerSec);
    else if (arg.startsWith('--batch=')) flags.batch = positiveInt(arg, '--batch=', LIMITS.batch);
    else if (arg.startsWith('--max-docs=')) flags.maxDocs = positiveInt(arg, '--max-docs=');
    else if (arg.startsWith('--slow-batch-ms=')) flags.slowBatchMs = positiveInt(arg, '--slow-batch-ms=');
    else if (arg.startsWith('--after=')) {
      const raw = arg.slice('--after='.length);
      if (!/^[0-9a-f]{24}$/i.test(raw)) throw new Error(`--after expects a 24-hex _id, got "${raw}"`);
      flags.after = raw.toLowerCase();
    } else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`unrecognized argument(s): ${unknown.join(' ')} — known flags are ${KNOWN_FLAGS.join(' ')}`);
  }
  // An _id belongs to ONE collection: resuming "after" it on every shard would
  // silently skip the start of the others.
  if (flags.after !== undefined && flags.shard === undefined) throw new Error('--after needs --shard (an _id belongs to one shard)');
  return flags;
}

export const chainIdOf = (collectionName) => Number(collectionName.split('_')[0]);

export function selectShards(collectionNames, shard) {
  return collectionNames
    .filter((name) => SHARD_COLLECTION_PATTERN.test(name))
    .filter((name) => shard === undefined || chainIdOf(name) === shard)
    .sort((a, b) => chainIdOf(a) - chainIdOf(b) || a.localeCompare(b));
}

/**
 * The one write of a batch. The `_id` range is what the walk just read; the
 * `$exists` clause makes a re-run (or a row the backend already cleaned) match
 * nothing, so the script is idempotent and never rewrites a clean document.
 * `closed` never touches an open position: the backend cleans those itself.
 */
export function batchFilter(firstId, lastId, scope) {
  const filter = { _id: { $gte: firstId, $lte: lastId }, rawSubgraph: { $exists: true } };
  if (scope === 'closed') filter.isActive = false;
  return filter;
}

export const BATCH_UPDATE = Object.freeze({ $unset: { rawSubgraph: '' } });

/** Milliseconds to wait after a batch so the walk holds `docsPerSec` on documents scanned. */
export function paceDelayMs(scanned, elapsedMs, docsPerSec) {
  if (!(docsPerSec > 0) || !(scanned > 0)) return 0;
  return Math.max(0, Math.ceil((scanned / docsPerSec) * 1000 - elapsedMs));
}

export const redactUri = (uri) => {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname && u.pathname !== '/' ? u.pathname : ''}`;
  } catch {
    return '(unparseable MONGODB_URI)';
  }
};

const fmt = (n) => Number(n).toLocaleString('en-US');
const mb = (bytes) => `${(Number(bytes) / 1e6).toFixed(1)} MB`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function duration(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** A random sample: the share of rows carrying the field and the bytes it holds (uncompressed). */
export async function sampleShard(coll, sampleSize) {
  const rows = await coll
    .aggregate(
      [
        { $sample: { size: sampleSize } },
        {
          $project: {
            _id: 0,
            isActive: 1,
            has: { $ne: [{ $type: '$rawSubgraph' }, 'missing'] },
            bytes: { $cond: [{ $eq: [{ $type: '$rawSubgraph' }, 'object'] }, { $bsonSize: '$rawSubgraph' }, 0] },
          },
        },
      ],
      { readPreference: 'secondaryPreferred', maxTimeMS: 60_000 },
    )
    .toArray();
  const out = { sampled: rows.length, withField: 0, closedWithField: 0, closed: 0, bytes: 0 };
  for (const row of rows) {
    if (row.isActive === false) out.closed++;
    if (!row.has) continue;
    out.withField++;
    if (row.isActive === false) out.closedWithField++;
    out.bytes += Number(row.bytes) || 0;
  }
  return out;
}

/** Do recently synced open positions still carry the field? Then the running backend still writes it. */
export async function backendStillWrites(coll, now = Date.now()) {
  const rows = await coll
    .find({ isActive: true }, { projection: { _id: 0, lastSyncedAt: 1, rawSubgraph: 1 }, readPreference: 'secondaryPreferred', maxTimeMS: 30_000 })
    .limit(200)
    .toArray();
  const recent = rows.filter((r) => r.lastSyncedAt instanceof Date && now - r.lastSyncedAt.getTime() <= RECENT_SYNC_MS);
  return { recent: recent.length, carrying: recent.filter((r) => r.rawSubgraph !== undefined).length };
}

/** The paced walk of one shard. Returns its totals and the last `_id` it finished. */
export async function cleanShard(coll, flags, state, log = console.log) {
  // `stopped`: why the walk ended before the shard's end; `trialEnd` = by --max-docs (asked for, not a failure).
  const totals = { scanned: 0, modified: 0, batches: 0, lastId: flags.after ? new mongoose.Types.ObjectId(flags.after) : null, stopped: null, trialEnd: false };
  const started = Date.now();
  let lastReport = started;
  for (;;) {
    if (state.interrupted) {
      totals.stopped = 'interrupted';
      break;
    }
    if (flags.maxDocs !== undefined && state.scanned >= flags.maxDocs) {
      totals.stopped = `--max-docs=${flags.maxDocs} reached`;
      totals.trialEnd = true;
      break;
    }
    const batchStarted = Date.now();
    const want = flags.maxDocs !== undefined ? Math.min(flags.batch, flags.maxDocs - state.scanned) : flags.batch;
    const ids = await coll
      .find(totals.lastId ? { _id: { $gt: totals.lastId } } : {}, { projection: { _id: 1 }, readPreference: 'secondaryPreferred', maxTimeMS: 60_000 })
      .sort({ _id: 1 })
      .limit(want)
      .toArray();
    if (ids.length === 0) break;
    const firstId = ids[0]._id;
    const lastId = ids[ids.length - 1]._id;
    const result = await coll.updateMany(batchFilter(firstId, lastId, flags.scope), BATCH_UPDATE, {
      writeConcern: { w: 'majority', wtimeoutMS: 60_000 },
      maxTimeMS: 60_000,
    });
    totals.lastId = lastId;
    totals.scanned += ids.length;
    totals.modified += result.modifiedCount ?? 0;
    totals.batches++;
    state.scanned += ids.length;
    const batchMs = Date.now() - batchStarted;
    if (batchMs > flags.slowBatchMs) {
      totals.stopped = `a batch took ${fmt(batchMs)} ms (limit ${fmt(flags.slowBatchMs)} ms) — the database is busy`;
      break;
    }
    if (Date.now() - lastReport >= 30_000) {
      lastReport = Date.now();
      log(`  … ${coll.collectionName}: scanned ${fmt(totals.scanned)}, cleaned ${fmt(totals.modified)}, last _id ${lastId}`);
    }
    if (ids.length < want) break;
    await sleep(paceDelayMs(ids.length, batchMs, flags.docsPerSec));
  }
  totals.elapsedMs = Date.now() - started;
  return totals;
}

async function main(argv) {
  const flags = parseArgs(argv);
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/copypools_positions';
  console.log(`target: ${redactUri(uri)}`);
  console.log(
    `mode: ${flags.apply ? 'APPLY' : 'dry run'} — remove rawSubgraph from ${flags.scope === 'closed' ? 'CLOSED positions' : 'ALL positions'}` +
      `${flags.shard !== undefined ? `, shard ${flags.shard} only` : ''}; ${fmt(flags.docsPerSec)} docs/s, batches of ${fmt(flags.batch)}`,
  );
  const state = { interrupted: false, scanned: 0 };
  process.on('SIGINT', () => {
    if (state.interrupted) process.exit(130);
    state.interrupted = true;
    console.log('\nstopping after the current batch (Ctrl-C again to quit now) …');
  });
  await mongoose.connect(uri);
  let exitCode = 0;
  let finished = true;
  try {
    const db = mongoose.connection.db;
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    const shards = selectShards(names, flags.shard);
    if (shards.length === 0) {
      throw new Error(flags.shard !== undefined ? `no positions shard for chainId ${flags.shard} in ${db.databaseName}` : `no positions shards in ${db.databaseName}`);
    }
    let estDocs = 0;
    let estBytes = 0;
    let stillWriting = false;
    for (const name of shards) {
      const coll = db.collection(name);
      const total = await coll.estimatedDocumentCount();
      const sample = await sampleShard(coll, Math.min(DEFAULTS.sample, Math.max(1, total)));
      const writes = await backendStillWrites(coll);
      if (writes.carrying > 0) stillWriting = true;
      const share = sample.sampled > 0 ? sample.withField / sample.sampled : 0;
      const closedShare = sample.sampled > 0 ? sample.closedWithField / sample.sampled : 0;
      const avg = sample.withField > 0 ? sample.bytes / sample.withField : 0;
      const target = Math.round(total * (flags.scope === 'closed' ? closedShare : share));
      estDocs += target;
      estBytes += target * avg;
      console.log(
        `\n── ${name}: ~${fmt(total)} documents\n` +
          `  sample of ${fmt(sample.sampled)}: ${(share * 100).toFixed(1)}% carry rawSubgraph (${(closedShare * 100).toFixed(1)}% are closed rows carrying it), ` +
          `~${Math.round(avg)} B each\n` +
          `  this run would clean ~${fmt(target)} rows (~${mb(target * avg)} uncompressed); a full walk at ${fmt(flags.docsPerSec)} docs/s takes ~${duration(total / flags.docsPerSec)}\n` +
          `  open positions synced in the last 2 h still carrying it: ${writes.carrying} of ${writes.recent} checked`,
      );
    }
    console.log(`\ntotal: ~${fmt(estDocs)} rows to clean, ~${mb(estBytes)} uncompressed (estimates from samples)`);
    if (stillWriting) {
      console.log(
        '[warn] recently synced open positions still carry rawSubgraph: the running backend still WRITES it. ' +
          'Closed rows can be cleaned now; open rows only after the deploy.',
      );
      if (flags.scope === 'all' && flags.apply) {
        throw new Error('--scope=all refused: deploy the backend build that stops writing rawSubgraph first (it would put the field straight back)');
      }
    }
    if (!flags.apply) {
      console.log('\ndry run complete (re-run with --apply to write; run it off-peak, never during a backfill or a deploy)');
      return;
    }
    for (const name of shards) {
      if (state.interrupted) break;
      console.log(`\ncleaning ${name} …`);
      const totals = await cleanShard(db.collection(name), flags, state);
      console.log(
        `  ${name}: scanned ${fmt(totals.scanned)}, cleaned ${fmt(totals.modified)} in ${duration(totals.elapsedMs / 1000)}` +
          `${totals.lastId ? `; last _id ${totals.lastId}` : ''}`,
      );
      if (totals.stopped) {
        finished = false;
        if (!totals.trialEnd) exitCode = 2;
        console.log(`  STOPPED: ${totals.stopped}`);
        if (totals.lastId) console.log(`  resume with: --apply --shard=${chainIdOf(name)} --after=${totals.lastId}`);
        break;
      }
    }
    if (state.interrupted) finished = false;
    console.log(finished ? '\ndone: every selected shard was walked to its end' : '\nnot finished — see the resume line above');
  } finally {
    await mongoose.disconnect();
  }
  process.exitCode = exitCode;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    // One line, no stack: every throw here is a refusal or a bad flag, and the message says what to do.
    console.error(`error: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}
