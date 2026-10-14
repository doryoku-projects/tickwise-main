import { describe, expect, it, vi } from 'vitest';
import {
  isDenied,
  resolveTokenTrust,
  trustEvidenceOn,
  trustPolicyOf,
  usesStoredVerdicts,
  type StoredTokenTrust,
  type TokenTrustMode,
  type TrustPolicy,
} from '../../src/pricing/token-trust.js';
import { TokenTrustService } from '../../src/pricing/token-trust.service.js';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { TokensRepository } from '../../src/database/token.repository.js';
import { PositionsRepository } from '../../src/database/positions.repository.js';
import type { NormalizedPosition } from '../../src/subgraph/normalized-position.js';

/**
 * `TOKEN_TRUST_MODE=combined`: anchor OR allowlisted OR a fresh earned verdict.
 * The point of the mode is that it can only ADD trust to either of the other
 * two — a listed token a DEX market cannot vouch for (4663 stocks) keeps its
 * allowlist trust, a real unlisted token (BTC.b) gains earned trust — with
 * ONE deliberate exception: the hand-set `trustDenied` flag, which allowlist
 * mode ignores by design. `allowlist` (default) stays byte-identical.
 */

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // config anchor (chain 1)
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'; // allowlisted, not an anchor
const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072'; // neither (BTC.b on Ethereum)
const SPAM = '0x000000000000000000000000000000000000a5a5'; // neither
const NOW = Date.UTC(2026, 9, 5, 12);
const FRESH = new Date(NOW - 10 * 60_000);
const STALE = new Date(NOW - 86_400_000 - 1);

const MODES: TokenTrustMode[] = ['allowlist', 'earned', 'combined'];
const policyFor = (mode: TokenTrustMode, deny = ''): TrustPolicy => trustPolicyOf({ tokenTrustMode: mode, tokenTrustDeny: deny });

describe('combined mode — config', () => {
  it('parses `combined` in any case; anything unknown stays today\'s allowlist', () => {
    expect(trustPolicyOf({ tokenTrustMode: 'combined' }).mode).toBe('combined');
    expect(trustPolicyOf({ tokenTrustMode: ' COMBINED ' }).mode).toBe('combined');
    expect(trustPolicyOf({ tokenTrustMode: 'union' }).mode).toBe('allowlist');
    expect(trustPolicyOf({}).mode).toBe('allowlist');
  });
  it('usesStoredVerdicts: earned and combined read the stored verdicts, allowlist does not', () => {
    expect(usesStoredVerdicts(policyFor('allowlist'))).toBe(false);
    expect(usesStoredVerdicts(policyFor('earned'))).toBe(true);
    expect(usesStoredVerdicts(policyFor('combined'))).toBe(true);
  });
  it('the sweep computes verdicts in combined mode (else no token could ever earn there); allowlist without shadow stays off', () => {
    expect(trustEvidenceOn(policyFor('combined'))).toBe(true);
    expect(trustEvidenceOn(policyFor('allowlist'))).toBe(false);
  });
  it('the trustDenied flag is honoured in earned + combined, ignored in allowlist; the env list in every mode', () => {
    for (const mode of MODES) {
      expect(isDenied(policyFor(mode), 1, CBBTC, { trustDenied: true })).toBe(mode !== 'allowlist');
      expect(isDenied(policyFor(mode, CBBTC), 1, CBBTC, undefined)).toBe(true);
    }
  });
});

// ─── The property matrix ──────────────────────────────────────────────────────

type Evidence = 'none' | 'earned-fresh' | 'earned-stale' | 'earned-failed' | 'flag-denied' | 'flag-denied+earned';
const EVIDENCE: Record<Evidence, StoredTokenTrust | undefined> = {
  none: undefined,
  'earned-fresh': { trustEarned: true, trustReason: 'earned', trustEvaluatedAt: FRESH },
  'earned-stale': { trustEarned: true, trustReason: 'earned', trustEvaluatedAt: STALE },
  'earned-failed': { trustEarned: false, trustReason: 'single-pool', trustEvaluatedAt: FRESH },
  'flag-denied': { trustDenied: true },
  'flag-denied+earned': { trustEarned: true, trustReason: 'earned', trustEvaluatedAt: FRESH, trustDenied: true },
};
const TOKENS: Record<string, string> = { anchor: USDC, allowlisted: CBBTC, unlisted: BTCB };

