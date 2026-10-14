import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_SPECS,
  CACHE_WARN_SHARE,
  HEADROOM_FACTOR,
  LEADERBOARD_COLLATION,
  LEGACY_INDEXES,
  LEGACY_METRIC_INDEXES,
  LEGACY_UNUSED_INDEXES,
  NOT_READY_EXIT_CODE,
  SAMPLE_PROJECTION,
  exitCodeFor,
  SET_R_SPECS,
  buildCreateIndexesCommand,
  buildDropEvidence,
  checkDropEvidence,
  checkHeadroom,
  classifySpec,
  connectMembers,
  deployReadiness,
  distinctHintSupported,
  estimateSpecBytes,
  estimateValueBytes,
  formatOps,
  inProgressBuilds,
  legacyDeclarationsInSource,
  matchesPartialFilter,
  memberClientOptions,
  memberHosts,
  mergeMemberIndexStats,
  normalizeCollation,
  overlapReport,
  parseArgs,
  planLegacyDrop,
  planShard,
  runApply,
  runDropLegacy,
  selectShards,
  sharedLeadingFields,
} from '../scripts/positions-index-migration.mjs';

// The script is plain ESM with no type declarations; the specs only need loose shapes.
type Spec = { name: string; set: string; key: Record<string, number>; collation?: Record<string, unknown>; partialFilterExpression?: Record<string, unknown> };
type Index = { name: string; key: Record<string, unknown>; collation?: Record<string, unknown>; [option: string]: unknown };

/** What `listIndexes` actually returns: `v`, the fully expanded ICU collation + `version`, and NO collation for simple. */
function serverShape(index: { name: string; key: Record<string, unknown>; collation?: Record<string, unknown>; partialFilterExpression?: Record<string, unknown> }): Index {
  const out: Index = { v: 2, key: { ...index.key }, name: index.name };
  if (index.collation && index.collation.locale !== 'simple') {
    out.collation = {
      locale: index.collation.locale,
      caseLevel: false,
      caseFirst: 'off',
      strength: 3,
      numericOrdering: index.collation.numericOrdering ?? false,
      alternate: 'non-ignorable',
      maxVariable: 'punct',
      normalization: false,
      backwards: false,
      version: '57.1',
    };
  }
  if (index.partialFilterExpression) out.partialFilterExpression = { ...index.partialFilterExpression };
  return out;
}

const specNamed = (name: string): Spec => [...SET_R_SPECS, ...BACKGROUND_SPECS].find((s: Spec) => s.name === name)!;
const ID_INDEX: Index = { v: 2, key: { _id: 1 }, name: '_id_' };
const LEGACY_SERVER: Index[] = LEGACY_METRIC_INDEXES.map((l: { name: string; key: Record<string, number> }) => serverShape(l));
const UNUSED_SERVER: Index[] = LEGACY_UNUSED_INDEXES.map((l: { name: string; key: Record<string, number> }) => serverShape(l));
const ALL_SERVER: Index[] = [...SET_R_SPECS, ...BACKGROUND_SPECS].map((s: Spec) => serverShape(s));

