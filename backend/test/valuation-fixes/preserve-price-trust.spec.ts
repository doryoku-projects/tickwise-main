/*
 * The write path's keep-last-known-price guard (`preserveTokenPrice`) now asks
 * the ONE trust rule (`resolveTokenTrust`). Allowlist mode (default) must be
 * today's anchor || CoinGecko-listed exactly; earned mode has no stored
 * verdict at hand there, so only anchors carry forward (fail closed); the env
 * deny list can only remove a carry-forward.
 */
import { describe, expect, it, vi } from 'vitest';
import { PositionsRepository } from '../../src/database/positions.repository.js';
import type { NormalizedPosition } from '../../src/subgraph/normalized-position.js';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // config anchor (chain 1)
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'; // CoinGecko-allowlisted (chain 1)
const SPAM = '0x000000000000000000000000000000000000a5a5'; // neither

function repoWith(previous: Record<string, unknown>, config?: Record<string, unknown>) {
  const model = {
    bulkWrite: vi.fn(async () => ({ upsertedCount: 1, modifiedCount: 0 })),
    find: vi.fn(() => ({ lean: vi.fn(async () => [previous]) })),
  };
  const resolver = { positionModel: () => model, transactionModel: () => model, priceModel: () => model };
  const repo = new PositionsRepository(resolver as never, {} as never, config as never);
  return { repo, model };
}

function position(token0: string, token1: string): NormalizedPosition {
  return {
    chainId: 1, protocol: 'uniswap-v4', positionId: '40', tokenId: '40', owner: '0x', poolId: '0x',
    token0: { address: token0, decimals: 18, symbol: 'A', priceUsd: 0 },
    token1: { address: token1, decimals: 18, symbol: 'B', priceUsd: 0 },
    fee: 3000, tickSpacing: 60, tickLower: 0, tickUpper: 60, currentTick: 0, sqrtPriceX96: '0', liquidity: '0', isActive: true,
    createdAtTimestamp: 0, closedAtTimestamp: null, amounts: {}, metrics: {}, poolStats: {}, pricing: {}, rawSubgraph: {},
  } as never;
}

async function written(token0: string, token1: string, config?: Record<string, unknown>) {
  const previous = { chainId: 1, protocol: 'uniswap-v4', positionId: '40', isActive: true, token0: { priceUsd: 7 }, token1: { priceUsd: 9 } };
  const { repo, model } = repoWith(previous, config);
  await repo.upsertMany([position(token0, token1)]);
  const op = (model.bulkWrite.mock.calls[0]?.[0] as Array<{ updateOne: { update: { $set: Record<string, { priceUsd: number }> } } }>)[0]!;
  return [op.updateOne.update.$set.token0!.priceUsd, op.updateOne.update.$set.token1!.priceUsd];
}

describe('preserveTokenPrice follows the ONE trust rule', () => {
  it('allowlist mode (default, also with no config): anchors and listed tokens carry forward, others do not (today)', async () => {
    expect(await written(USDC, SPAM)).toEqual([7, 0]);
    expect(await written(CBBTC, SPAM, {})).toEqual([7, 0]);
    expect(await written(CBBTC, USDC, { tokenTrustMode: 'allowlist' })).toEqual([7, 9]);
  });

  it('TOKEN_TRUST_DENY removes a listed token\'s carry-forward, never an anchor\'s', async () => {
    expect(await written(CBBTC, USDC, { tokenTrustDeny: `${CBBTC},${USDC}` })).toEqual([0, 9]);
  });

  it('earned mode: no verdict at hand on the write path → only anchors carry forward (fail closed)', async () => {
    expect(await written(CBBTC, USDC, { tokenTrustMode: 'earned' })).toEqual([0, 9]);
  });
});