interface Cell {
  token: string;
  address: string;
  evidence: Evidence;
  envDenied: boolean;
}
const CELLS: Cell[] = Object.entries(TOKENS).flatMap(([token, address]) =>
  (Object.keys(EVIDENCE) as Evidence[]).flatMap((evidence) =>
    [false, true].map((envDenied) => ({ token, address, evidence, envDenied })),
  ),
);
const verdictsOf = (c: Cell) =>
  Object.fromEntries(
    MODES.map((m) => [m, resolveTokenTrust(1, c.address, EVIDENCE[c.evidence], policyFor(m, c.envDenied ? c.address : ''), NOW)]),
  ) as Record<TokenTrustMode, ReturnType<typeof resolveTokenTrust>>;
const label = (c: Cell) => `${c.token}/${c.evidence}${c.envDenied ? '/env-denied' : ''}`;

describe('resolveTokenTrust — combined ⊇ allowlist and ⊇ earned (the point of the mode)', () => {
  it.each(CELLS.map((c) => [label(c), c] as const))('%s', (_name, c) => {
    const v = verdictsOf(c);
    const flagDenied = c.evidence.startsWith('flag-denied');
    // ⊇ allowlist — except the stored flag, which allowlist mode ignores by design.
    if (v.allowlist.trusted && !flagDenied) expect(v.combined.trusted).toBe(true);
    // ⊇ earned — always.
    if (v.earned.trusted) expect(v.combined.trusted).toBe(true);
    // ...and no trust out of thin air: combined is the union, nothing more.
    if (v.combined.trusted) expect(v.allowlist.trusted || v.earned.trusted).toBe(true);
    // The definition, spelled out.
    const anchor = c.token === 'anchor';
    const allowlisted = c.token !== 'unlisted';
    const earnedFresh = c.evidence === 'earned-fresh' || c.evidence === 'flag-denied+earned';
    expect(v.combined.trusted).toBe(anchor || (!c.envDenied && !flagDenied && (allowlisted || earnedFresh)));
    expect(v.combined.mode).toBe('combined');
    // Allowlist mode is today's rule exactly, whatever the stored evidence says.
    expect(v.allowlist.trusted).toBe(anchor || (allowlisted && !c.envDenied));
    expect(v.allowlist.reason).toBe(anchor ? 'anchor' : c.envDenied ? 'denied' : allowlisted ? 'allowlist' : 'not-allowlisted');
  });

  it('a seeded fuzz over random stored states keeps the same three relations', () => {
    let seed = 0x5eed;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const reasons = ['earned', 'single-pool', 'stale-quote', 'single-source', 'no-dex-market', 'garbage', undefined];
    for (let i = 0; i < 2_000; i++) {
      const address = pick([USDC, CBBTC, BTCB, SPAM]);
      const stored: StoredTokenTrust | undefined =
        rnd() < 0.15
          ? undefined
          : {
              trustEarned: pick([true, false, undefined]),
              trustReason: pick(reasons),
              // Around the 24 h boundary, plus a missing / invalid date.
              trustEvaluatedAt: pick([new Date(NOW - Math.floor(rnd() * 2 * 86_400_000)), undefined, new Date(Number.NaN)]),
              trustDenied: pick([true, false, undefined]),
            };
      const deny = rnd() < 0.2 ? address : '';
      const [a, e, c] = MODES.map((m) => resolveTokenTrust(1, address, stored, policyFor(m, deny), NOW));
      if (a!.trusted && stored?.trustDenied !== true) expect(c!.trusted).toBe(true);
      if (e!.trusted) expect(c!.trusted).toBe(true);
      if (c!.trusted) expect(a!.trusted || e!.trusted).toBe(true);
    }
  });
});

