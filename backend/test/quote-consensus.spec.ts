import { describe, expect, it } from 'vitest';
import { reconcileQuotes, consensusToConfidence } from '../src/pricing/quote-consensus.js';

describe('reconcileQuotes', () => {
  it('no positive quotes → none', () => {
    expect(reconcileQuotes([])).toMatchObject({ priceUsd: 0, confidence: 'none' });
    expect(reconcileQuotes([{ source: 'a', priceUsd: 0 }])).toMatchObject({ priceUsd: 0, confidence: 'none' });
  });

  it('single source → single-source', () => {
    const r = reconcileQuotes([{ source: 'dexscreener', priceUsd: 0.0105 }]);
    expect(r).toMatchObject({ priceUsd: 0.0105, confidence: 'single-source', sources: ['dexscreener'] });
  });

  it('two sources within tolerance → consensus (DUAL/WXRP class)', () => {
    const r = reconcileQuotes([
      { source: 'defillama', priceUsd: 0.00337 },
      { source: 'dexscreener', priceUsd: 0.00335 },
    ]);
    expect(r.confidence).toBe('consensus');
    expect(r.priceUsd).toBeCloseTo(0.00336, 5);
    expect(r.sources).toEqual(expect.arrayContaining(['defillama', 'dexscreener']));
    expect(r.outliers).toHaveLength(0);
  });

  it('rejects a lone 10,000x outlier among 3 sources (sPENDLE class)', () => {
    const r = reconcileQuotes([
      { source: 'defillama', priceUsd: 1.0 },
      { source: 'coingecko', priceUsd: 1.01 },
      { source: 'geckoterminal', priceUsd: 10000 },
    ]);
    expect(r.confidence).toBe('consensus');
    expect(r.priceUsd).toBeCloseTo(1.005, 3); // median of the agreeing cluster, NOT 1.01..10000
    expect(r.outliers.map((o) => o.source)).toContain('geckoterminal');
  });

  it('two wildly-disagreeing sources → conservative MIN, low confidence (no inflation)', () => {
    const r = reconcileQuotes([
      { source: 'a', priceUsd: 1 },
      { source: 'b', priceUsd: 10000 },
    ]);
    expect(r.confidence).toBe('single-source');
    expect(r.priceUsd).toBe(1); // never let the 10000 win
  });

  it('maps consensus verdicts to trust tiers', () => {
    expect(consensusToConfidence('consensus')).toBe('external-verified');
    expect(consensusToConfidence('single-source')).toBe('external-unverified');
    expect(consensusToConfidence('none')).toBe('missing');
  });
});
