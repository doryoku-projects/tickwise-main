import { describe, expect, it } from 'vitest';
// The script is plain ESM so it runs without a build; its pure helpers are
// exported for exactly this spec.
import {
  classifyStoredRow,
  diaMatches,
  evidenceIsCurrent,
  parseArgs,
  pinnedClearOp,
  quoteRejection as scriptRejection,
} from '../../scripts/purge-stale-prices.mjs';
import { quoteRejection, trustPolicyOf } from '../../src/pricing/token-trust.js';
import { priceEvidenceIsCurrent } from '../../src/database/token.repository.js';

const NOW = Date.UTC(2026, 9, 5, 12);
const DAY = 86_400_000;
const OPTS = { maxAgeMs: DAY, diaMinVolumeUsd: 1000 };
// Evidence written with the current price (what every flag-on write stamps).
const PRICED = new Date(NOW - 3_600_000);
const cur = { pricedAt: PRICED, priceEvidenceAt: PRICED };

describe('scripts/purge-stale-prices.mjs', () => {
  it('its quote rule is the service rule (same cases, same answers)', () => {
    const policy = trustPolicyOf({ priceQuoteGuard: 'on' });
    const cases: Array<[{ quotedAtMs?: number; volume24hUsd?: number }, string]> = [
      [{ quotedAtMs: NOW - 140 * DAY, volume24hUsd: 0.098 }, 'dia'],
      [{ quotedAtMs: NOW - DAY + 1, volume24hUsd: 0.098 }, 'dia'],
      [{ quotedAtMs: NOW - DAY + 1, volume24hUsd: 5000 }, 'dia'],
      [{ quotedAtMs: NOW - DAY - 1 }, 'defillama'],
      [{}, 'dexscreener'],
      [{ volume24hUsd: 0 }, 'geckoterminal'],
    ];
    for (const [q, name] of cases) expect(scriptRejection(q, name, OPTS, NOW)).toBe(quoteRejection(q, name, policy, NOW));
  });

  it('flags a hot-path price whose provider dated it past the window', () => {
    expect(classifyStoredRow({ ...cur, priceUsd: 31374, priceQuoteSource: 'dia', priceQuotedAt: new Date(NOW - 140 * DAY) }, OPTS, NOW)).toBe('stored-stale');
    expect(classifyStoredRow({ ...cur, priceUsd: 1, priceQuoteSource: 'dia', priceQuotedAt: new Date(NOW - 60_000) }, OPTS, NOW)).toBeNull();
    // A provider date with no provider recorded is not hot-path provenance.
    expect(classifyStoredRow({ ...cur, priceUsd: 31374, priceQuotedAt: new Date(NOW - 140 * DAY) }, OPTS, NOW)).toBeNull();
  });

  it('flags a saved price the guard would not serve (sweep shadow evidence)', () => {
    expect(classifyStoredRow({ ...cur, priceUsd: 31374, priceQuoteRejected: ['dia:stale'], priceGuardUsd: 0.0062 }, OPTS, NOW)).toBe('guard-differs');
    expect(classifyStoredRow({ ...cur, priceUsd: 31374, priceQuoteRejected: ['dia:stale'], priceGuardUsd: 0 }, OPTS, NOW)).toBe('guard-differs');
    // Rejections recorded but the accepted quotes agree with the saved price → keep.
    expect(classifyStoredRow({ ...cur, priceUsd: 1, priceQuoteRejected: ['dia:thin'], priceGuardUsd: 1.02 }, OPTS, NOW)).toBeNull();
    // No rejections → nothing to say, whatever the guard price.
    expect(classifyStoredRow({ ...cur, priceUsd: 1, priceQuoteRejected: [], priceGuardUsd: 0 }, OPTS, NOW)).toBeNull();
  });

  it('keeps a consensus price a stale DIA quote merely agreed with, whatever date the evidence carries', () => {
    // Fresh DeFiLlama + an agreeing 140-day-old DIA quote (shadow: the stale one voted).
    const row = {
      ...cur,
      priceUsd: 1,
      priceSources: ['defillama', 'dia'],
      priceQuoteRejected: ['dia:stale'],
      priceGuardUsd: 1,
      priceQuotedAt: new Date(NOW - 140 * DAY),
    };
    expect(classifyStoredRow(row, OPTS, NOW)).toBeNull();
  });

  it('ignores evidence that describes an OLDER price (a later write carried none)', () => {
    const stale = { pricedAt: new Date(NOW - 60_000), priceEvidenceAt: new Date(NOW - 10 * DAY) };
    expect(classifyStoredRow({ ...stale, priceUsd: 31374, priceQuoteRejected: ['dia:stale'], priceGuardUsd: 0 }, OPTS, NOW)).toBeNull();
    expect(classifyStoredRow({ ...stale, priceUsd: 31374, priceQuoteSource: 'dia', priceQuotedAt: new Date(NOW - 140 * DAY) }, OPTS, NOW)).toBeNull();
    // No stamp at all → no evidence to go on.
    expect(classifyStoredRow({ pricedAt: PRICED, priceUsd: 31374, priceQuoteRejected: ['dia:stale'], priceGuardUsd: 0 }, OPTS, NOW)).toBeNull();
  });

  it('its evidence-currency rule is the repository\'s', () => {
    const t = new Date(NOW);
    const cases = [
      { pricedAt: t, priceEvidenceAt: t },
      { pricedAt: t, priceEvidenceAt: new Date(NOW - 999) },
      { pricedAt: t, priceEvidenceAt: new Date(NOW - 1001) },
      { pricedAt: t },
      { priceEvidenceAt: t },
      { pricedAt: t.toISOString(), priceEvidenceAt: t.toISOString() },
    ];
    for (const c of cases) expect(evidenceIsCurrent(c)).toBe(priceEvidenceIsCurrent(c as never));
  });

  it('never flags a row without a positive price or without evidence', () => {
    expect(classifyStoredRow({ ...cur, priceUsd: 0, priceQuoteSource: 'dia', priceQuotedAt: new Date(0) }, OPTS, NOW)).toBeNull();
    expect(classifyStoredRow({ ...cur, priceUsd: 5 }, OPTS, NOW)).toBeNull();
  });

  it('--apply writes each row pinned to the price and pricedAt that were judged', () => {
    const at = new Date(NOW);
    expect(pinnedClearOp(1, { address: '0xAbC', priceUsd: 31374, pricedAt: PRICED }, 'guard-differs', at)).toEqual({
      updateOne: {
        filter: { chainId: 1, address: '0xabc', priceUsd: 31374, pricedAt: PRICED },
        update: { $set: { priceUsd: 0, pricePurgedAt: at, pricePurgedReason: 'purge-script:guard-differs' } },
      },
    });
  });

  it('--probe-dia: the saved price IS a stale/thin DIA quote only when it matches it within 1%', () => {
    const staleDia = { Price: 31374.54, VolumeYesterdayUSD: 0.098, Time: new Date(NOW - 140 * DAY).toISOString() };
    expect(diaMatches(31374.54, staleDia, OPTS, NOW)).toBe(true);
    expect(diaMatches(0.0062, staleDia, OPTS, NOW)).toBe(false); // saved price came from elsewhere
    const goodDia = { Price: 85250, VolumeYesterdayUSD: 60860, Time: new Date(NOW - 3_600_000).toISOString() };
    expect(diaMatches(85250, goodDia, OPTS, NOW)).toBe(false); // fresh, traded → keep
  });

  it('diagnoses by default and refuses unknown flags', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--apply', '--chain=1', '--probe-dia', '--max-age-ms=3600000']).apply).toBe(true);
    expect(parseArgs(['--address=0xB0F70C0bD6FD87dbEb7C10dC692a2a6106817072']).addresses).toEqual(['0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072']);
    expect(() => parseArgs(['--aply'])).toThrow(/unknown/);
    expect(() => parseArgs(['--address=nope'])).toThrow(/not an address/);
  });
});
