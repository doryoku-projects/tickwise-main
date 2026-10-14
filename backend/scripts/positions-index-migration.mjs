#!/usr/bin/env node
// Positions index migration: builds the leaderboard "Set R" indexes and the
// background-job indexes on every `{chainId}_{protocol}_positions` shard BEFORE
// the code that hints and declares them is deployed, and — in a separate, later
// run — drops the seven legacy simple-collation metric indexes Set R supersedes.
//
// WHY SET R EXISTS. `findLeaderboard` sorts `{<metric>, positionId}` under the
// collation `{locale:'en', numericOrdering:true}`, and every index the schema
// declares today uses the DEFAULT collation and lacks `positionId`. MongoDB can
// only use an index to provide a sort on a string field when the index
// collation matches the query's, so every leaderboard page is an in-memory sort
// over the whole matching set (measured on a local 430k-doc shard: default APR
// view 3.1 s with a blocking SORT, Closed and All PnL ~44 s examining every doc;
// hinted onto these indexes, 8 ms and 1–4 ms, no SORT stage). Each Set R index
// leads with the `{chainId, protocol}` equality prefix, then the sort pair,
// then the fields the default views filter on, so the filter is applied to
// index keys before any fetch.
// The three rate sorts (APR / fee APR / ROI) are active-only by construction,
// so their indexes are PARTIAL on `{isActive:true}` — ~5.5x smaller than a
// full index (230k active entries vs 1.28M rows in prod).
//
// WHY THE BACKGROUND SET EXISTS. The refresh walk, the token-price universe, the
// referenced-pool list and the pool holder counts all filter `isActive:true`
// and then walk or distinct a second field. With no index on that pair they
// scan far more than they return (Phase B walk: 66,488 docs examined to return
// 5,000; the token universe fetched every active doc, likely the 42 s GETMORE
// seen on 4663). These carry NO collation, because those queries carry none.
// `bg_active_pool_owner` (2026-10-03) carries `owner` after `poolId`, so the
// holder count's `$group` reads keys only; it REPLACES `bg_active_pool` under a
// new name — built beside it, the old one dropped later by `--drop-legacy`.
//
// CRITICAL ORDERING. Run `--apply` BEFORE deploying the code that hints or
// declares these names. Mongoose `autoIndex` is ON in this app and a failed
// boot-time build is logged and SWALLOWED by `main.ts`'s `unhandledRejection`
// handler, so a deploy that declares an index the script has not built either
// builds it at boot on the primary (an unplanned full-collection scan during a
// deploy) or fails silently on a name/spec conflict. Run it off-peak with the
// pools cron paused (`POOLS_SYNC_CRON_ENABLED=false`): the build is one
// collection scan per shard, on every replica-set member.
//
// DEPLOY READINESS. Every run ends with a verdict over EVERY positions shard
// (not only the ones `--shard` targets): READY only when every declared
// Set R + background index exists as specified everywhere and no row has a
// missing/non-boolean `isActive`. `--shard` and `--skip-background` are for
// spreading the build out, not for stopping early: position.schema.ts declares
// all of them on every shard, so whatever is left unbuilt is either built by
// autoIndex on the PRIMARY at the next boot (where autoIndex is on — one
// collection scan per index per shard, all shards at once) or, in production
// (shard autoIndex OFF since 2026-10-03), stays missing and every query hinted
// to it falls back. An `--apply` run that ends NOT READY exits with code 3, so
// `--apply && deploy` stops there. The app repeats the check at boot
// (`[alert] positions.index_preflight` / `positions.index_mismatch`).
//
// ODD `isActive`. The deploy that hints these indexes changes the rate sorts
// (APR / fee APR / ROI on the Active and All tabs) from `isActive: {$ne:false}`
// to `isActive: true` — the partial indexes can only serve that exact equality.
// A row whose `isActive` is missing, null or not a boolean matched the old
// filter and does not match the new one, and every background reader (`bg_*`)
// skips it too. `--apply` therefore REFUSES while any target shard holds such
// rows; fix them (they should not exist — every Mongoose write sets the field)
// or pass `--allow-odd-isactive` to accept that they drop out.
//
// OVERLAP COST. From `--apply` until `--drop-legacy --apply` (≥ 48 h after the
// deploy) every shard carries the new indexes AND the legacy ones.
// Every reprice and every fee "served" write rewrites the rate / PnL / value
// metrics, so each such write updates 4–5 new collated keys on top of the
// legacy simple ones. Measured locally ($collStats, 796,574 docs over 4 shards,
// 2026-10-02): the new twelve 151 MB, the legacy seven 107 MB, all positions
// indexes 400 MB; scaled to prod's ~1.28M rows ≈ 243 MB new + 172 MB legacy ≈
// 642 MB of indexes against an M10's ~0.5 GB WiredTiger cache — the index set
// alone no longer fits. The
// diagnose prints the projected total against `maximum bytes configured`
// (needs `serverStatus`; it says when it cannot read it). Keep the overlap as
// short as the `$indexStats` evidence allows, and watch cache eviction and
// disk IOPS on the secondaries during it.
//
// SERVER VERSION. The token-universe read sends `hint` on `distinct`, which
// MongoDB accepts only from 7.1. Below that the app falls back unhinted
// (`[alert] positions.distinct_hint_unsupported`), so it is not a blocker, but
// the diagnose prints the version and warns.
//
// `--drop-legacy` is a DIFFERENT run, days later. The legacy set is the seven
// metric indexes Set R supersedes (`LEGACY_METRIC_INDEXES`) plus, since
// 2026-10-03, eight indexes no reader uses any more (`LEGACY_UNUSED_INDEXES`:
// `{…, isActive}`, `{…, metrics.performanceReady}`,
// `{…, createdAtTimestamp, positionId}`, `{…, lastVerifiedAt}`, the two
// `txSyncStatus` / `txFinalizedAt` ones, `bg_fee_hot` and the old
// `bg_active_pool`). It needs (1) every declared Set R + background index
// present on the shard (the replacements: `bg_active_walk` for `{…, isActive}`,
// `bg_active_pool_owner` for `bg_active_pool`, …), (2) the deploy that stops
// declaring the legacy indexes — where autoIndex is on it rebuilds them at the
// next boot — and (3) EVIDENCE: `$indexStats` ops on each index to drop that
// have not moved for ≥ 48 h on EVERY member. That is now enforced, not just
// printed: `--drop-legacy --record-evidence=<file>` snapshots every member's
// ops and `since` per legacy index into a local JSON file (no database write),
// and `--drop-legacy --apply --evidence=<file>` refuses unless that snapshot is
// at least 48 h old, was taken against the same target, and every member still
// reports the same `since` (no restart reset the counters) and the same ops for
// every index it would drop. `$indexStats` is PER MONGOD, and every user read
// runs `secondaryPreferred`, so the script reads it from EVERY replica-set
// member (a direct connection to each host `hello` lists) and refuses the drop
// when any member cannot be read or any member is still building a declared
// index. Run it from a machine that can reach each member.
//
// ROLLBACK. Until `--drop-legacy --apply`, rolling back to the previous image
// is free: it still declares the legacy indexes, they still exist, and it never
// hints the new ones. AFTER the drop, an image that still declares them AND
// runs autoIndex on the shards (any image from before 2026-10-03, when shard
// autoIndex went off in production) rebuilds every one on the primary at boot
// (one collection scan per index per shard, every shard at once — ~5 s for six
// on a 430k-doc local shard, far longer on a loaded M10) in the middle of the
// incident that prompted the rollback. So: drop the legacy indexes only once a
// rollback past this change is no longer an option, or roll back to an image
// that no longer declares them (or runs with shard autoIndex off).
//
// WHAT IT NEVER DOES: drop an index implicitly; build beside an index that
// already holds one of these names with a different spec, or the same key under
// a different name (both are reported as CONFLICT and abort `--apply` before
// anything is built on any shard); write anything without `--apply`.
//
// Usage: node scripts/positions-index-migration.mjs                       (diagnose)
//        node scripts/positions-index-migration.mjs --apply               (build)
//        …--apply --shard=4663                 (one shard only — NOT deploy-ready on its own)
//        …--apply --skip-background            (Set R only — NOT deploy-ready on its own)
//        …--apply --allow-odd-isactive         (build despite rows with a non-boolean isActive)
//        node scripts/positions-index-migration.mjs --drop-legacy         (drop dry run + evidence)
//        …--drop-legacy --record-evidence=ev.json   (dry run that also saves every member's $indexStats)
//        …--drop-legacy --apply --evidence=ev.json  (drop — only with a ≥ 48 h old snapshot that still matches)
// Non-local: MONGODB_URI=… node scripts/positions-index-migration.mjs
// (deliberately NO dotenv: a stray `.env` must not silently point this at prod)
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

