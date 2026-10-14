/**
 * The report's safety rails: it can only read (wrapper + command monitor), it
 * never prints credentials, and a typo'd flag is an error — never a silently
 * different report.
 */
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DocPacer,
  READ_ONLY_COMMANDS,
  allowlistCrossCheck,
  legCorroboration,
  onlyDexSources,
  tokenTrust,
  isNoRealMarket,
  assertReadOnlyPipeline,
  attachWriteTripwire,
  discoverShards,
  isPositionOpen,
  parseArgs,
  passesPoolTvlFloor,
  prepareOutDir,
  readOnlyDb,
  redactUri,
  resolveThresholds,
  savedQuoteVerdict,
  valuationBasis,
  projectValue,
} from '../../scripts/valuation-impact-report.mjs';
import { fakeDb } from './fake-db.js';
import { sweepEvidence } from './sweep-evidence.js';

describe('read-only access', () => {
  it('the wrapper exposes find / aggregate / listIndexes only — no write method exists', () => {
    const { db, writes } = fakeDb({ x: [] });
    const ro = readOnlyDb(db as never);
    const coll = ro.collection('x') as unknown as Record<string, unknown>;
    expect(Object.keys(coll).sort()).toEqual(['aggregate', 'find', 'listIndexes', 'name']);
    for (const m of ['insertOne', 'updateOne', 'updateMany', 'deleteMany', 'bulkWrite', 'createIndex', 'drop', 'findOneAndUpdate']) {
      expect(coll[m], m).toBeUndefined();
    }
    expect(Object.keys(ro).sort()).toEqual(['collection', 'listCollections']);
    expect(Object.isFrozen(coll)).toBe(true);
    expect(writes).toEqual([]);
  });

  it('refuses an aggregation that writes ($out / $merge), anywhere in the pipeline', () => {
    const { db, calls } = fakeDb({ x: [] });
    const coll = readOnlyDb(db as never).collection('x');
    expect(() => coll.aggregate([{ $match: {} }, { $out: 'y' }])).toThrow(/\$out/);
    expect(() => coll.aggregate([{ $merge: { into: 'y' } }])).toThrow(/\$merge/);
    expect(() => assertReadOnlyPipeline({} as never)).toThrow(/array/);
    expect(calls.filter((c) => c.op === 'aggregate')).toEqual([]);
    expect(() => coll.aggregate([{ $match: {} }, { $group: { _id: null } }])).not.toThrow();
  });

  it('the command monitor flags every non-read command and nothing else', () => {
    const client = new EventEmitter();
    const seen: string[] = [];
    attachWriteTripwire(client, (name) => seen.push(name));
    for (const name of ['find', 'getMore', 'aggregate', 'listIndexes', 'listCollections', 'killCursors', 'endSessions', 'hello', 'ping']) {
      client.emit('commandStarted', { commandName: name });
    }
    expect(seen).toEqual([]);
    for (const name of ['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'dropIndexes', 'drop', 'create', 'collMod', 'renameCollection']) {
      client.emit('commandStarted', { commandName: name });
    }
    expect(seen).toEqual(['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'dropIndexes', 'drop', 'create', 'collMod', 'renameCollection']);
    expect(READ_ONLY_COMMANDS.has('insert')).toBe(false);
  });
});

describe('redactUri', () => {
  it('drops credentials and options, keeps host and db', () => {
    expect(redactUri('mongodb+srv://user:s3cret@cluster0.abc.mongodb.net/copypools_positions?retryWrites=true&authSource=admin')).toBe(
      'mongodb+srv://cluster0.abc.mongodb.net/copypools_positions',
    );
    expect(redactUri('mongodb://127.0.0.1:27032/?directConnection=true')).toBe('mongodb://127.0.0.1:27032');
    expect(redactUri('not a uri')).not.toContain('not a uri');
  });
});

describe('parseArgs', () => {
  it('defaults: secondary reads, 1,000-row pages, bounded maxTimeMS, nothing optional on', () => {
    const f = parseArgs([]);
    expect(f).toMatchObject({ readPreference: 'secondary', pageSize: 1000, maxTimeMs: 60_000, probeDia: false, probeDexscreener: false, includeClosed: false, chains: [] });
    expect(f.docsPerSec).toBe(5000);
    expect(f.landingMinPoolTvlUsd).toBe(1000);
  });
  it('--docs-per-sec: at most the 5,000/s background-scan ceiling, never 0 / unlimited', () => {
    expect(parseArgs(['--docs-per-sec=2000']).docsPerSec).toBe(2000);
    expect(parseArgs(['--docs-per-sec=5000']).docsPerSec).toBe(5000);
    expect(() => parseArgs(['--docs-per-sec=5001'])).toThrow(/may not exceed 5000/);
    expect(() => parseArgs(['--docs-per-sec=0'])).toThrow(/> 0/);
    expect(parseArgs(['--landing-min-pool-tvl=0']).landingMinPoolTvlUsd).toBe(0);
  });
  it('rejects unknown, valueless and malformed flags', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/unrecognized/);
    expect(() => parseArgs(['--chain', '1'])).toThrow(/unrecognized/);
    expect(() => parseArgs(['--chain=eth'])).toThrow(/numeric/);
    expect(() => parseArgs(['--page-size=0'])).toThrow(/> 0/);
    expect(() => parseArgs(['--page-size=1.5'])).toThrow(/whole/);
    expect(() => parseArgs(['--read-preference=fastest'])).toThrow(/read-preference/);
    expect(() => parseArgs(['--deny=0x12'])).toThrow(/addresses/);
    expect(() => parseArgs(['--out='])).toThrow(/needs a value/);
  });
  it('parses lists', () => {
    const f = parseArgs(['--chain=1,4663', '--deny=0x' + 'A'.repeat(40) + ',4663:0x' + 'b'.repeat(40), '--probe-dia', '--include-closed']);
    expect(f.chains).toEqual([1, 4663]);
    expect(f.deny).toEqual(['0x' + 'a'.repeat(40), '4663:0x' + 'b'.repeat(40)]);
    expect(f.probeDia && f.includeClosed).toBe(true);
  });
});

describe('resolveThresholds', () => {
  it('reads the flags’ own env through the real trustPolicyOf, flags winning', () => {
    const env = {
      PRICE_QUOTE_MAX_AGE_MS: '3600000',
      PRICE_DIA_MIN_VOLUME_USD: '250',
      TOKEN_TRUST_DENY: '0x' + 'c'.repeat(40),
      TOKEN_TRUST_MIN_POOLS: '3',
      MIN_REAL_MARKET_BACKING_USD: '5000',
    } as NodeJS.ProcessEnv;
    const th = resolveThresholds(parseArgs(['--deny=1:0x' + 'd'.repeat(40)]), env);
    expect(th.quoteMaxAgeMs).toBe(3_600_000);
    expect(th.diaMinVolumeUsd).toBe(250);
    expect(th.earned.minPools).toBe(3);
    expect(th.earned.mode).toBe('earned');
    expect(th.allowlist.mode).toBe('allowlist');
    expect(th.combined.mode).toBe('combined');
    expect([...th.earned.deny].sort()).toEqual([`*:0x${'c'.repeat(40)}`, `1:0x${'d'.repeat(40)}`]);
    expect([...th.combined.deny].sort()).toEqual([...th.earned.deny].sort());
    expect(th.combined.minPools).toBe(3);
    expect(th.honeypotAnchorExempt).toBe(false);
    expect(th.minRealMarketBackingUsd).toBe(5000);
    expect(resolveThresholds(parseArgs(['--quote-max-age-ms=60000']), env).quoteMaxAgeMs).toBe(60_000);
    const defaults = resolveThresholds(parseArgs([]), {} as NodeJS.ProcessEnv);
    expect(defaults.quoteMaxAgeMs).toBe(24 * 3_600_000);
    expect(defaults.minRealMarketBackingUsd).toBe(1000);
  });
});

describe('small rules', () => {
  it('discoverShards pairs positions with their pools / tokens and filters', () => {
    const shards = discoverShards(['1_uniswap_v4_positions', '1_uniswap_v4_pools', '1_tokens', '4663_uniswap_v4_positions', 'sync_cursors', '1_uniswap_v4_position_transactions']);
    expect(shards.map((s: { chainId: number }) => s.chainId)).toEqual([1, 4663]);
    expect(shards[0]).toMatchObject({ protocol: 'uniswap-v4', pools: '1_uniswap_v4_pools', tokens: '1_tokens' });
    expect(shards[1]).toMatchObject({ pools: undefined, tokens: undefined });
    expect(discoverShards(['1_uniswap_v4_positions'], { chains: [4663] })).toEqual([]);
  });

  it('isPositionOpen = the adapter’s positionOpen (active, liquidity > 0, not closed)', () => {
    expect(isPositionOpen({ isActive: true, liquidity: '1' })).toBe(true);
    expect(isPositionOpen({ isActive: false, liquidity: '1' })).toBe(false);
    expect(isPositionOpen({ isActive: true, liquidity: '0' })).toBe(false);
    expect(isPositionOpen({ isActive: true, liquidity: 'x' })).toBe(false);
    expect(isPositionOpen({ isActive: true, liquidity: '1', closedAtTimestamp: 1700000000 })).toBe(false);
  });

  it('valuationBasis / projectValue re-value on the basis the stored value was built on', () => {
    expect(valuationBasis({ value: 0, a0: 1, a1: 1, p0: 1, p1: 1 })).toBe('zero');
    expect(valuationBasis({ value: 3, a0: 1, a1: 1, p0: 1, p1: 2 })).toBe('linear');
    expect(valuationBasis({ value: 100, a0: 100, a1: 5, p0: 1, p1: 1000 })).toBe('leg0');
    expect(valuationBasis({ value: 5000, a0: 100, a1: 5, p0: 1, p1: 1000 })).toBe('leg1');
    expect(valuationBasis({ value: 777, a0: 100, a1: 5, p0: 1, p1: 1000 })).toBe('unreconciled');
    expect(projectValue('leg0', { value: 100, a0: 100, a1: 5, p0: 1, p1: 1000, tm0: 50, tm1: 9 })).toBe(50);
    expect(projectValue('zero', { value: 0, a0: 1, a1: 1, p0: 1, p1: 1, tm0: 9, tm1: 9 })).toBe(0);
    expect(projectValue('unreconciled', { value: 777, a0: 100, a1: 5, p0: 1, p1: 1000, tm0: 50, tm1: 2.5 })).toBeCloseTo(388.5, 6);
  });

  it('savedQuoteVerdict: guard evidence, dated hot-path quotes, consensus, candidates', () => {
    const th = resolveThresholds(parseArgs([]), {} as NodeJS.ProcessEnv);
    expect(savedQuoteVerdict({ priceUsd: 0 }, th).status).toBe('n/a');
    expect(savedQuoteVerdict({ priceUsd: 0, pricePurgedAt: new Date(), pricePurgedReason: 'quote-guard' }, th)).toMatchObject({ status: 'purged' });
    const pricedAt = new Date(Date.UTC(2026, 9, 5));
    // Evidence written by the write that wrote the price (`priceEvidenceAt === pricedAt`).
    const cur = (o: Record<string, unknown>) => ({ pricedAt, priceEvidenceAt: pricedAt, ...o });
    expect(savedQuoteVerdict(cur({ priceUsd: 5, priceQuoteRejected: ['dia:thin'], priceGuardUsd: 0 }), th)).toMatchObject({ status: 'rejected', reason: 'dia:thin' });
    expect(savedQuoteVerdict(cur({ priceUsd: 5, priceQuoteRejected: ['dia:stale'], priceGuardUsd: 1 }), th)).toMatchObject({ status: 'repriced', guardUsd: 1 });
    expect(savedQuoteVerdict(cur({ priceUsd: 5, priceQuoteRejected: [], priceGuardUsd: 5.01 }), th)).toMatchObject({ status: 'ok' });
    // Sweep evidence decides alone: nothing rejected → ok even if the guard price differs (purge-script rule).
    expect(savedQuoteVerdict(cur({ priceUsd: 5, priceQuoteRejected: [], priceGuardUsd: 9 }), th)).toMatchObject({ status: 'ok', reason: 'guard-evidence' });
    // The pre-rename spelling is still read as a fallback.
    expect(savedQuoteVerdict(cur({ priceUsd: 5, priceGuardRejected: ['dia:thin'], priceGuardUsd: 0 }), th)).toMatchObject({ status: 'rejected', reason: 'dia:thin' });
    expect(savedQuoteVerdict(cur({ priceUsd: 5, priceQuoteSource: 'dia', priceQuotedAt: new Date(Date.UTC(2026, 4, 22)) }), th)).toMatchObject({ status: 'rejected', reason: 'dia:stale' });
    expect(savedQuoteVerdict(cur({ priceUsd: 5, priceQuoteSource: 'defillama', priceQuotedAt: new Date(pricedAt.getTime() - 60_000) }), th)).toMatchObject({ status: 'ok' });
    // A fresh DIA date says nothing about its (unstored) volume: still a candidate.
    expect(savedQuoteVerdict(cur({ priceUsd: 5, priceQuoteSource: 'dia', priceQuotedAt: new Date(pricedAt.getTime() - 60_000) }), th)).toMatchObject({ status: 'candidate', reason: 'dia-only' });
    // Evidence that describes an OLDER price (a later flag-off write moved pricedAt) is ignored → candidate rules.
    const older = new Date(pricedAt.getTime() - 3_600_000);
    expect(savedQuoteVerdict({ priceUsd: 5, pricedAt, priceEvidenceAt: older, priceQuoteRejected: ['dia:thin'], priceGuardUsd: 0, priceSources: ['dia'] }, th)).toMatchObject({ status: 'candidate', reason: 'dia-only' });
    expect(savedQuoteVerdict({ priceUsd: 5, pricedAt, priceQuoteSource: 'dia', priceQuotedAt: new Date(Date.UTC(2026, 4, 22)) }, th)).toMatchObject({ status: 'candidate', reason: 'dia-only' });
    expect(savedQuoteVerdict({ priceUsd: 5, priceConfidence: 'external-verified', priceSources: ['defillama', 'dexscreener'] }, th)).toMatchObject({ status: 'ok' });
    expect(savedQuoteVerdict({ priceUsd: 5, priceConfidence: 'external-verified', priceSources: ['defillama', 'subgraph-current'] }, th)).toMatchObject({ status: 'candidate', reason: 'single-source' });
    expect(savedQuoteVerdict({ priceUsd: 5, priceSources: [] }, th)).toMatchObject({ status: 'candidate', reason: 'no-sources' });
  });
});

describe('savedQuoteVerdict over the sweep’s REAL evidence shape (PricingService.guardEvidence)', () => {
  const th = resolveThresholds(parseArgs([]), {} as NodeJS.ProcessEnv);
  const NOW = Date.UTC(2026, 9, 5, 12);
  const DAY = 86_400_000;

  it('HPP: a single stale DIA quote the guard rejects → rejected (not a candidate)', () => {
    const ev = sweepEvidence([{ source: 'dia', priceUsd: 31374.53, quotedAtMs: NOW - 140 * DAY, rejected: true }], ['dia'], ['dia:stale']);
    expect(Object.keys(ev).sort()).toEqual(['priceGuardUsd', 'priceQuoteRejected', 'priceQuotedAt', 'priceSourcesDisagreed']);
    const row = { priceUsd: 31374.53, priceSources: ['dia'], priceConfidence: 'external-unverified', pricedAt: new Date(NOW), priceEvidenceAt: new Date(NOW), ...ev };
    expect(savedQuoteVerdict(row, th)).toMatchObject({ status: 'rejected', reason: 'dia:stale', guardUsd: 0 });
  });

  it('a thin DIA quote → rejected', () => {
    const ev = sweepEvidence([{ source: 'dia', priceUsd: 2.5, quotedAtMs: NOW - 60_000, rejected: true }], ['dia'], ['dia:thin']);
    expect(savedQuoteVerdict({ priceUsd: 2.5, priceSources: ['dia'], pricedAt: new Date(NOW), priceEvidenceAt: new Date(NOW), ...ev }, th)).toMatchObject({ status: 'rejected', reason: 'dia:thin' });
  });

  it('a saved price the accepted-only consensus would move → repriced (guardUsd carries the new price)', () => {
    const ev = sweepEvidence(
      [
        { source: 'dia', priceUsd: 10, quotedAtMs: NOW - 140 * DAY, rejected: true },
        { source: 'defillama', priceUsd: 4, quotedAtMs: NOW - 60_000, rejected: false },
      ],
      ['dia'],
      ['dia:stale'],
    );
    expect(ev.priceGuardUsd).toBe(4);
    expect(savedQuoteVerdict({ priceUsd: 10, priceSources: ['dia'], pricedAt: new Date(NOW), priceEvidenceAt: new Date(NOW), ...ev }, th)).toMatchObject({ status: 'repriced', guardUsd: 4 });
  });

  it('a sweep that rejected nothing → ok', () => {
    const ev = sweepEvidence(
      [
        { source: 'defillama', priceUsd: 4, quotedAtMs: NOW - 60_000, rejected: false },
        { source: 'dexscreener', priceUsd: 4.01, rejected: false },
      ],
      ['defillama', 'dexscreener'],
      undefined,
    );
    expect(ev.priceQuoteRejected).toEqual([]);
    expect(savedQuoteVerdict({ priceUsd: 4.005, priceSources: ['defillama', 'dexscreener'], pricedAt: new Date(NOW), priceEvidenceAt: new Date(NOW), ...ev }, th)).toMatchObject({ status: 'ok', reason: 'guard-evidence' });
  });
});

describe('DocPacer — the documents-per-second ceiling', () => {
  it('lets one second of documents through, then holds the run to the rate', async () => {
    let t = 0;
    const waits: number[] = [];
    const p = new DocPacer(1000, { now: () => t, wait: async (ms) => { waits.push(ms); t += ms; } });
    await p.charge(1000); // the burst
    expect(waits).toEqual([]);
    await p.charge(1000);
    expect(waits).toEqual([1000]);
    await p.charge(500);
    expect(waits).toEqual([1000, 500]);
    expect(p.docs).toBe(2500);
    expect(p.waitedMs).toBe(1500);
  });

  it('idle time is not banked beyond the one-second burst', async () => {
    let t = 0;
    const waits: number[] = [];
    const p = new DocPacer(100, { now: () => t, wait: async (ms) => { waits.push(ms); t += ms; } });
    await p.charge(100);
    t += 60_000; // a long idle stretch
    await p.charge(300); // three seconds' worth at once: the burst covers one
    expect(waits).toEqual([2000]);
  });

  it('a zero / empty page costs nothing', async () => {
    const waits: number[] = [];
    const p = new DocPacer(1, { now: () => 0, wait: async (ms) => { waits.push(ms); } });
    await p.charge(0);
    expect(waits).toEqual([]);
    expect(p.docs).toBe(0);
  });
});

describe('prepareOutDir', () => {
  it('writes a .gitignore of * so git never picks up the dump (owner wallets)', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'impact-out-'));
    const out = prepareOutDir(path.join(repo, 'valuation-impact-20261005T120000'));
    const ignore = readFileSync(path.join(out, '.gitignore'), 'utf8');
    expect(ignore.split('\n')).toContain('*');
    let git = true;
    try {
      execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    } catch {
      git = false;
    }
    if (git && existsSync(path.join(repo, '.git'))) {
      // `git check-ignore -q` exits 0 when the path is ignored (throws otherwise).
      expect(() => execFileSync('git', ['-C', repo, 'check-ignore', '-q', path.join(out, 'positions.csv')])).not.toThrow();
      expect(() => execFileSync('git', ['-C', repo, 'check-ignore', '-q', path.join(out, '.gitignore')])).not.toThrow();
    }
  });
});