describe('index specs', () => {
  it('Set R is exactly the seven planned indexes, keys in planned order', () => {
    const shapes = Object.fromEntries(SET_R_SPECS.map((s: Spec) => [s.name, Object.entries(s.key)]));
    const tail = (metric: string) => [[metric, -1], ['positionId', 1], ['metrics.inRange', 1], ['metrics.underlyingValueUsd', 1]];
    expect(shapes).toEqual({
      lbr_apr_active: [['chainId', 1], ['protocol', 1], ...tail('metrics.aprExGas')],
      lbr_feeapr_active: [['chainId', 1], ['protocol', 1], ...tail('metrics.feeApr')],
      lbr_roi_active: [['chainId', 1], ['protocol', 1], ...tail('metrics.roi')],
      lbr_pnl: [['chainId', 1], ['protocol', 1], ['metrics.poolPnlUsd', -1], ['positionId', 1], ['isActive', 1], ['metrics.inRange', 1], ['metrics.underlyingValueUsd', 1]],
      lbr_value: [['chainId', 1], ['protocol', 1], ['metrics.underlyingValueUsd', -1], ['positionId', 1], ['isActive', 1], ['metrics.inRange', 1]],
      lbr_created: [['chainId', 1], ['protocol', 1], ['createdAtTimestamp', -1], ['positionId', 1], ['isActive', 1], ['metrics.inRange', 1]],
      lbr_tokenid: [['chainId', 1], ['protocol', 1], ['tokenId', 1], ['positionId', 1], ['isActive', 1], ['metrics.inRange', 1]],
    });
    expect(SET_R_SPECS.map((s: Spec) => s.name)).toEqual([
      'lbr_apr_active', 'lbr_feeapr_active', 'lbr_roi_active', 'lbr_pnl', 'lbr_value', 'lbr_created', 'lbr_tokenid',
    ]);
  });

  it('every Set R index carries EXACTLY the leaderboard query collation', () => {
    // findLeaderboard queries with this collation; an index under any other one cannot provide its sort.
    expect(LEADERBOARD_COLLATION).toEqual({ locale: 'en', numericOrdering: true });
    for (const spec of SET_R_SPECS as Spec[]) expect(spec.collation).toEqual({ locale: 'en', numericOrdering: true });
  });

  it('only the three rate-sort indexes are partial, and on {isActive:true}', () => {
    const partial = (SET_R_SPECS as Spec[]).filter((s) => s.partialFilterExpression).map((s) => s.name);
    expect(partial).toEqual(['lbr_apr_active', 'lbr_feeapr_active', 'lbr_roi_active']);
    for (const name of partial) expect(specNamed(name).partialFilterExpression).toEqual({ isActive: true });
    // Partial on actives: every background reader filters on isActive: true exactly.
    for (const spec of BACKGROUND_SPECS as Spec[]) expect(spec.partialFilterExpression).toEqual({ isActive: true });
  });

  it('the background set is exactly the four planned indexes, simple collation (owner in the pool index since 2026-10-03)', () => {
    expect(Object.fromEntries((BACKGROUND_SPECS as Spec[]).map((s) => [s.name, Object.entries(s.key)]))).toEqual({
      bg_active_walk: [['chainId', 1], ['protocol', 1], ['isActive', 1], ['positionId', 1], ['metrics.performanceReady', 1]],
      bg_active_token0: [['chainId', 1], ['protocol', 1], ['isActive', 1], ['token0.address', 1]],
      bg_active_token1: [['chainId', 1], ['protocol', 1], ['isActive', 1], ['token1.address', 1]],
      bg_active_pool_owner: [['chainId', 1], ['protocol', 1], ['isActive', 1], ['poolId', 1], ['owner', 1]],
    });
    for (const spec of BACKGROUND_SPECS as Spec[]) expect(normalizeCollation(spec.collation)).toBeNull();
  });

  it('every key leads with {chainId:1, protocol:1} — the shard-constant pair every query must carry', () => {
    for (const spec of [...SET_R_SPECS, ...BACKGROUND_SPECS] as Spec[]) {
      expect(Object.entries(spec.key).slice(0, 2)).toEqual([['chainId', 1], ['protocol', 1]]);
    }
  });

  it('names are unique across both sets and never collide with a legacy name', () => {
    const names = [...SET_R_SPECS, ...BACKGROUND_SPECS, ...LEGACY_INDEXES].map((s: { name: string }) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(LEGACY_INDEXES).toEqual([...LEGACY_METRIC_INDEXES, ...LEGACY_UNUSED_INDEXES]);
  });

  it('the unused legacy set: generated names for the unnamed ones, the old partial specs for the two bg_ ones', () => {
    expect(LEGACY_UNUSED_INDEXES.map((l: { name: string }) => l.name)).toEqual([
      'chainId_1_protocol_1_isActive_1',
      'chainId_1_protocol_1_metrics.performanceReady_1',
      'chainId_1_protocol_1_createdAtTimestamp_1_positionId_1',
      'chainId_1_protocol_1_lastVerifiedAt_1',
      'chainId_1_protocol_1_isActive_1_txSyncStatus_1_txLastSuccessAt_1',
      'chainId_1_protocol_1_isActive_1_txFinalizedAt_1',
      'bg_fee_hot',
      'bg_active_pool',
    ]);
    for (const legacy of LEGACY_UNUSED_INDEXES as Array<{ name: string; key: Record<string, number>; partialFilterExpression?: unknown }>) {
      if (legacy.name.startsWith('bg_')) {
        expect(legacy.partialFilterExpression, legacy.name).toEqual({ isActive: true });
      } else {
        expect(legacy.name).toBe(Object.entries(legacy.key).map(([field, dir]) => `${field}_${dir}`).join('_'));
        expect(legacy.partialFilterExpression).toBeUndefined();
      }
    }
  });

  it('legacy names are MongoDB\'s generated names for their keys (the schema declares them unnamed)', () => {
    expect(LEGACY_METRIC_INDEXES.map((l: { key: Record<string, number> }) => Object.keys(l.key)[2])).toEqual([
      'metrics.apr', 'metrics.feeApr', 'metrics.roi', 'metrics.pnlUsd', 'metrics.underlyingValueUsd', 'metrics.ageSeconds', 'metrics.aprExGas',
    ]);
    for (const legacy of LEGACY_METRIC_INDEXES as { name: string; key: Record<string, number> }[]) {
      const generated = Object.entries(legacy.key).map(([field, dir]) => `${field}_${dir}`).join('_');
      expect(legacy.name).toBe(generated);
    }
  });

  it('the $sample projection covers every indexed field', () => {
    for (const spec of [...SET_R_SPECS, ...BACKGROUND_SPECS] as Spec[]) {
      for (const field of Object.keys(spec.key)) expect(SAMPLE_PROJECTION[field]).toBe(1);
    }
  });

  it('importing the module runs nothing (no connection, no argv parsing)', () => {
    expect(mongoose.connection.readyState).toBe(0);
  });
});

describe('parseArgs', () => {
  it('defaults to a diagnose of every shard', () => {
    expect(parseArgs([])).toEqual({ apply: false, dropLegacy: false, skipBackground: false, allowOddIsActive: false, shard: undefined });
  });

  it('reads every known flag', () => {
    expect(parseArgs(['--apply', '--drop-legacy', '--skip-background', '--allow-odd-isactive', '--shard=4663'])).toEqual({
      apply: true, dropLegacy: true, skipBackground: true, allowOddIsActive: true, shard: 4663,
    });
    expect(parseArgs(['--drop-legacy', '--record-evidence=ev.json'])).toMatchObject({ dropLegacy: true, recordEvidence: 'ev.json', apply: false });
    expect(parseArgs(['--drop-legacy', '--apply', '--evidence=/tmp/ev.json'])).toMatchObject({ dropLegacy: true, apply: true, evidence: '/tmp/ev.json' });
  });

  it('the evidence flags belong to --drop-legacy, take a path, and recording is never an --apply', () => {
    expect(() => parseArgs(['--record-evidence=ev.json'])).toThrow(/belong to --drop-legacy/);
    expect(() => parseArgs(['--apply', '--evidence=ev.json'])).toThrow(/belong to --drop-legacy/);
    expect(() => parseArgs(['--drop-legacy', '--evidence='])).toThrow(/needs a file path/);
    expect(() => parseArgs(['--drop-legacy', '--apply', '--record-evidence=ev.json'])).toThrow(/dry-run step/);
  });

  it('throws on an unknown flag instead of treating it as declined', () => {
    expect(() => parseArgs(['--aply'])).toThrow(/unrecognized argument\(s\): --aply/);
    expect(() => parseArgs(['--apply', '--dry-run'])).toThrow(/--dry-run/);
  });

  it('rejects a space-separated --shard, which would otherwise silently mean every shard', () => {
    expect(() => parseArgs(['--shard', '2'])).toThrow(/unrecognized argument\(s\): --shard 2/);
  });

  it('rejects a non-numeric or empty shard and a contradictory repeat', () => {
    expect(() => parseArgs(['--shard=abc'])).toThrow(/numeric chainId/);
    expect(() => parseArgs(['--shard='])).toThrow(/numeric chainId/);
    expect(() => parseArgs(['--shard=1', '--shard=2'])).toThrow(/twice/);
    expect(parseArgs(['--shard=1', '--shard=1']).shard).toBe(1);
  });
});

describe('selectShards', () => {
  const names = [
    '43114_uniswap_v4_positions', '1_uniswap_v4_positions', '4663_uniswap_v4_positions', '11_uniswap_v4_positions',
    '1_uniswap_v4_position_transactions', '1_uniswap_v4_pools', '1_tokens', '1_token_price_historical',
    'uniswap_v4_positions', '1_uniswap-v4_positions', 'sync_cursors',
  ];

  it('keeps positions shards only, ordered by chainId numerically', () => {
    expect(selectShards(names, undefined)).toEqual([
      '1_uniswap_v4_positions', '11_uniswap_v4_positions', '4663_uniswap_v4_positions', '43114_uniswap_v4_positions',
    ]);
  });

  it('narrows to exactly one chain — 1 does not pick up 11', () => {
    expect(selectShards(names, 1)).toEqual(['1_uniswap_v4_positions']);
    expect(selectShards(names, 999)).toEqual([]);
  });
});

describe('classifySpec', () => {
  const value = specNamed('lbr_value');
  const apr = specNamed('lbr_apr_active');
  const walk = specNamed('bg_active_walk');

  it('missing when no index has the name or the key', () => {
    expect(classifySpec(value, [ID_INDEX, ...LEGACY_SERVER]).status).toBe('missing');
  });

  it('present against the server shape (expanded collation + version, v:2)', () => {
    expect(classifySpec(value, [ID_INDEX, serverShape(value)]).status).toBe('present');
    expect(classifySpec(apr, [serverShape(apr)]).status).toBe('present');
  });

  it('present for a simple-collation spec when the server reports no collation', () => {
    expect(classifySpec(walk, [serverShape(walk)]).status).toBe('present');
    expect(serverShape(walk).collation).toBeUndefined();
  });

  it('CONFLICT: same name, different key', () => {
    const existing = { ...serverShape(value), key: { chainId: 1, protocol: 1, 'metrics.underlyingValueUsd': -1, positionId: 1 } };
    const c = classifySpec(value, [existing]);
    expect(c.status).toBe('conflict');
    expect(c.reason).toMatch(/'lbr_value' exists with a different spec: key/);
  });

  it('CONFLICT: same name, simple collation where the leaderboard collation is required', () => {
    const c = classifySpec(value, [serverShape({ ...value, collation: undefined })]);
    expect(c.status).toBe('conflict');
    expect(c.reason).toMatch(/collation simple/);
  });

  it('CONFLICT: same name, numericOrdering off', () => {
    const c = classifySpec(value, [serverShape({ ...value, collation: { locale: 'en' } })]);
    expect(c.status).toBe('conflict');
  });

  it('CONFLICT: same name, missing or different partial filter', () => {
    expect(classifySpec(apr, [serverShape({ ...apr, partialFilterExpression: undefined })]).status).toBe('conflict');
    expect(classifySpec(apr, [serverShape({ ...apr, partialFilterExpression: { isActive: { $eq: true } } })]).status).toBe('conflict');
  });

  it('CONFLICT: same name but unique, sparse, TTL or hidden', () => {
    for (const option of [{ unique: true }, { sparse: true }, { expireAfterSeconds: 60 }, { hidden: true }]) {
      expect(classifySpec(value, [{ ...serverShape(value), ...option }]).status).toBe('conflict');
    }
  });

  it('CONFLICT: the identical spec under another name (MongoDB would refuse ours)', () => {
    const c = classifySpec(walk, [{ ...serverShape(walk), name: 'my_walk' }]);
    expect(c.status).toBe('conflict');
    expect(c.reason).toMatch(/already exists as 'my_walk'/);
  });

  it('CONFLICT: the same key under another name with different options', () => {
    const c = classifySpec(value, [serverShape({ ...value, name: 'other', collation: undefined })]);
    expect(c.status).toBe('conflict');
    expect(c.reason).toMatch(/'other' has the same key with different options/);
  });

  it('key ORDER matters: the {protocol, chainId, …} lb_* indexes are not the same key', () => {
    const reordered = { ...serverShape(value), name: 'lb_underlyingValueUsd', key: { protocol: 1, chainId: 1, 'metrics.underlyingValueUsd': -1, positionId: 1, isActive: 1, 'metrics.inRange': 1 } };
    expect(classifySpec(value, [reordered]).status).toBe('missing');
  });
});

describe('planShard', () => {
  it('builds all eleven on an untouched shard and none when everything is present', () => {
    expect(planShard([ID_INDEX, ...LEGACY_SERVER]).toBuild.map((s: Spec) => s.name)).toHaveLength(11);
    const full = planShard([ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER]);
    expect(full.toBuild).toEqual([]);
    expect(full.conflicts).toEqual([]);
  });

  it('--skip-background builds Set R only and does not let a background conflict block it', () => {
    const conflicting = { ...serverShape(specNamed('bg_active_pool_owner')), name: 'my_pool' };
    const plan = planShard([ID_INDEX, conflicting], { skipBackground: true });
    expect(plan.toBuild.map((s: Spec) => s.name)).toEqual(SET_R_SPECS.map((s: Spec) => s.name));
    expect(plan.conflicts).toEqual([]);
    expect(plan.background.find((c: { spec: Spec }) => c.spec.name === 'bg_active_pool_owner').status).toBe('conflict');
  });

  it('a background conflict blocks a full build', () => {
    const conflicting = { ...serverShape(specNamed('bg_active_pool_owner')), name: 'my_pool' };
    expect(planShard([ID_INDEX, conflicting]).conflicts.map((c: { spec: Spec }) => c.spec.name)).toEqual(['bg_active_pool_owner']);
  });

  it('the OLD bg_active_pool is no conflict for the new bg_active_pool_owner: different name, different key — built beside it', () => {
    const old = serverShape(LEGACY_UNUSED_INDEXES.find((l: { name: string }) => l.name === 'bg_active_pool'));
    const plan = planShard([ID_INDEX, old]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.toBuild.map((s: Spec) => s.name)).toContain('bg_active_pool_owner');
  });
});

describe('size estimate', () => {
  it('sizes values by KeyString type, collated strings larger than raw', () => {
    expect(estimateValueBytes(undefined, false)).toBe(1);
    expect(estimateValueBytes(true, false)).toBe(1);
    expect(estimateValueBytes(7, false)).toBe(5);
    expect(estimateValueBytes(12.5, false)).toBe(10);
    expect(estimateValueBytes('abcd', false)).toBe(6);
    expect(estimateValueBytes('abcd', true)).toBe(10);
  });

  it('discounts only the leading constant/boolean run that adjacent keys share', () => {
    const docs = [
      { chainId: 1, protocol: 'uniswap-v4', isActive: true, metrics: { inRange: true }, tokenId: '5' },
      { chainId: 1, protocol: 'uniswap-v4', isActive: false, metrics: { inRange: false }, tokenId: '6' },
    ];
    expect(sharedLeadingFields(LEGACY_UNUSED_INDEXES.find((l: { name: string }) => l.name === 'bg_fee_hot'), docs)).toEqual([
      'chainId',
      'protocol',
      'isActive',
      'metrics.inRange',
    ]);
    // after the first varying field nothing is shared, booleans included
    expect(sharedLeadingFields(specNamed('lbr_tokenid'), docs)).toEqual(['chainId', 'protocol']);
    expect(sharedLeadingFields(specNamed('lbr_tokenid'), [])).toEqual([]);
  });

  it('a partial index has one entry per ACTIVE doc and is averaged over active docs only', () => {
    const active = { chainId: 1, protocol: 'uniswap-v4', isActive: true, positionId: '1', metrics: { aprExGas: 1.5, inRange: true, underlyingValueUsd: 10.25 } };
    const closed = { ...active, isActive: false, positionId: '123456789012345678901234567890' };
    const apr = specNamed('lbr_apr_active');
    const onlyActive = estimateSpecBytes(apr, [active], { totalCount: 1000, activeCount: 100 });
    expect(onlyActive.entries).toBe(100);
    expect(estimateSpecBytes(apr, [active, closed], { totalCount: 1000, activeCount: 100 })).toEqual(onlyActive);
    const full = estimateSpecBytes(specNamed('lbr_pnl'), [active, closed], { totalCount: 1000, activeCount: 100 });
    expect(full.entries).toBe(1000);
    expect(full.bytes).toBe(Math.ceil(full.avgKeyBytes * 1000));
  });

  it('nothing to index costs nothing; an empty sample of a non-empty shard falls back high', () => {
    expect(estimateSpecBytes(specNamed('lbr_pnl'), [], { totalCount: 0, activeCount: 0 }).bytes).toBe(0);
    expect(estimateSpecBytes(specNamed('lbr_pnl'), [], { totalCount: 10, activeCount: 0 }).bytes).toBe(1280);
  });

  it('refuses to guess a partial filter it cannot evaluate', () => {
    expect(matchesPartialFilter({ isActive: true }, { isActive: true })).toBe(true);
    expect(matchesPartialFilter({ isActive: true }, { isActive: false })).toBe(false);
    expect(() => matchesPartialFilter({ isActive: { $eq: true } }, { isActive: true })).toThrow(/only equality/);
  });
});

describe('checkHeadroom', () => {
  const GB = 1024 ** 3;
  it(`requires free disk of at least ${HEADROOM_FACTOR}x the estimate`, () => {
    expect(HEADROOM_FACTOR).toBe(3);
    expect(checkHeadroom({ fsUsedSize: 7 * GB, fsTotalSize: 10 * GB }, 1 * GB).ok).toBe(true);
    expect(checkHeadroom({ fsUsedSize: 7 * GB + 1, fsTotalSize: 10 * GB }, 1 * GB).ok).toBe(false);
    const refused = checkHeadroom({ fsUsedSize: 9 * GB, fsTotalSize: 10 * GB }, 1 * GB);
    expect(refused).toMatchObject({ ok: false, freeBytes: 1 * GB, requiredBytes: 3 * GB });
  });

  it('unreadable fs stats refuse a real build but not an empty one', () => {
    expect(checkHeadroom({}, 1).ok).toBe(false);
    expect(checkHeadroom({ fsUsedSize: 1, fsTotalSize: 0 }, 1).ok).toBe(false);
    expect(checkHeadroom(undefined, 0).ok).toBe(true);
  });
});

describe('planLegacyDrop', () => {
  const required = (indexes: Index[]) => {
    const plan = planShard(indexes);
    return [...plan.setR, ...plan.background];
  };
  const allPresent = () => required([ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER]);
  const stats = (extra: Record<string, { building?: boolean }> = {}) =>
    new Map([...ALL_SERVER, ...LEGACY_SERVER, ...UNUSED_SERVER].map((ix) => [ix.name, { ops: 0, since: new Date(0), building: false, ...extra[ix.name] }]));

  it('allows the drop only with every declared index present, and names exactly the legacy seven (when only they exist)', () => {
    const plan = planLegacyDrop(allPresent(), [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER], stats());
    expect(plan.allowed).toBe(true);
    expect(plan.toDrop).toEqual(LEGACY_METRIC_INDEXES.map((l: { name: string }) => l.name));
  });

  it('drops the unused eight too — the old bg_active_pool and bg_fee_hot matched with their partial filter', () => {
    const indexes = [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER, ...UNUSED_SERVER];
    const plan = planLegacyDrop(required(indexes), indexes, stats());
    expect(plan.allowed).toBe(true);
    expect(plan.toDrop).toEqual(LEGACY_INDEXES.map((l: { name: string }) => l.name));
  });

  it('refuses while a REPLACEMENT is missing: no bg_active_pool_owner, no drop of bg_active_pool (or anything)', () => {
    const indexes = [ID_INDEX, ...ALL_SERVER.filter((ix) => ix.name !== 'bg_active_pool_owner'), ...UNUSED_SERVER];
    const plan = planLegacyDrop(required(indexes), indexes, stats());
    expect(plan).toMatchObject({ allowed: false, toDrop: [] });
    expect(plan.reason).toMatch(/bg_active_pool_owner=missing/);
  });

  it('an index carrying an unused legacy NAME without its partial filter is not the one meant — refused', () => {
    const odd = UNUSED_SERVER.map((ix) => (ix.name === 'bg_fee_hot' ? { ...ix, partialFilterExpression: undefined } : ix));
    const indexes = [ID_INDEX, ...ALL_SERVER, ...odd];
    const plan = planLegacyDrop(required(indexes), indexes, stats());
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toMatch(/bg_fee_hot/);
  });

  it('refuses while any Set R index is missing', () => {
    const indexes = [ID_INDEX, ...ALL_SERVER.filter((ix) => ix.name !== 'lbr_pnl'), ...LEGACY_SERVER];
    const plan = planLegacyDrop(required(indexes), indexes, stats());
    expect(plan).toMatchObject({ allowed: false, toDrop: [] });
    expect(plan.reason).toMatch(/lbr_pnl=missing/);
  });

  it('refuses while a Set R index is in CONFLICT', () => {
    const indexes = [ID_INDEX, ...ALL_SERVER.filter((ix) => ix.name !== 'lbr_value'), { ...serverShape(specNamed('lbr_value')), hidden: true }, ...LEGACY_SERVER];
    expect(planLegacyDrop(required(indexes), indexes, stats()).reason).toMatch(/lbr_value=conflict/);
  });

  it('refuses while a Set R index is still building', () => {
    const plan = planLegacyDrop(allPresent(), [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER], stats({ lbr_created: { building: true } }));
    expect(plan.reason).toMatch(/lbr_created=building/);
  });

  it('refuses without $indexStats — there would be no usage evidence to print', () => {
    expect(planLegacyDrop(allPresent(), [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER], null).allowed).toBe(false);
  });

  it('refuses when a legacy NAME carries a different spec', () => {
    const odd = LEGACY_SERVER.map((ix) => (ix.name === 'chainId_1_protocol_1_metrics.roi_-1' ? { ...ix, collation: { locale: 'en' } } : ix));
    const plan = planLegacyDrop(allPresent(), [ID_INDEX, ...ALL_SERVER, ...odd], stats());
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toMatch(/metrics\.roi_-1/);
  });

  it('reports already-absent legacy indexes instead of failing on them', () => {
    const plan = planLegacyDrop(allPresent(), [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER.slice(1)], stats());
    expect(plan.allowed).toBe(true);
    expect(plan.absent).toEqual(['chainId_1_protocol_1_metrics.apr_-1', ...LEGACY_UNUSED_INDEXES.map((l: { name: string }) => l.name)]);
    expect(plan.toDrop).toHaveLength(6);
  });

  it('refuses when ANY member\'s $indexStats could not be read — the secondaries serve the user reads', () => {
    const plan = planLegacyDrop(allPresent(), [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER], stats(), { unreadableMembers: ['rs-2.example:27017'] });
    expect(plan).toMatchObject({ allowed: false, toDrop: [] });
    expect(plan.reason).toMatch(/could not be read on rs-2\.example:27017/);
  });

  it('refuses while a Set R index is still building on ONE member (merged across members)', () => {
    const row = (name: string, building = false) => ({ name, accesses: { ops: 0, since: new Date(0) }, building });
    const names = [...ALL_SERVER, ...LEGACY_SERVER].map((ix) => ix.name);
    // The building member comes FIRST, so a "last member wins" merge would miss it.
    const merged = mergeMemberIndexStats([
      { host: 'a', rows: names.map((n) => row(n, n === 'lbr_pnl')) },
      { host: 'b', rows: names.map((n) => row(n)) },
    ]);
    expect(planLegacyDrop(allPresent(), [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER], merged).reason).toMatch(/lbr_pnl=building/);
  });
});

describe('replica-set members', () => {
  it('memberHosts: electable hosts + passives, de-duplicated; null for a standalone', () => {
    expect(memberHosts({ isWritablePrimary: true })).toBeNull();
    expect(memberHosts(undefined)).toBeNull();
    expect(memberHosts({ setName: 'rs0', hosts: ['a:1', 'b:1'], passives: ['c:1', 'a:1'], arbiters: ['z:1'] })).toEqual(['a:1', 'b:1', 'c:1']);
  });

  it('memberClientOptions: a DIRECT connection carrying the client\'s credentials and TLS (DEFAULT mechanism left to the driver)', () => {
    expect(
      memberClientOptions({ credentials: { username: 'u', password: 'p', source: 'admin', mechanism: 'DEFAULT' }, tls: true, tlsCAFile: '/ca.pem', appName: 'x' }),
    ).toEqual({
      directConnection: true, serverSelectionTimeoutMS: 15_000, readPreference: 'secondaryPreferred',
      auth: { username: 'u', password: 'p' }, authSource: 'admin', tls: true, tlsCAFile: '/ca.pem',
    });
    expect(memberClientOptions({ credentials: { username: 'u', password: 'p', source: '$external', mechanism: 'PLAIN' } })).toMatchObject({ authMechanism: 'PLAIN', authSource: '$external' });
    expect(memberClientOptions({})).toEqual({ directConnection: true, serverSelectionTimeoutMS: 15_000, readPreference: 'secondaryPreferred' });
  });

  it('mergeMemberIndexStats: ops summed, building if any member is, earliest since, the split kept', () => {
    const merged = mergeMemberIndexStats([
      { host: 'a', rows: [{ name: 'x', accesses: { ops: 3, since: new Date(2000) } }] },
      { host: 'b', rows: [{ name: 'x', accesses: { ops: 9, since: new Date(1000) }, building: true }] },
      { host: 'c', rows: [{ name: 'x', accesses: { ops: 0, since: new Date(3000) } }, { name: 'y', accesses: { ops: 1 } }] },
    ]);
    expect(merged.get('x')).toMatchObject({ ops: 12, building: true, since: new Date(1000) });
    expect(merged.get('x').perMember.map((m: { host: string; ops: number }) => [m.host, m.ops])).toEqual([['a', 3], ['b', 9], ['c', 0]]);
    expect(merged.get('y')).toMatchObject({ ops: 1, building: false });
    expect(formatOps(merged.get('x'))).toBe('ops 12 (a 3, b 9, c 0) (building)');
    expect(formatOps({ ops: 4, building: false, perMember: [{ host: 'a', ops: 4 }] })).toBe('ops 4');
    expect(formatOps(undefined)).toBe('ops n/a');
  });

  it('connectMembers: a standalone reads from the one connection; a replica set opens one direct client per member, an unreachable one is reported and closed', async () => {
    const primaryDb = { databaseName: 'copypools_positions' };
    const standalone = await connectMembers({ options: {} }, { command: async () => ({ isWritablePrimary: true }) }, primaryDb);
    expect(standalone.members).toEqual([{ host: '(standalone)', db: primaryDb }]);
    expect(standalone.unreachable).toEqual([]);

    const opened: Array<{ uri: string; options: Record<string, unknown>; closed: boolean }> = [];
    class FakeClient {
      record: { uri: string; options: Record<string, unknown>; closed: boolean };
      constructor(uri: string, options: Record<string, unknown>) {
        this.record = { uri, options, closed: false };
        opened.push(this.record);
      }
      async connect() {
        if (this.record.uri.includes('down')) throw new Error('connect ECONNREFUSED');
      }
      db(name: string) {
        return { databaseName: name, uri: this.record.uri };
      }
      async close() {
        this.record.closed = true;
      }
    }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const set = await connectMembers(
      { options: { credentials: { username: 'u', password: 'p', source: 'admin' }, tls: true } },
      { command: async () => ({ setName: 'atlas-x', hosts: ['a:27017', 'down:27017'], passives: ['c:27017'] }) },
      primaryDb,
      FakeClient as never,
    );
    expect(set.replicaSet).toBe('atlas-x');
    expect(set.members.map((m: { host: string }) => m.host)).toEqual(['a:27017', 'c:27017']);
    expect(set.unreachable).toEqual(['down:27017']);
    expect(opened.map((o) => o.uri)).toEqual(['mongodb://a:27017/', 'mongodb://down:27017/', 'mongodb://c:27017/']);
    expect(opened.every((o) => o.options.directConnection === true && o.options.tls === true)).toBe(true);
    expect(opened.find((o) => o.uri.includes('down'))!.closed).toBe(true);
    expect(set.clients).toHaveLength(2);
    vi.restoreAllMocks();
  });
});

describe('server version, overlap and deploy readiness', () => {
  it('distinctHintSupported: from 7.1 on; null when unknown', () => {
    expect(distinctHintSupported([7, 0, 14, 0])).toBe(false);
    expect(distinctHintSupported([6, 9, 0, 0])).toBe(false);
    expect(distinctHintSupported([7, 1, 0, 0])).toBe(true);
    expect(distinctHintSupported([8, 0, 32, 0])).toBe(true);
    expect(distinctHintSupported(undefined)).toBeNull();
    expect(distinctHintSupported([8])).toBeNull();
  });

  it('overlapReport: current + build against the cache, warning at the threshold, unknown cache = no verdict', () => {
    const mb = 1024 ** 2;
    expect(overlapReport({ currentIndexBytes: 345 * mb, buildBytes: 0, legacyIndexBytes: 95 * mb, cacheBytes: 512 * mb })).toMatchObject({
      projectedBytes: 345 * mb, share: 345 / 512, warn: true,
    });
    const atThreshold = overlapReport({ currentIndexBytes: CACHE_WARN_SHARE * 100, buildBytes: 0, cacheBytes: 100 });
    expect(atThreshold.warn).toBe(true);
    expect(overlapReport({ currentIndexBytes: 40, buildBytes: 9, cacheBytes: 100 }).warn).toBe(false);
    expect(overlapReport({ currentIndexBytes: 40, buildBytes: 9, cacheBytes: null })).toMatchObject({ projectedBytes: 49, share: null, warn: false });
  });

  it('deployReadiness: READY only with all twelve present everywhere and no odd isActive rows', () => {
    const full = [ID_INDEX, ...ALL_SERVER];
    expect(deployReadiness([{ name: 'a', indexes: full, oddIsActiveCount: 0 }, { name: 'b', indexes: full }])).toEqual({ ready: true, problems: [] });
    const conflicting = { ...serverShape(specNamed('lbr_value')), hidden: true };
    const verdict = deployReadiness([
      { name: 'a', indexes: full, oddIsActiveCount: 0 },
      // a --skip-background run on this shard: Set R only
      { name: 'b', indexes: [ID_INDEX, ...ALL_SERVER.filter((ix) => ix.name.startsWith('lbr_') && ix.name !== 'lbr_value'), conflicting] },
      { name: 'c', indexes: full, oddIsActiveCount: 4 },
    ]);
    expect(verdict.ready).toBe(false);
    expect(verdict.problems).toEqual([
      { name: 'b', missing: BACKGROUND_SPECS.map((s: Spec) => s.name), conflicts: ['lbr_value'], oddIsActiveCount: 0 },
      { name: 'c', missing: [], conflicts: [], oddIsActiveCount: 4 },
    ]);
    expect(deployReadiness([{ name: 'c', indexes: full, oddIsActiveCount: 4 }], { allowOddIsActive: true }).ready).toBe(true);
    // A conflict ALONE is not deploy-ready: the hint would land on the wrong index.
    const onlyConflict = [ID_INDEX, ...ALL_SERVER.filter((ix) => ix.name !== 'lbr_value'), conflicting];
    expect(deployReadiness([{ name: 'd', indexes: onlyConflict, oddIsActiveCount: 0 }])).toEqual({
      ready: false,
      problems: [{ name: 'd', missing: [], conflicts: ['lbr_value'], oddIsActiveCount: 0 }],
    });
  });

  it('exitCodeFor: an --apply BUILD run that is not deploy-ready exits non-zero; diagnose and --drop-legacy do not', () => {
    const notReady = { ready: false, problems: [{ name: 'b', missing: ['bg_fee_hot'], conflicts: [], oddIsActiveCount: 0 }] };
    expect(NOT_READY_EXIT_CODE).toBe(3);
    expect(exitCodeFor({ ...FLAGS, apply: true }, notReady)).toBe(NOT_READY_EXIT_CODE);
    expect(exitCodeFor({ ...FLAGS, apply: true }, { ready: true, problems: [] })).toBe(0);
    expect(exitCodeFor({ ...FLAGS, apply: false }, notReady)).toBe(0);
    expect(exitCodeFor({ ...FLAGS, apply: true, dropLegacy: true }, notReady)).toBe(0);
    expect(exitCodeFor({ ...FLAGS, apply: true }, null)).toBe(0);
  });
});

describe('legacyDeclarationsInSource', () => {
  const declarations = [
    "PositionSchema.index({ chainId: 1, protocol: 1, 'metrics.apr': -1 });",
    "PositionSchema.index({ chainId: 1, protocol: 1, 'metrics.feeApr': -1 });",
    "PositionSchema.index({ chainId: 1, protocol: 1, 'metrics.roi': -1 });",
    "PositionSchema.index({ chainId: 1, protocol: 1, 'metrics.pnlUsd': -1 });",
    "PositionSchema.index({ chainId: 1, protocol: 1, 'metrics.underlyingValueUsd': -1 });",
    "PositionSchema.index({ chainId: 1, protocol: 1, 'metrics.ageSeconds': -1 }, { background: true });",
    "PositionSchema.index({\n  chainId: 1,\n  protocol: 1,\n  'metrics.aprExGas': -1\n});",
  ];

  it('finds all seven, including declarations with options or across lines', () => {
    expect(legacyDeclarationsInSource(declarations.join('\n'))).toEqual(LEGACY_METRIC_INDEXES.map((l: { name: string }) => l.name));
  });

  it('ignores the Set R declarations and unrelated indexes that share a field', () => {
    const source = [
      "PositionSchema.index({ chainId: 1, protocol: 1, 'metrics.aprExGas': -1, positionId: 1, 'metrics.inRange': 1 }, { name: 'lbr_apr_active' });",
      "PositionSchema.index({ chainId: 1, protocol: 1, 'metrics.feesSource': 1 });",
      "PositionSchema.index({ chainId: 1, protocol: 1, isActive: -1, tokenId: 1 });",
      "PositionSchema.index({ chainId: 1, protocol: 1, isActive: 1, positionId: 1, 'metrics.performanceReady': 1 }, { name: 'bg_active_walk' });",
      "PositionSchema.index({ chainId: 1, protocol: 1, isActive: 1, poolId: 1, owner: 1 }, { name: 'bg_active_pool_owner', partialFilterExpression: { isActive: true } });",
      "// PositionSchema.index({ chainId: 1, protocol: 1, 'metrics.apr': 1 });",
    ].join('\n');
    expect(legacyDeclarationsInSource(source)).toEqual([]);
  });

  it('finds the unused eight: unnamed ones by key literal (quoted or not), the bg_ ones by their name option', () => {
    const source = [
      'PositionSchema.index({ chainId: 1, protocol: 1, isActive: 1 });',
      "PositionSchema.index({ chainId: 1, protocol: 1, 'metrics.performanceReady': 1 });",
      'PositionSchema.index({ chainId: 1, protocol: 1, createdAtTimestamp: 1, positionId: 1 });',
      'PositionSchema.index({ chainId: 1, protocol: 1, lastVerifiedAt: 1 });',
      'PositionSchema.index({ chainId: 1, protocol: 1, isActive: 1, txSyncStatus: 1, txLastSuccessAt: 1 });',
      'PositionSchema.index({\n  "chainId": 1,\n  "protocol": 1,\n  "isActive": 1,\n  "txFinalizedAt": 1,\n});',
      "PositionSchema.index({ chainId: 1, protocol: 1, isActive: 1, 'metrics.inRange': 1, tokenId: 1 }, { name: 'bg_fee_hot', partialFilterExpression: { ...ACTIVE_ONLY } });",
      'PositionSchema.index(\n  { chainId: 1, protocol: 1, isActive: 1, poolId: 1 },\n  { name: "bg_active_pool", partialFilterExpression: { ...ACTIVE_ONLY } },\n);',
    ].join('\n');
    expect(legacyDeclarationsInSource(source)).toEqual(LEGACY_UNUSED_INDEXES.map((l: { name: string }) => l.name));
  });
});

describe('buildCreateIndexesCommand', () => {
  it('is ONE createIndexes carrying each index\'s own collation and partial filter, without commitQuorum', () => {
    const specs = [specNamed('lbr_apr_active'), specNamed('lbr_pnl'), specNamed('bg_active_pool_owner')];
    const command = buildCreateIndexesCommand('1_uniswap_v4_positions', specs);
    expect(Object.keys(command)).toEqual(['createIndexes', 'indexes']);
    expect(command.createIndexes).toBe('1_uniswap_v4_positions');
    expect(command.indexes).toEqual([
      { key: specNamed('lbr_apr_active').key, name: 'lbr_apr_active', collation: { locale: 'en', numericOrdering: true }, partialFilterExpression: { isActive: true } },
      { key: specNamed('lbr_pnl').key, name: 'lbr_pnl', collation: { locale: 'en', numericOrdering: true } },
      { key: specNamed('bg_active_pool_owner').key, name: 'bg_active_pool_owner', collation: { locale: 'simple' }, partialFilterExpression: { isActive: true } },
    ]);
    // copies, so the driver can never mutate the frozen spec list
    expect(command.indexes[0].key).not.toBe(specNamed('lbr_apr_active').key);
  });
});

// ── the --apply / --drop-legacy gates, against an in-memory server ───────────

type Command = Record<string, unknown>;

function fakeServer(initial: Record<string, Index[]>, { currentOps = [] as unknown[], currentOpError = null as Error | null, dropOnBuild = null as string | null } = {}) {
  const state: Record<string, Index[]> = Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, [...v]]));
  const commands: Command[] = [];
  const db = {
    databaseName: 'copypools_positions',
    command: vi.fn(async (command: Command) => {
      commands.push(command);
      if (command.createIndexes) {
        const name = command.createIndexes as string;
        const before = state[name].length;
        for (const index of command.indexes as Index[]) {
          if (index.name !== dropOnBuild) state[name].push(serverShape(index as never));
        }
        return { ok: 1, numIndexesBefore: before, numIndexesAfter: state[name].length };
      }
      if (command.dropIndexes) {
        const names = command.index as string[];
        state[command.dropIndexes as string] = state[command.dropIndexes as string].filter((ix) => !names.includes(ix.name));
        return { ok: 1 };
      }
      throw new Error(`unexpected command ${JSON.stringify(command)}`);
    }),
    collection: (name: string) => ({
      indexes: async () => state[name].map((ix) => ({ ...ix })),
      aggregate: () => ({ toArray: async () => [] }),
    }),
  };
  const adminDb = {
    aggregate: () => ({
      toArray: async () => {
        if (currentOpError) throw currentOpError;
        return currentOps;
      },
    }),
  };
  return { db, adminDb, state, commands };
}

