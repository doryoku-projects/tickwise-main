import 'reflect-metadata';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  bucketAgeSeconds,
  canonicalJson,
  changeReasons,
  declaredLeavesOf,
  decodeWh,
  DEFAULT_FORCED_REWRITE_MS,
  DEFAULT_FORCED_REWRITE_ZERO_MS,
  diffSections,
  encodeWh,
  forcedRewriteIntervalMs,
  fullWriteReason,
  IDENTITY_FIELDS,
  SECTIONS,
  sectionHash,
  sectionLeafWrites,
  sectionOfField,
  sectionUpdateParts,
  sectionValue,
  sectionValues,
  storedImpliedEthPrice,
  valueBucket,
  WH_BYTES,
  writeSkipSettings,
  WRITE_SKIP_OFF,
  type NextWriteState,
  type StoredWriteState,
} from '../../src/database/position-write-hash.js';
import { PositionSchema } from '../../src/database/schemas/position.schema.js';
import type { NormalizedPosition } from '../../src/subgraph/normalized-position.js';
import { normalized } from './support/fixtures.js';

const DECLARED = declaredLeavesOf(PositionSchema);

describe('canonicalJson', () => {
  it('sorts keys at every depth, drops undefined, keeps null', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, e: null } })).toBe('{"a":{"d":2,"e":null},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    // null and missing are different values; undefined and missing are the same.
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson({ a: undefined })).toBe(canonicalJson({}));
  });

  it('-0 is 0; NaN and ±Infinity are tokens no string can collide with', () => {
    expect(canonicalJson(-0)).toBe(canonicalJson(0));
    expect(canonicalJson(Number.NaN)).toBe('NaN');
    expect(canonicalJson(Number.NaN)).not.toBe(canonicalJson('NaN'));
    expect(canonicalJson(Number.POSITIVE_INFINITY)).not.toBe(canonicalJson(Number.NEGATIVE_INFINITY));
    expect(canonicalJson(Number.NaN)).not.toBe(canonicalJson(null));
  });

  it('a Date is its ms, distinct from the same number; bytes as hex; bigint marked', () => {
    expect(canonicalJson(new Date(1234))).toBe('D1234');
    expect(canonicalJson(new Date(1234))).not.toBe(canonicalJson(1234));
    expect(canonicalJson(new Date(Number.NaN))).toBe('Dnull');
    expect(canonicalJson(Buffer.from([1, 255]))).toBe('B01ff');
    expect(canonicalJson(5n)).toBe('5n');
    expect(canonicalJson(5n)).not.toBe(canonicalJson(5));
  });

  it('numbers print as Number#toString (exact) — material rounds to 6 significant digits', () => {
    expect(canonicalJson(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(canonicalJson(1000.004, { material: true })).toBe(canonicalJson(1000.001, { material: true }));
    expect(canonicalJson(1000.004)).not.toBe(canonicalJson(1000.001));
  });

  it('material tolerance (D-2) applies to the numeric sections, never to identity / fee stamp / pricing', () => {
    const a = normalized() as unknown as Record<string, unknown>;
    const nudged = {
      ...a,
      metrics: { ...(a.metrics as object), underlyingValueUsd: 7850.500001 },
      currentTick: 13,
    };
    const first = diffSections(sectionValues(a, DECLARED).values, null, 'material');
    expect(diffSections(sectionValues(nudged, DECLARED).values, first.slots, 'material').changed).toEqual(['i']);
    expect(diffSections(sectionValues(nudged, DECLARED).values, first.slots, 'exact').changed).toEqual(['i', 'm']);
    const stamp = { ...a, rpcFeesUncollected0: '1', rpcFeesUncollected1: '2', rpcFeesBlock: 1_000_000, rpcFeesAt: new Date(1) };
    const s1 = diffSections(sectionValues(stamp, DECLARED).values, null, 'material');
    expect(diffSections(sectionValues({ ...stamp, rpcFeesBlock: 1_000_001 }, DECLARED).values, s1.slots, 'material').changed).toEqual(['f']);
  });

  it('array order matters', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('sectionHash / wh', () => {
  it('8 bytes, deterministic, never the all-zero "unknown" slot', () => {
    const h = sectionHash({ a: 1 });
    expect(h).toHaveLength(8);
    expect(h.equals(sectionHash({ a: 1 }))).toBe(true);
    expect(h.equals(sectionHash({ a: 2 }))).toBe(false);
    expect(h.equals(Buffer.alloc(8))).toBe(false);
  });

  it('round-trips 64 bytes; zero slots read back as unknown; a BSON Binary decodes too', () => {
    const slots = SECTIONS.map((_, i) => (i % 2 === 0 ? sectionHash(i) : null));
    const wh = encodeWh(slots);
    expect(wh).toHaveLength(WH_BYTES);
    const back = decodeWh(wh)!;
    back.forEach((slot, i) => {
      if (i % 2 === 0) expect(slot!.equals(slots[i]!)).toBe(true);
      else expect(slot).toBeNull();
    });
    expect(decodeWh(new mongoose.mongo.BSON.Binary(wh))).toEqual(back);
  });

  it('anything but exactly 64 bytes is "no hash"', () => {
    expect(decodeWh(undefined)).toBeNull();
    expect(decodeWh(null)).toBeNull();
    expect(decodeWh(Buffer.alloc(63))).toBeNull();
    expect(decodeWh(Buffer.alloc(65))).toBeNull();
    expect(decodeWh('a'.repeat(64))).toBeNull();
    expect(decodeWh({ buffer: Buffer.alloc(64) })).toBeNull(); // not a BSON Binary
  });
});

describe('sections', () => {
  it('every NormalizedPosition field has a section or is deliberately unhashed', () => {
    const p = normalized({ rpcFeesUncollected0: '1', rpcFeesUncollected1: '2', rpcFeesBlock: 5, rpcFeesAt: new Date() });
    const unknown = Object.keys(p).filter((k) => sectionOfField(k) === null);
    expect(unknown).toEqual([]);
    expect(sectionOfField('rawSubgraph')).toBe('unhashed');
    expect(sectionOfField('lastSyncedAt')).toBe('unhashed');
    expect(sectionOfField('somethingNew')).toBeNull();
  });

  it('section i lists its fields explicitly', () => {
    expect([...IDENTITY_FIELDS].sort()).toEqual(
      [
        'chainId', 'closedAtTimestamp', 'createdAtTimestamp', 'currentTick', 'fee', 'isActive', 'lastModifyBlock',
        'liquidity', 'owner', 'poolId', 'positionId', 'protocol', 'sqrtPriceX96', 'tickLower', 'tickSpacing',
        'tickUpper', 'tokenId',
      ].sort(),
    );
  });

  it('declared leaves come from the schema, with defaults (usd is one leaf; feesSource has none)', () => {
    const metrics = new Map(DECLARED.metrics.map((l) => [l.name, l]));
    expect(metrics.get('nominalValueUsd')!.defaultValue!()).toBe(0);
    expect(metrics.get('priceUnavailable')!.defaultValue!()).toBe(false);
    expect(metrics.get('performanceSource')!.defaultValue!()).toBe('pending-transactions');
    expect(metrics.get('feesSource')!.defaultValue).toBeUndefined();
    expect(metrics.get('feesMeasuredAt')!.defaultValue).toBeUndefined();
    expect(metrics.has('usd')).toBe(true);
    expect([...metrics.keys()].some((k) => k.startsWith('usd.'))).toBe(false);
    expect(metrics.has('_id')).toBe(false);
    // Not declared — Mongoose strict mode drops it, so it is not hashed.
    expect(DECLARED.token0.map((l) => l.name)).not.toContain('priceConfidence');
  });

  it('a section hashes what MongoDB would STORE: defaults for absent leaves, no undeclared keys, no excluded leaves', () => {
    const set = normalized() as unknown as Record<string, unknown>;
    const m1 = sectionValue(set, 'm', DECLARED) as Record<string, unknown>;
    expect(m1).not.toHaveProperty('ageSeconds');
    const withoutNominal = { ...set, metrics: { ...(set.metrics as object), nominalValueUsd: undefined } };
    const m2 = sectionValue(withoutNominal, 'm', DECLARED) as Record<string, unknown>;
    expect(m2.nominalValueUsd).toBe(0);
    const t0 = sectionValue(set, 't0', DECLARED) as Record<string, unknown>;
    expect(t0).not.toHaveProperty('priceConfidence');
    const r = sectionValue(set, 'r', DECLARED) as Record<string, unknown>;
    expect(r).not.toHaveProperty('pricedAt');
  });

  it('a moving ageSeconds / pricedAt / lastSyncedAt / rawSubgraph changes no section hash', () => {
    const a = normalized() as unknown as Record<string, unknown>;
    const b = {
      ...a,
      metrics: { ...(a.metrics as object), ageSeconds: 99 },
      pricing: { ...(a.pricing as object), pricedAt: new Date(5) },
      lastSyncedAt: new Date(7),
      rawSubgraph: { other: true },
    };
    const d = diffSections(sectionValues(b, DECLARED).values, diffSections(sectionValues(a, DECLARED).values, null).slots);
    expect(d.changed).toEqual([]);
  });

  it('i / f are their present top-level fields; absent → no slot written, the stored one kept', () => {
    const set = normalized() as unknown as Record<string, unknown>;
    expect(sectionValue(set, 'f', DECLARED)).toBeUndefined();
    const first = diffSections(sectionValues(set, DECLARED).values, null);
    expect(first.present).not.toContain('f');
    expect(first.slots[SECTIONS.indexOf('f')]).toBeNull();
    const stamp = { ...set, rpcFeesUncollected0: '1', rpcFeesUncollected1: '2', rpcFeesBlock: 9, rpcFeesAt: new Date(1) };
    const second = diffSections(sectionValues(stamp, DECLARED).values, first.slots);
    expect(second.changed).toEqual(['f']);
    const third = diffSections(sectionValues(set, DECLARED).values, second.slots);
    expect(third.changed).toEqual([]);
    expect(third.slots[SECTIONS.indexOf('f')]!.equals(second.slots[SECTIONS.indexOf('f')]!)).toBe(true);
  });

  it('an unknown field is reported', () => {
    expect(sectionValues({ ...(normalized() as object), shinyNew: 1 }, DECLARED).unknownFields).toEqual(['shinyNew']);
  });
});

describe('leaf writes = today\'s whole-subdoc $set', () => {
  it('present leaves set, absent declared leaves set to their default or unset', () => {
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    sectionLeafWrites('metrics', { apr: 1, apr2: 5 }, DECLARED, set, unset);
    expect(set['metrics.apr']).toBe(1);
    expect(set['metrics.nominalValueUsd']).toBe(0);
    expect(set['metrics.usd']).toEqual({});
    expect(set['metrics.performanceSource']).toBe('pending-transactions');
    expect(unset['metrics.feesSource']).toBe('');
    expect(unset['metrics.feesMeasuredAt']).toBe('');
    expect(set['metrics.apr2']).toBe(5); // undeclared: sent, strict mode drops it as on a whole write
    expect(Object.keys(set).some((k) => k in unset)).toBe(false);
  });

  it('a null leaf is written as null; a non-object section is written whole', () => {
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    sectionLeafWrites('poolStats', { tvlUsd: null }, DECLARED, set, unset);
    expect(set['poolStats.tvlUsd']).toBeNull();
    const whole: Record<string, unknown> = {};
    sectionLeafWrites('pricing', null, DECLARED, whole, {});
    expect(whole).toEqual({ pricing: null });
  });

  it('sectionUpdateParts writes only the changed sections', () => {
    const full = normalized() as unknown as Record<string, unknown>;
    const parts = sectionUpdateParts(full, ['i', 'p'], DECLARED);
    expect(parts.set.currentTick).toBe(12);
    expect(parts.set['poolStats.tvlUsd']).toBe(1_000_000);
    expect(Object.keys(parts.set).some((k) => k.startsWith('metrics') || k.startsWith('amounts'))).toBe(false);
  });
});

describe('fullWriteReason (design §4.2 rule 2)', () => {
  const settings = { ...WRITE_SKIP_OFF, mode: 'on' as const };
  const now = Date.parse('2026-10-04T12:00:00Z');
  const wh = encodeWh(SECTIONS.map((s) => sectionHash(s)));
  const stored = (over: Partial<StoredWriteState> = {}): StoredWriteState => ({
    isActive: true,
    staleMisses: 0,
    wh,
    wAt: new Date(now - 60_000),
    underlyingValueUsd: 100,
    sectionTypes: {},
    ...over,
  });
  const next = (over: Partial<NextWriteState> = {}): NextWriteState => ({
    positionId: '7',
    isActive: true,
    underlyingValueUsd: 100,
    set: normalized() as unknown as Record<string, unknown>,
    unknownFields: [],
    ...over,
  });

  it('null when sections may be compared', () => {
    expect(fullWriteReason(stored(), next(), now, settings)).toBeNull();
  });
  it('insert', () => expect(fullWriteReason(undefined, next(), now, settings)).toBe('insert'));
  it('staleMisses > 0', () => expect(fullWriteReason(stored({ staleMisses: 1 }), next(), now, settings)).toBe('stale-misses'));
  it('isActive flip (either way, a missing stored flag included)', () => {
    expect(fullWriteReason(stored({ isActive: false }), next(), now, settings)).toBe('active-flip');
    expect(fullWriteReason(stored(), next({ isActive: false }), now, settings)).toBe('active-flip');
    expect(fullWriteReason(stored({ isActive: undefined }), next(), now, settings)).toBe('active-flip');
  });
  it('wh missing / invalid, or wAt missing', () => {
    expect(fullWriteReason(stored({ wh: undefined }), next(), now, settings)).toBe('no-hash');
    expect(fullWriteReason(stored({ wh: Buffer.alloc(10) }), next(), now, settings)).toBe('no-hash');
    expect(fullWriteReason(stored({ wAt: undefined }), next(), now, settings)).toBe('no-hash');
  });
  it('lastVerifiedAt after wAt (a full write by a writer that left wh behind); equal or absent compares sections', () => {
    const wAt = new Date(now - 60_000);
    expect(fullWriteReason(stored({ wAt, lastVerifiedAt: new Date(wAt.getTime() + 1) }), next(), now, settings)).toBe('no-hash');
    expect(fullWriteReason(stored({ wAt, lastVerifiedAt: new Date(wAt.getTime()) }), next(), now, settings)).toBeNull();
    expect(fullWriteReason(stored({ wAt, lastVerifiedAt: new Date(wAt.getTime() - 1) }), next(), now, settings)).toBeNull();
    expect(fullWriteReason(stored({ wAt, lastVerifiedAt: undefined }), next(), now, settings)).toBeNull();
  });
  it('an unknown $set field', () => expect(fullWriteReason(stored(), next({ unknownFields: ['x'] }), now, settings)).toBe('unknown-field'));
  it('forced after 6 h × the per-position jitter, 24 h when stored and new value are both $0', () => {
    const interval = forcedRewriteIntervalMs('7', false, settings);
    expect(interval).toBeGreaterThanOrEqual(DEFAULT_FORCED_REWRITE_MS * 0.75);
    expect(interval).toBeLessThan(DEFAULT_FORCED_REWRITE_MS * 1.25);
    expect(fullWriteReason(stored({ wAt: new Date(now - interval + 1) }), next(), now, settings)).toBeNull();
    expect(fullWriteReason(stored({ wAt: new Date(now - interval) }), next(), now, settings)).toBe('forced');
    // Exactly at the interval (wAt = epoch 0 keeps the subtraction exact): due.
    expect(fullWriteReason(stored({ wAt: new Date(0) }), next(), interval, settings)).toBe('forced');
    expect(fullWriteReason(stored({ wAt: new Date(0) }), next(), interval - 0.001, settings)).toBeNull();
    const zero = forcedRewriteIntervalMs('7', true, settings);
    expect(zero / interval).toBeCloseTo(DEFAULT_FORCED_REWRITE_ZERO_MS / DEFAULT_FORCED_REWRITE_MS, 6);
    const zeroStored = stored({ underlyingValueUsd: 0, wAt: new Date(now - interval - 1) });
    expect(fullWriteReason(zeroStored, next({ underlyingValueUsd: 0 }), now, settings)).toBeNull();
    expect(fullWriteReason(zeroStored, next({ underlyingValueUsd: 1 }), now, settings)).toBe('forced');
  });
  it('the jitter differs per position and is stable', () => {
    const a = forcedRewriteIntervalMs('1', false, settings);
    const b = forcedRewriteIntervalMs('2', false, settings);
    expect(a).not.toBe(b);
    expect(forcedRewriteIntervalMs('1', false, settings)).toBe(a);
  });
  it('legacy shape: a stored section that is not an object where the new one is', () => {
    expect(fullWriteReason(stored({ sectionTypes: { poolStats: 'null' } }), next(), now, settings)).toBe('legacy-shape');
    expect(fullWriteReason(stored({ sectionTypes: { pricing: 'array' } }), next(), now, settings)).toBe('legacy-shape');
    expect(fullWriteReason(stored({ sectionTypes: { poolStats: 'object', pricing: 'missing' } }), next(), now, settings)).toBeNull();
  });
});

describe('settings', () => {
  it('defaults are today; garbage reads as the default', () => {
    expect(writeSkipSettings(undefined)).toEqual(WRITE_SKIP_OFF);
    expect(writeSkipSettings({ positionsWriteSkip: 'ON', positionsGasRevalue: 'full-write', positionsWriteSkipAge: 'bucket' })).toMatchObject({
      mode: 'on',
      gas: 'full-write',
      age: 'bucket',
    });
    expect(writeSkipSettings({ positionsWriteSkip: 'maybe', positionsForcedRewriteMs: 0 })).toMatchObject({
      mode: 'off',
      forcedRewriteMs: DEFAULT_FORCED_REWRITE_MS,
    });
    expect(writeSkipSettings({ positionsForcedRewriteMs: '3600000' }).forcedRewriteMs).toBe(3_600_000);
  });
});

describe('clock and gas inputs', () => {
  it('bucketAgeSeconds: ≤ 1 % behind, ≤ 6 h behind, never ahead', () => {
    for (const age of [10, 99, 1000, 86_400, 30 * 86_400, 400 * 86_400]) {
      const b = bucketAgeSeconds(age);
      expect(b).toBeLessThanOrEqual(age);
      expect(age - b).toBeLessThanOrEqual(Math.max(1, Math.min(age * 0.01, 21_600)));
    }
    expect(bucketAgeSeconds(400 * 86_400)).toBe(bucketAgeSeconds(400 * 86_400 + 3_000));
  });

  it('storedImpliedEthPrice reproduces the stored gas USD bit for bit', () => {
    for (const [eth, price] of [[0.0123, 3001.37], [1e-7, 4123.5], [17.25, 2999.99]] as const) {
      const usd = eth * price;
      const implied = storedImpliedEthPrice(usd, String(eth))!;
      expect(Number(String(eth)) * implied).toBe(usd);
    }
    expect(storedImpliedEthPrice(0, '0.1')).toBeUndefined();
    expect(storedImpliedEthPrice(-5, '0.1')).toBeUndefined();
    expect(storedImpliedEthPrice(-5, '-0.1')).toBeUndefined();
    expect(storedImpliedEthPrice(5, '0')).toBeUndefined();
    expect(storedImpliedEthPrice(undefined, undefined)).toBeUndefined();
  });

  it('valueBucket', () => {
    expect([0, 5, 500, 5000, 50_000, 500_000, Number.NaN].map(valueBucket)).toEqual(['0', '<100', '<1k', '<10k', '<100k', '>=100k', '0']);
  });
});

describe('changeReasons (shadow)', () => {
  it('names the leaves that moved', () => {
    const p = normalized() as unknown as Record<string, unknown>;
    const stored = sectionValue(p, 'i', DECLARED);
    const moved = sectionValue({ ...p, currentTick: 99 }, 'i', DECLARED);
    expect(changeReasons('i', stored, moved)).toEqual(['pool-state']);
    const m = sectionValue(p, 'm', DECLARED) as Record<string, unknown>;
    expect(changeReasons('m', m, { ...m, totalGasCostUsd: 9 })).toEqual(['gas']);
    expect(changeReasons('m', m, { ...m, apr: 9 }).sort()).toEqual(['apr-age']);
    expect(changeReasons('m', m, { ...m, pendingFeesUsd: 9, inRange: false }).sort()).toEqual(['fees', 'pool-state']);
    const t0 = sectionValue(p, 't0', DECLARED) as Record<string, unknown>;
    expect(changeReasons('t0', t0, { ...t0, priceUsd: 1 })).toEqual(['token-price']);
    expect(changeReasons('f', undefined, {})).toEqual(['fee-stamp']);
  });
});

describe('two writes of the same position at different times hash alike', () => {
  it('only the clock-driven fields differ', () => {
    const a = normalized();
    const b: NormalizedPosition = {
      ...a,
      metrics: { ...a.metrics, ageSeconds: a.metrics.ageSeconds + 1800 },
      pricing: { ...a.pricing, pricedAt: new Date(a.pricing.pricedAt.getTime() + 1_800_000) },
    };
    const first = diffSections(sectionValues(a as unknown as Record<string, unknown>, DECLARED).values, null);
    const second = diffSections(sectionValues(b as unknown as Record<string, unknown>, DECLARED).values, first.slots);
    expect(second.changed).toEqual([]);
  });
});
