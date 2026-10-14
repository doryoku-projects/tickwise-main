import { describe, expect, it, vi } from 'vitest';
import {
  TokensRepository,
  priceEvidenceIsCurrent,
  savedPriceBackedOnlyBy,
  type TokenPriceRecord,
} from '../../src/database/token.repository.js';

/**
 * Fix 1 review fixes in `TokensRepository`:
 *  - a price write that carries provenance stamps `priceEvidenceAt` and drops
 *    the evidence fields it does not carry (one write's evidence, never a mix);
 *    a write carrying none is today's write, byte for byte;
 *  - the guard clears a saved price only when it came from the providers it
 *    rejected, pinned to the price that was judged.
 */

const A = '0x000000000000000000000000000000000000a001';
const B = '0x000000000000000000000000000000000000a002';
const C = '0x000000000000000000000000000000000000a003';

function fakeModel(rows: Array<Record<string, unknown>> = []) {
  const bulk: unknown[][] = [];
  const finds: unknown[] = [];
  const model = {
    find: (f: unknown) => {
      finds.push(f);
      const c: Record<string, unknown> = { select: () => c, lean: async () => rows };
      return c;
    },
    bulkWrite: vi.fn(async (ops: unknown[]) => {
      bulk.push(ops);
      return { modifiedCount: ops.length };
    }),
  };
  const repo = new TokensRepository({ tokenModel: () => model } as never, {} as never);
  return { repo, bulk, finds, model };
}

describe('upsertPrices — evidence is one write\'s', () => {
  it('a record with no provenance is today\'s write: $set only, no stamp, no $unset', async () => {
    const { repo, bulk } = fakeModel();
    const pricedAt = new Date('2026-10-05T12:00:00Z');
    await repo.upsertPrices(1, [{ address: A, priceUsd: 2, pricedAt, priceSources: ['defillama'], priceConfidence: 'external-unverified' }]);
    expect(bulk[0]).toEqual([
      {
        updateOne: {
          filter: { chainId: 1, address: A },
          update: { $set: { priceUsd: 2, pricedAt, priceConfidence: 'external-unverified', priceSources: ['defillama'] } },
          upsert: true,
        },
      },
    ]);
  });

  it('a hot-path provenance write stamps priceEvidenceAt = pricedAt and unsets the sweep evidence', async () => {
    const { repo, bulk } = fakeModel();
    const pricedAt = new Date('2026-10-05T12:00:00Z');
    await repo.upsertPrices(1, [{ address: A, priceUsd: 2, pricedAt, priceQuoteSource: 'defillama', priceQuotedAt: null }]);
    const update = (bulk[0]![0] as { updateOne: { update: Record<string, Record<string, unknown>> } }).updateOne.update;
    expect(update.$set!.priceEvidenceAt).toBe(pricedAt);
    expect(update.$unset).toEqual({ priceQuoteRejected: '', priceGuardUsd: '' });
  });

  it('a sweep write unsets the hot-path source; priceSourcesDisagreed is written but never unset', async () => {
    const { repo, bulk } = fakeModel();
    const rec: TokenPriceRecord = {
      address: A,
      priceUsd: 2,
      priceQuotedAt: null,
      priceQuoteRejected: ['dia:stale'],
      priceGuardUsd: 2,
      priceSourcesDisagreed: false,
    };
    await repo.upsertPrices(1, [rec, { address: B, priceUsd: 1, priceQuoteSource: 'dia', priceQuotedAt: null }]);
    const [a, b] = bulk[0] as Array<{ updateOne: { update: Record<string, Record<string, unknown>> } }>;
    expect(a!.updateOne.update.$unset).toEqual({ priceQuoteSource: '' });
    expect(a!.updateOne.update.$set!.priceSourcesDisagreed).toBe(false);
    expect(a!.updateOne.update.$set!.priceEvidenceAt).toBe(a!.updateOne.update.$set!.pricedAt);
    expect(Object.keys(b!.updateOne.update.$unset ?? {})).not.toContain('priceSourcesDisagreed');
  });
});

describe('priceEvidenceIsCurrent', () => {
  it('true only when the evidence was written with the current price', () => {
    const t = new Date('2026-10-05T12:00:00Z');
    expect(priceEvidenceIsCurrent({ pricedAt: t, priceEvidenceAt: t })).toBe(true);
    expect(priceEvidenceIsCurrent({ pricedAt: new Date(t.getTime() + 5 * 60_000), priceEvidenceAt: t })).toBe(false);
    expect(priceEvidenceIsCurrent({ pricedAt: t })).toBe(false);
    expect(priceEvidenceIsCurrent({ priceEvidenceAt: t })).toBe(false);
  });
});