export const KNOWN_FLAGS = [
  '--apply',
  '--drop-legacy',
  '--skip-background',
  '--allow-odd-isactive',
  '--shard=<chainId>',
  '--record-evidence=<file>',
  '--evidence=<file>',
];
/** A `--drop-legacy --apply` needs `$indexStats` evidence at least this old (ops unchanged since). */
export const DROP_EVIDENCE_MIN_AGE_MS = 48 * 60 * 60_000;
/** An `--apply` build run that leaves the deployment NOT READY exits with this code. */
export const NOT_READY_EXIT_CODE = 3;
/** `distinct` accepts `hint` from this server version on. */
export const DISTINCT_HINT_MIN_VERSION = Object.freeze([7, 1]);
/** The diagnose warns when the projected index set takes at least this share of the WiredTiger cache. */
export const CACHE_WARN_SHARE = 0.5;
/** Every positions shard and nothing else (`_position_transactions`, `_pools`, `{chainId}_tokens`). */
export const SHARD_COLLECTION_PATTERN = /^\d+_[a-z0-9_]+_positions$/;
/** EXACTLY the collation `findLeaderboard` queries with — anything else and the index cannot serve its sort. */
export const LEADERBOARD_COLLATION = Object.freeze({ locale: 'en', numericOrdering: true });
/**
 * Stated explicitly rather than omitted, so an index never inherits a collection
 * DEFAULT collation. The server normalises it to "no collation" (verified on
 * 8.0: listIndexes shows none), so a later schema declaration of the same name
 * and key with no collation option is a no-op against it, not a conflict.
 */
export const SIMPLE_COLLATION = Object.freeze({ locale: 'simple' });
/** `--apply` refuses unless free disk ≥ this × the estimated new index bytes. */
export const HEADROOM_FACTOR = 3;
export const SAMPLE_SIZE = 1000;

const PREFIX = Object.freeze({ chainId: 1, protocol: 1 });
const ACTIVE_ONLY = Object.freeze({ isActive: true });

const rateSortIndex = (name, metric) => ({
  name,
  set: 'R',
  key: { ...PREFIX, [metric]: -1, positionId: 1, 'metrics.inRange': 1, 'metrics.underlyingValueUsd': 1 },
  collation: LEADERBOARD_COLLATION,
  partialFilterExpression: ACTIVE_ONLY,
});
const fullSortIndex = (name, sortKey, rest) => ({
  name,
  set: 'R',
  key: { ...PREFIX, ...sortKey, positionId: 1, ...rest },
  collation: LEADERBOARD_COLLATION,
});
// Partial on isActive:true like the rate-sort indexes: every background reader
// (refresh walk, active-token / active-pool distinct, fee hot tier) filters on
// `isActive: true` exactly, and ~82% of positions are closed — a full index
// would be ~5x larger for rows no reader visits.
const backgroundIndex = (name, rest) => ({
  name,
  set: 'background',
  key: { ...PREFIX, ...rest },
  collation: SIMPLE_COLLATION,
  partialFilterExpression: ACTIVE_ONLY,
});

export const SET_R_SPECS = Object.freeze([
  rateSortIndex('lbr_apr_active', 'metrics.aprExGas'),
  rateSortIndex('lbr_feeapr_active', 'metrics.feeApr'),
  rateSortIndex('lbr_roi_active', 'metrics.roi'),
  fullSortIndex('lbr_pnl', { 'metrics.poolPnlUsd': -1 }, { isActive: 1, 'metrics.inRange': 1, 'metrics.underlyingValueUsd': 1 }),
  fullSortIndex('lbr_value', { 'metrics.underlyingValueUsd': -1 }, { isActive: 1, 'metrics.inRange': 1 }),
  // createdAtTimestamp and tokenId never change for a position, so these two
  // are not rewritten on every reprice (metrics.ageSeconds is re-stamped on
  // every write, which is why the age sort moves off it).
  fullSortIndex('lbr_created', { createdAtTimestamp: -1 }, { isActive: 1, 'metrics.inRange': 1 }),
  fullSortIndex('lbr_tokenid', { tokenId: 1 }, { isActive: 1, 'metrics.inRange': 1 }),
]);

export const BACKGROUND_SPECS = Object.freeze([
  backgroundIndex('bg_active_walk', { isActive: 1, positionId: 1, 'metrics.performanceReady': 1 }),
  backgroundIndex('bg_active_token0', { isActive: 1, 'token0.address': 1 }),
  backgroundIndex('bg_active_token1', { isActive: 1, 'token1.address': 1 }),
  // The pool modal's open positions and the pools list's holder counts; `owner`
  // in the key makes the holder count's `$group` index-only (2026-10-03).
  backgroundIndex('bg_active_pool_owner', { isActive: 1, poolId: 1, owner: 1 }),
]);

/**
 * The seven simple-collation metric indexes Set R supersedes — position.schema.ts
 * declares them unnamed, so these are MongoDB's generated names (verified
 * against a live shard). Matched by name AND key before any drop: an index that
 * merely carries one of these names is not proof it is the index meant here.
 */
export const LEGACY_METRIC_INDEXES = Object.freeze([
  { name: 'chainId_1_protocol_1_metrics.apr_-1', key: { ...PREFIX, 'metrics.apr': -1 } },
  { name: 'chainId_1_protocol_1_metrics.feeApr_-1', key: { ...PREFIX, 'metrics.feeApr': -1 } },
  { name: 'chainId_1_protocol_1_metrics.roi_-1', key: { ...PREFIX, 'metrics.roi': -1 } },
  { name: 'chainId_1_protocol_1_metrics.pnlUsd_-1', key: { ...PREFIX, 'metrics.pnlUsd': -1 } },
  { name: 'chainId_1_protocol_1_metrics.underlyingValueUsd_-1', key: { ...PREFIX, 'metrics.underlyingValueUsd': -1 } },
  { name: 'chainId_1_protocol_1_metrics.ageSeconds_-1', key: { ...PREFIX, 'metrics.ageSeconds': -1 } },
  { name: 'chainId_1_protocol_1_metrics.aprExGas_-1', key: { ...PREFIX, 'metrics.aprExGas': -1 } },
]);

/**
 * Indexes NO reader uses any more (scale plan 1.10 / D1, 2026-10-03), dropped
 * with the metric seven by `--drop-legacy`, under the same evidence rule.
 * position.schema.ts no longer declares any of them. `replacedBy` names the
 * declared index the former reader moved to (must be present before the drop;
 * `planLegacyDrop` requires EVERY declared index anyway).
 *  - `{…, isActive}`: /v1/stats' active count, now a COUNT_SCAN of `bg_active_walk`;
 *  - `{…, metrics.performanceReady}`: the refresh's pending split reads `bg_active_walk`'s keys;
 *  - `{…, createdAtTimestamp, positionId}`: an admin sample walk uses `lbr_created`;
 *  - `{…, lastVerifiedAt}`: read only by two dead repository methods (removed);
 *  - `{…, isActive, txSyncStatus, txLastSuccessAt}` / `{…, isActive, txFinalizedAt}`:
 *    the v3-only closed picker walks the positionId index (v4 never reaches it);
 *  - `bg_fee_hot`: the fee hot tier, off by default since 2026-10-03;
 *  - `bg_active_pool`: replaced by `bg_active_pool_owner`.
 */
export const LEGACY_UNUSED_INDEXES = Object.freeze([
  { name: 'chainId_1_protocol_1_isActive_1', key: { ...PREFIX, isActive: 1 }, replacedBy: 'bg_active_walk' },
  { name: 'chainId_1_protocol_1_metrics.performanceReady_1', key: { ...PREFIX, 'metrics.performanceReady': 1 }, replacedBy: 'bg_active_walk' },
  { name: 'chainId_1_protocol_1_createdAtTimestamp_1_positionId_1', key: { ...PREFIX, createdAtTimestamp: 1, positionId: 1 }, replacedBy: 'lbr_created' },
  { name: 'chainId_1_protocol_1_lastVerifiedAt_1', key: { ...PREFIX, lastVerifiedAt: 1 }, replacedBy: null },
  {
    name: 'chainId_1_protocol_1_isActive_1_txSyncStatus_1_txLastSuccessAt_1',
    key: { ...PREFIX, isActive: 1, txSyncStatus: 1, txLastSuccessAt: 1 },
    replacedBy: null,
  },
  { name: 'chainId_1_protocol_1_isActive_1_txFinalizedAt_1', key: { ...PREFIX, isActive: 1, txFinalizedAt: 1 }, replacedBy: null },
  { name: 'bg_fee_hot', key: { ...PREFIX, isActive: 1, 'metrics.inRange': 1, tokenId: 1 }, partialFilterExpression: ACTIVE_ONLY, replacedBy: null },
  { name: 'bg_active_pool', key: { ...PREFIX, isActive: 1, poolId: 1 }, partialFilterExpression: ACTIVE_ONLY, replacedBy: 'bg_active_pool_owner' },
]);

/** Everything `--drop-legacy` may drop: the metric seven, then the unused eight. */
export const LEGACY_INDEXES = Object.freeze([...LEGACY_METRIC_INDEXES, ...LEGACY_UNUSED_INDEXES]);

// ── argument parsing ─────────────────────────────────────────────────────────

/**
 * A typo'd flag must not read as "the operator declined the option" — that is
 * how someone concludes the build was skipped deliberately, or that a drop ran
 * when it did not. `--shard 1` (space-separated) is rejected for the same
 * reason: it would otherwise silently mean "every shard".
 */