describe('resolveTokenTrust — combined reasons', () => {
  const policy = policyFor('combined');
  const r = (address: string, stored?: StoredTokenTrust) => resolveTokenTrust(1, address, stored, policy, NOW);
  it('anchor first (even when flagged), then a denial, then earned ahead of the allowlist', () => {
    expect(r(USDC, { trustDenied: true })).toMatchObject({ trusted: true, reason: 'anchor' });
    expect(r(CBBTC, { trustDenied: true })).toMatchObject({ trusted: false, reason: 'denied' });
    // A listed token that has ALSO earned trust reports the stronger fact.
    expect(r(CBBTC, EVIDENCE['earned-fresh'])).toMatchObject({ trusted: true, reason: 'earned' });
  });
  it('a listed token keeps the allowlist whatever its earned verdict says (4663 stocks: single-source by construction)', () => {
    expect(r(CBBTC)).toMatchObject({ trusted: true, reason: 'allowlist' });
    expect(r(CBBTC, EVIDENCE['earned-failed'])).toMatchObject({ trusted: true, reason: 'allowlist' });
    expect(r(CBBTC, EVIDENCE['earned-stale'])).toMatchObject({ trusted: true, reason: 'allowlist' });
  });
  it('an unlisted token is judged exactly as earned mode judges it', () => {
    const earned = policyFor('earned');
    for (const stored of Object.values(EVIDENCE)) {
      const c = r(BTCB, stored);
      const e = resolveTokenTrust(1, BTCB, stored, earned, NOW);
      expect({ trusted: c.trusted, reason: c.reason }).toEqual({ trusted: e.trusted, reason: e.reason });
    }
    expect(r(BTCB).reason).toBe('no-evidence');
    expect(r(BTCB, EVIDENCE['earned-stale']).reason).toBe('stale-verdict');
    expect(r(BTCB, EVIDENCE['earned-failed']).reason).toBe('single-pool');
  });
});

// ─── TokenTrustService ────────────────────────────────────────────────────────

describe('TokenTrustService — combined mode', () => {
  const rows = () =>
    new Map<string, StoredTokenTrust>([
      [BTCB, { trustEarned: true, trustEvaluatedAt: new Date() }],
      [SPAM, { trustEarned: false, trustReason: 'single-source', trustEvaluatedAt: new Date() }],
    ]);

  it('warm reads the stored verdicts (once, then cached); unwarmed, the allowlist alone answers', async () => {
    const findTrustState = vi.fn(async () => rows());
    const svc = new TokenTrustService({ tokenTrustMode: 'combined' } as never, { findTrustState } as never);
    // Nothing warmed yet: a listed token is trusted, an unlisted one has no evidence.
    expect(svc.trust(1, CBBTC)).toMatchObject({ trusted: true, reason: 'allowlist' });
    expect(svc.trust(1, BTCB)).toMatchObject({ trusted: false, reason: 'no-evidence' });
    await svc.warm(1, [BTCB, CBBTC, SPAM]);
    expect(findTrustState).toHaveBeenCalledTimes(1);
    expect(svc.trust(1, BTCB)).toMatchObject({ trusted: true, reason: 'earned' });
    expect(svc.trust(1, CBBTC)).toMatchObject({ trusted: true, reason: 'allowlist' }); // listed, no verdict: still trusted
    expect(svc.trust(1, SPAM)).toMatchObject({ trusted: false, reason: 'single-source' });
    await svc.warm(1, [BTCB, CBBTC]);
    expect(findTrustState).toHaveBeenCalledTimes(1);
  });

  it('a warmed trustDenied flag removes a listed token\'s trust', async () => {
    const findTrustState = vi.fn(async () => new Map([[CBBTC, { trustDenied: true }]]));
    const svc = new TokenTrustService({ tokenTrustMode: 'combined' } as never, { findTrustState } as never);
    await svc.warm(1, [CBBTC]);
    expect(svc.trust(1, CBBTC)).toMatchObject({ trusted: false, reason: 'denied' });
  });

  it('a failed read leaves the allowlist answer (listed stays trusted, unlisted stays untrusted)', async () => {
    const svc = new TokenTrustService(
      { tokenTrustMode: 'combined' } as never,
      { findTrustState: async () => { throw new Error('down'); } } as never,
    );
    await svc.warm(1, [BTCB, CBBTC]);
    expect(svc.isTrusted(1, CBBTC)).toBe(true);
    expect(svc.isTrusted(1, BTCB)).toBe(false);
  });

  it('allowlist mode (unset, explicit, or an unknown value) still reads NOTHING and ignores primed verdicts', async () => {
    for (const config of [{}, { tokenTrustMode: 'allowlist' }, { tokenTrustMode: 'bogus' }]) {
      const findTrustState = vi.fn(async () => rows());
      const svc = new TokenTrustService(config as never, { findTrustState } as never);
      await svc.warm(1, [BTCB, CBBTC]);
      expect(findTrustState).not.toHaveBeenCalled();
      // The quote guard can prime the cache in allowlist mode; the answer must not move.
      svc.primeMany(1, [BTCB, CBBTC], new Map([[BTCB, { trustEarned: true, trustEvaluatedAt: new Date() }], [CBBTC, { trustDenied: true }]]));
      expect(svc.trust(1, BTCB)).toMatchObject({ trusted: false, reason: 'not-allowlisted' });
      expect(svc.trust(1, CBBTC)).toMatchObject({ trusted: true, reason: 'allowlist' });
    }
  });
});

