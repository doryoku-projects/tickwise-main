/**
 * The impact report mirrors the few decision rules that live in Nest-heavy
 * modules (the report runs under plain tsx and imports only pure ones). Each
 * mirror is pinned here to the ORIGINAL, over fixed edge cases and seeded
 * random inputs, so a change to the real rule that the report does not follow
 * fails this suite instead of producing a plausible, wrong report.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEXSCREENER_BATCH,
  DEXSCREENER_CHAIN,
  DEXSCREENER_PAIR_CAP,
  DIA_CHAIN,
  DYNAMIC_FEE_FLAG,
  HONEYPOT_MIN_FEE_PIPS,
  TRUSTED_TVL_CONFIDENCES,
  TVL_CEILING_USD,
  UNTRUSTED_TVL_MAX_SHARE,
  crossCheckAllowlistedPair,
  dexProbeCoverage,
  dexProbeUrl,
  evaluatePoolTvl,
  isEnvDenied,
  isHoneypotFee,
  isNoRealMarket,
  isSpamToken,
  isStoredAnchorPair,
  landingVisible,
  resolveThresholds,
  parseArgs,
  storedVerdictBucket,
  tickMathAmounts,
} from '../../scripts/valuation-impact-report.mjs';
import {
  DYNAMIC_FEE_FLAG as REPO_DYNAMIC_FEE_FLAG,
  HONEYPOT_FEE_MIN_PIPS as REPO_HONEYPOT_FEE_MIN_PIPS,
  PositionsRepository,
  honeypotFeeClause,
  type LeaderboardQuery,
} from '../../src/database/positions.repository.js';
import { evaluatePoolTvl as realEvaluatePoolTvl } from '../../src/sync/pools-sync.service.js';
import {
  crossCheckAllowlistedPair as realCrossCheck,
  tickMathAmounts as realTickMathAmounts,
} from '../../src/subgraph/adapters/envio.adapter.js';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { TokensRepository } from '../../src/database/token.repository.js';
import { DIA_CHAIN as REAL_DIA_CHAIN } from '../../src/pricing/providers/dia.provider.js';
import {
  DEXSCREENER_CHAIN as REAL_DEXSCREENER_CHAIN,
  DEXSCREENER_RESPONSE_PAIR_CAP as REAL_DEXSCREENER_PAIR_CAP,
  DexScreenerProvider,
} from '../../src/pricing/providers/dexscreener.provider.js';
import { anchorAddresses, isAnchorPair } from '../../src/common/pool-fee.js';
import { resolveTokenTrust } from '../../src/pricing/token-trust.js';
import { isAnchorTokenStandalone } from '../../src/pricing/pricing-policy.js';
import { getSqrtRatioAtTick } from '../../src/pricing/tick-math.js';
import { matches, miniModel, prng } from '../support/mini-mongo.js';

const FEES = [0, 100, 500, 3000, 10_000, 23_033, 49_999, 50_000, 50_001, 60_001, 99_993, 100_000, 999_993, 0x7fffff, 0x800000, 0x800001, 0xffffff];

describe('fix 2 — honeypot fee rule', () => {
  it('uses the repository constants', () => {
    expect(HONEYPOT_MIN_FEE_PIPS).toBe(REPO_HONEYPOT_FEE_MIN_PIPS);
    expect(DYNAMIC_FEE_FLAG).toBe(REPO_DYNAMIC_FEE_FLAG);
  });

  it('excludes exactly the rows honeypotFeeClause() does not keep (incl. null / missing fee)', () => {
    const clause = honeypotFeeClause();
    const docs: Array<Record<string, unknown>> = [...FEES.map((fee) => ({ fee })), { fee: null }, {}, { fee: Number.NaN }, { fee: '60000' }, { fee: '100' }, { fee: true }];
    for (const doc of docs) {
      const kept = matches(doc, clause, false);
      expect(isHoneypotFee(doc.fee), `fee=${String(doc.fee)}`).toBe(!kept);
    }
  });

  it('agrees with the pools-sync honeypot verdict on every numeric fee', () => {
    for (const feeTier of FEES) {
      // Trusted, tiny legs: the only risky cause left is the fee.
      const v = realEvaluatePoolTvl({ reserve0: 1, reserve1: 1, price0: 1, price1: 1, confidence0: 'anchor', confidence1: 'anchor', feeTier });
      expect(isHoneypotFee(feeTier), `fee=${feeTier}`).toBe(v.risky);
    }
  });
});

describe('fix 3 — tick-math amounts', () => {
  const real = (input: Parameters<typeof realTickMathAmounts>[1]) =>
    realTickMathAmounts({ positionAmounts: (i) => PricingService.prototype.positionAmounts.call({}, i) }, input);

  it('matches the adapter (its guards + PricingService.positionAmounts) on edge cases', () => {
    const cases = [
      { liquidity: '3483295279090671660867', tickLower: 110280, tickUpper: 110460, currentTick: 110374, decimals0: 18, decimals1: 18 },
      { liquidity: '1000000000000000000', tickLower: -600, tickUpper: 600, sqrtPriceX96: getSqrtRatioAtTick(0).toString(), decimals0: 6, decimals1: 18 },
      { liquidity: '0', tickLower: -600, tickUpper: 600, currentTick: 0, decimals0: 18, decimals1: 18 },
      { liquidity: 'not-a-number', tickLower: -600, tickUpper: 600, currentTick: 0, decimals0: 18, decimals1: 18 },
      { liquidity: '1000', tickLower: 600, tickUpper: -600, currentTick: 0, decimals0: 18, decimals1: 18 },
      { liquidity: '1000', tickLower: 1.5, tickUpper: 600, currentTick: 0, decimals0: 18, decimals1: 18 },
      { liquidity: '1000', tickLower: -900000, tickUpper: 600, currentTick: 0, decimals0: 18, decimals1: 18 },
      { liquidity: '1000', tickLower: -600, tickUpper: 600, decimals0: 18, decimals1: 18 },
      { liquidity: '1000', tickLower: -600, tickUpper: 600, sqrtPriceX96: 'garbage', currentTick: 10, decimals0: 18, decimals1: 18 },
      { liquidity: '1000', tickLower: '-600' as unknown as number, tickUpper: '600' as unknown as number, currentTick: 0, decimals0: 18, decimals1: 18 },
      { liquidity: '123456789012345678901234', tickLower: -887220, tickUpper: 887220, currentTick: -887000, decimals0: 0, decimals1: 30 },
    ];
    for (const input of cases) {
      expect(tickMathAmounts(input), JSON.stringify(input)).toEqual(real(input as never));
    }
  });

  it('matches the adapter on 2,000 random positions', () => {
    const rnd = prng(42);
    const tick = () => Math.trunc((rnd() * 2 - 1) * 887_000);
    for (let i = 0; i < 2000; i++) {
      let lo = tick();
      let hi = tick();
      if (rnd() < 0.9 && lo > hi) [lo, hi] = [hi, lo];
      const current = rnd() < 0.5 ? tick() : Math.trunc(lo + (hi - lo) * rnd());
      const input = {
        liquidity: String(BigInt(Math.floor(rnd() * 1e12)) * 10n ** BigInt(Math.floor(rnd() * 12))),
        tickLower: lo,
        tickUpper: hi,
        sqrtPriceX96: rnd() < 0.5 ? getSqrtRatioAtTick(current).toString() : undefined,
        currentTick: current,
        decimals0: Math.floor(rnd() * 19),
        decimals1: Math.floor(rnd() * 19),
      };
      expect(tickMathAmounts(input)).toEqual(real(input as never));
    }
  });
});

describe('pool TVL (fix 4 projection) — evaluatePoolTvl mirror', () => {
  it('uses the pools-sync constants', () => {
    expect(TVL_CEILING_USD).toBe(5e10);
    expect([...TRUSTED_TVL_CONFIDENCES].sort()).toEqual(['anchor', 'external-verified']);
    expect(UNTRUSTED_TVL_MAX_SHARE).toBe(0.2);
  });

  it('matches the real evaluatePoolTvl on 3,000 random pools', () => {
    const rnd = prng(7);
    const confs = ['anchor', 'external-verified', 'external-unverified', 'pool-derived-strong', 'missing', undefined];
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const amount = () => (rnd() < 0.1 ? -rnd() * 1e6 : rnd() < 0.1 ? 0 : rnd() * 10 ** Math.floor(rnd() * 12));
    for (let i = 0; i < 3000; i++) {
      const input = {
        reserve0: rnd() < 0.02 ? Number.NaN : amount(),
        reserve1: amount(),
        price0: rnd() < 0.05 ? Number.POSITIVE_INFINITY : amount(),
        price1: Math.abs(amount()),
        confidence0: pick(confs),
        confidence1: pick(confs),
        feeTier: pick(FEES),
      };
      expect(evaluatePoolTvl(input)).toEqual(realEvaluatePoolTvl(input));
    }
  });
});

describe('fix 1 — allowlisted-pair cross-check mirror', () => {
  it('matches crossCheckAllowlistedPair on 3,000 random pairs', () => {
    const rnd = prng(99);
    const trusts = ['anchor', 'verified', 'unverified', 'none', 'suspect'] as const;
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const price = () => (rnd() < 0.15 ? 0 : 10 ** ((rnd() * 2 - 1) * 6));
    for (let i = 0; i < 3000; i++) {
      const input = {
        vp0: price(),
        vp1: price(),
        trust0: rnd() < 0.7 ? 'verified' : pick(trusts),
        trust1: rnd() < 0.7 ? 'verified' : pick(trusts),
        ratio: rnd() < 0.1 ? Number.NaN : rnd() < 0.05 ? 0 : 10 ** ((rnd() * 2 - 1) * 8),
        corroborated0: rnd() < 0.4,
        corroborated1: rnd() < 0.4,
        open: rnd() < 0.8,
        reserve0: rnd() < 0.2 ? undefined : rnd() < 0.1 ? -5 : rnd() * 1e6,
        reserve1: rnd() < 0.2 ? undefined : rnd() * 1e6,
        floorUsd: pick([0, 1000, 50]),
      };
      expect(crossCheckAllowlistedPair(input)).toEqual(realCrossCheck(input as never));
    }
  });
});

describe('fix 4 — the no-real-market exclusion mirror', () => {
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'; // allowlisted on Ethereum
  const HPP = '0xe33fbe7584eb79e2673abe576b7ac8c0de62565c'; // allowlisted on Ethereum
  const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072'; // NOT allowlisted on Ethereum
  const NOW = Date.UTC(2026, 9, 5, 12);

  function randomTokens(seed: number) {
    const rnd = prng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const named = [USDC, CBBTC, HPP, BTCB];
    const docs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 400; i++) {
      const address = i < named.length ? named[i]! : `0x${(i + 0x1000).toString(16).padStart(40, '0')}`;
      const doc: Record<string, unknown> = { chainId: 1, address };
      if (rnd() < 0.8) doc.priceUsd = rnd() < 0.2 ? 0 : rnd() * 100;
      const dex = pick([true, false, undefined, undefined]);
      if (dex !== undefined) doc.dexActive = dex;
      if (rnd() < 0.7) doc.priceSources = pick([[], ['defillama'], ['dexscreener'], ['dia', 'geckoterminal'], ['subgraph-current']]);
      if (rnd() < 0.5) {
        doc.trustEarned = rnd() < 0.5;
        doc.trustReason = doc.trustEarned ? 'earned' : pick(['single-pool', 'no-dex-market', 'single-source', 'stale-quote']);
        doc.trustEvaluatedAt = new Date(NOW - Math.floor(rnd() * 2 * 86_400_000));
      }
      if (rnd() < 0.05) doc.trustDenied = true;
      // A price the quote guard / purge script cleared stays in the scan (`pricePurgedAt: {$exists: true}`).
      if (rnd() < 0.15) {
        doc.priceUsd = 0;
        doc.pricePurgedAt = new Date(NOW - 3_600_000);
      }
      if (rnd() < 0.05) doc.isHoneypot = true;
      if (rnd() < 0.03) doc.isBlacklisted = true;
      docs.push(doc);
    }
    return docs;
  }

  async function realSets(docs: Array<Record<string, unknown>>, config: Record<string, unknown>) {
    const { model } = miniModel(docs);
    const repo = new TokensRepository({ tokenModel: () => model } as never, config as never);
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      return { noMarket: new Set(await repo.findNoRealMarketAddresses(1)), spam: new Set(await repo.findSpamAddresses(1)) };
    } finally {
      Date.now = realNow;
    }
  }

  for (const mode of ['allowlist', 'earned', 'combined'] as const) {
    for (const deny of ['', `1:0x${(0x1003).toString(16).padStart(40, '0')},0x${(0x5000).toString(16).padStart(40, '0')}`]) {
      it(`matches findNoRealMarketAddresses + findSpamAddresses (mode=${mode}, deny=${deny ? 'set' : 'none'})`, async () => {
        const docs = randomTokens(mode === 'allowlist' ? 11 : mode === 'earned' ? 12 : 13);
        const th = resolveThresholds(parseArgs([]), { TOKEN_TRUST_DENY: deny } as NodeJS.ProcessEnv);
        const policy = th[mode];
        expect(policy.mode).toBe(mode);
        const real = await realSets(docs, { tokenTrustMode: mode, tokenTrustDeny: deny });
        const mine = new Set<string>();
        // The report's union: the per-row rule, plus every env-denied address
        // (the repository's tail loop adds them whatever their row says).
        for (const d of docs) if (isNoRealMarket(1, d, policy, NOW) || isEnvDenied(1, String(d.address), policy)) mine.add(String(d.address));
        // …including denied addresses with no row at all (the report asks per position leg).
        for (const entry of policy.deny as Set<string>) {
          const a = entry.split(':')[1]!;
          if (isEnvDenied(1, a, policy)) mine.add(a);
        }
        expect(isEnvDenied(1, USDC, { ...policy, deny: new Set([`*:${USDC}`]) })).toBe(false); // anchors never
        expect([...mine].sort()).toEqual([...real.noMarket].sort());
        const mySpam = docs.filter((d) => isSpamToken(d)).map((d) => String(d.address)).sort();
        expect(mySpam).toEqual([...real.spam].sort());
      });
    }
  }
});

describe('DIA chains', () => {
  it('asks DIA for exactly the chains the provider does', () => {
    expect({ ...DIA_CHAIN }).toEqual({ ...REAL_DIA_CHAIN });
  });
});

describe('fix 2 + HONEYPOT_FEE_ANCHOR_EXEMPT — the exemption mirrors', () => {
  const HPP = '0xe33fbe7584eb79e2673abe576b7ac8c0de62565c'; // allowlisted, NOT an anchor
  const RANDOM = '0x00000000000000000000000000000000000beef0';
  const CHAINS = [1, 43114, 42161, 4663, 999];

  /** Every pairing that decides the `$in` branch: anchor/anchor, one leg off, case, missing, null, non-string. */
  function legPairs(chainId: number): Array<[unknown, unknown]> {
    const a = anchorAddresses(chainId);
    const x = a[0] ?? HPP;
    const y = a[a.length - 1] ?? HPP;
    return [
      [x, y], [y, x], [x, x], [x, HPP], [HPP, y], [HPP, RANDOM],
      [typeof x === 'string' ? x.toUpperCase().replace('0X', '0x') : x, y], // another case: `$in` is exact
      [undefined, y], [x, undefined], [null, y], [x, null], [123, y],
    ];
  }

  it('isHoneypotFee(fee, {anchorExempt: true}) excludes exactly what honeypotFeeClause(chainId, true) does not keep', () => {
    let exemptCases = 0;
    for (const chainId of CHAINS) {
      const clause = honeypotFeeClause(chainId, true);
      for (const [token0, token1] of legPairs(chainId)) {
        for (const fee of [...FEES, null, undefined, Number.NaN, '60000', true]) {
          const doc: Record<string, unknown> = {};
          if (fee !== undefined) doc.fee = fee;
          if (token0 !== undefined) doc.token0 = { address: token0 };
          if (token1 !== undefined) doc.token1 = { address: token1 };
          const kept = matches(doc, clause, false);
          const mine = isHoneypotFee(doc.fee, { chainId, token0, token1, anchorExempt: true });
          expect(mine, JSON.stringify({ chainId, token0, token1, fee: String(fee) })).toBe(!kept);
          if (!mine && isHoneypotFee(doc.fee)) exemptCases++;
        }
      }
    }
    // The exemption actually kept something on the anchored chains (the spec is not vacuous).
    expect(exemptCases).toBeGreaterThan(20);
  });

  it('with the exemption off (or no chain) it is today’s three-branch clause, exactly', () => {
    expect(honeypotFeeClause(1, false)).toEqual(honeypotFeeClause());
    expect(honeypotFeeClause(undefined, true)).toEqual(honeypotFeeClause());
    for (const chainId of CHAINS) {
      for (const [token0, token1] of legPairs(chainId)) {
        for (const fee of FEES) {
          expect(isHoneypotFee(fee, { chainId, token0, token1, anchorExempt: false })).toBe(isHoneypotFee(fee));
          expect(isHoneypotFee(fee, undefined)).toBe(!matches({ fee }, honeypotFeeClause(), false));
        }
      }
    }
  });

  it('the stored-row predicate and the pools sync’s isAnchorPair agree on lowercased addresses', () => {
    for (const chainId of CHAINS) {
      const pool = [...anchorAddresses(chainId), HPP, RANDOM];
      for (const t0 of pool) for (const t1 of pool) expect(isStoredAnchorPair(chainId, t0, t1), `${chainId} ${t0} ${t1}`).toBe(isAnchorPair(chainId, t0, t1));
      for (const a of anchorAddresses(chainId)) expect(isAnchorTokenStandalone(chainId, a)).toBe(true);
    }
  });

  it('the evaluatePoolTvl mirror matches the real one WITH honeypotExempt on 3,000 random pools', () => {
    const rnd = prng(17);
    const confs = ['anchor', 'external-verified', 'external-unverified', undefined];
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const amount = () => (rnd() < 0.1 ? -rnd() * 1e6 : rnd() < 0.1 ? 0 : rnd() * 10 ** Math.floor(rnd() * 12));
    let flipped = 0;
    for (let i = 0; i < 3000; i++) {
      const input = {
        reserve0: amount(),
        reserve1: amount(),
        price0: Math.abs(amount()),
        price1: Math.abs(amount()),
        confidence0: pick(confs),
        confidence1: pick(confs),
        feeTier: pick(FEES),
        honeypotExempt: pick([true, false, undefined]),
      };
      const mine = evaluatePoolTvl(input);
      expect(mine).toEqual(realEvaluatePoolTvl(input));
      if (input.honeypotExempt === true && !mine.risky && evaluatePoolTvl({ ...input, honeypotExempt: false }).risky) flipped++;
    }
    expect(flipped).toBeGreaterThan(50); // the exemption changed the verdict on real cases
  });
});

