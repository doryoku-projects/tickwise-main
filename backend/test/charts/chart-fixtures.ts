/*
 * Deterministic chart fixtures (seeded PRNG — no wall clock, no randomness
 * between runs).
 *
 *  - POOL      USDC/WETH, day data from 420 days ago up to TODAY, with gaps.
 *  - LAG_POOL  ETH(native)/USDC, day data that STOPS 150 days ago — an indexer
 *              months behind head, the case that rendered 30d charts empty.
 *  - Positions:
 *      A '1001'  active, 300 days old: deposits, collects, a partial withdraw
 *      B '1002'  active, 10 days old (younger than every range but 30d)
 *      C '1003'  busy: 2,346 transactions, timestamps in runs of 4, so the
 *                1000-row page boundary falls INSIDE a run of equal timestamps
 *      D '1004'  on LAG_POOL; token0 is the native token with no token day data
 *      E '1005'  closed (fully withdrawn)
 *      F '1006'  created on a day POOL has no row
 */
import type { FakeData, FakePool, FakePoolDay, FakeTick, FakeTokenDay, FakeTx } from './fake-subgraph.js';

export const NOW_MS = Date.UTC(2026, 9, 1, 12, 0, 0); // mid-day, so `now − N days` is not a day boundary
export const NOW = NOW_MS / 1000;
export const DAY = 86_400;
export const TODAY = Math.floor(NOW / DAY) * DAY;
export const CHAIN = 1;
export const PROTO = 'uniswap-v4';

export const POOL = `0x${'a1'.repeat(32)}`;
export const LAG_POOL = `0x${'b2'.repeat(32)}`;
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const NATIVE = '0x0000000000000000000000000000000000000000';
const OWNER = '0x1111111111111111111111111111111111111111';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poolDays(pool: string, fromDay: number, toDay: number, baseTick: number, dec0: number, dec1: number, seed: number): FakePoolDay[] {
  const r = rng(seed);
  const rows: FakePoolDay[] = [];
  let tick = baseTick;
  for (let day = fromDay, i = 0; day <= toDay; day += DAY, i++) {
    tick += Math.round((r() - 0.5) * 600);
    if (i % 9 === 4) continue; // a quiet day: no row
    const price0 = Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
    const price1 = 1 / price0;
    const volume = 200_000 + r() * 2_000_000;
    rows.push({
      pool,
      date: day,
      tick: i % 37 === 5 ? null : String(tick),
      token0Price: String(price0),
      token1Price: String(price1),
      open: String(price1 * (1 + (r() - 0.5) * 0.02)),
      high: String(price1 * (1 + r() * 0.03)),
      low: String(price1 * (1 - r() * 0.03)),
      close: String(price1),
      tvlUSD: i % 50 === 7 ? '0' : String(3_000_000 + r() * 4_000_000),
      volumeUSD: String(volume),
      feesUSD: String(volume * 0.0005),
    });
  }
  return rows;
}

function tokenDays(token: string, fromDay: number, toDay: number, price: (i: number) => number, skipEvery: number): FakeTokenDay[] {
  const rows: FakeTokenDay[] = [];
  for (let day = fromDay, i = 0; day <= toDay; day += DAY, i++) {
    if (i % skipEvery === 3) continue;
    rows.push({ token, date: day, priceUSD: i % 61 === 10 ? '0' : String(price(i)) });
  }
  return rows;
}

function ticks(pool: string, center: number, spacing: number, seed: number): FakeTick[] {
  const r = rng(seed);
  const out: FakeTick[] = [];
  for (let k = -20; k < 20; k++) {
    const net = BigInt(Math.round((r() - 0.3) * 1e15));
    out.push({
      pool,
      tickIdx: String(center + k * spacing),
      liquidityGross: String(net < 0n ? -net : net + 1n),
      liquidityNet: String(net),
      price0: '0',
      price1: '0',
    });
  }
  return out;
}

let txSeq = 0;
function tx(tokenId: string, type: string, timestamp: number, amount0: number, amount1: number, sharedHash?: string): FakeTx {
  txSeq++;
  return {
    chainId: String(CHAIN),
    txHash: sharedHash ?? `0x${txSeq.toString(16).padStart(64, '0')}`,
    logIndex: String(txSeq % 7),
    type,
    tokenId,
    amount0: String(amount0),
    amount1: String(amount1),
    gasCostETH: String(0.0004 + (txSeq % 5) * 0.0001),
    timestamp: String(timestamp),
    blockNumber: String(20_000_000 + txSeq),
    sender: OWNER,
  };
}