// ─── Position path (PricingService) ───────────────────────────────────────────

function provider(quotes: Record<string, { priceUsd: number }>) {
  return {
    name: 'mock',
    supportsCurrentBatch: true,
    supportsHistoricalBatch: false,
    maxBatchSize: 50,
    singleConcurrency: 1,
    defaultBackoffMs: 0,
    isEnabled: () => true,
    isAvailable: () => true,
    getCurrentSingle: vi.fn(async (_c: number, a: string) => quotes[a.toLowerCase()] ?? null),
    getCurrentBatch: vi.fn(async (chainId: number, addrs: string[]) => {
      const out = new Map<string, { priceUsd: number }>();
      for (const a of addrs) if (quotes[a.toLowerCase()]) out.set(`${chainId}:${a.toLowerCase()}`, quotes[a.toLowerCase()]!);
      return out;
    }),
    getHistoricalSingle: vi.fn(async () => null),
    getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
  };
}

function pricing(
  config: Record<string, unknown>,
  stored: Record<string, StoredTokenTrust>,
  listing: { isListed: (c: number, a: string) => boolean } | undefined = { isListed: (_c, a) => a === CBBTC },
) {
  const p = provider({ [USDC]: { priceUsd: 1 }, [BTCB]: { priceUsd: 85_000 }, [CBBTC]: { priceUsd: 85_000 } });
  const findMarketState = vi.fn(async (_c: number, addrs: string[]) =>
    new Map(addrs.filter((a) => a in stored).map((a) => [a, { trust: stored[a]! }])),
  );
  const svc = new PricingService(
    { priceFallbackEnabled: true, tokenListingGateEnabled: true, dexMarketGateEnabled: true, dexMarketFailClosed: true, pricingPrefetchChunkConcurrency: 2, ...config } as never,
    {} as never,
    { currentProviders: () => [p], historicalProviders: () => [p] } as never,
    listing as never,
    { findLatestPrices: async () => new Map(), upsertPrices: async () => {}, findDexMarketState: async () => new Map(), findMarketState } as never,
  );
  return { svc, findMarketState };
}
const pool = { chainId: 1, token0: { address: BTCB, decimals: 8, verified: false }, token1: { address: CBBTC, decimals: 8, verified: false } };
const earnedNow = (): StoredTokenTrust => ({ trustEarned: true, trustReason: 'earned', trustEvaluatedAt: new Date() });
type Private = { listedFor(c: number, a: string): boolean; legCorroborated(c: number, a: string): boolean | undefined };