describe('passesPoolTvlFloor (the dashboard minPoolTvl clause)', () => {
  it('hides a KNOWN TVL in (0, floor); 0 / negative pass; missing / null / NaN match neither branch', () => {
    expect(passesPoolTvlFloor(999.99, 1000)).toBe(false);
    expect(passesPoolTvlFloor(1, 1000)).toBe(false);
    expect(passesPoolTvlFloor(1000, 1000)).toBe(true);
    expect(passesPoolTvlFloor(0, 1000)).toBe(true);
    expect(passesPoolTvlFloor(-5, 1000)).toBe(true);
    expect(passesPoolTvlFloor(undefined, 1000)).toBe(false);
    expect(passesPoolTvlFloor(null, 1000)).toBe(false);
    expect(passesPoolTvlFloor(Number.NaN, 1000)).toBe(false);
    expect(passesPoolTvlFloor(500, 0)).toBe(true); // no floor, no clause
    expect(passesPoolTvlFloor(undefined, 0)).toBe(true);
  });
});

describe('allowlistCrossCheck — the evidence the pricing layer attaches per leg', () => {
  // Two allowlisted, non-anchor legs on Ethereum.
  const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
  const HPP = '0xe33fbe7584eb79e2673abe576b7ac8c0de62565c';
  const th = resolveThresholds(parseArgs([]), {} as NodeJS.ProcessEnv);
  const consensus = { priceConfidence: 'external-verified', priceSources: ['defillama', 'coingecko'] };
  const single = { priceConfidence: 'external-unverified', priceSources: ['dia'] };
  // Pool at tick 0 with equal decimals: ratio 1, so HPP at $86,000 vs cbBTC at $86,000 agrees,
  // and HPP at $860,000 sits 10x above the pool-implied price.
  const row = {
    isActive: true, liquidity: '1000',
    token0: { address: CBBTC, decimals: 8, priceUsd: 86_000 }, token1: { address: HPP, decimals: 8, priceUsd: 860_000 },
    amounts: { amount0: '1', amount1: '1' }, metrics: { underlyingValueUsd: 946_000 },
  };
  const state = { currentTick: 0, sqrtPriceX96: undefined };
  const tok = (t0: Record<string, unknown> | undefined, t1: Record<string, unknown> | undefined) =>
    new Map<string, Record<string, unknown>>([...(t0 ? [[CBBTC, t0] as const] : []), ...(t1 ? [[HPP, t1] as const] : [])]);

  it('legCorroboration mirrors findMarketState + pricePool: disagreed → false, consensus → true, single → false, nothing → undefined', () => {
    expect(legCorroboration(consensus)).toBe(true);
    expect(legCorroboration(single)).toBe(false);
    expect(legCorroboration({ ...consensus, priceSourcesDisagreed: true })).toBe(false);
    expect(legCorroboration({ priceConfidence: 'external-verified' })).toBeUndefined(); // no recorded sources = no sweep verdict
    expect(legCorroboration({ priceConfidence: 'missing', priceSources: ['dia'] })).toBeUndefined();
    expect(legCorroboration(undefined)).toBeUndefined();
  });

  it('as built: a SINGLE-SOURCE divergent verified leg is lowered to the pool price', () => {
    const out = allowlistCrossCheck(1, row, tok(consensus, single), state, undefined, th);
    expect(out?.changed).toBe(true);
    expect(out?.vp1).toBeCloseTo(86_000, 0);
    expect(out?.deltaUsd).toBeCloseTo(-774_000, 0);
    expect(out?.trust1).toBe('verified'); // single-source keeps the listing upgrade; the cross-check (not a demotion) runs
  });

  it('as built, either leg: a divergent single-source token0 is lowered too', () => {
    const swapped = { ...row, token0: { ...row.token0, priceUsd: 860_000 }, token1: { ...row.token1, priceUsd: 86_000 } };
    const out = allowlistCrossCheck(1, swapped, tok(single, consensus), state, undefined, th);
    expect(out?.changed).toBe(true);
    expect(out?.vp0).toBeCloseTo(86_000, 0);
  });

  it('as built: corroborated legs are left alone', () => {
    const out = allowlistCrossCheck(1, row, tok(consensus, consensus), state, undefined, th);
    expect(out?.changed).toBe(false);
    expect(out?.vp1).toBe(860_000);
  });

  it('as built: a leg with NO evidence (never swept) is left alone; all-swept counts it as single-source', () => {
    expect(allowlistCrossCheck(1, row, tok(consensus, undefined), state, undefined, th)?.changed).toBe(false);
    const upper = allowlistCrossCheck(1, row, tok(consensus, undefined), state, undefined, th, { corroboration: 'all-swept' });
    expect(upper?.changed).toBe(true);
    expect(upper?.vp1).toBeCloseTo(86_000, 0);
    // all-swept never touches a corroborated leg.
    expect(allowlistCrossCheck(1, row, tok(consensus, consensus), state, undefined, th, { corroboration: 'all-swept' })?.changed).toBe(false);
  });

  it('a leg whose sources DISAGREED stays unverified and is corrected by enforcePoolConsistency against the verified reference', () => {
    const out = allowlistCrossCheck(1, row, tok(consensus, { ...consensus, priceSourcesDisagreed: true }), state, undefined, th);
    expect(out?.trust1).toBe('unverified');
    expect(out?.changed).toBe(true);
    expect(out?.vp1).toBeCloseTo(86_000, 0);
  });
});