export function parseArgs(argv) {
  const flags = {
    apply: false,
    dropLegacy: false,
    skipBackground: false,
    allowOddIsActive: false,
    shard: undefined,
    recordEvidence: undefined,
    evidence: undefined,
  };
  const unknown = [];
  const pathFlag = (arg, prefix) => {
    const value = arg.slice(prefix.length);
    if (!value) throw new Error(`${prefix}<file> needs a file path`);
    return value;
  };
  for (const arg of argv) {
    if (arg === '--apply') flags.apply = true;
    else if (arg === '--drop-legacy') flags.dropLegacy = true;
    else if (arg === '--skip-background') flags.skipBackground = true;
    else if (arg === '--allow-odd-isactive') flags.allowOddIsActive = true;
    else if (arg.startsWith('--record-evidence=')) flags.recordEvidence = pathFlag(arg, '--record-evidence=');
    else if (arg.startsWith('--evidence=')) flags.evidence = pathFlag(arg, '--evidence=');
    else if (arg.startsWith('--shard=')) {
      const raw = arg.slice('--shard='.length);
      if (!/^\d+$/.test(raw)) throw new Error(`--shard expects a numeric chainId (e.g. --shard=4663), got "${raw}"`);
      const chainId = Number(raw);
      if (flags.shard !== undefined && flags.shard !== chainId) {
        throw new Error(`--shard given twice with different values (${flags.shard}, ${chainId})`);
      }
      flags.shard = chainId;
    } else {
      unknown.push(arg);
    }
  }
  if (unknown.length > 0) {
    throw new Error(`unrecognized argument(s): ${unknown.join(' ')} — known flags are ${KNOWN_FLAGS.join(' ')}`);
  }
  if ((flags.recordEvidence || flags.evidence) && !flags.dropLegacy) {
    throw new Error('--record-evidence / --evidence belong to --drop-legacy');
  }
  if (flags.recordEvidence && flags.apply) {
    throw new Error('--record-evidence is a dry-run step: record now, drop ≥ 48 h later with --apply --evidence=<file>');
  }
  return flags;
}

export const chainIdOf = (collectionName) => Number(collectionName.split('_')[0]);

/** Positions shards, ordered by chainId, optionally narrowed to one chain. */
export function selectShards(collectionNames, shard) {
  return collectionNames
    .filter((name) => SHARD_COLLECTION_PATTERN.test(name))
    .filter((name) => shard === undefined || chainIdOf(name) === shard)
    .sort((a, b) => chainIdOf(a) - chainIdOf(b) || a.localeCompare(b));
}

// ── spec comparison ──────────────────────────────────────────────────────────

const ICU_DEFAULTS = Object.freeze({
  caseLevel: false,
  caseFirst: 'off',
  strength: 3,
  numericOrdering: false,
  alternate: 'non-ignorable',
  maxVariable: 'punct',
  normalization: false,
  backwards: false,
});

/**
 * `listIndexes` returns the FULLY expanded collation (every ICU option plus a
 * server-assigned `version`), while a spec states two fields. Expand both to the
 * same shape before comparing; `version` is dropped because it describes the
 * server's ICU build, not the index's ordering. Simple collation → null.
 */
export function normalizeCollation(collation) {
  if (!collation || collation.locale === 'simple') return null;
  const normalized = { locale: collation.locale };
  for (const [option, fallback] of Object.entries(ICU_DEFAULTS)) normalized[option] = collation[option] ?? fallback;
  return normalized;
}

/** Stable JSON with sorted object keys — for option objects whose key order carries no meaning. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const keyDirection = (value) => {
  const n = Number(value);
  return Number.isNaN(n) ? String(value) : String(n);
};

/** Key patterns are ORDERED: `{a:1,b:1}` and `{b:1,a:1}` are different indexes. */
export function sameKey(a, b) {
  const ea = Object.entries(a ?? {});
  const eb = Object.entries(b ?? {});
  return ea.length === eb.length && ea.every(([field, dir], i) => eb[i][0] === field && keyDirection(eb[i][1]) === keyDirection(dir));
}

export const formatKey = (key) =>
  `{${Object.entries(key ?? {})
    .map(([field, dir]) => `${field}:${keyDirection(dir)}`)
    .join(', ')}}`;

/** Human-readable differences between a wanted spec and an existing index; [] means identical. */
export function specDifferences(spec, existing) {
  const diffs = [];
  if (!sameKey(spec.key, existing.key)) diffs.push(`key ${formatKey(existing.key)} (want ${formatKey(spec.key)})`);
  const wantCollation = normalizeCollation(spec.collation);
  const haveCollation = normalizeCollation(existing.collation);
  if (canonical(wantCollation) !== canonical(haveCollation)) {
    diffs.push(`collation ${haveCollation ? canonical(haveCollation) : 'simple'} (want ${wantCollation ? canonical(wantCollation) : 'simple'})`);
  }
  if (canonical(existing.partialFilterExpression ?? null) !== canonical(spec.partialFilterExpression ?? null)) {
    diffs.push(
      `partialFilterExpression ${canonical(existing.partialFilterExpression ?? null)} (want ${canonical(spec.partialFilterExpression ?? null)})`,
    );
  }
  for (const option of ['unique', 'sparse']) {
    if (Boolean(existing[option]) !== Boolean(spec[option])) diffs.push(`${option}=${Boolean(existing[option])}`);
  }
  if (existing.expireAfterSeconds !== undefined) diffs.push(`expireAfterSeconds=${existing.expireAfterSeconds}`);
  // A hidden index is invisible to the planner AND to hints, so for the
  // purpose these serve it is not present; unhiding it is a deliberate act.
  if (existing.hidden) diffs.push('hidden=true');
  return diffs;
}

/**
 * present / missing / conflict for one spec against a shard's `listIndexes`.
 *
 * Two conflict shapes, and both abort `--apply`:
 *  - SAME NAME, different spec — building would throw IndexOptionsConflict /
 *    IndexKeySpecsConflict, and the hint the deploy relies on would land on an
 *    index that cannot serve it;
 *  - SAME KEY, different name — an identical spec under another name makes
 *    MongoDB refuse ours outright, and the same key with different options
 *    would leave two near-identical indexes paying for every write.
 */
export function classifySpec(spec, existingIndexes) {
  const byName = existingIndexes.find((ix) => ix.name === spec.name);
  if (byName) {
    const diffs = specDifferences(spec, byName);
    if (diffs.length === 0) return { spec, status: 'present', existing: byName };
    return { spec, status: 'conflict', existing: byName, reason: `'${spec.name}' exists with a different spec: ${diffs.join('; ')}` };
  }
  const byKey = existingIndexes.find((ix) => sameKey(ix.key, spec.key));
  if (byKey) {
    const diffs = specDifferences(spec, byKey);
    return {
      spec,
      status: 'conflict',
      existing: byKey,
      reason:
        diffs.length === 0
          ? `the same index already exists as '${byKey.name}' — MongoDB refuses a second name for an identical spec; rename one deliberately`
          : `'${byKey.name}' has the same key with different options (${diffs.join('; ')})`,
    };
  }
  return { spec, status: 'missing' };
}

/**
 * Classify both sets and decide what one `createIndexes` would carry. A conflict
 * blocks only when its set is being built — with `--skip-background`, a
 * background conflict is reported and does not hold Set R hostage.
 */
export function planShard(existingIndexes, { skipBackground = false } = {}) {
  const setR = SET_R_SPECS.map((spec) => classifySpec(spec, existingIndexes));
  const background = BACKGROUND_SPECS.map((spec) => classifySpec(spec, existingIndexes));
  const inScope = skipBackground ? setR : [...setR, ...background];
  return {
    setR,
    background,
    toBuild: inScope.filter((c) => c.status === 'missing').map((c) => c.spec),
    conflicts: inScope.filter((c) => c.status === 'conflict'),
  };
}

// ── size estimate ────────────────────────────────────────────────────────────

/**
 * Per-entry overhead beyond the key values: the RecordId plus WiredTiger cell
 * framing. Calibrated against a freshly built 430k-doc local shard: every one of
 * its 19 indexes came in UNDER this model (estimate/actual 1.03–10.7x; see
 * `sharedLeadingFields` for the one discount it takes). An index bloated by
 * update churn can exceed it (one came in at 0.85x), which a fresh build is
 * not. Repeated strings are NOT discounted, so address-keyed indexes estimate
 * several times their built size — high is the safe direction for a
 * disk-headroom gate.
 */
export const ENTRY_OVERHEAD_BYTES = 8;

/**
 * The leading run of key fields that adjacent index entries share byte-for-byte:
 * fields constant across the sample (`chainId`, `protocol` — identical on every
 * key of a shard) and booleans directly after them (`isActive` changes value
 * once in the whole index). WiredTiger prefix-compresses index keys against the
 * previous key, so these cost ~nothing; counting them overstated the built size
 * of the existing indexes 2–13x. The run stops at the first varying field,
 * because after it nothing is shared.
 */
export function sharedLeadingFields(spec, docs) {
  const shared = [];
  if (docs.length === 0) return shared;
  for (const field of Object.keys(spec.key)) {
    const values = docs.map((doc) => getPath(doc, field));
    const constant = values.every((value) => value === values[0]);
    const boolean = values.every((value) => typeof value === 'boolean');
    if (!constant && !boolean) break;
    shared.push(field);
  }
  return shared;
}

/** Approximate KeyString bytes for one key value. */
export function estimateValueBytes(value, collated) {
  if (value === undefined || value === null || typeof value === 'boolean') return 1;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Math.abs(value) < 2 ** 31) return 5;
    return 10;
  }
  if (typeof value === 'string') {
    // A collated string is stored as its ICU sort key, not its bytes; with
    // numericOrdering each digit run becomes a numeric primary, so hex ids grow.
    return collated ? Math.ceil(value.length * 1.5) + 4 : value.length + 2;
  }
  if (value instanceof Date) return 9;
  return 16;
}

export const getPath = (doc, path) => path.split('.').reduce((node, part) => (node == null ? undefined : node[part]), doc);

/** Only the equality filters these specs use (`{isActive:true}`) — anything else is refused, not guessed. */
export function matchesPartialFilter(filter, doc) {
  return Object.entries(filter).every(([path, want]) => {
    if (want !== null && typeof want === 'object') throw new Error(`size estimate supports only equality partial filters, got ${canonical(filter)}`);
    return getPath(doc, path) === want;
  });
}