const FS_PLENTY = { fsUsedSize: 1, fsTotalSize: 1024 ** 4 };

function reportFor(name: string, indexes: Index[], flags = { skipBackground: false }, bytesEach = 1_000) {
  const plan = planShard(indexes, flags);
  return {
    name,
    plan,
    indexes,
    indexStats: new Map(indexes.map((ix) => [ix.name, { ops: 3, since: new Date(0), building: false }])),
    storage: null,
    estimates: new Map(plan.toBuild.map((spec: Spec) => [spec.name, { entries: 1, avgKeyBytes: bytesEach, bytes: bytesEach }])),
    buildBytes: plan.toBuild.length * bytesEach,
    outcome: '',
  };
}

const FLAGS = { apply: true, dropLegacy: false, skipBackground: false, shard: undefined };

describe('runApply', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds every missing index of a shard in ONE createIndexes, and skips a complete shard', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...LEGACY_SERVER], b: [ID_INDEX, ...ALL_SERVER] });
    const reports = [reportFor('a', server.state.a), reportFor('b', server.state.b)];
    await runApply(server, reports, FS_PLENTY, FLAGS);
    expect(server.commands).toHaveLength(1);
    expect(server.commands[0].createIndexes).toBe('a');
    expect((server.commands[0].indexes as Index[]).map((ix) => ix.name)).toEqual([...SET_R_SPECS, ...BACKGROUND_SPECS].map((s: Spec) => s.name));
    expect(reports[0].outcome).toMatch(/^built 11 in/);
    expect(reports[0].plan.toBuild).toEqual([]);
    expect(reports[1].outcome).toBe('nothing to build');
  });

  it('--skip-background builds Set R only', async () => {
    const server = fakeServer({ a: [ID_INDEX] });
    await runApply(server, [reportFor('a', server.state.a, { skipBackground: true })], FS_PLENTY, { ...FLAGS, skipBackground: true });
    expect((server.commands[0].indexes as Index[]).map((ix) => ix.name)).toEqual(SET_R_SPECS.map((s: Spec) => s.name));
  });

  it('a CONFLICT on any shard aborts before anything is built on any shard', async () => {
    const conflicting = { ...serverShape(specNamed('lbr_value')), key: { chainId: 1, protocol: 1, 'metrics.underlyingValueUsd': -1 } };
    const server = fakeServer({ a: [ID_INDEX], b: [ID_INDEX, conflicting] });
    const reports = [reportFor('a', server.state.a), reportFor('b', server.state.b)];
    await expect(runApply(server, reports, FS_PLENTY, FLAGS)).rejects.toThrow(/1 index conflict\(s\) — refusing to build anything/);
    expect(server.commands).toEqual([]);
    expect(reports.map((r) => r.outcome)).toEqual(['BLOCKED (conflict)', 'BLOCKED (conflict)']);
  });

  it('refuses when free disk is under 3x the summed estimate across shards', async () => {
    const server = fakeServer({ a: [ID_INDEX], b: [ID_INDEX] });
    const reports = [reportFor('a', server.state.a, undefined, 100), reportFor('b', server.state.b, undefined, 100)];
    // 2 shards x 11 indexes x 100 B = 2,200 B → 6,600 B required; 6,599 free must refuse
    await expect(runApply(server, reports, { fsUsedSize: 1, fsTotalSize: 6_600 }, FLAGS)).rejects.toThrow(/insufficient disk headroom/);
    expect(server.commands).toEqual([]);
    await runApply(server, reports, { fsUsedSize: 0, fsTotalSize: 6_600 }, FLAGS);
    expect(server.commands).toHaveLength(2);
  });

  it('refuses to start while an index build is already running on a target shard', async () => {
    const server = fakeServer({ a: [ID_INDEX] }, { currentOps: [{ ns: 'copypools_positions.a', msg: 'Index Build: scanning collection' }] });
    await expect(runApply(server, [reportFor('a', server.state.a)], FS_PLENTY, FLAGS)).rejects.toThrow(/already running on copypools_positions\.a/);
    expect(server.commands).toEqual([]);
  });

  it('a build on ANOTHER collection does not block, and an unreadable $currentOp only warns', async () => {
    const elsewhere = fakeServer({ a: [ID_INDEX] }, { currentOps: [{ ns: 'copypools_positions.1_uniswap_v4_pools' }] });
    await runApply(elsewhere, [reportFor('a', elsewhere.state.a)], FS_PLENTY, FLAGS);
    expect(elsewhere.commands).toHaveLength(1);
    const blind = fakeServer({ a: [ID_INDEX] }, { currentOpError: new Error('not authorized on admin to execute command') });
    await runApply(blind, [reportFor('a', blind.state.a)], FS_PLENTY, FLAGS);
    expect(blind.commands).toHaveLength(1);
  });

  it('fails loudly when an index is not present as specified after the build', async () => {
    const server = fakeServer({ a: [ID_INDEX] }, { dropOnBuild: 'lbr_created' });
    const report = reportFor('a', server.state.a);
    await expect(runApply(server, [report], FS_PLENTY, FLAGS)).rejects.toThrow(/lbr_created=missing/);
    expect(report.outcome).toBe('FAILED (verify)');
  });

  it('a shard with everything present issues no command', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...ALL_SERVER] });
    await runApply(server, [reportFor('a', server.state.a)], {}, FLAGS);
    expect(server.commands).toEqual([]);
  });

  it('refuses while any target shard has rows with a non-boolean isActive — unless --allow-odd-isactive', async () => {
    const server = fakeServer({ a: [ID_INDEX], b: [ID_INDEX] });
    const reports = [{ ...reportFor('a', server.state.a), oddIsActiveCount: 0 }, { ...reportFor('b', server.state.b), oddIsActiveCount: 2 }];
    await expect(runApply(server, reports, FS_PLENTY, FLAGS)).rejects.toThrow(/b: 2 row\(s\) with a missing\/null\/non-boolean isActive.*nothing was built/);
    expect(server.commands).toEqual([]);
    expect(reports.map((r) => r.outcome)).toEqual(['withheld (another shard refused)', 'REFUSED (odd isActive)']);
    await runApply(server, reports, FS_PLENTY, { ...FLAGS, allowOddIsActive: true });
    expect(server.commands).toHaveLength(2);
  });
});