describe('fix 4 predictions and the exclusion pre-filter follow the trust fixes', () => {
  const th = resolveThresholds(parseArgs([]), {} as NodeJS.ProcessEnv);
  const NOW = Date.UTC(2026, 9, 5, 12);
  const X = '0x000000000000000000000000000000000000beef';

  it('a DEX-only consensus is ONE on-chain source: predicted single-source (a) when no verdict is stored', () => {
    const dexOnly = { address: X, priceUsd: 1, dexActive: true, priceConfidence: 'external-verified', priceSources: ['dexscreener', 'geckoterminal'] };
    expect(onlyDexSources(dexOnly)).toBe(true);
    expect(tokenTrust(1, X, dexOnly, th, NOW).predicted).toMatchObject({ trusted: false, reason: 'single-source' });
    const mixed = { ...dexOnly, priceSources: ['defillama', 'dexscreener'] };
    expect(onlyDexSources(mixed)).toBe(false);
    expect(tokenTrust(1, X, mixed, th, NOW).predicted).toBeNull(); // (c)/(d) need the sweep's own evidence
    expect(onlyDexSources({ priceSources: ['subgraph-current'] })).toBe(false); // pool-derived never counts
  });

  it('a price the guard / purge script cleared stays in the no-real-market scan (pricePurgedAt)', () => {
    const purged = { address: X, priceUsd: 0, priceSources: ['dia'], pricePurgedAt: new Date(NOW) };
    expect(isNoRealMarket(1, purged, th.allowlist, NOW)).toBe(true);
    expect(isNoRealMarket(1, { ...purged, pricePurgedAt: undefined }, th.allowlist, NOW)).toBe(false); // $0, never purged: not scanned
  });
});

describe('resolveThresholds reads every trust env the policy has', () => {
  it('TOKEN_TRUST_MIN_POOL_LIQUIDITY_USD / _DEEP_POOL_ / _MIN_OUTSIDE_ reach the earned policy', () => {
    const th = resolveThresholds(parseArgs([]), {
      TOKEN_TRUST_MIN_POOL_LIQUIDITY_USD: '25000',
      TOKEN_TRUST_DEEP_POOL_LIQUIDITY_USD: '0',
      TOKEN_TRUST_MIN_OUTSIDE_LIQUIDITY_USD: '75000',
    } as NodeJS.ProcessEnv);
    expect(th.earned.perPoolCounterUsd).toBe(25_000);
    expect(th.earned.deepPoolCounterUsd).toBe(0);
    expect(th.earned.minOutsideCounterUsd).toBe(75_000);
    const dflt = resolveThresholds(parseArgs([]), {} as NodeJS.ProcessEnv);
    expect(dflt.earned.perPoolCounterUsd).toBe(10_000);
  });
});