export function estimateKeyBytes(spec, doc, sharedFields = []) {
  const collated = normalizeCollation(spec.collation) !== null;
  let bytes = ENTRY_OVERHEAD_BYTES;
  for (const field of Object.keys(spec.key)) {
    if (!sharedFields.includes(field)) bytes += estimateValueBytes(getPath(doc, field), collated);
  }
  return bytes;
}

/** Fallback per-entry size when a non-empty shard returned no sample (e.g. it was empty a moment ago). */
export const FALLBACK_KEY_BYTES = 128;

/**
 * Sampled average key size × entries. A partial index has one entry per doc
 * matching its filter (the shard's active count), a full index one per doc.
 */
export function estimateSpecBytes(spec, sampleDocs, { totalCount, activeCount }) {
  const partial = Boolean(spec.partialFilterExpression);
  const entries = partial ? activeCount : totalCount;
  if (!entries) return { entries: 0, avgKeyBytes: 0, bytes: 0 };
  const eligible = partial ? sampleDocs.filter((doc) => matchesPartialFilter(spec.partialFilterExpression, doc)) : sampleDocs;
  // Inactive docs carry the same field types, so they are a fair stand-in when
  // the sample happened to contain no active ones.
  const basis = eligible.length > 0 ? eligible : sampleDocs;
  if (basis.length === 0) return { entries, avgKeyBytes: FALLBACK_KEY_BYTES, bytes: FALLBACK_KEY_BYTES * entries };
  const shared = sharedLeadingFields(spec, basis);
  const avgKeyBytes = basis.reduce((sum, doc) => sum + estimateKeyBytes(spec, doc, shared), 0) / basis.length;
  return { entries, avgKeyBytes, bytes: Math.ceil(avgKeyBytes * entries) };
}

/** Every field any spec indexes — the `$sample` projection. */
export const SAMPLE_PROJECTION = Object.freeze(
  Object.fromEntries([...SET_R_SPECS, ...BACKGROUND_SPECS].flatMap((spec) => Object.keys(spec.key)).map((field) => [field, 1])),
);

// ── gates ────────────────────────────────────────────────────────────────────

/**
 * Disk headroom. An index build needs room for the new files AND for its
 * external-sort spill, and the M10 has hit its disk limit before. Unreadable fs
 * stats refuse a non-empty build rather than wave it through.
 */
export function checkHeadroom(fsStats, estimateBytes, factor = HEADROOM_FACTOR) {
  const requiredBytes = Math.ceil(estimateBytes * factor);
  const used = Number(fsStats?.fsUsedSize);
  const total = Number(fsStats?.fsTotalSize);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return {
      ok: estimateBytes === 0,
      freeBytes: null,
      requiredBytes,
      reason: 'dbStats did not report fsUsedSize/fsTotalSize, so free disk cannot be verified',
    };
  }
  const freeBytes = total - used;
  return {
    ok: freeBytes >= requiredBytes,
    freeBytes,
    requiredBytes,
    reason: `free ${formatBytes(freeBytes)} vs required ${formatBytes(requiredBytes)} (${factor}x estimate ${formatBytes(estimateBytes)})`,
  };
}

/**
 * Whether `--drop-legacy` may drop on this shard, and exactly which names. Every
 * declared index (`requiredClassifications`: Set R AND the background set —
 * the replacements of the unused legacy ones live there) must be PRESENT (a
 * conflict, or an index still building on ANY member, is not): dropping first
 * would leave a reader with no index at all. And the usage evidence must come
 * from EVERY member: `$indexStats` is per mongod, and the user reads that would
 * still touch a legacy index run on the secondaries, so a member that could not
 * be read refuses the drop. A legacy index is dropped only when it exists
 * EXACTLY as listed in `LEGACY_INDEXES` (name, key, collation, partial filter):
 * an index that merely carries one of these names is not proof it is the one
 * meant here.
 */
export function planLegacyDrop(requiredClassifications, existingIndexes, indexStatsByName, { unreadableMembers = [] } = {}) {
  if (!indexStatsByName) {
    return { allowed: false, reason: '$indexStats is unavailable, so there is no usage evidence to show', toDrop: [], absent: [] };
  }
  if (unreadableMembers.length > 0) {
    return {
      allowed: false,
      reason: `$indexStats could not be read on ${unreadableMembers.join(', ')} — every member's counters are the evidence (user reads run on the secondaries)`,
      toDrop: [],
      absent: [],
    };
  }
  const notReady = requiredClassifications.filter((c) => c.status !== 'present' || indexStatsByName.get(c.spec.name)?.building);
  if (notReady.length > 0) {
    const detail = notReady.map((c) => `${c.spec.name}=${c.status === 'present' ? 'building' : c.status}`).join(', ');
    return { allowed: false, reason: `the declared Set R / background indexes are not complete on this shard (${detail})`, toDrop: [], absent: [] };
  }
  const toDrop = [];
  const absent = [];
  const mismatched = [];
  for (const legacy of LEGACY_INDEXES) {
    const existing = existingIndexes.find((ix) => ix.name === legacy.name);
    if (!existing) absent.push(legacy.name);
    else if (specDifferences(legacy, existing).length > 0) mismatched.push(`${legacy.name} ${formatKey(existing.key)}`);
    else toDrop.push(legacy.name);
  }
  if (mismatched.length > 0) {
    return {
      allowed: false,
      reason: `an index carries a legacy name with a different spec, so it is not the index meant to be dropped: ${mismatched.join('; ')}`,
      toDrop: [],
      absent,
    };
  }
  return { allowed: true, reason: null, toDrop, absent };
}

// ── drop evidence ────────────────────────────────────────────────────────────

/** Per-member `{ops, since}` of one merged `$indexStats` entry (a single merged row when no split was kept). */
function memberStats(stats) {
  if (!stats) return [];
  if (Array.isArray(stats.perMember) && stats.perMember.length > 0) return stats.perMember;
  return [{ host: '(merged)', ops: stats.ops, since: stats.since }];
}

const sinceMs = (since) => (since === undefined || since === null ? null : new Date(since).getTime());

/**
 * The evidence snapshot `--drop-legacy --record-evidence=<file>` writes: for
 * every legacy index present on every shard, each member's `$indexStats` ops
 * and `since`. No database write — a local JSON file the operator keeps for
 * ≥ 48 h, then hands to `--drop-legacy --apply --evidence=<file>`.
 */
export function buildDropEvidence(reports, { target, takenAt = new Date() }) {
  const shards = {};
  for (const report of reports) {
    const names = new Set(report.indexes.map((ix) => ix.name));
    const entry = {};
    for (const legacy of LEGACY_INDEXES) {
      if (!names.has(legacy.name)) continue;
      const members = {};
      for (const member of memberStats(report.indexStats?.get(legacy.name))) {
        members[member.host] = { ops: Number(member.ops ?? 0), since: member.since ? new Date(member.since).toISOString() : null };
      }
      entry[legacy.name] = { members };
    }
    shards[report.name] = entry;
  }
  return { version: 1, takenAt: new Date(takenAt).toISOString(), target, minAgeMs: DROP_EVIDENCE_MIN_AGE_MS, shards };
}

/**
 * Whether a recorded snapshot proves that every index about to be dropped went
 * unused for ≥ `DROP_EVIDENCE_MIN_AGE_MS`: the snapshot is old enough, was taken
 * against the same target, and EVERY member — the same set of members — still
 * reports the same `since` (no restart reset its counters in between) and the
 * same ops for every index in `plans[].plan.toDrop`. Anything else is a
 * problem, and one problem refuses the whole drop.
 */
