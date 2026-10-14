/*
 * `TokensRepository.recordPriceMisses` — the STORE half of "once per miss
 * episode". The two ops it sends per address are replayed in order against
 * documents with the test's mini-mongo matcher (the same matching semantics
 * the leaderboard specs use), so the filter is checked as MongoDB reads it.
 */
import { describe, expect, it } from 'vitest';
import { TokensRepository } from '../../src/database/token.repository.js';
import { PRICE_MISS_LADDER_MS, priceMissNotHeldClauses } from '../../src/pricing/price-ledger.js';
import { matches, type Doc } from '../support/mini-mongo.js';

const MIN = 60_000;
const CHAIN = 4663;
const X = '0x00000000000000000000000000000000000000aa';

type Op = { updateOne: { filter: Doc; update: Record<string, Record<string, unknown>>; upsert?: boolean } };

function harness(initial: Doc[]) {
  const docs = initial.map((d) => ({ ...d }));
  const calls: Array<{ ops: Op[]; opts: unknown }> = [];
  const model = {
    bulkWrite: async (ops: Op[], opts: unknown) => {
      calls.push({ ops, opts });
      for (const { updateOne: u } of ops) {
        const doc = docs.find((d) => matches(d, u.filter, false));
        if (doc) {
          for (const [k, v] of Object.entries(u.update.$inc ?? {})) doc[k] = ((doc[k] as number | undefined) ?? 0) + (v as number);
          for (const [k, v] of Object.entries(u.update.$set ?? {})) doc[k] = v;
        } else if (u.upsert) {
          const eq = Object.fromEntries(Object.entries(u.filter).filter(([k]) => !k.startsWith('$')));
          docs.push({ ...eq, ...(u.update.$setOnInsert ?? {}), ...(u.update.$set ?? {}) });
        }
      }
    },
  };
  const repo = new TokensRepository({ tokenModel: () => model } as never);
  return { repo, docs, calls };
}

describe('priceMissNotHeldClauses', () => {
  const at = 100 * 60 * MIN;
  const m = (doc: Doc) => matches(doc, { $or: priceMissNotHeldClauses(at) }, false);
  it('matches no entry, and an entry whose ladder step has elapsed', () => {
    expect(m({})).toBe(true);
    expect(m({ priceMissStreak: 0 })).toBe(true);
    expect(m({ priceMissStreak: 2 })).toBe(true); // streak without a time: treat as elapsed
    expect(m({ priceMissStreak: 1, priceMissAt: new Date(at - 30 * MIN) })).toBe(true);
    expect(m({ priceMissStreak: 3, priceMissAt: new Date(at - 2 * 60 * MIN) })).toBe(true);
    expect(m({ priceMissStreak: 9, priceMissAt: new Date(at - 6 * 60 * MIN) })).toBe(true);
  });
  it('does not match an entry inside its hold (every ladder step, cap included)', () => {
    PRICE_MISS_LADDER_MS.forEach((hold, i) => {
      expect(m({ priceMissStreak: i + 1, priceMissAt: new Date(at - hold + 1) })).toBe(false);
    });
    expect(m({ priceMissStreak: 12, priceMissAt: new Date(at - 6 * 60 * MIN + 1) })).toBe(false);
  });
});

describe('TokensRepository.recordPriceMisses', () => {
  it('a token with no row: inserted at streak 1 (once, however many askers)', async () => {
    const h = harness([]);
    const at = new Date(10 * MIN);
    await h.repo.recordPriceMisses(CHAIN, [X], at);
    await h.repo.recordPriceMisses(CHAIN, [X], new Date(at.getTime() + 2_000));
    expect(h.docs).toEqual([{ chainId: CHAIN, address: X, priceMissStreak: 1, priceMissAt: at }]);
    expect(h.calls[0]!.opts).toEqual({ ordered: true });
  });

  it('an existing priced row without an entry gets streak 1; a held one is left alone', async () => {
    const at = new Date(50 * MIN);
    const h = harness([{ chainId: CHAIN, address: X, priceUsd: 0 }]);
    await h.repo.recordPriceMisses(CHAIN, [X], at);
    expect(h.docs[0]).toMatchObject({ priceMissStreak: 1, priceMissAt: at });
    await h.repo.recordPriceMisses(CHAIN, [X], new Date(at.getTime() + 10 * MIN));
    expect(h.docs[0]).toMatchObject({ priceMissStreak: 1, priceMissAt: at });
  });

  it('a new miss after the step elapsed climbs one rung', async () => {
    const first = new Date(0);
    const h = harness([{ chainId: CHAIN, address: X, priceMissStreak: 1, priceMissAt: first }]);
    const next = new Date(31 * MIN);
    await h.repo.recordPriceMisses(CHAIN, [X, X.toUpperCase().replace('0X', '0x')], next);
    expect(h.docs).toHaveLength(1);
    expect(h.docs[0]).toMatchObject({ priceMissStreak: 2, priceMissAt: next });
  });
});
