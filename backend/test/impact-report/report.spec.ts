/**
 * End to end over a driver-shaped in-memory database seeded with the cases
 * from docs/spam-and-pool-mismatch-2026-10-05.md: AERGO/HPP in a 99.99%-fee
 * pool on a stale single DIA quote, BTC.b/cbBTC (a real pool the allowlist
 * hides), a THALES-class allowlisted token with no DEX market, a frozen
 * indexer amount. Proves what the report counts, that it pages, that it only
 * ever reads, and what it writes to disk.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, tickMathAmounts } from '../../scripts/valuation-impact-report.mjs';
import { getSqrtRatioAtTick } from '../../src/pricing/tick-math.js';
import { BTCB, CBBTC, DIAONLY, ETH, HPP, LISTED_NOMKT, POOL_BTC, POOL_ETH, POOL_LISTED, POOL_THALES, THALES, USDC, btcTick, openRow, run, tok } from './fixtures.js';

describe('valuation impact report — end to end', () => {
  it('fix 2: counts the honeypot-fee rows (open; closed only with --include-closed)', async () => {
    const { summary } = await run(['--page-size=2', '--pace-ms=0']);
    const c = summary.chains[0];
    expect(c.feeExcluded.rows).toBe(1);
    expect(c.feeExcluded.landingRows).toBe(1);
    expect(c.feeExcluded.valueUsd).toBeCloseTo(148_756_081.58, 0);
    expect(c.feeExcluded.closedRows).toBe(0);
    expect(summary.top.feeExcluded[0]).toMatchObject({ positionId: '366810', fee: 999_993 });
    const closed = await run(['--page-size=2', '--pace-ms=0', '--include-closed']);
    expect(closed.summary.chains[0].feeExcluded.closedRows).toBe(1);
    // The closed walk reads closed rows ONLY: `isActive: false` equality on the
    // {chainId, protocol, isActive, tokenId} index, keyset on tokenId.
    const closedFinds = closed.fake.calls.filter((c) => c.collection === '1_uniswap_v4_positions' && c.op === 'find' && c.filter?.isActive === false);
    expect(closedFinds.length).toBeGreaterThan(0);
    for (const call of closedFinds) {
      expect(call.opts).toMatchObject({ hint: 'chainId_1_protocol_1_isActive_-1_tokenId_1', sort: { tokenId: 1 } });
    }
    expect(closed.summary.chains[0].indexes.closed).toBe('chainId_1_protocol_1_isActive_-1_tokenId_1');
  });

  it('paces every read against a documents-per-second ceiling (charged with the documents fetched)', async () => {
    let t = 0;
    const waits: number[] = [];
    const { summary } = await run(['--page-size=2', '--pace-ms=0', '--docs-per-sec=1', '--include-closed'], {
      pacerNow: () => t,
      pacerWait: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    // tokens 10 + open positions 5 + pool rows fetched per page 4 (POOL_DIA has no row) + closed 2 + pools walk 5 = 26.
    expect(summary.reads.docs).toBe(26);
    // At 1 doc/s with a one-second burst, the run has to wait (26 − 1) s in all.
    expect(waits.reduce((a, b) => a + b, 0)).toBeCloseTo(25_000, 6);
    expect(summary.reads.pacedMs).toBe(25_000);
    expect(summary.flags.docsPerSec).toBe(1);
  });

  it('walks every open row across keyset pages (page size 2) and only the open ones', async () => {
    const { summary, fake } = await run(['--page-size=2', '--pace-ms=0']);
    expect(summary.chains[0].open.rows).toBe(5);
    const posFinds = fake.calls.filter((c) => c.collection === '1_uniswap_v4_positions' && c.op === 'find');
    expect(posFinds.length).toBe(3); // 2 + 2 + 1
    for (const call of posFinds) {
      expect(call.filter).toMatchObject({ chainId: 1, protocol: 'uniswap-v4', isActive: true });
      expect(call.opts).toMatchObject({ hint: 'bg_active_walk', sort: { positionId: 1 }, limit: 2, readPreference: 'secondary' });
      expect(typeof call.opts?.maxTimeMS).toBe('number');
    }
    expect(posFinds[0]!.filter?.positionId).toBeUndefined();
    expect(posFinds[1]!.filter?.positionId).toEqual({ $gt: '366810' }); // '108486' < '366810' < '371154' …
    // Pools come in one $in per page, never one read per position.
    const poolIn = fake.calls.filter((c) => c.collection === '1_uniswap_v4_pools' && c.op === 'find' && (c.filter?.poolId as Record<string, unknown>)?.$in);
    expect(poolIn.length).toBeLessThanOrEqual(3);
  });

  it('is read-only: only find / listIndexes / listCollections reach the database', async () => {
    const { fake } = await run(['--page-size=2', '--pace-ms=0', '--include-closed']);
    expect(fake.writes).toEqual([]);
    expect(new Set(fake.calls.map((c) => c.op))).toEqual(new Set(['listCollections', 'listIndexes', 'find']));
  });

  it('fix 3: recomputes amounts from the POOL ROW price with the real tick math', async () => {
    const { summary } = await run(['--pace-ms=0']);
    const t = summary.chains[0].tickMath;
    expect(t.priceSource.pool).toBe(2); // HPP, BTC (ETH / THALES pool rows carry no price)
    expect(t.priceSource.position).toBe(2); // SCAM row (pool row unpriced) and POOL_DIA (no pool row)
    expect(t.priceSource.tick).toBe(1); // THALES: neither stores a sqrtPrice
    expect(t.rowsKept).toBe(1); // zero liquidity keeps the indexer's amounts
    const want = tickMathAmounts({ liquidity: '200000000000', tickLower: -200, tickUpper: 200, sqrtPriceX96: getSqrtRatioAtTick(btcTick).toString(), currentTick: btcTick, decimals0: 8, decimals1: 8 })!;
    const btc = summary.top.tickMath.find((r: { positionId: string }) => r.positionId === '371154');
    expect(btc).toBeDefined();
    expect(btc.valueAfterUsd).toBeCloseTo(want.amount0 * 86000 + want.amount1 * 86300, 4);
    expect(t.priceSourceDisagree).toBe(1); // the BTC row's own snapshot is at tick 0, the pool at -35
  });

  it('fix 1: a saved price the guarded sweep would not keep is REJECTED and its exposure counted', async () => {
    const { summary } = await run(['--pace-ms=0']);
    const q = summary.chains[0].quotes;
    expect(q.rejected).toBe(1);
    expect(q.rejectedExposureUsd).toBeCloseTo(4741.299632609254 * 31374.53717473271, 0);
    const row = summary.top.quoteExposure.find((r: { address: string }) => r.address === HPP);
    expect(row).toMatchObject({ status: 'rejected', reason: 'dia:stale' });
    // DIA-only saved price with no evidence: a candidate until probed.
    expect(summary.top.quoteExposure.find((r: { address: string }) => r.address === DIAONLY)).toMatchObject({ status: 'candidate', reason: 'dia-only' });
  });

  it('--probe-dia turns a candidate into a definite verdict from DIA’s own timestamp and volume', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return { ok: true, json: async () => ({ Price: 2.5, Time: '2026-05-22T10:14:00Z', VolumeYesterdayUSD: 0.098 }) };
    }) as unknown as typeof fetch;
    const { summary } = await run(['--pace-ms=0', '--probe-dia'], { fetchImpl });
    expect(asked).toEqual([`https://api.diadata.org/v1/assetQuotation/Ethereum/${DIAONLY}`]);
    expect(summary.probe).toMatchObject({ asked: 1, rejected: 1, errors: 0 });
    expect(summary.top.quoteExposure.find((r: { address: string }) => r.address === DIAONLY)).toMatchObject({ status: 'rejected', reason: 'dia-probe:stale' });
  });

  it('fix 4: BTC.b/cbBTC appears on the Pools page; THALES/USDC disappears; THALES rows leave the ranked lists', async () => {
    const { summary } = await run(['--pace-ms=0']);
    const tr = summary.chains[0].trust;
    expect(tr.poolsAppear).toBe(1);
    expect(summary.top.poolsAppear[0]).toMatchObject({ poolId: POOL_BTC, change: 'appear' });
    expect(summary.top.poolsAppear[0].tvlAfterUsd).toBeCloseTo(50 * 86000 + 50 * 86300, 0);
    expect(tr.poolsDisappear).toBe(2);
    const gone = Object.fromEntries(summary.top.poolsDisappear.map((r: { poolId: string; reason: string }) => [r.poolId, r.reason]));
    expect(gone).toEqual({
      // No open position holds LST, so no price / trust sweep ever evaluates it: never earns trust.
      [POOL_LISTED]: 'token0-no-evidence (never swept)',
      [POOL_THALES]: 'token0-no-dex-market (predicted)',
    });
    expect(tr.poolsUndetermined).toBe(0);
    expect(tr.poolsLoseNeverSwept).toBe(1);
    expect(tr.poolsDisappearNeverSwept).toBe(1);
    expect(tr.poolsDisappearNeverSweptTvlUsd).toBe(2_000_000);
    expect(tr.tokensGain).toBe(1); // BTC.b
    expect(summary.top.trustGain.map((r: { address: string }) => r.address)).toEqual([BTCB]);
    expect(summary.top.trustLose.map((r: { address: string }) => r.address).sort()).toEqual([HPP, THALES].sort());
    expect(tr.positionsNewlyExcluded).toBe(2); // 108486 (THALES) and 366810 (HPP: single DIA source, no DEX source)
    expect(summary.top.newlyExcluded.map((r: { positionId: string }) => r.positionId).sort()).toEqual(['108486', '366810']);
  });

  it('fix 4: a pool leg an open position DOES hold, with no verdict yet, stays undetermined (a sweep will decide it)', async () => {
    const holder = openRow('900003', {
      poolId: POOL_LISTED, token0: tok(LISTED_NOMKT, 'LST', 18, 3), token1: tok(USDC, 'USDC', 6, 1),
      amounts: { amount0: '1', amount1: '0' }, metrics: { underlyingValueUsd: 3, inRange: false },
    });
    const { summary } = await run(['--pace-ms=0'], { extraPositions: [holder] });
    const tr = summary.chains[0].trust;
    expect(tr.poolsUndetermined).toBe(1);
    expect(tr.poolsLoseNeverSwept).toBe(0);
    const gone = Object.fromEntries(summary.top.poolsDisappear.map((r: { poolId: string; reason: string }) => [r.poolId, r.reason]));
    expect(gone[POOL_LISTED]).toBe('token0-excluded'); // held: still leaves, but through the no-real-market exclusion
  });

  it('the landing view honours the dashboard’s pool-TVL floor (known TVL in (0, 1000) hidden; 0 = unknown passes)', async () => {
    const thin = openRow('900004', {
      poolId: POOL_ETH, poolStats: { tvlUsd: 500 }, token0: tok(ETH, 'ETH', 18, 2700), token1: tok(USDC, 'USDC', 6, 1),
      amounts: { amount0: '1', amount1: '0' }, metrics: { underlyingValueUsd: 2700, inRange: true },
    });
    const deep = openRow('900005', { ...thin, positionId: '900005', tokenId: '900005', poolStats: { tvlUsd: 1000 } });
    const { summary } = await run(['--pace-ms=0'], { extraPositions: [thin, deep] });
    const ids = (rows: Array<{ positionId: string }>) => rows.map((r) => r.positionId);
    expect(ids(summary.top.landingToday)).not.toContain('900004');
    expect(ids(summary.top.landingToday)).toContain('900005');
    expect(ids(summary.top.landingAfter)).not.toContain('900004');
    expect(summary.chains[0].open.landingRows).toBe(5); // the 4 below + 900005
    const off = await run(['--pace-ms=0', '--landing-min-pool-tvl=0'], { extraPositions: [thin, deep] });
    expect(ids(off.summary.top.landingToday)).toContain('900004');
    expect(renderMarkdown(summary)).toContain('pool TVL ≥ $1.0k or unknown');
  });

  it('the landing view: today vs after fixes 2 + 3 + 4', async () => {
    const { summary } = await run(['--pace-ms=0']);
    const c = summary.chains[0];
    // Today: 366810, 371154, 108486, 900001 (SCAM is spam-excluded).
    expect(c.open.landingRows).toBe(4);
    // After: 366810 (fee), 108486 (THALES excluded) leave.
    expect(c.after.landingRows).toBe(2);
    expect(summary.landingTop.leaving).toBe(2);
  });

  it('writes summary-ready CSVs with one row per change', async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'impact-report-'));
    const { summary } = await run(['--pace-ms=0'], { outDir });
    expect(readdirSync(outDir).sort()).toEqual(['pools.csv', 'positions.csv', 'tokens.csv']);
    const positionsCsv = readFileSync(path.join(outDir, 'positions.csv'), 'utf8').trim().split('\n');
    expect(positionsCsv[0]).toMatch(/^chainId,protocol,positionId,owner,poolId,pair,fee,/);
    const hpp = positionsCsv.find((l) => l.includes(',366810,'));
    expect(hpp).toContain(',true,'); // feeExcluded
    const poolsCsv = readFileSync(path.join(outDir, 'pools.csv'), 'utf8');
    expect(poolsCsv).toContain(`${POOL_BTC},BTC.b/cbBTC,100,appear`);
    const tokensCsv = readFileSync(path.join(outDir, 'tokens.csv'), 'utf8');
    expect(tokensCsv).toMatch(new RegExp(`${HPP},HPP,.*,rejected,dia:stale`));
    expect(summary.csvRows.pools).toBeGreaterThanOrEqual(2);
    const md = renderMarkdown(summary);
    for (const heading of ['## Landing view', '## Fix 2', '## Fix 3', '## Fix 1', '## Fix 4', '## Run']) expect(md).toContain(heading);
    expect(md).toContain('366810');
  });

  it('honours --chain (no shard read for other chains)', async () => {
    const { summary, fake } = await run(['--pace-ms=0', '--chain=4663']);
    expect(summary.chains).toEqual([]);
    expect(fake.calls.filter((c) => c.op === 'find')).toEqual([]);
  });
});