export function checkDropEvidence(evidence, plans, { target, now = Date.now() } = {}) {
  const problems = [];
  if (!evidence || evidence.version !== 1 || !evidence.shards || !evidence.takenAt) {
    return { ok: false, problems: ['no usable evidence snapshot (record one with --drop-legacy --record-evidence=<file>)'] };
  }
  const takenAt = new Date(evidence.takenAt).getTime();
  if (!Number.isFinite(takenAt)) problems.push('the evidence snapshot has no valid takenAt');
  else if (now - takenAt < DROP_EVIDENCE_MIN_AGE_MS) {
    problems.push(
      `the evidence snapshot is only ${((now - takenAt) / 3_600_000).toFixed(1)} h old — it must be at least ${DROP_EVIDENCE_MIN_AGE_MS / 3_600_000} h`,
    );
  }
  if (target !== undefined && evidence.target !== target) problems.push(`the evidence was recorded against ${evidence.target}, not ${target}`);
  for (const { report, plan } of plans) {
    for (const name of plan.toDrop) {
      const recorded = evidence.shards[report.name]?.[name]?.members;
      if (!recorded) {
        problems.push(`${report.name}: no evidence recorded for ${name}`);
        continue;
      }
      const current = memberStats(report.indexStats?.get(name));
      const currentHosts = new Set(current.map((m) => m.host));
      for (const host of Object.keys(recorded)) {
        if (!currentHosts.has(host)) problems.push(`${report.name}: ${name} — member ${host} is in the snapshot but did not answer now`);
      }
      for (const member of current) {
        const before = recorded[member.host];
        if (!before) {
          problems.push(`${report.name}: ${name} — member ${member.host} is not in the snapshot`);
        } else if (sinceMs(before.since) !== sinceMs(member.since)) {
          problems.push(`${report.name}: ${name} — ${member.host}'s counters were reset since the snapshot (a restart): record new evidence`);
        } else if (Number(before.ops) !== Number(member.ops ?? 0)) {
          problems.push(`${report.name}: ${name} — USED since the snapshot on ${member.host} (ops ${before.ops} → ${member.ops}): something still reads it`);
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── members, server, overlap, readiness ─────────────────────────────────────

/**
 * The members whose `$indexStats` counters matter, from `hello`: `hosts`
 * (electable) and `passives` (priority 0 — e.g. Atlas analytics nodes).
 * Hidden members are not listed, and serve no `secondaryPreferred` read;
 * arbiters hold no data. Null for a standalone (no `setName`): the one
 * connection IS the member.
 */
export function memberHosts(hello) {
  if (!hello?.setName) return null;
  return [...new Set([...(hello.hosts ?? []), ...(hello.passives ?? [])])];
}

/**
 * Options for a DIRECT connection to one member, carrying the main client's
 * credentials and TLS settings — read off the CONNECTED client, so an SRV URI's
 * implied TLS and `authSource` come along without re-parsing the URI.
 */
export function memberClientOptions(options) {
  const out = { directConnection: true, serverSelectionTimeoutMS: 15_000, readPreference: 'secondaryPreferred' };
  const credentials = options?.credentials;
  if (credentials?.username) {
    out.auth = { username: credentials.username, password: credentials.password };
    if (credentials.source) out.authSource = credentials.source;
    if (credentials.mechanism && credentials.mechanism !== 'DEFAULT') out.authMechanism = credentials.mechanism;
  }
  for (const option of ['tls', 'tlsCAFile', 'tlsCertificateKeyFile', 'tlsAllowInvalidCertificates', 'tlsAllowInvalidHostnames']) {
    if (options?.[option] !== undefined) out[option] = options[option];
  }
  return out;
}

/**
 * `$indexStats` rows from every member, merged per index: ops SUMMED (each
 * mongod counts only what it served), `building` when ANY member is still
 * building, the earliest `since`, and the per-member split kept for printing.
 * `perMember` is `[{ host, rows }]`.
 */
export function mergeMemberIndexStats(perMember) {
  const byName = new Map();
  for (const { host, rows } of perMember) {
    for (const row of rows) {
      const ops = Number(row.accesses?.ops ?? 0);
      const since = row.accesses?.since;
      const building = Boolean(row.building);
      const entry = byName.get(row.name) ?? { ops: 0, since: undefined, building: false, perMember: [] };
      entry.ops += ops;
      if (since && (!entry.since || since < entry.since)) entry.since = since;
      entry.building = entry.building || building;
      entry.perMember.push({ host, ops, since, building });
      byName.set(row.name, entry);
    }
  }
  return byName;
}

/** Whether `distinct` accepts `hint` on a server reporting this `buildInfo.versionArray`; null when unknown. */
export function distinctHintSupported(versionArray) {
  if (!Array.isArray(versionArray) || versionArray.length < 2) return null;
  const [major, minor] = versionArray.map(Number);
  const [wantMajor, wantMinor] = DISTINCT_HINT_MIN_VERSION;
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

/**
 * The index bytes the overlap window carries — the positions shards' indexes
 * now plus the estimated build — against the WiredTiger cache. `cacheBytes`
 * null/0 = unknown (no `serverStatus` privilege).
 */
export function overlapReport({ currentIndexBytes, buildBytes, legacyIndexBytes, cacheBytes }) {
  const projectedBytes = (Number(currentIndexBytes) || 0) + (Number(buildBytes) || 0);
  const cache = Number(cacheBytes) > 0 ? Number(cacheBytes) : null;
  const share = cache ? projectedBytes / cache : null;
  return { projectedBytes, legacyIndexBytes: Number(legacyIndexBytes) || 0, cacheBytes: cache, share, warn: share !== null && share >= CACHE_WARN_SHARE };
}

/**
 * Deploy readiness over EVERY positions shard, whatever this run was narrowed
 * to: every declared Set R + background index present exactly as specified (position.schema.ts
 * declares both sets on every shard, and autoIndex builds whatever is missing
 * on the primary at boot), and no row with a non-boolean `isActive` unless the
 * operator accepted that. `shards` is `[{ name, indexes, oddIsActiveCount }]`.
 */
export function deployReadiness(shards, { allowOddIsActive = false } = {}) {
  const problems = [];
  for (const shard of shards) {
    const plan = planShard(shard.indexes ?? [], { skipBackground: false });
    const classified = [...plan.setR, ...plan.background];
    const missing = classified.filter((c) => c.status === 'missing').map((c) => c.spec.name);
    const conflicts = classified.filter((c) => c.status === 'conflict').map((c) => c.spec.name);
    const oddIsActiveCount = allowOddIsActive ? 0 : Number(shard.oddIsActiveCount ?? 0);
    if (missing.length > 0 || conflicts.length > 0 || oddIsActiveCount > 0) problems.push({ name: shard.name, missing, conflicts, oddIsActiveCount });
  }
  return { ready: problems.length === 0, problems };
}

/**
 * The process exit code: an `--apply` BUILD run that leaves the deployment NOT
 * READY (a narrowed run, a build that left something missing) exits non-zero so
 * a scripted `--apply && deploy` stops. A diagnose only reports.
 */
export function exitCodeFor(flags, readiness) {
  return flags.apply && !flags.dropLegacy && readiness && !readiness.ready ? NOT_READY_EXIT_CODE : 0;
}

/**
 * Legacy declarations still present in position.schema.ts. Dropping them while
 * the code still declares them is wasted work at best: where autoIndex is on it
 * rebuilds them on the primary at the next boot. An unnamed one is matched by
 * its key literal (`.index({ chainId: 1, protocol: 1, <field>: <dir>, … })`,
 * fields quoted or not, across lines, options or not); a named one
 * (`bg_fee_hot`, `bg_active_pool`) by its `name: '…'` option. This reads the
 * REPO's source, not the deployed build, so an empty answer is necessary
 * rather than sufficient.
 */
export function legacyDeclarationsInSource(source) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return LEGACY_INDEXES.filter((legacy) => {
    if (!legacy.name.startsWith('chainId_')) {
      return new RegExp(`name:\\s*['"]${escape(legacy.name)}['"]`).test(source);
    }
    const fields = Object.entries(legacy.key).map(([field, dir]) => `(?:'${escape(field)}'|"${escape(field)}"|${escape(field)}):\\s*${escape(String(dir))}`);
    return new RegExp(`\\.index\\(\\s*\\{\\s*${fields.join('\\s*,\\s*')}\\s*,?\\s*\\}\\s*[,)]`).test(source);
  }).map((legacy) => legacy.name);
}

/**
 * ONE command per shard, so every missing index is built from a single
 * collection scan. A raw `createIndexes` rather than the helper so each index
 * keeps its own collation and partial filter. No `commitQuorum`: the default
 * (all voting members) is the right one, and a standalone rejects the field.
 */
export function buildCreateIndexesCommand(collectionName, specs) {
  return {
    createIndexes: collectionName,
    indexes: specs.map((spec) => {
      const index = { key: { ...spec.key }, name: spec.name };
      if (spec.collation) index.collation = { ...spec.collation };
      if (spec.partialFilterExpression) index.partialFilterExpression = { ...spec.partialFilterExpression };
      return index;
    }),
  };
}

// ── formatting ───────────────────────────────────────────────────────────────

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return 'n/a';
  const n = Number(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(n);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${n < 0 ? '-' : ''}${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

const formatInt = (n) => (n === null || n === undefined ? 'n/a' : Number(n).toLocaleString('en-US'));
const formatDate = (value) => (value instanceof Date ? value.toISOString() : String(value ?? 'unknown'));
export const redactUri = (uri) => uri.replace(/\/\/[^@/]*@/, '//<credentials>@');

const STATUS_LABEL = { present: 'present', missing: 'MISSING', conflict: 'CONFLICT' };

const tally = (classifications) => {
  const count = (status) => classifications.filter((c) => c.status === status).length;
  return `${count('present')}/${count('missing')}/${count('conflict')}`;
};

// ── database side ────────────────────────────────────────────────────────────

/**
 * `$indexStats` for one collection from every member (`members` is
 * `[{ host, db }]`; one entry for a standalone). The merged map is null when
 * no member answered; `unreadableMembers` names the ones that did not.
 */
async function readIndexStats(members, collectionName) {
  const perMember = [];
  const unreadableMembers = [];
  for (const { host, db } of members) {
    try {
      perMember.push({ host, rows: await db.collection(collectionName).aggregate([{ $indexStats: {} }]).toArray() });
    } catch (err) {
      console.log(`  $indexStats unavailable on ${host}: ${err.message}`);
      unreadableMembers.push(host);
    }
  }
  return { indexStats: perMember.length > 0 ? mergeMemberIndexStats(perMember) : null, unreadableMembers };
}

/**
 * One database handle per replica-set member, for the per-mongod `$indexStats`
 * (a direct connection to each host `hello` lists). A standalone's one
 * connection is its only member. A member that cannot be reached is returned in
 * `unreachable`, which refuses `--drop-legacy` and is reported by diagnose.
 */
export async function connectMembers(client, adminDb, primaryDb, MongoClient = mongoose.mongo.MongoClient) {
  let hello;
  try {
    hello = await adminDb.command({ hello: 1 });
  } catch (err) {
    console.log(`members: hello failed (${err.message}) — reading $indexStats from this connection only`);
    return { members: [{ host: '(this connection)', db: primaryDb }], unreachable: [], clients: [], replicaSet: null };
  }
  const hosts = memberHosts(hello);
  if (!hosts) return { members: [{ host: '(standalone)', db: primaryDb }], unreachable: [], clients: [], replicaSet: null };
  const options = memberClientOptions(client.options);
  const members = [];
  const unreachable = [];
  const clients = [];
  for (const host of hosts) {
    const memberClient = new MongoClient(`mongodb://${host}/`, options);
    try {
      await memberClient.connect();
      clients.push(memberClient);
      members.push({ host, db: memberClient.db(primaryDb.databaseName) });
    } catch (err) {
      console.log(`members: cannot connect directly to ${host}: ${err.message}`);
      unreachable.push(host);
      await memberClient.close().catch(() => {});
    }
  }
  return { members, unreachable, clients, replicaSet: hello.setName };
}

/** Server version and WiredTiger cache size, best-effort (`serverStatus` needs clusterMonitor). */
async function inspectServer(adminDb) {
  const out = { version: null, versionArray: null, cacheBytes: null, cacheError: null };
  try {
    const info = await adminDb.command({ buildInfo: 1 });
    out.version = info.version ?? null;
    out.versionArray = info.versionArray ?? null;
  } catch (err) {
    out.versionError = err.message;
  }
  try {
    const status = await adminDb.command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0 });
    out.cacheBytes = Number(status?.wiredTiger?.cache?.['maximum bytes configured']) || null;
    if (!out.cacheBytes) out.cacheError = 'serverStatus reported no wiredTiger.cache';
  } catch (err) {
    out.cacheError = err.message;
  }
  return out;
}

function printServer(server, memberSet) {
  const supported = distinctHintSupported(server.versionArray);
  console.log(
    `server: MongoDB ${server.version ?? `unknown (${server.versionError})`} — distinct accepts hint: ${supported === null ? 'unknown' : supported ? 'yes' : 'NO'}`,
  );
  if (supported === false) {
    console.log(
      `  [warn] below ${DISTINCT_HINT_MIN_VERSION.join('.')}: the token-universe read falls back unhinted (the app alerts ` +
        'positions.distinct_hint_unsupported once) — not a blocker, but the bg_active_token* indexes then go unused by it',
    );
  }
  console.log(
    `members: ${memberSet.replicaSet ? `replica set ${memberSet.replicaSet}, ` : ''}$indexStats read from ${memberSet.members.map((m) => m.host).join(', ') || 'no member'}` +
      (memberSet.unreachable.length > 0 ? ` — UNREACHABLE: ${memberSet.unreachable.join(', ')}` : ''),
  );
}

async function readStorage(collection) {
  try {
    const [row] = await collection.aggregate([{ $collStats: { storageStats: { scale: 1 } } }]).toArray();
    return row?.storageStats ?? null;
  } catch (err) {
    console.log(`  $collStats unavailable: ${err.message}`);
    return null;
  }
}

/**
 * Counts and estimate inputs for one shard. Every count carries the
 * `{chainId, protocol}` prefix: every index on these collections is prefixed by
 * that pair, and a bare `{isActive: …}` filter matches no prefix and COLLSCANs.
 */
async function countOddIsActive(collection, chainId, protocols) {
  let odd = 0;
  for (const protocol of protocols) odd += await collection.countDocuments({ chainId, protocol, isActive: { $nin: [true, false] } });
  return odd;
}

/**
 * What the readiness verdict and the overlap total need from a shard this run
 * does NOT target (`--shard`): its indexes, sizes and odd-`isActive` count —
 * no sample, no estimate, no `$indexStats`.
 */
async function inspectShardLight(db, name) {
  const collection = db.collection(name);
  const chainId = chainIdOf(name);
  const protocols = await collection.distinct('protocol', { chainId });
  return { name, indexes: await collection.indexes(), storage: await readStorage(collection), oddIsActiveCount: await countOddIsActive(collection, chainId, protocols) };
}

async function inspectShard(db, name, flags, memberSet) {
  const collection = db.collection(name);
  const chainId = chainIdOf(name);
  const totalCount = await collection.estimatedDocumentCount();
  const protocols = await collection.distinct('protocol', { chainId });
  let activeCount = 0;
  for (const protocol of protocols) activeCount += await collection.countDocuments({ chainId, protocol, isActive: true });
  const oddIsActiveCount = await countOddIsActive(collection, chainId, protocols);
  const storage = await readStorage(collection);
  const indexes = await collection.indexes();
  const stats = await readIndexStats(memberSet.members, name);
  const indexStats = stats.indexStats;
  const unreadableMembers = [...memberSet.unreachable, ...stats.unreadableMembers];
  const sample =
    totalCount > 0
      ? await collection.aggregate([{ $sample: { size: SAMPLE_SIZE } }, { $project: { _id: 0, ...SAMPLE_PROJECTION } }]).toArray()
      : [];
  const plan = planShard(indexes, flags);
  const estimates = new Map(
    [...plan.setR, ...plan.background]
      .filter((c) => c.status === 'missing')
      .map((c) => [c.spec.name, estimateSpecBytes(c.spec, sample, { totalCount, activeCount })]),
  );
  const buildBytes = plan.toBuild.reduce((sum, spec) => sum + (estimates.get(spec.name)?.bytes ?? 0), 0);
  return { name, chainId, protocols, totalCount, activeCount, oddIsActiveCount, storage, indexes, indexStats, unreadableMembers, sampleSize: sample.length, plan, estimates, buildBytes, outcome: '' };
}

/** `ops 12` — or, read from several members, `ops 12 (host-a 3, host-b 9, host-c 0)`. */
export function formatOps(stats) {
  if (!stats) return 'ops n/a';
  const split = stats.perMember && stats.perMember.length > 1 ? ` (${stats.perMember.map((m) => `${m.host} ${formatInt(m.ops)}`).join(', ')})` : '';
  return `ops ${formatInt(stats.ops)}${split}${stats.building ? ' (building)' : ''}`;
}

function printShard(report, flags) {
  const { name, chainId, protocols, storage, indexStats } = report;
  console.log(`\n── ${name} (chainId ${chainId}, protocol ${protocols.join(', ') || '(no documents)'}) ──`);
  console.log(`  documents ${formatInt(report.totalCount)} (estimated)  active ${formatInt(report.activeCount)}  isActive not in {true,false}: ${formatInt(report.oddIsActiveCount)}`);
  if (report.oddIsActiveCount > 0) {
    // The indexes would be correct either way, but the deploy that switches the
    // rate sorts from `isActive:$ne:false` to `isActive:true` (so they can use
    // the partial indexes) would stop showing these rows — so `--apply` refuses
    // without `--allow-odd-isactive`, and the readiness verdict says NOT READY.
    console.log(
      `  [warn] ${formatInt(report.oddIsActiveCount)} row(s) with a missing/null/non-boolean isActive: the rate sorts' isActive:true ` +
        `and every bg_* reader drop them — --apply refuses unless --allow-odd-isactive${flags.allowOddIsActive ? ' (given)' : ''}`,
    );
  }
  if (report.unreadableMembers?.length > 0) {
    console.log(`  [warn] $indexStats missing from ${report.unreadableMembers.join(', ')} — usage evidence is incomplete; --drop-legacy refuses`);
  }
  if (storage) {
    console.log(`  storage: data ${formatBytes(storage.size)}, on disk ${formatBytes(storage.storageSize)}, indexes ${formatBytes(storage.totalIndexSize)}`);
  }
  const since = indexStats ? [...indexStats.values()].map((s) => s.since).filter(Boolean).sort((a, b) => a - b)[0] : undefined;
  console.log(`  indexes (size, $indexStats ops${since ? ` since ${formatDate(since)}` : ''}):`);
  for (const ix of report.indexes) {
    const legacy = LEGACY_INDEXES.some((l) => l.name === ix.name) ? '  [legacy]' : '';
    console.log(`    ${ix.name.padEnd(64)} ${formatBytes(storage?.indexSizes?.[ix.name]).padStart(10)}  ${formatOps(indexStats?.get(ix.name))}${legacy}`);
  }
  const printSet = (label, classifications, skipped) => {
    console.log(`  ${label}${skipped ? ' (skipped by --skip-background)' : ''}:`);
    for (const c of classifications) {
      const est = report.estimates.get(c.spec.name);
      const building = c.status === 'present' && indexStats?.get(c.spec.name)?.building ? ' (building)' : '';
      const detail =
        c.status === 'missing' && est
          ? `est. +${formatBytes(est.bytes)} (${formatInt(est.entries)} entries x ~${Math.round(est.avgKeyBytes)} B)`
          : c.status === 'conflict'
            ? c.reason
            : '';
      console.log(`    ${c.spec.name.padEnd(20)} ${(STATUS_LABEL[c.status] + building).padEnd(19)} ${detail}`);
    }
  };
  printSet('Set R (collation en/numericOrdering)', report.plan.setR, false);
  printSet('background (simple collation)', report.plan.background, flags.skipBackground);
}

/**
 * Best-effort: refuse to start a build while another is running on a target
 * shard (two concurrent scans of the same collection on an already busy
 * primary). Without the privilege to look, it says so and goes on — the build
 * itself is still correct, only the timing is unchecked. `$currentOp` is a
 * database-level aggregation and only runs against `admin`.
 */
export async function inProgressBuilds(adminDb, databaseName, shardNames) {
  try {
    const ops = await adminDb
      .aggregate([
        { $currentOp: { allUsers: true, idleConnections: false } },
        { $match: { $or: [{ 'command.createIndexes': { $exists: true } }, { msg: /^Index Build/ }] } },
      ])
      .toArray();
    const targets = new Set(shardNames.map((name) => `${databaseName}.${name}`));
    return {
      checked: true,
      running: [...new Set(ops.map((op) => op.ns ?? `${op.command?.$db}.${op.command?.createIndexes}`))].filter((ns) => targets.has(ns)),
    };
  } catch (err) {
    return { checked: false, running: [], error: err.message };
  }
}

/**
 * `--apply` (build mode). Every gate is evaluated across ALL target shards
 * before the first build starts, so a refusal never leaves the run half done.
 * `db` / `adminDb` are injected so the gates are testable without a server.
 */
export async function runApply({ db, adminDb }, reports, fsStats, flags) {
  const conflicts = reports.flatMap((r) => r.plan.conflicts.map((c) => `${r.name}: ${c.spec.name} — ${c.reason}`));
  if (conflicts.length > 0) {
    for (const line of conflicts) console.log(`apply: CONFLICT ${line}`);
    for (const r of reports) r.outcome = 'BLOCKED (conflict)';
    throw new Error(`${conflicts.length} index conflict(s) — refusing to build anything; nothing was dropped or built`);
  }
  const totalBytes = reports.reduce((sum, r) => sum + r.buildBytes, 0);
  const pending = reports.filter((r) => r.plan.toBuild.length > 0);
  if (pending.length === 0) {
    for (const r of reports) r.outcome = 'nothing to build';
    console.log('apply: every requested index is already present — nothing to build');
    return;
  }
  const odd = reports.filter((r) => Number(r.oddIsActiveCount ?? 0) > 0);
  if (odd.length > 0 && !flags.allowOddIsActive) {
    for (const r of reports) r.outcome = odd.includes(r) ? 'REFUSED (odd isActive)' : 'withheld (another shard refused)';
    throw new Error(
      `${odd.map((r) => `${r.name}: ${formatInt(r.oddIsActiveCount)}`).join(', ')} row(s) with a missing/null/non-boolean isActive — ` +
        'the deploy\'s rate sorts (isActive: true) and every bg_* reader would stop showing them. Fix those rows, or re-run with ' +
        '--allow-odd-isactive to accept it; nothing was built',
    );
  }
  const headroom = checkHeadroom(fsStats, totalBytes);
  console.log(`apply: disk headroom — ${headroom.reason}`);
  if (!headroom.ok) {
    for (const r of pending) r.outcome = 'REFUSED (disk headroom)';
    throw new Error(`insufficient disk headroom for the build — ${headroom.reason}`);
  }
  const running = await inProgressBuilds(adminDb, db.databaseName, pending.map((r) => r.name));
  if (!running.checked) console.log(`apply: [warn] could not check for in-progress index builds (${running.error}) — make sure none is running`);
  if (running.running.length > 0) {
    for (const r of pending) r.outcome = 'REFUSED (build already running)';
    throw new Error(`an index build is already running on ${running.running.join(', ')} — refusing to start another`);
  }
  console.log('apply: reminder — run off-peak with POOLS_SYNC_CRON_ENABLED=false; a build is one collection scan per shard on every member');
  for (const report of reports) {
    if (report.plan.toBuild.length === 0) {
      report.outcome = 'nothing to build';
      continue;
    }
    const command = buildCreateIndexesCommand(report.name, report.plan.toBuild);
    const names = report.plan.toBuild.map((spec) => spec.name);
    console.log(`apply: ${report.name}: building ${names.length} index(es) in one createIndexes: ${names.join(', ')}`);
    const started = Date.now();
    // A dropped client connection does NOT abort a server-side build, so a
    // timeout here is not a rollback — re-run diagnose to see where it stands.
    const res = await db.command(command);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`apply: ${report.name}: createIndexes ok in ${seconds}s (indexes ${res.numIndexesBefore} → ${res.numIndexesAfter})`);
    // Re-read rather than trusting `ok: 1`: the claim this run makes is that
    // the indexes now exist AS SPECIFIED, and only listIndexes can say so.
    const collection = db.collection(report.name);
    const indexesAfter = await collection.indexes();
    const after = planShard(indexesAfter, flags);
    const stillMissing = [...after.setR, ...after.background].filter((c) => names.includes(c.spec.name) && c.status !== 'present');
    if (stillMissing.length > 0) {
      report.outcome = 'FAILED (verify)';
      throw new Error(`${report.name}: after the build these are not present as specified: ${stillMissing.map((c) => `${c.spec.name}=${c.status}`).join(', ')}`);
    }
    // Built vs estimated, per index — the calibration evidence for the next run.
    const storageAfter = await readStorage(collection);
    for (const name of names) {
      const actual = storageAfter?.indexSizes?.[name];
      console.log(`    ${name.padEnd(20)} built ${formatBytes(actual).padStart(9)}  (estimated ${formatBytes(report.estimates.get(name)?.bytes)})`);
    }
    report.plan = after;
    report.indexes = indexesAfter;
    report.outcome = `built ${names.length} in ${seconds}s`;
  }
}

/**
 * `--drop-legacy`. Evaluated across ALL target shards first: one refused shard
 * refuses the whole run, so an ambiguous invocation is never half-destructive.
 * Writes only with `--apply`, and only with `--evidence` (a snapshot recorded
 * by an earlier `--record-evidence` run, ≥ 48 h old, that every member still
 * matches — `checkDropEvidence`). `schemaSource` is position.schema.ts (null
 * when it could not be read, which warns rather than blocks — see main).
 * `options`: `evidence` (the parsed snapshot), `target` (the redacted URI it
 * must have been taken against), `now`, and `writeEvidence(json)` for
 * `--record-evidence` (main writes the file).
 */
export async function runDropLegacy({ db }, reports, flags, schemaSource, options = {}) {
  const stillDeclared = schemaSource ? legacyDeclarationsInSource(schemaSource) : [];
  if (stillDeclared.length > 0) {
    console.log(`drop-legacy: position.schema.ts STILL DECLARES ${stillDeclared.length} legacy index(es) — where autoIndex is on it rebuilds them at the next boot:`);
    for (const name of stillDeclared) console.log(`    ${name}`);
  }
  const plans = reports.map((report) => ({
    report,
    plan: planLegacyDrop([...report.plan.setR, ...report.plan.background], report.indexes, report.indexStats, {
      unreadableMembers: report.unreadableMembers ?? [],
    }),
  }));
  for (const { report, plan } of plans) {
    console.log(`\ndrop-legacy: ${report.name}: ${plan.allowed ? 'declared indexes complete' : `REFUSED — ${plan.reason}`}`);
    for (const name of plan.toDrop) {
      const stats = report.indexStats?.get(name);
      console.log(
        `    ${name.padEnd(64)} ${formatBytes(report.storage?.indexSizes?.[name]).padStart(10)}  ${formatOps(stats)} since ${formatDate(stats?.since)}`,
      );
    }
    if (plan.absent.length > 0) console.log(`    already absent: ${plan.absent.join(', ')}`);
  }
  console.log(
    'drop-legacy: evidence rule — drop only once these ops have stayed unchanged for ≥ 48 h on EVERY member: record a snapshot ' +
      '(--record-evidence=<file>), then --apply --evidence=<file> ≥ 48 h later (refused if any member restarted or used one). Rollback: ' +
      'after the drop, an image that still declares them with autoIndex on rebuilds them on the primary at boot',
  );
  if (flags.recordEvidence) {
    const snapshot = buildDropEvidence(reports, { target: options.target, takenAt: new Date(options.now ?? Date.now()) });
    options.writeEvidence?.(snapshot);
    console.log(`drop-legacy: evidence snapshot recorded to ${flags.recordEvidence} — drop with --apply --evidence=${flags.recordEvidence} after ${snapshot.takenAt} + 48 h`);
  }
  const refused = plans.filter((p) => !p.plan.allowed);
  if (refused.length > 0) {
    for (const { report } of plans) report.outcome = refused.some((p) => p.report === report) ? 'drop REFUSED' : 'drop withheld (another shard refused)';
    throw new Error(
      `--drop-legacy refused on ${refused.map((p) => p.report.name).join(', ')} — nothing was dropped (narrow with --shard=<chainId> to drop where the declared indexes are complete)`,
    );
  }
  if (!flags.apply) {
    for (const { report, plan } of plans) report.outcome = plan.toDrop.length > 0 ? `would drop ${plan.toDrop.length}` : 'no legacy indexes left';
    console.log(
      stillDeclared.length > 0
        ? 'drop-legacy: dry run — --apply will REFUSE until the deploy that removes the declarations above has shipped'
        : 'drop-legacy: dry run — re-run with --apply --evidence=<snapshot ≥ 48 h old> to drop the indexes listed above',
    );
    return;
  }
  if (stillDeclared.length > 0) {
    for (const { report } of plans) report.outcome = 'drop REFUSED (still declared)';
    throw new Error('the legacy indexes are still declared in position.schema.ts — deploy the change that removes them first');
  }
  if (plans.every(({ plan }) => plan.toDrop.length === 0)) {
    for (const { report } of plans) report.outcome = 'no legacy indexes left';
    console.log('drop-legacy: nothing left to drop');
    return;
  }
  const evidence = checkDropEvidence(options.evidence ?? null, plans, { target: options.target, now: options.now ?? Date.now() });
  if (!evidence.ok) {
    for (const problem of evidence.problems) console.log(`drop-legacy: EVIDENCE — ${problem}`);
    for (const { report } of plans) report.outcome = 'drop REFUSED (evidence)';
    throw new Error(`--drop-legacy --apply refused: the $indexStats evidence does not show these indexes unused for ≥ 48 h (${evidence.problems.length} problem(s)) — nothing was dropped`);
  }
  for (const { report, plan } of plans) {
    if (plan.toDrop.length === 0) {
      report.outcome = 'no legacy indexes left';
      continue;
    }
    await db.command({ dropIndexes: report.name, index: plan.toDrop });
    report.outcome = `dropped ${plan.toDrop.length}`;
    console.log(`drop-legacy: ${report.name}: dropped ${plan.toDrop.join(', ')}`);
  }
}

function printSummary(reports, fsStats, flags) {
  console.log('\nsummary:');
  const header = ['shard', 'docs', 'active', 'Set R ok/miss/conf', 'bg ok/miss/conf', 'est. build', 'outcome'];
  const rows = reports.map((r) => [
    r.name,
    formatInt(r.totalCount),
    formatInt(r.activeCount),
    tally(r.plan.setR),
    `${tally(r.plan.background)}${flags.skipBackground ? ' (skip)' : ''}`,
    // The pre-build estimate: after an --apply, plan.toBuild is empty but the
    // estimate is still what the headroom gate judged.
    r.buildBytes > 0 ? `+${formatBytes(r.buildBytes)}` : '-',
    r.outcome || (flags.dropLegacy ? '' : r.plan.conflicts.length > 0 ? 'BLOCKED (conflict)' : r.plan.toBuild.length > 0 ? `would build ${r.plan.toBuild.length}` : 'nothing to build'),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => `  ${cells.map((cell, i) => cell.padEnd(widths[i])).join('  ')}`;
  console.log(line(header));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) console.log(line(row));
  if (flags.dropLegacy) return;
  const totalBytes = reports.reduce((sum, r) => sum + r.buildBytes, 0);
  const headroom = checkHeadroom(fsStats, totalBytes);
  console.log(`summary: disk — ${headroom.reason}${totalBytes > 0 ? (headroom.ok ? ' — OK' : ' — INSUFFICIENT') : ''}`);
}

/**
 * The overlap window's index footprint across ALL positions shards (targets and
 * the rest), against the WiredTiger cache. `buildBytes` covers the targeted
 * shards only — a narrowed run says so.
 */
function printOverlap(reports, others, server, flags) {
  const shards = [...reports, ...others];
  const currentIndexBytes = shards.reduce((sum, s) => sum + (Number(s.storage?.totalIndexSize) || 0), 0);
  const legacyIndexBytes = shards.reduce(
    (sum, s) => sum + LEGACY_INDEXES.reduce((acc, l) => acc + (Number(s.storage?.indexSizes?.[l.name]) || 0), 0),
    0,
  );
  const buildBytes = reports.reduce((sum, r) => sum + r.buildBytes, 0);
  const overlap = overlapReport({ currentIndexBytes, buildBytes, legacyIndexBytes, cacheBytes: server.cacheBytes });
  console.log(
    `overlap: positions indexes now ${formatBytes(currentIndexBytes)} (legacy ${formatBytes(legacyIndexBytes)}, freed by --drop-legacy)` +
      ` + est. build ${formatBytes(buildBytes)}${flags.shard !== undefined ? ' (targeted shard only)' : ''} = ${formatBytes(overlap.projectedBytes)}` +
      (overlap.cacheBytes
        ? ` vs WiredTiger cache ${formatBytes(overlap.cacheBytes)} (${Math.round(overlap.share * 100)}%)`
        : ` — WiredTiger cache size unknown (${server.cacheError ?? 'not reported'})`),
  );
  if (overlap.warn) {
    console.log(
      `  [warn] the index set alone takes ≥ ${Math.round(CACHE_WARN_SHARE * 100)}% of the cache until --drop-legacy: expect more eviction and disk reads ` +
        'on the members that serve user reads — keep the overlap short and watch cache eviction / IOPS',
    );
  }
}

/** The deploy-readiness verdict over every positions shard (see `deployReadiness`). */
function printReadiness(readiness, flags) {
  if (readiness.ready) {
    console.log('deploy readiness: READY — every positions shard has every declared Set R + background index as specified; no odd isActive rows' + (flags.allowOddIsActive ? ' (odd rows accepted by --allow-odd-isactive)' : ''));
    return;
  }
  console.log('deploy readiness: NOT READY — do NOT deploy the schema that declares these yet:');
  for (const p of readiness.problems) {
    const parts = [];
    if (p.missing.length > 0) parts.push(`missing ${p.missing.join(', ')}`);
    if (p.conflicts.length > 0) parts.push(`CONFLICT ${p.conflicts.join(', ')}`);
    if (p.oddIsActiveCount > 0) parts.push(`${formatInt(p.oddIsActiveCount)} odd isActive row(s)`);
    console.log(`    ${p.name}: ${parts.join('; ')}`);
  }
  console.log(
    '  a deploy now either makes autoIndex build every missing index on the PRIMARY at boot (where shard autoIndex is on: one ' +
      'collection scan per index per shard, all shards at once) or, in production (shard autoIndex off), leaves it missing and every ' +
      'query hinted to it on its fallback; a CONFLICT stays wrong and is never hinted. Run --apply without --shard / --skip-background first.',
  );
}

/**
 * The repo's position.schema.ts, for the "still declared" check. A copy of this
 * script run from outside the repo cannot see it; that WARNS rather than blocks,
 * because the check was only ever a necessary condition, never a sufficient one.
 */
function readSchemaSource() {
  try {
    return readFileSync(new URL('../src/database/schemas/position.schema.ts', import.meta.url), 'utf8');
  } catch {
    console.log('drop-legacy: [warn] could not read src/database/schemas/position.schema.ts to check the legacy declarations');
    return null;
  }
}

/** The `--evidence=<file>` snapshot, parsed — a missing or unreadable file refuses the drop (null). */
function readEvidence(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.log(`drop-legacy: [warn] could not read the evidence snapshot ${path}: ${err.message}`);
    return null;
  }
}

async function main(argv) {
  const flags = parseArgs(argv);
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/copypools_positions';
  console.log(`target: ${redactUri(uri)}`);
  const action = flags.dropLegacy ? 'drop legacy metric indexes' : 'build Set R + background indexes';
  console.log(`mode: ${flags.apply ? 'APPLY' : 'diagnose (dry run)'} — ${action}${flags.shard !== undefined ? `, shard ${flags.shard} only` : ''}${flags.skipBackground ? ', Set R only' : ''}`);
  if (!flags.dropLegacy && (flags.shard !== undefined || flags.skipBackground)) {
    console.log(
      '[warn] NARROWED run: position.schema.ts declares every Set R + background index on EVERY shard. Whatever this run leaves unbuilt, ' +
        'a deploy makes autoIndex build on the PRIMARY at boot — see the deploy-readiness verdict at the end before deploying.',
    );
  }
  await mongoose.connect(uri);
  let memberSet = { members: [], unreachable: [], clients: [], replicaSet: null };
  try {
    const db = mongoose.connection.db;
    const client = mongoose.connection.getClient();
    const adminDb = client.db('admin');
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    const shards = selectShards(names, flags.shard);
    if (shards.length === 0) {
      throw new Error(flags.shard !== undefined ? `no positions shard for chainId ${flags.shard} in ${db.databaseName}` : `no positions shards in ${db.databaseName}`);
    }
    const otherShards = selectShards(names, undefined).filter((name) => !shards.includes(name));
    const server = await inspectServer(adminDb);
    memberSet = await connectMembers(client, adminDb, db);
    printServer(server, memberSet);
    const fsStats = await db.command({ dbStats: 1, scale: 1 });
    console.log(`disk: used ${formatBytes(fsStats.fsUsedSize)} of ${formatBytes(fsStats.fsTotalSize)} (free ${formatBytes(Number(fsStats.fsTotalSize) - Number(fsStats.fsUsedSize))})`);
    const reports = [];
    for (const name of shards) {
      const report = await inspectShard(db, name, flags, memberSet);
      printShard(report, flags);
      reports.push(report);
    }
    const others = [];
    for (const name of otherShards) others.push(await inspectShardLight(db, name));
    console.log('');
    const deps = { db, adminDb };
    let readiness = null;
    try {
      if (flags.dropLegacy) {
        await runDropLegacy(deps, reports, flags, readSchemaSource(), {
          target: redactUri(uri),
          evidence: flags.evidence ? readEvidence(flags.evidence) : null,
          writeEvidence: flags.recordEvidence
            ? (snapshot) => writeFileSync(flags.recordEvidence, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' })
            : undefined,
        });
      }
      else if (flags.apply) await runApply(deps, reports, fsStats, flags);
    } finally {
      printSummary(reports, fsStats, flags);
      if (!flags.dropLegacy) {
        printOverlap(reports, others, server, flags);
        // After an --apply, `reports[i].indexes` is the post-build listIndexes.
        readiness = deployReadiness([...reports, ...others], flags);
        printReadiness(readiness, flags);
      }
    }
    const exitCode = exitCodeFor(flags, readiness);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      console.log(`done — built what was asked, but the deployment is NOT READY (exit code ${exitCode})`);
      return;
    }
    console.log(flags.apply ? 'done — migration applied' : 'dry run complete (re-run with --apply to write)');
  } finally {
    for (const memberClient of memberSet.clients) await memberClient.close().catch(() => {});
    await mongoose.disconnect();
  }
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) await main(process.argv.slice(2));