/** A stored position document: CHARTS_PROJECTION fields plus what detail sanitizes. */
export interface StoredPosition {
  chainId: number;
  protocol: string;
  positionId: string;
  tokenId: string;
  owner: string;
  poolId: string;
  isActive: boolean;
  liquidity: string;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
  createdAtTimestamp: number;
  token0: { address: string; symbol: string; decimals: number; priceUsd: number };
  token1: { address: string; symbol: string; decimals: number; priceUsd: number };
  amounts: Record<string, string>;
  metrics: Record<string, unknown>;
  poolStats: Record<string, number>;
  pricing: Record<string, unknown>;
}

function position(over: Partial<StoredPosition> & Pick<StoredPosition, 'positionId' | 'poolId' | 'createdAtTimestamp'>): StoredPosition {
  const onLag = over.poolId === LAG_POOL;
  return {
    chainId: CHAIN,
    protocol: PROTO,
    tokenId: over.positionId,
    owner: OWNER,
    isActive: true,
    liquidity: '123456789012345',
    currentTick: onLag ? -198_100 : 198_050,
    tickLower: onLag ? -198_600 : 197_400,
    tickUpper: onLag ? -197_400 : 198_600,
    tickSpacing: 60,
    token0: onLag
      ? { address: NATIVE, symbol: 'ETH', decimals: 18, priceUsd: 2_480 }
      : { address: USDC, symbol: 'USDC', decimals: 6, priceUsd: 1 },
    token1: onLag
      ? { address: USDC, symbol: 'USDC', decimals: 6, priceUsd: 1 }
      : { address: WETH, symbol: 'WETH', decimals: 18, priceUsd: 2_480 },
    amounts: {
      amount0: onLag ? '1.4' : '3100',
      amount1: onLag ? '3400' : '1.25',
      depositedToken0: '5000',
      depositedToken1: '2',
      withdrawnToken0: '0',
      withdrawnToken1: '0',
      totalFeesCollected0: '120',
      totalFeesCollected1: '0.05',
      totalGasCostEth: '0.004',
    },
    metrics: {
      totalGasCostUsd: 9.92,
      pendingFeesUsd: 14.5,
      underlyingValueUsd: 6_200,
      isPriceable: true,
    },
    poolStats: { tvlUsd: 5_000_000, tvlUsdUntracked: 5_000_000, volumeUsd: 1_000_000, totalFeesUsd: 10_000 },
    pricing: { source: 'anchor' },
    ...over,
  };
}

export interface ChartFixture {
  data: FakeData;
  positions: Record<string, StoredPosition>;
}