describe('position path (pricePool) — combined mode', () => {
  it('an earned BTC.b AND a listed-but-unearned cbBTC are both trusted (earned mode drops cbBTC, allowlist mode drops BTC.b)', async () => {
    const results: Record<string, [number, number]> = {};
    for (const mode of MODES) {
      const { svc } = pricing({ tokenTrustMode: mode }, { [BTCB]: earnedNow() });
      await svc.prefetchPrices(1, [BTCB, CBBTC]);
      const r = await svc.pricePool(pool);
      results[mode] = [r.token0Usd, r.token1Usd];
    }
    expect(results).toEqual({ allowlist: [0, 85_000], earned: [85_000, 0], combined: [85_000, 85_000] });
  });

  it('combined loads the trust evidence in the market-state read (allowlist mode keeps today\'s read)', async () => {
    const combined = pricing({ tokenTrustMode: 'combined' }, {});
    await combined.svc.prefetchPrices(1, [BTCB, CBBTC]);
    expect(combined.findMarketState).toHaveBeenCalledTimes(1);
    const allowlist = pricing({}, {});
    await allowlist.svc.prefetchPrices(1, [BTCB, CBBTC]);
    expect(allowlist.findMarketState).not.toHaveBeenCalled();
  });

  it('a stored trustDenied flag removes a listed leg in combined mode (allowlist mode ignores it)', async () => {
    const combined = pricing({ tokenTrustMode: 'combined' }, { [CBBTC]: { trustDenied: true } });
    await combined.svc.prefetchPrices(1, [BTCB, CBBTC]);
    expect((await combined.svc.pricePool(pool)).token1Usd).toBe(0);
    // Allowlist mode + the quote guard reads the same rows and still trusts it.
    const allowlist = pricing({ priceQuoteGuard: 'on' }, { [CBBTC]: { trustDenied: true } });
    await allowlist.svc.prefetchPrices(1, [BTCB, CBBTC]);
    expect((await allowlist.svc.pricePool(pool)).token1Usd).toBe(85_000);
  });

  it('listedFor: combined never drops what allowlist mode lists — whatever the listing service answers, absent included', async () => {
    const odd = { isListed: (_c: number, a: string) => a === SPAM }; // a service that disagrees with the committed list
    for (const listing of [odd, undefined]) {
      for (const addr of [SPAM, CBBTC, BTCB]) {
        const a = pricing({}, {}, listing).svc as unknown as Private;
        const c = pricing({ tokenTrustMode: 'combined' }, {}, listing).svc as unknown as Private;
        if (a.listedFor(1, addr)) expect(c.listedFor(1, addr)).toBe(true);
      }
    }
    // ...and the env deny list still removes it in both.
    const deny = { tokenTrustDeny: SPAM };
    expect((pricing(deny, {}, odd).svc as unknown as Private).listedFor(1, SPAM)).toBe(false);
    expect((pricing({ ...deny, tokenTrustMode: 'combined' }, {}, odd).svc as unknown as Private).listedFor(1, SPAM)).toBe(false);
  });

  it('legCorroborated: a fresh earned verdict counts in combined mode — for a listed token too', async () => {
    const out: Record<string, boolean | undefined> = {};
    for (const [name, config] of [
      ['allowlist+guard', { priceQuoteGuard: 'on' }],
      ['earned', { tokenTrustMode: 'earned' }],
      ['combined', { tokenTrustMode: 'combined' }],
    ] as const) {
      const { svc } = pricing(config, { [CBBTC]: earnedNow(), [BTCB]: earnedNow() });
      await svc.prefetchPrices(1, [BTCB, CBBTC]);
      const p = svc as unknown as Private;
      out[`${name}:cbBTC`] = p.legCorroborated(1, CBBTC);
      out[`${name}:BTC.b`] = p.legCorroborated(1, BTCB);
    }
    expect(out).toEqual({
      'allowlist+guard:cbBTC': undefined, // no consensus evidence; allowlist mode reads no verdict
      'allowlist+guard:BTC.b': undefined,
      'earned:cbBTC': true,
      'earned:BTC.b': true,
      'combined:cbBTC': true,
      'combined:BTC.b': true,
    });
  });
});

// ─── Leaderboard exclusion scan ───────────────────────────────────────────────

describe('no-real-market exclusion — combined mode', () => {
  function scan(rows: Array<Record<string, unknown>>, config: Record<string, unknown>) {
    const model = {
      find: () => {
        const c: Record<string, unknown> = { select: () => c, read: () => c, maxTimeMS: () => c, lean: async () => rows };
        return c;
      },
    };
    return new TokensRepository({ tokenModel: () => model } as never, config as never).findNoRealMarketAddresses(1);
  }
  const noMarket = (address: string, extra: Record<string, unknown> = {}) => ({ address, priceSources: ['defillama'], dexActive: false, ...extra });
  const rows = [
    noMarket(USDC),
    noMarket(CBBTC), // allowlisted, no verdict
    noMarket(BTCB, { trustEarned: true, trustEvaluatedAt: new Date() }), // earned, unlisted
    noMarket(SPAM, { trustEarned: false, trustReason: 'single-source', trustEvaluatedAt: new Date() }),
  ];

  it('keeps allowlisted AND earned tokens, excludes the rest; = allowlist ∩ earned for unflagged rows', async () => {
    const combined = (await scan(rows, { tokenTrustMode: 'combined' })).sort();
    expect(combined).toEqual([SPAM]);
    const allowlist = new Set(await scan(rows, {}));
    const earned = new Set(await scan(rows, { tokenTrustMode: 'earned' }));
    expect(combined).toEqual([...allowlist].filter((a) => earned.has(a)).sort());
  });

  it('honours the stored trustDenied flag (allowlist mode does not)', async () => {
    const flagged = [{ address: CBBTC, priceSources: ['dexscreener'], dexActive: true, trustDenied: true }];
    expect(await scan(flagged, { tokenTrustMode: 'combined' })).toEqual([CBBTC]);
    expect(await scan(flagged, {})).toEqual([]);
  });
});

