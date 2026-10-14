/**
 * `--probe-dexscreener[=N]`: flag parsing, the request it sends to each of
 * DexScreener's batch endpoints, how an answer counts as coverage, the pacing
 * (≤ 1 request a second, a back-off after a 429), and the end-to-end summary.
 * No network: every fetch is a stub.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  readOnlyDb,
  resolveThresholds,
  runReport,
  DEXSCREENER_LATEST_URL,
  DEXSCREENER_PER_CHAIN_URL,
  KNOWN_FLAGS,
  dexProbeCoverage,
  dexProbeUrl,
  parseArgs,
  probeDexscreener,
  renderMarkdown,
} from '../../scripts/valuation-impact-report.mjs';
import { fakeDb } from './fake-db.js';
import { AERGO, BTCB, CBBTC, DIAONLY, ETH, HPP, NOW, SPAM, THALES, USDC, openRow, run, tok } from './fixtures.js';

const addr = (i: number) => `0x${(0xa000 + i).toString(16).padStart(40, '0')}`;
const pair = (base: string, chainId = 'ethereum', priceUsd = '1') => ({ chainId, pairAddress: `0x${'1'.repeat(40)}`, priceUsd, liquidity: { usd: 1e6 }, baseToken: { address: base }, quoteToken: { address: USDC } });

/** A fetch stub that answers per endpoint, recording every URL. */
function stubFetch(answer: (url: string) => { status?: number; body?: unknown; throws?: boolean }) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init?: { signal?: unknown; headers?: Record<string, string> }) => {
    urls.push(url);
    expect(init?.signal).toBeDefined(); // every request is bounded
    const a = answer(url);
    if (a.throws) throw new Error('socket hang up');
    const status = a.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => a.body };
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe('--probe-dexscreener flag', () => {
  it('off by default; bare = on with 60 tokens a chain; =N sets N', () => {
    expect(parseArgs([])).toMatchObject({ probeDexscreener: false, probeDexscreenerLimit: 60 });
    expect(parseArgs(['--probe-dexscreener'])).toMatchObject({ probeDexscreener: true, probeDexscreenerLimit: 60 });
    expect(parseArgs(['--probe-dexscreener=120'])).toMatchObject({ probeDexscreener: true, probeDexscreenerLimit: 120 });
    expect(parseArgs(['--probe-dexscreener=1'])).toMatchObject({ probeDexscreener: true, probeDexscreenerLimit: 1 });
    expect(KNOWN_FLAGS).toContain('--probe-dexscreener');
    expect(KNOWN_FLAGS).toContain('--probe-dexscreener=');
  });
  it('a malformed or oversized N is an error, never the default', () => {
    expect(() => parseArgs(['--probe-dexscreener='])).toThrow(/needs a value/);
    expect(() => parseArgs(['--probe-dexscreener=0'])).toThrow(/> 0/);
    expect(() => parseArgs(['--probe-dexscreener=1.5'])).toThrow(/whole/);
    expect(() => parseArgs(['--probe-dexscreener=sixty'])).toThrow(/number/);
    expect(() => parseArgs([`--probe-dexscreener=${DEFAULTS.maxDexProbeLimit + 1}`])).toThrow(/may not exceed/);
    expect(parseArgs([`--probe-dexscreener=${DEFAULTS.maxDexProbeLimit}`]).probeDexscreenerLimit).toBe(DEFAULTS.maxDexProbeLimit);
    expect(() => parseArgs(['--probe-dexscreener', '60'])).toThrow(/unrecognized/);
    expect(() => parseArgs(['--probe-dexscreen'])).toThrow(/unrecognized/);
  });
});

describe('dexProbeUrl / dexProbeCoverage', () => {
  it('the two batch endpoints, lowercased, comma-joined', () => {
    expect(dexProbeUrl('latest', 43114, ['0xABC', '0xdef'])).toBe(`${DEXSCREENER_LATEST_URL}/0xabc,0xdef`);
    expect(dexProbeUrl('per-chain', 43114, ['0xABC', '0xdef'])).toBe(`${DEXSCREENER_PER_CHAIN_URL}/avalanche/0xabc,0xdef`);
    expect(dexProbeUrl('per-chain', 4663, ['0x1'])).toBe('https://api.dexscreener.com/tokens/v1/robinhood/0x1');
  });
  it('covered = a priced pair on this chain with the token as BASE; a capped answer is flagged', () => {
    const a = addr(1);
    const b = addr(2);
    const c = addr(3);
    const body = { pairs: [pair(a.toUpperCase().replace('0X', '0x')), pair(b, 'base'), { ...pair(c), baseToken: { address: USDC }, quoteToken: { address: c } }, pair(USDC, 'ethereum', '0')] };
    const cov = dexProbeCoverage(body, 'latest', 1, [a, b, c]);
    expect(cov).toMatchObject({ ok: true, pairs: 4, capped: false });
    expect([...cov.covered]).toEqual([a]); // b is on another chain; c only as the QUOTE token
    const capped = dexProbeCoverage({ pairs: Array.from({ length: 30 }, () => pair(a)) }, 'latest', 1, [a, b]);
    expect(capped).toMatchObject({ ok: true, capped: true, pairs: 30 });
    expect(dexProbeCoverage([pair(a)], 'per-chain', 1, [a]).covered.has(a)).toBe(true);
    expect(dexProbeCoverage({ pairs: [pair(a)] }, 'per-chain', 1, [a]).ok).toBe(false);
    expect(dexProbeCoverage(null, 'latest', 1, [a]).ok).toBe(false);
    expect(dexProbeCoverage({ pairs: null }, 'latest', 1, [a])).toMatchObject({ ok: true, pairs: 0 });
  });
});