describe('the stored-verdict buckets read freshness the way the trust rule does', () => {
  const NOW = Date.UTC(2026, 9, 5, 12);
  const th = resolveThresholds(parseArgs([]), {} as NodeJS.ProcessEnv);
  it('agrees with resolveTokenTrust (earned) on 2,000 random non-anchor verdicts', () => {
    const rnd = prng(23);
    const reasons = ['earned', 'single-source', 'stale-quote', 'no-dex-market', 'single-pool', 'mystery', undefined];
    for (let i = 0; i < 2000; i++) {
      const address = `0x${(0x9000 + i).toString(16).padStart(40, '0')}`;
      const doc: Record<string, unknown> = { address };
      if (rnd() < 0.85) doc.trustEarned = rnd() < 0.4;
      if (rnd() < 0.9) doc.trustReason = reasons[Math.floor(rnd() * reasons.length)];
      const age = rnd() < 0.1 ? undefined : Math.floor(rnd() * 3 * 86_400_000);
      if (age !== undefined) doc.trustEvaluatedAt = new Date(NOW - age);
      const bucket = storedVerdictBucket(doc, th, NOW);
      const real = resolveTokenTrust(1, address, doc as never, th.earned, NOW);
      if (bucket === 'no-verdict') expect(real.reason).toBe('no-evidence');
      else if (bucket === 'stale-verdict') expect(real.reason).toBe('stale-verdict');
      else if (bucket === 'other') expect(real.reason).toBe('single-source'); // the rule's fallback for an unknown reason
      else expect(real.reason).toBe(bucket);
    }
  });
});

