import { PositionsRepository } from '../../../src/database/positions.repository.js';
import type { NormalizedPosition } from '../../../src/subgraph/normalized-position.js';
import type { PositionSim } from './position-sim.js';

/** Mainnet anchors (`preserveTokenPrice` carries their last positive price forward). */
export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

export const CHAIN = 1;
export const PROTOCOL = 'uniswap-v4';

type Over = Partial<Omit<NormalizedPosition, 'metrics' | 'amounts' | 'token0' | 'token1'>> & {
  metrics?: Partial<NormalizedPosition['metrics']> & Record<string, unknown>;
  amounts?: Partial<NormalizedPosition['amounts']>;
  token0?: Partial<NormalizedPosition['token0']>;
  token1?: Partial<NormalizedPosition['token1']>;
};

/** A complete normalized position (what the Envio adapter hands `upsertMany`). */
export function normalized(over: Over = {}): NormalizedPosition {
  const { metrics, amounts, token0, token1, ...rest } = over;
  return {
    chainId: CHAIN,
    protocol: PROTOCOL,
    positionId: '424242',
    tokenId: '424242',
    owner: '0x1111111111111111111111111111111111111111',
    poolId: '0xpool',
    token0: { address: WETH, symbol: 'WETH', decimals: 18, verified: true, priceUsd: 3000, priceConfidence: 'anchor', ...token0 },
    token1: { address: USDC, symbol: 'USDC', decimals: 6, verified: true, priceUsd: 1, priceConfidence: 'anchor', ...token1 },
    fee: 3000,
    tickSpacing: 60,
    tickLower: -600,
    tickUpper: 600,
    currentTick: 12,
    sqrtPriceX96: '79228162514264337593543950336',
    liquidity: '123456789',
    isActive: true,
    createdAtTimestamp: 1_759_000_000,
    closedAtTimestamp: null,
    lastModifyBlock: 23_000_000,
    amounts: {
      amount0: '1.25',
      amount1: '4100.5',
      depositedToken0: '2',
      depositedToken1: '2000',
      depositedUsd: '0',
      withdrawnToken0: '0.75',
      withdrawnToken1: '0',
      withdrawnUsd: '0',
      totalFeesCollected0: '0.01',
      totalFeesCollected1: '33.3333333333333333',
      totalFeesCollectedUsd: '0',
      totalFeesUncollected0: '0.002',
      totalFeesUncollected1: '4.4',
      totalFeesUncollectedUsd: '10.4',
      totalGasCostEth: '0.0123',
      totalGasCostUsd: '0',
      diffToken0: '0',
      diffToken1: '0',
      diffUsd: '0',
      ...amounts,
    },
    metrics: {
      apr: 0,
      aprExGas: 0,
      feeApr: 0,
      poolApr: 0,
      roi: 0,
      pnlUsd: 0,
      pnlEth: 0,
      pnlHodl: 0,
      poolPnlUsd: 0,
      divergenceLossUsd: 0,
      underlyingValueUsd: 7850.5,
      nominalValueUsd: 7850.5,
      pendingFeesUsd: 10.4,
      collectedFeesUsd: 63.33,
      totalFeesUsd: 73.73,
      totalGasCostUsd: 0,
      investedUsd: 0,
      depositedUsd: 0,
      withdrawnUsd: 0,
      diffUsd: 0,
      unclaimedRewardsUsd: 0,
      claimedRewardsUsd: 0,
      ageSeconds: 86_400 * 20,
      inRange: true,
      isPriceable: true,
      performanceReady: false,
      performanceSource: 'pending-transactions',
      aprWarmup: false,
      feesSource: 'indexer',
      ...metrics,
    } as NormalizedPosition['metrics'],
    poolStats: { tvlUsd: 1_000_000, tvlUsdUntracked: 0, volumeUsd: 5_000_000, totalFeesUsd: 15_000, priceDivergence: 0 },
    pricing: { source: 'orchestrated', usedFallback: false, pricedAt: new Date() },
    rawSubgraph: { id: '1_424242', updatedAtBlock: '23000000' },
    ...rest,
  };
}

/** A repository over `sim` with the given skip settings (`undefined` = no config = skip off). */
export function repoOver(sim: PositionSim, config?: Record<string, unknown>, observer?: unknown): PositionsRepository {
  const repo = new PositionsRepository(
    { positionModel: () => sim } as never,
    {} as never,
    config as never,
    undefined,
    undefined,
    undefined,
    observer as never,
  );
  // Quiet: the `[write-skip]` window lines go to `logs` (specs read them).
  const logs: string[] = [];
  (repo as unknown as { logger: unknown }).logger = {
    log: (line: string) => logs.push(line),
    warn: (line: string) => logs.push(line),
    debug: () => undefined,
    error: (line: string) => logs.push(line),
  };
  (repo as unknown as { logs: string[] }).logs = logs;
  return repo;
}

/** The lines a `repoOver` repository logged. */
export function logsOf(repo: PositionsRepository): string[] {
  return (repo as unknown as { logs: string[] }).logs;
}

/** Seeded PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