describe('probeDexscreener', () => {
  it('batches of 30, both endpoints, at least one second between two requests, nothing before the first', async () => {
    const addresses = Array.from({ length: 65 }, (_, i) => addr(i));
    const waits: number[] = [];
    const { fetchImpl, urls } = stubFetch((url) => {
      const asked = url.split('/').pop()!.split(',');
      // latest: capped, only the first token; per-chain: every token (one pair each).
      if (url.startsWith(DEXSCREENER_LATEST_URL)) return { body: { pairs: Array.from({ length: 30 }, () => pair(asked[0]!)) } };
      return { body: asked.map((a) => pair(a)) };
    });
    const out = await probeDexscreener([{ chainId: 1, swept: 200, addresses }], { fetchImpl, wait: async (ms: number) => void waits.push(ms) });
    expect(urls).toHaveLength(6); // 3 batches (30 + 30 + 5) × 2 endpoints
    expect(urls.filter((u) => u.startsWith(`${DEXSCREENER_PER_CHAIN_URL}/ethereum/`))).toHaveLength(3);
    expect(urls.map((u) => u.split('/').pop()!.split(',').length)).toEqual([30, 30, 30, 30, 5, 5]);
    expect(waits).toEqual([1000, 1000, 1000, 1000, 1000]);
    const c = out.chains[0];
    expect(c).toMatchObject({ chainId: 1, dexChain: 'ethereum', swept: 200, asked: 65, batches: 3, both: 3, onlyLatest: 0, onlyPerChain: 62, neither: 0 });
    expect(c.latest).toMatchObject({ requests: 3, answered: 65, covered: 3, cappedAnswers: 3, errors: 0 });
    expect(c.perChain).toMatchObject({ requests: 3, answered: 65, covered: 65, cappedAnswers: 2, errors: 0 });
    expect(out).toMatchObject({ requests: 6, errors: 0, rateLimited: 0 });
  });

  it('a 429 is counted and backs off; a failure is counted; neither is retried, and their tokens are not "answered"', async () => {
    const addresses = Array.from({ length: 3 }, (_, i) => addr(i));
    const waits: number[] = [];
    let n = 0;
    const { fetchImpl, urls } = stubFetch(() => {
      n++;
      if (n === 1) return { status: 429 };
      if (n === 2) return { throws: true };
      return { body: [] };
    });
    const out = await probeDexscreener(
      [{ chainId: 43114, addresses }, { chainId: 1, addresses }],
      { fetchImpl, wait: async (ms: number) => void waits.push(ms), intervalMs: 1000, backoffMs: 10_000 },
    );
    expect(urls).toHaveLength(4);
    expect(waits).toEqual([10_000, 1000, 1000]); // the request after the 429 waited out the back-off
    expect(out.chains[0].latest).toMatchObject({ rateLimited: 1, answered: 0 });
    expect(out.chains[0].perChain).toMatchObject({ errors: 1, answered: 0 });
    expect(out.chains[1].latest.answered).toBe(3);
    expect(out).toMatchObject({ requests: 4, rateLimited: 1, errors: 1 });
  });

  it('a batch one endpoint did not answer (429 / failure) is never a coverage difference: compared only where both answered', async () => {
    const addresses = Array.from({ length: 60 }, (_, i) => addr(i));
    // Both endpoints cover every token identically; /latest's FIRST batch is rate-limited, per-chain's second one throws.
    let latest = 0;
    let perChain = 0;
    const { fetchImpl } = stubFetch((url) => {
      const asked = url.split('/').pop()!.split(',');
      if (url.startsWith(DEXSCREENER_LATEST_URL)) return ++latest === 1 ? { status: 429 } : { body: { pairs: asked.map((a) => pair(a)) } };
      return ++perChain === 2 ? { throws: true } : { body: asked.map((a) => pair(a)) };
    });
    const out = await probeDexscreener([{ chainId: 1, addresses }], { fetchImpl, wait: async () => {} });
    const c = out.chains[0];
    expect(c).toMatchObject({ both: 0, onlyLatest: 0, onlyPerChain: 0, neither: 0, unansweredByOne: 60 });
    expect(c.latest.answered).toBe(30);
    expect(c.perChain.answered).toBe(30);
    // Without the failures the same answers split as identical coverage.
    const clean = stubFetch((url) => {
      const asked = url.split('/').pop()!.split(',');
      return url.startsWith(DEXSCREENER_LATEST_URL) ? { body: { pairs: asked.map((a) => pair(a)) } } : { body: asked.map((a) => pair(a)) };
    });
    expect((await probeDexscreener([{ chainId: 1, addresses }], { fetchImpl: clean.fetchImpl, wait: async () => {} })).chains[0]).toMatchObject({ both: 60, onlyLatest: 0, onlyPerChain: 0, neither: 0, unansweredByOne: 0 });
  });
});

