import { describe, expect, it } from 'vitest';
import { PositionsRepository, type LeaderboardQuery } from '../src/database/positions.repository.js';

// Capture the Mongo filter that findLeaderboard builds, without a real DB.
function makeRepo(confirmedBad: string[] = []) {
  let captured: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'sort', 'collation', 'hint', 'skip', 'limit', 'read', 'maxTimeMS']) {
    chain[method] = () => chain;
  }
  chain.lean = async () => [];
  const model = {
    find: (filter: Record<string, unknown>) => {
      captured = filter;
      return chain;
    },
  };
  const resolver = { positionModel: () => model };
  // The merged spam + no-market set, as TokensRepository serves it.
  const tokens = { readyLeaderboardExclusions: async () => ({ addresses: confirmedBad, ok: true }) };
  const repo = new PositionsRepository(resolver as never, tokens as never);
  return { repo, getFilter: () => captured };
}

function query(over: Partial<LeaderboardQuery> = {}): LeaderboardQuery {
  return {
    chainId: 1,
    protocol: 'uniswap-v4',
    sort: 'apr',
    page: 1,
    limit: 25,
    activeOnly: true,
    status: 'active',
    range: 'all',
    minValueUsd: 0,
    minPoolTvl: 0,
    includeRisky: false,
    ...over,
  };
}

describe('findLeaderboard filter — status handling', () => {
  it('active (default) applies the open-only ghost guards', async () => {
    const { repo, getFilter } = makeRepo();
    await repo.findLeaderboard(query({ status: 'active', minValueUsd: 500, minPoolTvl: 1000 }));
    const f = getFilter();
    expect(f.isActive).toBe(true);
    expect(f['metrics.underlyingValueUsd']).toEqual({ $gte: 500, $gt: 0 });
    expect(f['pricing.source']).toEqual({ $ne: 'none' });
    expect(f['metrics.performanceReady']).toBe(true); // apr is a performance sort
    expect(f.$and).toBeUndefined();
  });

  it('closed-only exempts closed positions from every open-only guard', async () => {
    const { repo, getFilter } = makeRepo();
    await repo.findLeaderboard(query({ status: 'inactive', activeOnly: false }));
    const f = getFilter();
    expect(f.isActive).toBe(false);
    // none of the open-only guards may be present, or closed rows (0 value) vanish
    expect(f['metrics.underlyingValueUsd']).toBeUndefined();
    expect(f['pricing.source']).toBeUndefined();
    expect(f['metrics.performanceReady']).toBeUndefined();
    expect(f['metrics.aprExGas']).toBeUndefined();
  });

  it('all view applies open guards only to open rows (closed pass via $or)', async () => {
    const { repo, getFilter } = makeRepo();
    await repo.findLeaderboard(query({ status: 'all', activeOnly: false }));
    const f = getFilter();
    expect(f.isActive).toBeUndefined(); // both states returned
    expect(Array.isArray(f.$and)).toBe(true);
    const orClause = (f.$and as Array<{ $or?: unknown[] }>)[0]?.$or as Array<Record<string, unknown>>;
    expect(orClause[0]).toEqual({ isActive: false }); // closed bypass
    expect(orClause[1]).toMatchObject({ 'metrics.underlyingValueUsd': { $gt: 0 } }); // open guarded
  });

  it('includeRisky drops all guards regardless of status', async () => {
    const { repo, getFilter } = makeRepo();
    await repo.findLeaderboard(query({ status: 'all', activeOnly: false, includeRisky: true }));
    const f = getFilter();
    expect(f['metrics.underlyingValueUsd']).toBeUndefined();
    expect(f['pricing.source']).toBeUndefined();
    expect(f.$and).toBeUndefined();
  });

  it('positionId search still applies (as an $and $or clause)', async () => {
    const { repo, getFilter } = makeRepo();
    await repo.findLeaderboard(query({ status: 'inactive', activeOnly: false, positionId: '123' }));
    const f = getFilter();
    const orClause = (f.$and as Array<{ $or?: unknown[] }>)[0]?.$or;
    expect(orClause).toEqual([{ positionId: '123' }, { tokenId: '123' }]);
  });

  describe('owner filter', () => {
    const OWNER = '0x1111111111111111111111111111111111111111';

    it('filters to the lowercased owner address', async () => {
      const { repo, getFilter } = makeRepo();
      await repo.findLeaderboard(query({ owner: OWNER.toUpperCase() }));
      expect(getFilter().owner).toBe(OWNER);
    });

    it('composes with the other filters (owner + positionId ownership check)', async () => {
      const { repo, getFilter } = makeRepo();
      await repo.findLeaderboard(query({ status: 'all', activeOnly: false, owner: OWNER, positionId: '123' }));
      const f = getFilter();
      expect(f.owner).toBe(OWNER);
      const orClause = (f.$and as Array<{ $or?: unknown[] }>).find((c) => c.$or)?.$or;
      expect(orClause).toEqual([{ positionId: '123' }, { tokenId: '123' }]);
    });

    it('adds no owner clause when omitted', async () => {
      const { repo, getFilter } = makeRepo();
      await repo.findLeaderboard(query());
      expect(getFilter().owner).toBeUndefined();
    });
  });

  describe('GoPlus-confirmed-bad address filter', () => {
    const BAD = '0xbadc0ffee0000000000000000000000000000bad';

    it('excludes positions whose either leg is a confirmed-bad token', async () => {
      const { repo, getFilter } = makeRepo([BAD]);
      await repo.findLeaderboard(query({ status: 'all', activeOnly: false }));
      const and = getFilter().$and as Array<Record<string, unknown>>;
      const scam = and.find((c) => 'token0.address' in c);
      expect(scam).toEqual({ 'token0.address': { $nin: [BAD] }, 'token1.address': { $nin: [BAD] } });
    });

    it('applies even in the risky view (scam filter is not risky-gated)', async () => {
      const { repo, getFilter } = makeRepo([BAD]);
      await repo.findLeaderboard(query({ status: 'all', activeOnly: false, includeRisky: true }));
      const and = (getFilter().$and as Array<Record<string, unknown>>) ?? [];
      expect(and.some((c) => 'token0.address' in c)).toBe(true);
    });

    it('adds no clause when nothing is confirmed bad (unchecked tokens still show)', async () => {
      const { repo, getFilter } = makeRepo([]);
      await repo.findLeaderboard(query({ status: 'all', activeOnly: false }));
      const and = (getFilter().$and as Array<Record<string, unknown>>) ?? [];
      expect(and.some((c) => 'token0.address' in c)).toBe(false);
    });

    it('is bypassed for a direct id lookup', async () => {
      const { repo, getFilter } = makeRepo([BAD]);
      await repo.findLeaderboard(query({ status: 'all', activeOnly: false, positionId: '133302' }));
      const and = (getFilter().$and as Array<Record<string, unknown>>) ?? [];
      expect(and.some((c) => 'token0.address' in c)).toBe(false);
    });
  });
});