describe('inProgressBuilds', () => {
  it('matches only the target namespaces and reports when it could not look', async () => {
    const { adminDb } = fakeServer({}, { currentOps: [{ ns: 'db.a' }, { command: { $db: 'db', createIndexes: 'b' } }, { ns: 'db.c' }] });
    expect(await inProgressBuilds(adminDb, 'db', ['a', 'b'])).toEqual({ checked: true, running: ['db.a', 'db.b'] });
    const blind = fakeServer({}, { currentOpError: new Error('denied') }).adminDb;
    expect(await inProgressBuilds(blind, 'db', ['a'])).toEqual({ checked: false, running: [], error: 'denied' });
  });
});

describe('checkDropEvidence (per member)', () => {
  const NOW = Date.UTC(2026, 9, 10, 12);
  const since = new Date(Date.UTC(2026, 9, 1));
  const name = 'chainId_1_protocol_1_isActive_1';
  const report = (members: Array<{ host: string; ops: number; since?: Date }>) => ({
    name: 'a',
    indexes: [{ name, key: { chainId: 1, protocol: 1, isActive: 1 } }],
    indexStats: new Map([[name, { ops: members.reduce((n, m) => n + m.ops, 0), since, building: false, perMember: members.map((m) => ({ since, ...m, building: false })) }]]),
  });
  const plans = (r: ReturnType<typeof report>) => [{ report: r, plan: { toDrop: [name] } }];
  const recorded = buildDropEvidence([report([{ host: 'p:1', ops: 10 }, { host: 's1:2', ops: 0 }, { host: 's2:3', ops: 0 }])], {
    target: 't',
    takenAt: new Date(NOW - 50 * 3_600_000),
  });

  it('passes when every member reports the same since and ops', () => {
    const now = report([{ host: 'p:1', ops: 10 }, { host: 's1:2', ops: 0 }, { host: 's2:3', ops: 0 }]);
    expect(checkDropEvidence(recorded, plans(now), { target: 't', now: NOW })).toEqual({ ok: true, problems: [] });
  });

  it('one secondary that served a read since the snapshot refuses it', () => {
    const now = report([{ host: 'p:1', ops: 10 }, { host: 's1:2', ops: 1 }, { host: 's2:3', ops: 0 }]);
    const verdict = checkDropEvidence(recorded, plans(now), { target: 't', now: NOW });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/USED since the snapshot on s1:2 \(ops 0 → 1\)/);
  });

  it('a member the snapshot lacks, or one that no longer answers, refuses it', () => {
    const extra = report([{ host: 'p:1', ops: 10 }, { host: 's1:2', ops: 0 }, { host: 's2:3', ops: 0 }, { host: 's3:4', ops: 0 }]);
    expect(checkDropEvidence(recorded, plans(extra), { target: 't', now: NOW }).problems.join('\n')).toMatch(/s3:4 is not in the snapshot/);
    const fewer = report([{ host: 'p:1', ops: 10 }, { host: 's1:2', ops: 0 }]);
    expect(checkDropEvidence(recorded, plans(fewer), { target: 't', now: NOW }).problems.join('\n')).toMatch(/s2:3 is in the snapshot but did not answer/);
  });

  it('no snapshot, or one without this index, refuses it', () => {
    expect(checkDropEvidence(null, [], { now: NOW }).ok).toBe(false);
    const now = report([{ host: 'p:1', ops: 10 }]);
    const other = { ...plans(now)[0]!, plan: { toDrop: ['bg_fee_hot'] } };
    expect(checkDropEvidence(recorded, [other], { target: 't', now: NOW }).problems.join('\n')).toMatch(/no evidence recorded for bg_fee_hot/);
  });
});