describe('--probe-dexscreener, end to end (stubbed fetch)', () => {
  it('asks about the chain’s swept tokens — open positions’ legs, highest exposure first, native skipped — and reports both endpoints', async () => {
    const waits: number[] = [];
    const { fetchImpl, urls } = stubFetch((url) => {
      const asked = url.split('/').pop()!.split(',');
      if (url.startsWith(DEXSCREENER_LATEST_URL)) return { body: { pairs: [pair(HPP), pair(USDC)] } };
      return { body: asked.filter((a) => a !== SPAM).map((a) => pair(a)) };
    });
    const { summary } = await run(['--pace-ms=0', '--probe-dexscreener=4'], { fetchImpl, probeWait: async (ms) => void waits.push(ms) });
    expect(urls).toHaveLength(2);
    const asked = urls[0]!.split('/').pop()!.split(',');
    // Held non-anchor legs by open exposure: HPP ($148.76M) > THALES ($119.75M) > BTC.b ($4.64M) > cbBTC ($3.97M); the zero address is never asked.
    expect(asked).toEqual([HPP, THALES, BTCB, CBBTC]);
    expect(urls[1]).toBe(`${DEXSCREENER_PER_CHAIN_URL}/ethereum/${asked.join(',')}`);
    expect(waits).toEqual([1000]);
    const c = summary.dexProbe.chains[0];
    expect(c).toMatchObject({ chainId: 1, asked: 4, swept: 8, both: 1, onlyPerChain: 3 });
    expect(c.latest.covered).toBe(1);
    expect(c.perChain.covered).toBe(4);
    expect(summary.flags).toMatchObject({ probeDexscreener: true, probeDexscreenerLimit: 4 });
    const md = renderMarkdown(summary);
    expect(md).toContain('## DexScreener batch endpoints (`--probe-dexscreener`, live)');
    expect(md).toContain('| 1 (ethereum) | 4 (8) | 1 of 4 answered | 0 of 1 | 4 of 4 answered | 0 of 1 | 1 / 0 / 3 / 0 |');
  });

  it('off by default: no request, no section', async () => {
    const { fetchImpl, urls } = stubFetch(() => ({ body: [] }));
    const { summary } = await run(['--pace-ms=0'], { fetchImpl });
    expect(urls).toEqual([]);
    expect(summary.dexProbe).toBeNull();
    expect(renderMarkdown(summary)).not.toContain('DexScreener batch endpoints');
  });

  it('`--probe-dexscreener` without N asks up to 60 tokens a chain, never the native pseudo-address', async () => {
    const { fetchImpl, urls } = stubFetch(() => ({ body: [] }));
    // An open ETH/USDC row: the sweep asks about the native pseudo-address too, the probe does not.
    const ethRow = openRow('900030', { poolId: '0x' + 'e'.repeat(64), token0: tok(ETH, 'ETH', 18, 2700), token1: tok(USDC, 'USDC', 6, 1), amounts: { amount0: '1', amount1: '0' }, metrics: { underlyingValueUsd: 2700, inRange: true } });
    const { summary } = await run(['--pace-ms=0', '--probe-dexscreener'], { fetchImpl, extraPositions: [ethRow] });
    expect(summary.flags.probeDexscreenerLimit).toBe(60);
    // The fixture chain's open legs: AERGO, HPP, BTC.b, cbBTC, THALES, DIAX, USDC, SCAM — and ETH, skipped.
    const asked = urls[0]!.split('/').pop()!.split(',');
    expect(asked.sort()).toEqual([AERGO, HPP, BTCB, CBBTC, THALES, DIAONLY, USDC, SPAM].sort());
    expect(summary.dexProbe.chains[0].swept).toBe(8);
  });

  it('a chain DexScreener does not list gets no request (and no row in the probe)', async () => {
    const { fetchImpl, urls } = stubFetch(() => ({ body: [] }));
    const fake = fakeDb({
      '999_uniswap_v4_positions': [{ ...openRow('1', { token0: tok(addr(1), 'A', 18, 1), token1: tok(addr(2), 'B', 18, 1) }), chainId: 999 }],
    });
    const flags = parseArgs(['--pace-ms=0', '--probe-dexscreener']);
    const summary = await runReport({ db: readOnlyDb(fake.db as never), flags, thresholds: resolveThresholds(flags, {} as NodeJS.ProcessEnv), now: NOW, fetchImpl, pacerNow: () => 0, pacerWait: async () => {}, probeWait: async () => {} });
    expect(summary.chains.map((c: { chainId: number }) => c.chainId)).toEqual([999]);
    expect(urls).toEqual([]);
    expect(summary.dexProbe).toMatchObject({ requests: 0, chains: [] });
  });
});
