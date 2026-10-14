import { describe, expect, it, vi } from 'vitest';
import { TokensRepository, isSpamSignals } from '../src/database/token.repository.js';

// Fake per-chain model recording the collection it resolved + the ops it got.
function makeRepo() {
  const calls: { resolvedChains: number[]; bulkOps: unknown[]; finds: Record<string, unknown>[] } = {
    resolvedChains: [],
    bulkOps: [],
    finds: [],
  };
  const model = {
    bulkWrite: vi.fn(async (ops: unknown[]) => {
      calls.bulkOps.push(...ops);
    }),
    find: vi.fn((filter: Record<string, unknown>) => {
      calls.finds.push(filter);
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.read = () => chain;
      chain.maxTimeMS = () => chain;
      chain.lean = async () => [{ address: '0xBAD' }];
      return chain;
    }),
  };
  const resolver = {
    tokenModel: (chainId: number) => {
      calls.resolvedChains.push(chainId);
      return model;
    },
  };
  return { repo: new TokensRepository(resolver as never), calls, model };
}

describe('isSpamSignals (hard-flag rule)', () => {
  it('flags any of the five hard signals (GoPlus fake_token included)', () => {
    expect(isSpamSignals({ isHoneypot: true })).toBe(true);
    expect(isSpamSignals({ cannotSellAll: true })).toBe(true);
    expect(isSpamSignals({ personalSlippageModifiable: true })).toBe(true);
    expect(isSpamSignals({ isBlacklisted: true })).toBe(true);
    expect(isSpamSignals({ fakeToken: true })).toBe(true);
    expect(isSpamSignals({ fakeToken: false })).toBe(false);
  });
  it('does NOT flag soft signals (tax/proxy/closed-source/low-holders) by default', () => {
    expect(isSpamSignals({ sellTax: 0.9, isProxy: true, isOpenSource: false, holderCount: 1, honeypotWithSameCreator: true })).toBe(false);
  });
});

describe('TokensRepository', () => {
  it('resolves the per-chain sharded model (chain 1 → its own model)', async () => {
    const { repo, calls } = makeRepo();
    await repo.findMany(1, ['0xabc']);
    expect(calls.resolvedChains).toContain(1);
  });

  it('upsertSecurity writes raw signals (no verified field)', async () => {
    const { repo, calls } = makeRepo();
    await repo.upsertSecurity([{ chainId: 1, address: '0xAbC', isHoneypot: true, buyTax: 0.05 }]);
    const op = calls.bulkOps[0] as { updateOne: { update: { $set: Record<string, unknown> }; filter: Record<string, unknown> } };
    expect(op.updateOne.filter).toMatchObject({ chainId: 1, address: '0xabc' });
    expect(op.updateOne.update.$set).toMatchObject({ isHoneypot: true, buyTax: 0.05 });
    expect('verified' in op.updateOne.update.$set).toBe(false);
    expect(op.updateOne.update.$set.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('findSpamAddresses queries the hard-flag $or plus the two identity pre-filters, and lowercases', async () => {
    const { repo, calls, model } = makeRepo();
    model.find.mockImplementationOnce((filter: Record<string, unknown>) => {
      calls.finds.push(filter);
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.read = () => chain;
      chain.maxTimeMS = () => chain;
      chain.lean = async () => [{ address: '0xBAD', isHoneypot: true }, { address: '0xC1EAN' }];
      return chain;
    });
    const bad = await repo.findSpamAddresses(1);
    expect(calls.finds[0]).toHaveProperty('$or');
    // five hard flags (fakeToken included) + `symbol` / `tokenSymbol` $regex
    expect((calls.finds[0].$or as unknown[]).length).toBe(7);
    expect(bad).toEqual(['0xbad']);
  });

  it('leads every by-address lookup with chainId so the {chainId, address} index is usable', async () => {
    // Without the leading chainId the planner cannot use the only index and
    // scans the whole collection — once per unpriced position leg.
    const { repo, calls } = makeRepo();
    await repo.findMany(43114, ['0xAbC']);
    await repo.findLatestPrices(43114, ['0xAbC']);
    await repo.findDexMarketState(43114, ['0xAbC']);
    expect(calls.finds).toHaveLength(3);
    for (const filter of calls.finds) {
      expect(filter).toMatchObject({ chainId: 43114, address: { $in: ['0xabc'] } });
    }
  });

  it('findLatestPricesForRead: the same chainId-led positive-price $in, but secondaryPreferred with a maxTimeMS', async () => {
    const seen: Record<string, unknown> = {};
    const model = {
      find: (filter: Record<string, unknown>) => {
        seen.filter = filter;
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.read = (pref: unknown) => ((seen.read = pref), chain);
        chain.maxTimeMS = (ms: unknown) => ((seen.maxTimeMS = ms), chain);
        chain.lean = async () => [{ address: '0xAbC', priceUsd: 2.5 }];
        return chain;
      },
    };
    const repo = new TokensRepository({ tokenModel: () => model } as never);
    const out = await repo.findLatestPricesForRead(43114, ['0xAbC'], 1_000);
    expect(out).toEqual(new Map([['0xabc', { priceUsd: 2.5, pricedAt: undefined }]]));
    expect(seen.filter).toEqual({ chainId: 43114, address: { $in: ['0xabc'] }, priceUsd: { $gt: 0 } });
    expect((seen.read as { mode?: string })?.mode).toBe('secondaryPreferred');
    expect(seen.maxTimeMS).toBe(1_000);
  });

  it('upsertPrices writes priceUsd + pricedAt (upsert)', async () => {
    const { repo, calls } = makeRepo();
    await repo.upsertPrices(1, [{ address: '0xAbC', priceUsd: 1.23, symbol: 'FOO' }]);
    const op = calls.bulkOps[0] as { updateOne: { update: { $set: Record<string, unknown> }; upsert: boolean } };
    expect(op.updateOne.update.$set).toMatchObject({ priceUsd: 1.23, symbol: 'FOO' });
    expect(op.updateOne.update.$set.pricedAt).toBeInstanceOf(Date);
    expect(op.updateOne.upsert).toBe(true);
  });
});