describe('runDropLegacy', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const LEGACY_NAMES = LEGACY_METRIC_INDEXES.map((l: { name: string }) => l.name);
  const DECLARED = "PositionSchema.index({ chainId: 1, protocol: 1, 'metrics.apr': -1 });";
  const NOW = Date.UTC(2026, 9, 10, 12);
  const TARGET = 'mongodb://<credentials>@rs.example/copypools_positions';
  /** A snapshot of these reports' $indexStats taken `ageH` hours before NOW. */
  const evidenceFor = (reports: unknown[], ageH = 49) =>
    buildDropEvidence(reports, { target: TARGET, takenAt: new Date(NOW - ageH * 3_600_000) });
  const withEvidence = (reports: unknown[], ageH = 49) => ({ evidence: evidenceFor(reports, ageH), target: TARGET, now: NOW });

  it('drops the seven legacy indexes in one dropIndexes per shard with --apply', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER] });
    const report = reportFor('a', server.state.a);
    await runDropLegacy(server, [report], { ...FLAGS, dropLegacy: true }, '', withEvidence([report]));
    expect(server.commands).toEqual([{ dropIndexes: 'a', index: LEGACY_NAMES }]);
    expect(report.outcome).toBe('dropped 7');
    expect(server.state.a.map((ix) => ix.name)).toEqual(['_id_', ...ALL_SERVER.map((ix) => ix.name)]);
  });

  it('drops the unused eight with them, the old bg_active_pool included', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER, ...UNUSED_SERVER] });
    const report = reportFor('a', server.state.a);
    await runDropLegacy(server, [report], { ...FLAGS, dropLegacy: true }, '', withEvidence([report]));
    expect(server.commands).toEqual([{ dropIndexes: 'a', index: LEGACY_INDEXES.map((l: { name: string }) => l.name) }]);
    expect(report.outcome).toBe('dropped 15');
  });

  it('refuses the whole drop while a REPLACEMENT (here bg_active_pool_owner) is missing on a shard', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...ALL_SERVER.filter((ix) => ix.name !== 'bg_active_pool_owner'), ...UNUSED_SERVER] });
    const report = reportFor('a', server.state.a);
    await expect(runDropLegacy(server, [report], { ...FLAGS, dropLegacy: true }, '', withEvidence([report]))).rejects.toThrow(/refused on a/);
    expect(server.commands).toEqual([]);
  });

  it('--apply WITHOUT evidence refuses — nothing dropped', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER] });
    const report = reportFor('a', server.state.a);
    await expect(runDropLegacy(server, [report], { ...FLAGS, dropLegacy: true }, '', { target: TARGET, now: NOW })).rejects.toThrow(
      /evidence does not show these indexes unused/,
    );
    expect(server.commands).toEqual([]);
    expect(report.outcome).toBe('drop REFUSED (evidence)');
  });

  it('refuses evidence younger than 48 h, from another target, or that the counters contradict', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER] });
    const report = reportFor('a', server.state.a);
    const flags = { ...FLAGS, dropLegacy: true };
    // too young
    await expect(runDropLegacy(server, [report], flags, '', withEvidence([report], 47))).rejects.toThrow(/evidence/);
    // another target
    await expect(runDropLegacy(server, [report], flags, '', { ...withEvidence([report]), target: 'mongodb://other/db' })).rejects.toThrow(/evidence/);
    // used since the snapshot
    const snapshot = evidenceFor([report]);
    const used = { ...report, indexStats: new Map([...report.indexStats].map(([n, st]) => [n, n === LEGACY_NAMES[2] ? { ...st, ops: 4 } : st])) };
    await expect(runDropLegacy(server, [used], flags, '', { evidence: snapshot, target: TARGET, now: NOW })).rejects.toThrow(/evidence/);
    // a restart reset the counters (same ops, new since)
    const restarted = { ...report, indexStats: new Map([...report.indexStats].map(([n, st]) => [n, { ...st, since: new Date(NOW - 3_600_000) }])) };
    await expect(runDropLegacy(server, [restarted], flags, '', { evidence: snapshot, target: TARGET, now: NOW })).rejects.toThrow(/evidence/);
    expect(server.commands).toEqual([]);
  });

  it('--record-evidence (a dry run) hands the snapshot to the writer and drops nothing', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER] });
    const report = reportFor('a', server.state.a);
    const written: unknown[] = [];
    await runDropLegacy(server, [report], { ...FLAGS, apply: false, dropLegacy: true, recordEvidence: 'ev.json' }, '', {
      target: TARGET,
      now: NOW,
      writeEvidence: (json: unknown) => written.push(json),
    });
    expect(server.commands).toEqual([]);
    expect(written).toEqual([evidenceFor([report], 0)]);
    const snapshot = written[0] as { shards: Record<string, Record<string, { members: Record<string, { ops: number }> }>> };
    expect(Object.keys(snapshot.shards.a)).toEqual(LEGACY_NAMES);
    expect(snapshot.shards.a[LEGACY_NAMES[0]!]!.members['(merged)']).toEqual({ ops: 3, since: new Date(0).toISOString() });
  });

  it('without --apply it is a dry run', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER] });
    const report = reportFor('a', server.state.a);
    await runDropLegacy(server, [report], { ...FLAGS, apply: false, dropLegacy: true }, '');
    expect(server.commands).toEqual([]);
    expect(report.outcome).toBe('would drop 7');
  });

  it('one shard without complete Set R refuses the WHOLE run — nothing dropped anywhere', async () => {
    const server = fakeServer({
      a: [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER],
      b: [ID_INDEX, ...ALL_SERVER.filter((ix) => ix.name !== 'lbr_tokenid'), ...LEGACY_SERVER],
    });
    const reports = [reportFor('a', server.state.a), reportFor('b', server.state.b)];
    await expect(runDropLegacy(server, reports, { ...FLAGS, dropLegacy: true }, '')).rejects.toThrow(/refused on b — nothing was dropped/);
    expect(server.commands).toEqual([]);
    expect(reports.map((r) => r.outcome)).toEqual(['drop withheld (another shard refused)', 'drop REFUSED']);
  });

  it('refuses --apply while position.schema.ts still declares a legacy index (autoIndex would rebuild it)', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER] });
    await expect(runDropLegacy(server, [reportFor('a', server.state.a)], { ...FLAGS, dropLegacy: true }, DECLARED)).rejects.toThrow(/still declared/);
    expect(server.commands).toEqual([]);
  });

  it('an unreadable schema source warns and does not block (the check is necessary, not sufficient)', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...ALL_SERVER, ...LEGACY_SERVER] });
    const report = reportFor('a', server.state.a);
    await runDropLegacy(server, [report], { ...FLAGS, dropLegacy: true }, null, withEvidence([report]));
    expect(server.commands).toHaveLength(1);
  });

  it('a shard with no legacy indexes left issues no command', async () => {
    const server = fakeServer({ a: [ID_INDEX, ...ALL_SERVER] });
    const report = reportFor('a', server.state.a);
    await runDropLegacy(server, [report], { ...FLAGS, dropLegacy: true }, '');
    expect(server.commands).toEqual([]);
    expect(report.outcome).toBe('no legacy indexes left');
  });
});
