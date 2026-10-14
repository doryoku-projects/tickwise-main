/**
 * Price-source coverage and the stored trust-verdict distribution: per
 * chain, tokens by the number of INDEPENDENT sources behind their stored
 * price (0 / 1 / 2 / 3+, DEX-only vs with a non-DEX aggregator), the stored
 * `trustReason` buckets, and the "unknown" share (no verdict or a stale one).
 */
import { describe, expect, it } from 'vitest';
import { SOURCE_BUCKETS, VERDICT_BUCKETS, parseArgs, renderMarkdown, resolveThresholds, sourceCoverage, storedVerdictBucket } from '../../scripts/valuation-impact-report.mjs';
import { DAY, NOW, fresh, openRow, run, tok, USDC } from './fixtures.js';

const th = resolveThresholds(parseArgs([]), {} as NodeJS.ProcessEnv);

describe('sourceCoverage', () => {
  it('counts independent sources only (pool-derived subgraph-* never), de-duplicated', () => {
    expect(sourceCoverage({ priceSources: [] })).toMatchObject({ bucket: '0', dexOnly: false, withAggregator: false });
    expect(sourceCoverage(undefined)).toMatchObject({ bucket: '0' });
    expect(sourceCoverage({ priceSources: ['subgraph-current', 'subgraph-historical'] })).toMatchObject({ bucket: '0' });
    expect(sourceCoverage({ priceSources: ['dexscreener'] })).toMatchObject({ bucket: '1', dexOnly: true, withAggregator: false });
    expect(sourceCoverage({ priceSources: ['dia', 'dia'] })).toMatchObject({ bucket: '1', dexOnly: false, withAggregator: true });
    expect(sourceCoverage({ priceSources: ['dexscreener', 'geckoterminal'] })).toMatchObject({ bucket: '2', dexOnly: true });
    expect(sourceCoverage({ priceSources: ['defillama', 'dexscreener', 'subgraph-current'] })).toMatchObject({ bucket: '2', dexOnly: false, withAggregator: true });
    expect(sourceCoverage({ priceSources: ['defillama', 'coingecko', 'dexscreener', 'dia'] })).toMatchObject({ bucket: '3+', sources: 4 });
    expect(SOURCE_BUCKETS).toEqual(['0', '1', '2', '3+']);
  });
});

describe('storedVerdictBucket', () => {
  it('no verdict, stale (or undated), earned, each stored failure, anything else as other', () => {
    expect(storedVerdictBucket({}, th, NOW)).toBe('no-verdict');
    expect(storedVerdictBucket({ trustReason: 'earned' }, th, NOW)).toBe('no-verdict'); // a reason without the boolean is no verdict
    expect(storedVerdictBucket({ trustEarned: true, trustReason: 'earned' }, th, NOW)).toBe('stale-verdict'); // undated
    expect(storedVerdictBucket({ trustEarned: true, trustReason: 'earned', trustEvaluatedAt: new Date(NOW - 2 * DAY) }, th, NOW)).toBe('stale-verdict');
    expect(storedVerdictBucket({ trustEarned: true, trustReason: 'earned', trustEvaluatedAt: fresh }, th, NOW)).toBe('earned');
    for (const r of ['single-source', 'stale-quote', 'no-dex-market', 'single-pool']) {
      expect(storedVerdictBucket({ trustEarned: false, trustReason: r, trustEvaluatedAt: fresh }, th, NOW)).toBe(r);
    }
    expect(storedVerdictBucket({ trustEarned: false, trustReason: 'mystery', trustEvaluatedAt: fresh }, th, NOW)).toBe('other');
    // The pre-rename date field is read too (storedTrustOf).
    expect(storedVerdictBucket({ trustEarned: false, trustReason: 'single-pool', trustCheckedAt: fresh }, th, NOW)).toBe('single-pool');
    // An anchor is counted by what it STORED (the trust rule answers `anchor` before looking).
    expect(storedVerdictBucket({ address: USDC, trustEarned: false, trustReason: 'single-source', trustEvaluatedAt: fresh }, th, NOW)).toBe('single-source');
    expect(VERDICT_BUCKETS).toContain('no-verdict');
  });

  it('follows PRICE_QUOTE_MAX_AGE_MS', () => {
    const short = resolveThresholds(parseArgs(['--quote-max-age-ms=600000']), {} as NodeJS.ProcessEnv);
    const at = new Date(NOW - 3_600_000);
    expect(storedVerdictBucket({ trustEarned: true, trustEvaluatedAt: at }, th, NOW)).toBe('earned');
    expect(storedVerdictBucket({ trustEarned: true, trustEvaluatedAt: at }, short, NOW)).toBe('stale-verdict');
  });
});