// ─── Write path: keep-last-known-price guard ─────────────────────────────────

describe('preserveTokenPrice — combined mode carries forward exactly what allowlist mode does', () => {
  async function written(
    token0: string,
    token1: string,
    config: Record<string, unknown>,
    tokens: Record<string, unknown> = { findTrustState: async () => new Map() },
  ) {
    const previous = { chainId: 1, protocol: 'uniswap-v4', positionId: '40', isActive: true, token0: { priceUsd: 7 }, token1: { priceUsd: 9 } };
    const model = {
      bulkWrite: vi.fn(async () => ({ upsertedCount: 1, modifiedCount: 0 })),
      find: vi.fn(() => ({ lean: vi.fn(async () => [previous]) })),
    };
    const resolver = { positionModel: () => model, transactionModel: () => model, priceModel: () => model };
    const repo = new PositionsRepository(resolver as never, tokens as never, config as never);
    (repo as unknown as { logger: unknown }).logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const pos = {
      chainId: 1, protocol: 'uniswap-v4', positionId: '40', tokenId: '40', owner: '0x', poolId: '0x',
      token0: { address: token0, decimals: 18, symbol: 'A', priceUsd: 0 },
      token1: { address: token1, decimals: 18, symbol: 'B', priceUsd: 0 },
      fee: 3000, tickSpacing: 60, tickLower: 0, tickUpper: 60, currentTick: 0, sqrtPriceX96: '0', liquidity: '0', isActive: true,
      createdAtTimestamp: 0, closedAtTimestamp: null, amounts: {}, metrics: {}, poolStats: {}, pricing: {}, rawSubgraph: {},
    } as unknown as NormalizedPosition;
    await repo.upsertMany([pos]);
    const op = (model.bulkWrite.mock.calls[0] as unknown as [Array<{ updateOne: { update: { $set: Record<string, { priceUsd: number }> } } }>])[0][0]!;
    return [op.updateOne.update.$set.token0!.priceUsd, op.updateOne.update.$set.token1!.priceUsd];
  }

  it('anchors and listed tokens carry forward, unlisted ones do not — identical to allowlist mode', async () => {
    for (const [t0, t1] of [[CBBTC, USDC], [BTCB, USDC], [SPAM, CBBTC]] as const) {
      expect(await written(t0, t1, { tokenTrustMode: 'combined' })).toEqual(await written(t0, t1, {}));
    }
    expect(await written(CBBTC, USDC, { tokenTrustMode: 'combined' })).toEqual([7, 9]);
    expect(await written(BTCB, USDC, { tokenTrustMode: 'combined' })).toEqual([0, 9]);
  });

  // The hot path loads the flag (a flagged listed cbBTC prices 0 — 'a stored
  // trustDenied flag removes a listed leg in combined mode' above); the write
  // path must not then put the pre-flag price back on every sync.
  it('a flagged (trustDenied) listed token is NOT carried forward in combined mode; allowlist mode ignores the flag', async () => {
    const reads: string[][] = [];
    const flagged = {
      findTrustState: async (_c: number, addrs: string[]) => {
        reads.push(addrs);
        return new Map(addrs.filter((a) => a === CBBTC).map((a) => [a, { trustDenied: true }]));
      },
    };
    expect(await written(CBBTC, USDC, { tokenTrustMode: 'combined' }, flagged)).toEqual([0, 9]);
    // Only the leg the guard would carry forward without its document is read (USDC is an anchor).
    expect(reads).toEqual([[CBBTC]]);
    expect(await written(CBBTC, USDC, {}, flagged)).toEqual([7, 9]);
    expect(reads).toHaveLength(1); // allowlist mode reads nothing
    // The write-skip planner (shadow / on) builds its update through the same guard.
    for (const positionsWriteSkip of ['shadow', 'on']) {
      expect(await written(CBBTC, USDC, { tokenTrustMode: 'combined', positionsWriteSkip }, flagged), positionsWriteSkip).toEqual([0, 9]);
      expect(await written(CBBTC, USDC, { tokenTrustMode: 'combined', positionsWriteSkip }), positionsWriteSkip).toEqual([7, 9]);
    }
  });

  it('a row re-issued whole from a fresh read (a stamp conflict, E11000) is judged with the flag too', async () => {
    const previous = { chainId: 1, protocol: 'uniswap-v4', positionId: '41', isActive: true, token0: { priceUsd: 7 }, token1: { priceUsd: 9 } };
    let call = 0;
    const model = {
      // The first write loses to a newer stored stamp; the re-issue lands.
      bulkWrite: vi.fn(async () => {
        if (++call === 1) throw Object.assign(new Error('E11000'), { writeErrors: [{ index: 0, code: 11000 }], result: {} });
        return { upsertedCount: 0, modifiedCount: 1 };
      }),
      find: vi.fn(() => ({ lean: vi.fn(async () => [previous]) })),
    };
    const resolver = { positionModel: () => model, transactionModel: () => model, priceModel: () => model };
    const tokens = { findTrustState: async (_c: number, addrs: string[]) => new Map(addrs.filter((a) => a === CBBTC).map((a) => [a, { trustDenied: true }])) };
    const repo = new PositionsRepository(resolver as never, tokens as never, { tokenTrustMode: 'combined' } as never);
    (repo as unknown as { logger: unknown }).logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const pos = {
      chainId: 1, protocol: 'uniswap-v4', positionId: '41', tokenId: '41', owner: '0x', poolId: '0x',
      token0: { address: CBBTC, decimals: 8, symbol: 'cbBTC', priceUsd: 0 },
      token1: { address: USDC, decimals: 6, symbol: 'USDC', priceUsd: 0 },
      fee: 3000, tickSpacing: 60, tickLower: 0, tickUpper: 60, currentTick: 0, sqrtPriceX96: '0', liquidity: '0', isActive: true,
      createdAtTimestamp: 0, closedAtTimestamp: null, amounts: {}, metrics: {}, poolStats: {}, pricing: {}, rawSubgraph: {},
      rpcFeesBlock: 123, // a carried fee reading: the op is stamp-guarded
    } as unknown as NormalizedPosition;
    await repo.upsertMany([pos]);
    expect(model.bulkWrite).toHaveBeenCalledTimes(2);
    const op = (model.bulkWrite.mock.calls[1] as unknown as [Array<{ updateOne: { update: { $set: Record<string, { priceUsd: number }> } } }>])[0][0]!;
    expect([op.updateOne.update.$set.token0!.priceUsd, op.updateOne.update.$set.token1!.priceUsd]).toEqual([0, 9]);
  });

  it('earned mode reads no flag (nothing but anchors is carried forward there); an unreadable flag fails closed in combined mode', async () => {
    const findTrustState = vi.fn(async () => new Map());
    expect(await written(CBBTC, USDC, { tokenTrustMode: 'earned' }, { findTrustState })).toEqual([0, 9]);
    expect(findTrustState).not.toHaveBeenCalled();
    const broken = { findTrustState: async () => { throw new Error('mongo down'); } };
    expect(await written(CBBTC, USDC, { tokenTrustMode: 'combined' }, broken)).toEqual([0, 9]);
  });
});