describe('--probe-dexscreener reads DexScreener the way the provider does', () => {
  const WAVAX = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7';
  const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e';
  const USDT = '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7';
  const NOPAIR = '0x000000000000000000000000000000000000dead';
  const pair = (base: string, quote: string, priceUsd: unknown, chainId = 'avalanche', id = `0x${'1'.repeat(40)}`) => ({
    chainId, dexId: 'uniswap', pairAddress: id, priceUsd, liquidity: { usd: 1e6, base: 1, quote: 1 }, volume: { h24: 1e5 },
    baseToken: { address: base.toUpperCase().replace('0X', '0x') }, quoteToken: { address: quote },
  });
  const provider = (mode: 'latest' | 'per-chain') =>
    new DexScreenerProvider({ pricingProviderMaxConcurrency: 4, pricingHistoricalSingleConcurrency: 4, dexscreenerBatchEndpoint: mode } as never);
  const pid = (i: number) => `0x${String(i).padStart(40, '0')}`;

  it('mirrors the provider’s chain map, pair cap and batch size', () => {
    expect({ ...DEXSCREENER_CHAIN }).toEqual({ ...REAL_DEXSCREENER_CHAIN });
    expect(DEXSCREENER_PAIR_CAP).toBe(REAL_DEXSCREENER_PAIR_CAP);
    expect(DEXSCREENER_BATCH).toBe(provider('latest').maxBatchSize);
  });

  const bodies: Record<'latest' | 'per-chain', unknown[]> = {
    latest: [
      { pairs: [pair(WAVAX, USDC, '18.2'), pair(WAVAX, USDT, '18.1'), pair(USDC, USDT, '1.0'), pair(USDT, USDC, '0'), pair(NOPAIR, USDC, '5', 'ethereum')] },
      { pairs: null },
      {},
      { pairs: Array.from({ length: 30 }, () => pair(WAVAX, USDC, '18')) }, // capped: WAVAX crowds everyone out
    ],
    // Distinct pair ids, as the live endpoint answers them: the provider counts
    // a pair answered twice once (`uniquePairs`), which must not merge two pairs.
    'per-chain': [
      [pair(WAVAX, USDC, '18.2', 'avalanche', pid(1)), pair(USDC, USDT, 'NaN', 'avalanche', pid(2)), pair(USDT, USDC, '0.9999', 'avalanche', pid(3))],
      [],
      Array.from({ length: 30 }, (_, i) => pair(i === 0 ? USDT : WAVAX, USDC, '2', 'avalanche', pid(10 + i))),
      // The same pair twice (a quote-only token answered with another token's pair).
      [pair(WAVAX, USDC, '18.2', 'avalanche', pid(4)), pair(WAVAX, USDC, '18.2', 'avalanche', pid(4))],
    ],
  };

  for (const mode of ['latest', 'per-chain'] as const) {
    it(`asks the same URL and covers the same tokens as getCurrentBatch (${mode})`, async () => {
      const addresses = [WAVAX, USDC, USDT, NOPAIR];
      for (const body of bodies[mode]) {
        const p = provider(mode);
        const http = vi.spyOn(p as unknown as { httpJson: (url: string) => unknown }, 'httpJson').mockResolvedValue({ statusCode: 200, data: body } as never);
        const quotes = await p.getCurrentBatch(43114, addresses);
        expect(http.mock.calls[0]![0]).toBe(dexProbeUrl(mode, 43114, addresses));
        const real = new Set([...quotes.keys()].map((k) => k.split(':').pop()!.toLowerCase()));
        const mine = dexProbeCoverage(body, mode, 43114, addresses);
        expect(mine.ok, JSON.stringify(body).slice(0, 80)).toBe(true);
        expect([...mine.covered].sort(), JSON.stringify(body).slice(0, 80)).toEqual([...real].sort());
        vi.restoreAllMocks();
      }
    });
  }

  it('per-chain: an answer that is not an array is an error for both (no tokens covered)', async () => {
    const p = provider('per-chain');
    vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson').mockResolvedValue({ statusCode: 200, data: { pairs: [pair(WAVAX, USDC, '18')] } } as never);
    expect((await p.getCurrentBatch(43114, [WAVAX])).size).toBe(0);
    expect(dexProbeCoverage({ pairs: [pair(WAVAX, USDC, '18')] }, 'per-chain', 43114, [WAVAX]).ok).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('the landing view mirror — PositionsDashboard Open tab through the real buildLeaderboardFilter', () => {
  const BAD = '0x00000000000000000000000000000000000000bd';
  const OK = '0x00000000000000000000000000000000000000aa';
  const repo = new PositionsRepository(
    { positionModel: () => ({}) } as never,
    { readyLeaderboardExclusions: async () => ({ addresses: [BAD], ok: true }) } as never,
  );
  const TVLS: unknown[] = [undefined, null, Number.NaN, -5, 0, 1, 500, 999.99, 1000, 1000.01, 5e6];
  const VALUES = [0, 1, 499.99, 500, 500.01, 1e6];

  for (const minPoolTvl of [1000, 0, 777]) {
    it(`agrees with the filter the dashboard's landing request runs (minPoolTvl ${minPoolTvl})`, async () => {
      const query = {
        chainId: 1, protocol: 'uniswap-v4', sort: 'apr', page: 1, limit: 20,
        status: 'active', range: 'in', minValueUsd: 500, minPoolTvl, includeRisky: true,
      } as unknown as LeaderboardQuery;
      const plan = await repo.leaderboardPlan(query);
      const th = { ...resolveThresholds(parseArgs([`--landing-min-pool-tvl=${minPoolTvl}`]), {} as NodeJS.ProcessEnv) };
      let compared = 0;
      for (const tvl of TVLS)
        for (const value of VALUES)
          for (const inRange of [true, false])
            for (const [a0, a1] of [[OK, OK], [BAD, OK], [OK, BAD]] as const) {
              const doc: Record<string, unknown> = {
                chainId: 1, protocol: 'uniswap-v4', isActive: true,
                metrics: { inRange, underlyingValueUsd: value },
                token0: { address: a0 }, token1: { address: a1 },
              };
              if (tvl !== undefined) doc.poolStats = { tvlUsd: tvl };
              const real = matches(doc, plan.filter, false);
              const mine = landingVisible({ inRange, value, poolTvl: tvl, excluded0: a0 === BAD, excluded1: a1 === BAD }, th);
              expect(mine, JSON.stringify({ tvl: String(tvl), value, inRange, a0, a1 })).toBe(real);
              compared++;
            }
      expect(compared).toBe(TVLS.length * VALUES.length * 2 * 3);
    });
  }
});