export function buildFixture(): ChartFixture {
  txSeq = 0;
  const poolRows = poolDays(POOL, TODAY - 420 * DAY, TODAY, 198_000, 6, 18, 7);
  const lagRows = poolDays(LAG_POOL, TODAY - 500 * DAY, TODAY - 150 * DAY, -198_000, 18, 6, 11);

  const usdcR = rng(3);
  const wethR = rng(5);
  const tokenDayDatas = [
    ...tokenDays(USDC, TODAY - 520 * DAY, TODAY, () => 1 + (usdcR() - 0.5) * 0.002, 11),
    ...tokenDays(WETH, TODAY - 420 * DAY, TODAY, (i) => 2_000 + i * 1.3 + wethR() * 40, 13),
  ];

  const pools: Record<string, FakePool> = {
    [POOL]: { tick: '198050', sqrtPrice: '1', tickSpacing: '60', token0: { decimals: '6' }, token1: { decimals: '18' } },
    [LAG_POOL]: { tick: '-198100', sqrtPrice: '1', tickSpacing: '60', token0: { decimals: '18' }, token1: { decimals: '6' } },
  };

  const createdA = TODAY - 300 * DAY + 5 * 3600;
  const createdB = TODAY - 10 * DAY + 7 * 3600;
  const createdC = TODAY - 200 * DAY + 3600;
  const createdD = TODAY - 300 * DAY + 2 * 3600;
  const createdE = TODAY - 250 * DAY + 3600;
  // On a day POOL has NO row (day index 121 from its first day: 121 % 9 === 4),
  // with rows the day before and after — so a nearest-tick lookup that could see
  // pre-creation rows would pick a different tick than the `all` view always did.
  const createdF = TODAY - 299 * DAY + 3600;

  const txs: FakeTx[] = [];
  // A: deposit, collects every ~20 days, an increase, a partial withdraw.
  txs.push(tx('1001', 'DEPOSIT', createdA, 5000, 2));
  for (let d = 20; d < 300; d += 20) txs.push(tx('1001', 'COLLECT', createdA + d * DAY, 8 + d / 10, 0.003));
  txs.push(tx('1001', 'DEPOSIT', createdA + 100 * DAY + 600, 1000, 0.4));
  txs.push(tx('1001', 'WITHDRAW', createdA + 200 * DAY + 900, 1200, 0.5));
  // B: one deposit, ten days ago.
  txs.push(tx('1002', 'DEPOSIT', createdB, 800, 0.3));
  // C: a deposit, then 2,345 collects in runs of four identical timestamps.
  txs.push(tx('1003', 'DEPOSIT', createdC, 9000, 3));
  for (let i = 0; i < 2345; i++) {
    const run = Math.floor(i / 4);
    txs.push(tx('1003', 'COLLECT', createdC + 3600 + run * 7200, 0.5 + (i % 3) * 0.1, 0.0002));
  }
  // D: on the lagging pool.
  txs.push(tx('1004', 'DEPOSIT', createdD, 1.5, 3500));
  for (let d = 30; d < 300; d += 45) txs.push(tx('1004', 'COLLECT', createdD + d * DAY, 0.002, 4));
  // E: deposited, then fully withdrawn.
  txs.push(tx('1005', 'DEPOSIT', createdE, 4000, 1.5));
  txs.push(tx('1005', 'COLLECT', createdE + 60 * DAY, 30, 0.01));
  txs.push(tx('1005', 'WITHDRAW', createdE + 130 * DAY, 3900, 1.6));
  // F: created (and first deposited) on a day without a pool row. SMALL on
  // purpose: day 0's divergence is clamped to ±$50, and a large position would
  // saturate that band and hide which tick the day was valued at.
  txs.push(tx('1006', 'DEPOSIT', createdF, 0.01, 0.000004));
  txs.push(tx('1006', 'COLLECT', createdF + 40 * DAY, 0.0001, 0.00000004));

  const positions: Record<string, StoredPosition> = {
    '1001': position({ positionId: '1001', poolId: POOL, createdAtTimestamp: createdA }),
    '1002': position({ positionId: '1002', poolId: POOL, createdAtTimestamp: createdB }),
    '1003': position({ positionId: '1003', poolId: POOL, createdAtTimestamp: createdC }),
    '1004': position({ positionId: '1004', poolId: LAG_POOL, createdAtTimestamp: createdD }),
    '1005': position({
      positionId: '1005',
      poolId: POOL,
      createdAtTimestamp: createdE,
      isActive: false,
      liquidity: '0',
      amounts: {
        amount0: '0',
        amount1: '0',
        depositedToken0: '4000',
        depositedToken1: '1.5',
        withdrawnToken0: '3900',
        withdrawnToken1: '1.6',
        totalFeesCollected0: '30',
        totalFeesCollected1: '0.01',
        totalGasCostEth: '0.0015',
      },
    }),
    '1006': position({
      positionId: '1006',
      poolId: POOL,
      createdAtTimestamp: createdF,
      liquidity: '1000000',
      amounts: {
        amount0: '0.009',
        amount1: '0.0000041',
        depositedToken0: '0.01',
        depositedToken1: '0.000004',
        withdrawnToken0: '0',
        withdrawnToken1: '0',
        totalFeesCollected0: '0.0001',
        totalFeesCollected1: '0.00000004',
        totalGasCostEth: '0.0005',
      },
    }),
  };

  return {
    data: {
      poolDayDatas: [...poolRows, ...lagRows],
      tokenDayDatas,
      ticks: [...ticks(POOL, 198_000, 60, 13), ...ticks(LAG_POOL, -198_000, 60, 17)],
      pools,
      positionTransactions: txs,
    },
    positions,
  };
}