// ─── Historical walk: the trusted-market gates read the flag too ──────────────

describe('historicalTokenPricesUsdMany — the trusted-market gates load the stored flag', () => {
  // A pool-derived (`subgraph-historical`) cached row for listed cbBTC is
  // served only while cbBTC has a trusted market. Nothing on this path used to
  // load the stored verdicts, so a flagged listed token read as listed there.
  async function served(config: Record<string, unknown>, stored: Record<string, StoredTokenTrust>) {
    const findTrustState = vi.fn(async (_c: number, addrs: string[]) => new Map(addrs.filter((a) => stored[a]).map((a) => [a, stored[a]!])));
    const svc = new PricingService(
      { priceFallbackEnabled: false, tokenListingGateEnabled: true, pricingMissTtlMs: 60_000, ...config } as never,
      {
        findHistoricalNear: async () => null,
        findHistoricalNearMany: async (lookups: Array<{ chainId: number; address: string; bucketTs: number }>) =>
          new Map(lookups.map((l) => [`${l.chainId}:${l.address}:${l.bucketTs}`, { ...l, priceUsd: 85_000, source: 'subgraph-historical' }])),
        upsertHistorical: async () => {},
        upsertManyHistorical: async () => {},
      } as never,
      undefined,
      { isListed: (_c: number, a: string) => a === CBBTC } as never,
      { findTrustState } as never,
    );
    const prices = await svc.historicalTokenPricesUsdMany([{ chainId: 1, address: CBBTC, timestamp: 1_700_000_000 }]);
    return { price: [...prices.values()][0] ?? 0, findTrustState };
  }

  it('combined: a flagged listed token\'s pool-derived row is refused; unflagged it is served (allowlist mode reads nothing)', async () => {
    expect((await served({ tokenTrustMode: 'combined' }, { [CBBTC]: { trustDenied: true } })).price).toBe(0);
    expect((await served({ tokenTrustMode: 'combined' }, {})).price).toBe(85_000);
    const allowlist = await served({}, { [CBBTC]: { trustDenied: true } });
    expect(allowlist.price).toBe(85_000);
    expect(allowlist.findTrustState).not.toHaveBeenCalled();
  });

  it('earned: an earned token is no longer refused on a cold cache', async () => {
    expect((await served({ tokenTrustMode: 'earned' }, { [CBBTC]: { trustEarned: true, trustReason: 'earned', trustEvaluatedAt: new Date() } })).price).toBe(85_000);
    expect((await served({ tokenTrustMode: 'earned' }, {})).price).toBe(0);
  });
});