describe('coverage, end to end', () => {
  // A held token the sweep never wrote a row for, and three more rows for the buckets.
  const NOROW = '0x00000000000000000000000000000000000a0a0a';
  const TRIPLE = '0x00000000000000000000000000000000000b0b0b';
  const STALE = '0x00000000000000000000000000000000000c0c0c';
  const FAILED = '0x00000000000000000000000000000000000d0d0d';
  const extraTokens = [
    { chainId: 1, address: TRIPLE, symbol: 'TRI', priceUsd: 1, dexActive: true, priceSources: ['defillama', 'coingecko', 'dexscreener'], priceConfidence: 'external-verified', pricedAt: fresh, trustEarned: false, trustReason: 'single-pool', trustEvaluatedAt: fresh },
    { chainId: 1, address: STALE, symbol: 'OLD', priceUsd: 1, dexActive: true, priceSources: ['dexscreener', 'geckoterminal'], priceConfidence: 'external-verified', pricedAt: fresh, trustEarned: true, trustReason: 'earned', trustEvaluatedAt: new Date(NOW - 3 * DAY) },
    { chainId: 1, address: FAILED, symbol: 'ONE', priceUsd: 1, dexActive: true, priceSources: ['defillama'], priceConfidence: 'external-unverified', pricedAt: fresh, trustEarned: false, trustReason: 'single-source', trustEvaluatedAt: fresh },
  ];
  // WETH: an anchor an open position holds with no token row — never counted (anchors need no verdict).
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const holders = [NOROW, TRIPLE, STALE, WETH].map((a, i) =>
    openRow(`90010${i}`, { poolId: '0x' + '7'.repeat(64), token0: tok(a, 'X', 18, 1), token1: tok(USDC, 'USDC', 6, 1), amounts: { amount0: '1', amount1: '0' }, metrics: { underlyingValueUsd: 1, inRange: false } }),
  );

  it('buckets every token row (and held tokens with no row) by sources and stored verdict, all and held', async () => {
    const { summary } = await run(['--pace-ms=0'], { extraTokens, extraPositions: holders });
    const cov = summary.chains[0].coverage;
    // 10 fixture rows + 3 extra rows + 1 held token with no row.
    expect(cov.tokens).toBe(14);
    expect(cov.heldNoRow).toBe(1);
    // Held non-anchor: HPP AERGO BTC.b cbBTC THALES DIAX SCAM (fixture) + NOROW TRIPLE STALE.
    expect(cov.held).toBe(10);
    expect(cov.sources['0']).toMatchObject({ tokens: 1, held: 1 });
    expect(cov.sources['1']).toMatchObject({ tokens: 6, held: 4, dexOnly: 1, dexOnlyHeld: 1, withAggregator: 5, withAggregatorHeld: 3 });
    expect(cov.sources['2']).toMatchObject({ tokens: 6, held: 4, dexOnly: 1, dexOnlyHeld: 1, withAggregator: 5, withAggregatorHeld: 3 });
    expect(cov.sources['3+']).toMatchObject({ tokens: 1, held: 1, withAggregator: 1 });
    const sum = (k: 'tokens' | 'held') => SOURCE_BUCKETS.reduce((acc: number, b: string) => acc + cov.sources[b][k], 0);
    expect([sum('tokens'), sum('held')]).toEqual([cov.tokens, cov.held]);
    expect(cov.verdicts.earned).toEqual({ tokens: 3, held: 3 }); // AERGO BTC.b cbBTC
    expect(cov.verdicts['single-pool']).toEqual({ tokens: 1, held: 1 });
    expect(cov.verdicts['single-source']).toEqual({ tokens: 1, held: 0 }); // FAILED: nobody holds it
    expect(cov.verdicts['stale-verdict']).toEqual({ tokens: 1, held: 1 });
    expect(cov.verdicts['no-verdict']).toEqual({ tokens: 8, held: 5 });
    const vsum = (k: 'tokens' | 'held') => VERDICT_BUCKETS.reduce((acc: number, b: string) => acc + cov.verdicts[b][k], 0);
    expect([vsum('tokens'), vsum('held')]).toEqual([cov.tokens, cov.held]);
  });

  it('a held token with no row is counted in the held-trust comparison too, as the coverage section counts it', async () => {
    // LINK: allowlisted, not an anchor, no token row → trusted today and under
    // combined, undecided under earned. NOROW: neither → undecided in both.
    const LINK = '0x514910771af9ca656af840dff83e8264ecf986ca';
    const hold = (a: string, i: number) =>
      openRow(`90020${i}`, { poolId: '0x' + '6'.repeat(64), token0: tok(a, 'X', 18, 1), token1: tok(USDC, 'USDC', 6, 1), amounts: { amount0: '1', amount1: '0' }, metrics: { underlyingValueUsd: 1, inRange: false } });
    const base = (await run(['--pace-ms=0'])).summary.chains[0];
    const c = (await run(['--pace-ms=0'], { extraPositions: [hold(LINK, 0), hold(NOROW, 1)] })).summary.chains[0];
    const delta = (k: string, block: 'trust' | 'trustCombined' = 'trust') => c[block][k] - base[block][k];
    expect(c.coverage.held - base.coverage.held).toBe(2);
    expect(c.coverage.heldNoRow - base.coverage.heldNoRow).toBe(2);
    expect(delta('heldToday')).toBe(1); // LINK
    expect(delta('heldCombined')).toBe(1); // LINK
    expect(delta('heldEarned')).toBe(0);
    expect(delta('heldEarnedUndecided')).toBe(2);
    expect(delta('heldCombinedUndecided')).toBe(1); // NOROW
    expect(delta('tokensNoVerdictHeld')).toBe(2);
    expect(delta('tokensNoVerdictAllowlistedHeld')).toBe(1);
    expect(delta('tokensNoVerdictHeld', 'trustCombined')).toBe(1);
  });

  it('Markdown: the per-chain tables, the unknown share and the artefact warning', async () => {
    const { summary } = await run(['--pace-ms=0'], { extraTokens, extraPositions: holders });
    const md = renderMarkdown(summary);
    expect(md).toContain('## Price-source coverage and stored trust verdicts');
    expect(md).toContain('| 3+ | 1 | 1 | 0 · 0 held | 1 · 1 held |');
    expect(md).toContain('| no stored verdict | 8 | 5 |');
    expect(md).toContain('| stale verdict (> 24.0 h) | 1 | 1 |');
    // Unknown = no verdict + stale: 6 of 10 held, 9 of 14 overall.
    expect(md).toContain('Unknown share (no stored verdict, or one older than 24.0 h): 6 of 10 held tokens (60.0%); 9 of 14 tokens overall (64.3%).');
    expect(md).toMatch(/without the definite-only rule .* may be artefacts/);
    // Sums across chains (sumTotals) keep the bucket shape.
    expect(summary.totals.coverage.sources['3+'].tokens).toBe(1);
  });
});