describe('clearGuardedPrices — only a price the rejected providers supplied, pinned', () => {
  it('savedPriceBackedOnlyBy: the sweep cluster, else the hot-path source; no provenance → keep', () => {
    const dia = new Set(['dia']);
    expect(savedPriceBackedOnlyBy({ priceSources: ['dia'] }, dia)).toBe(true);
    expect(savedPriceBackedOnlyBy({ priceSources: ['dia', 'defillama'] }, dia)).toBe(false);
    expect(savedPriceBackedOnlyBy({ priceSources: [], priceQuoteSource: 'dia' }, dia)).toBe(true);
    expect(savedPriceBackedOnlyBy({ priceSources: [], priceQuoteSource: 'defillama' }, dia)).toBe(false);
    expect(savedPriceBackedOnlyBy({}, dia)).toBe(false);
  });

  it('clears the matching rows with a filter pinned to the judged price and pricedAt', async () => {
    const pricedAt = new Date('2026-10-01T00:00:00Z');
    const { repo, bulk } = fakeModel([
      { address: A, priceUsd: 31_374, pricedAt, priceSources: ['dia'] }, // DIA's price → cleared
      { address: B, priceUsd: 232.97, pricedAt, priceSources: ['defillama'] }, // another provider's → kept
      { address: C, priceUsd: 5, pricedAt }, // no provenance → kept
    ]);
    const at = new Date('2026-10-05T12:00:00Z');
    const n = await repo.clearGuardedPrices(
      1,
      [A, B, C].map((address) => ({ address, rejectedSources: ['dia'] })),
      'quote-guard',
      at,
    );
    expect(n).toBe(1);
    expect(bulk[0]).toEqual([
      {
        updateOne: {
          filter: { chainId: 1, address: A, priceUsd: 31_374, pricedAt },
          update: { $set: { priceUsd: 0, pricePurgedAt: at, pricePurgedReason: 'quote-guard' } },
        },
      },
    ]);
  });

  it('writes nothing when no row qualifies', async () => {
    const { repo, model } = fakeModel([{ address: B, priceUsd: 1, priceSources: ['defillama'] }]);
    expect(await repo.clearGuardedPrices(1, [{ address: B, rejectedSources: ['dia'] }], 'quote-guard')).toBe(0);
    expect(model.bulkWrite).not.toHaveBeenCalled();
  });
});

describe('findMarketState — the disagreement flag', () => {
  it('reads priceSourcesDisagreed (absent → undefined)', async () => {
    const { repo } = fakeModel([
      { address: A, priceSources: ['defillama'], priceSourcesDisagreed: true },
      { address: B, priceSources: ['defillama'], priceSourcesDisagreed: false },
      { address: C, priceSources: ['defillama'], priceConfidence: 'external-unverified' },
    ]);
    const m = await repo.findMarketState(1, [A, B, C]);
    expect(m.get(A)?.disagreed).toBe(true);
    expect(m.get(B)?.disagreed).toBe(false);
    expect(m.get(C)?.disagreed).toBeUndefined(); // single-source today: no disagreement on record
  });
});

describe('findMarketState — the stored consensus verdict (quote-guard corroboration)', () => {
  it('maps priceConfidence: external-verified → true, external-unverified → false, anything else / no sources → undefined', async () => {
    const D = '0x000000000000000000000000000000000000a004';
    const E = '0x000000000000000000000000000000000000a005';
    const { repo } = fakeModel([
      { address: A, priceSources: ['defillama', 'coingecko'], priceConfidence: 'external-verified' },
      { address: B, priceSources: ['defillama'], priceConfidence: 'external-unverified' },
      { address: C, priceSources: ['defillama'], priceConfidence: 'missing' },
      // A verdict with no recorded sources is not a sweep verdict (hot-path rows never write priceConfidence).
      { address: D, priceSources: [], priceConfidence: 'external-verified' },
      { address: E, priceSources: ['dia'] },
    ]);
    const m = await repo.findMarketState(1, [A, B, C, D, E]);
    expect(m.get(A)?.consensus).toBe(true);
    expect(m.get(B)?.consensus).toBe(false);
    expect(m.get(C)?.consensus).toBeUndefined();
    expect(m.get(D)?.consensus).toBeUndefined();
    expect(m.get(E)?.consensus).toBeUndefined();
  });
});