// ─── The sweep: combined mode must EARN verdicts, or it is allowlist mode ─────

describe('consensus sweep — combined mode computes and stores verdicts', () => {
  const POOL = '0x9c25d738109ff9ad10516f5f97ef24b9af51a9aa3db4b3b5728edf18a2d3f11c';
  function sweepProvider(name: string, quotes: Record<string, Record<string, unknown> & { priceUsd: number }>) {
    return { ...provider(quotes as never), name };
  }
  async function sweep(config: Record<string, unknown>) {
    const verdicts: Array<{ address: string; trustEarned: boolean }> = [];
    const tokens = {
      findLatestPrices: async (_c: number, addrs: string[]) =>
        new Map(addrs.filter((a) => a === CBBTC).map((a) => [a, { priceUsd: 85_300, pricedAt: new Date() }])),
      upsertPrices: async () => {},
      upsertTrustEvidence: async (_c: number, r: Array<{ address: string; trustEarned: boolean }>) => void verdicts.push(...r),
      clearGuardedPrices: async () => {},
      findTrustState: async () => new Map(),
      findDexMarketState: async () => new Map(),
    };
    const providers = [
      sweepProvider('defillama', { [BTCB]: { priceUsd: 85_852, quotedAtMs: Date.now() - 600_000 }, [CBBTC]: { priceUsd: 85_300 } }),
      sweepProvider('dexscreener', {
        [BTCB]: {
          priceUsd: 85_300,
          volume24hUsd: 60_866,
          counterLiquidity: 49.1352,
          counterTokenAddress: CBBTC,
          dexPairs: [{ id: POOL, liquidityUsd: 8_530_070, counterLiquidity: 49.1352, counterTokenAddress: CBBTC }],
          dexPairsComplete: true,
        },
        [CBBTC]: { priceUsd: 85_300 },
      }),
    ];
    const svc = new PricingService(
      { priceFallbackEnabled: true, tokenListingGateEnabled: true, dexMarketMinVolumeUsd: 50, dexMarketMinCounterLiquidityUsd: 1000, pricingPrefetchChunkConcurrency: 2, ...config } as never,
      {} as never,
      { currentProviders: () => providers, historicalProviders: () => providers } as never,
      { isListed: (_c: number, a: string) => a === CBBTC } as never,
      tokens as never,
    );
    await svc.prefetchConsensus(1, [BTCB]);
    return verdicts;
  }

  it('BTC.b earns trust under TOKEN_TRUST_MODE=combined (no shadow flag needed); allowlist mode writes nothing (today)', async () => {
    expect((await sweep({ tokenTrustMode: 'combined' })).find((v) => v.address === BTCB)).toMatchObject({ trustEarned: true });
    expect(await sweep({})).toEqual([]);
  });
});
