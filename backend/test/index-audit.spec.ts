/*
 * The app's boot pre-flight (`src/database/index-audit.ts`) and the migration
 * script judge "is this index the one we declared?" with two copies of one
 * rule — the script cannot be imported by `src/` (outside the build root, and
 * not shipped in the image). These cases hold the two to the SAME answers, and
 * hold the schema's declarations to the script's specs through the app's copy.
 */
import { describe, expect, it } from 'vitest';
import { BACKGROUND_SPECS, SET_R_SPECS, specDifferences } from '../scripts/positions-index-migration.mjs';
import {
  auditIndexes,
  declaredIndexes,
  declaredNamedIndexes,
  generatedIndexName,
  indexSpecDifferences,
  type DeclaredIndex,
  type ExistingIndex,
} from '../src/database/index-audit.js';
import { PositionSchema } from '../src/database/schemas/position.schema.js';

type Spec = { name: string; key: Record<string, number>; collation?: Record<string, unknown>; partialFilterExpression?: Record<string, unknown> };
const SPECS = [...(SET_R_SPECS as Spec[]), ...(BACKGROUND_SPECS as Spec[])];

function serverShape(spec: Spec): ExistingIndex {
  const out: ExistingIndex & { v: number } = { v: 2, key: { ...spec.key }, name: spec.name };
  if (spec.collation && spec.collation.locale !== 'simple') {
    out.collation = {
      locale: spec.collation.locale, caseLevel: false, caseFirst: 'off', strength: 3,
      numericOrdering: spec.collation.numericOrdering ?? false, alternate: 'non-ignorable',
      maxVariable: 'punct', normalization: false, backwards: false, version: '57.1',
    };
  }
  if (spec.partialFilterExpression) out.partialFilterExpression = { ...spec.partialFilterExpression };
  return out;
}

const collated = (spec: Spec) => Boolean(spec.collation && spec.collation.locale !== 'simple');

/** Each case: a mutation of the server-side index, and whether (for this spec) it must read as different. */
const VARIANTS: Array<[string, (ix: ExistingIndex) => ExistingIndex, (spec: Spec) => boolean]> = [
  ['identical', (ix) => ix, () => false],
  ['key order swapped', (ix) => { const [a, b, ...rest] = Object.entries(ix.key); return { ...ix, key: Object.fromEntries([b!, a!, ...rest]) }; }, () => true],
  ['key field dropped', (ix) => ({ ...ix, key: Object.fromEntries(Object.entries(ix.key).slice(0, -1)) }), () => true],
  ['key direction flipped', (ix) => ({ ...ix, key: Object.fromEntries(Object.entries(ix.key).map(([k, v], i) => [k, i === 2 ? -Number(v) : v])) }), () => true],
  ['direction as a string', (ix) => ({ ...ix, key: Object.fromEntries(Object.entries(ix.key).map(([k, v]) => [k, String(v)])) }), () => false],
  ['collation dropped', (ix) => ({ ...ix, collation: undefined }), collated],
  ['collation added', (ix) => ({ ...ix, collation: { locale: 'en', numericOrdering: true, strength: 3 } }), (spec) => !collated(spec)],
  ['numericOrdering off', (ix) => ({ ...ix, collation: { locale: 'en' } }), () => true],
  ['partial filter narrowed', (ix) => ({ ...ix, partialFilterExpression: { isActive: true, 'metrics.inRange': true } }), () => true],
  ['partial filter dropped', (ix) => ({ ...ix, partialFilterExpression: undefined }), (spec) => Boolean(spec.partialFilterExpression)],
  ['unique', (ix) => ({ ...ix, unique: true }), () => true],
  ['sparse', (ix) => ({ ...ix, sparse: true }), () => true],
  ['TTL', (ix) => ({ ...ix, expireAfterSeconds: 60 }), () => true],
  ['hidden', (ix) => ({ ...ix, hidden: true }), () => true],
];

describe('index-audit mirrors the migration script', () => {
  const cases = SPECS.flatMap((spec) => VARIANTS.map(([label, mutate, differs]) => ({ spec, label, mutate, differs: differs(spec) })));

  it.each(cases)('$spec.name · $label (differs=$differs)', ({ spec, mutate, differs }) => {
    const existing = mutate(serverShape(spec));
    const declared: DeclaredIndex = { name: spec.name, key: spec.key, collation: spec.collation, partialFilterExpression: spec.partialFilterExpression };
    const app = indexSpecDifferences(declared, existing);
    expect(app).toEqual(specDifferences(spec, existing));
    expect(app.length > 0).toBe(differs);
  });

  it('the schema declares exactly the specs, as the app reads them (names, keys, collation, partial filter)', () => {
    const declared = declaredNamedIndexes(PositionSchema);
    expect(declared.map((d) => d.name).sort()).toEqual(SPECS.map((s) => s.name).sort());
    const audit = auditIndexes(declared, SPECS.map(serverShape));
    expect(audit).toEqual({ missing: [], mismatched: [] });
  });

  it('auditIndexes: missing by NAME (an identical key under another name is still missing), mismatched with reasons', () => {
    const declared = declaredNamedIndexes(PositionSchema);
    const renamed = { ...serverShape(SPECS.find((s) => s.name === 'lbr_value')!), name: 'my_value_index' };
    const hidden = { ...serverShape(SPECS.find((s) => s.name === 'bg_active_pool_owner')!), hidden: true };
    const existing = [...SPECS.filter((s) => s.name !== 'lbr_value' && s.name !== 'bg_active_pool_owner').map(serverShape), renamed, hidden];
    expect(auditIndexes(declared, existing)).toEqual({
      missing: ['lbr_value'],
      mismatched: [{ name: 'bg_active_pool_owner', differences: ['hidden=true'] }],
    });
  });

  it('declaredNamedIndexes ignores unnamed declarations and names outside the pattern', () => {
    const names = declaredNamedIndexes(PositionSchema).map((d) => d.name);
    expect(names.every((n) => /^(lbr|bg)_/.test(n))).toBe(true);
    expect(declaredNamedIndexes(PositionSchema, /^nothing_matches$/)).toEqual([]);
  });

  it('declaredIndexes: every declaration, the unnamed ones under the name MongoDB generates for them', () => {
    const all = declaredIndexes(PositionSchema);
    const unnamed = all.filter((d) => !d.named).map((d) => d.name);
    expect(unnamed).toEqual([
      'chainId_1_protocol_1_positionId_1',
      'chainId_1_protocol_1_poolId_1',
      'chainId_1_protocol_1_owner_1',
      'chainId_1_protocol_1_isActive_-1_tokenId_1',
      'chainId_1_protocol_1_token0.address_1',
      'chainId_1_protocol_1_token1.address_1',
    ]);
    expect(all.filter((d) => d.named).map((d) => d.name).sort()).toEqual(SPECS.map((s) => s.name).sort());
    // The collated owner index keeps its collation (the pre-flight compares it).
    expect(all.find((d) => d.name === 'chainId_1_protocol_1_owner_1')!.collation).toEqual({ locale: 'en', numericOrdering: true });
    expect(generatedIndexName({ chainId: 1, protocol: 1, 'metrics.apr': -1 })).toBe('chainId_1_protocol_1_metrics.apr_-1');
  });
});
