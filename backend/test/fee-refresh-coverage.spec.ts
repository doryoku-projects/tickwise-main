/*
 * Which enabled integrations the on-chain fee job cannot reach.
 *
 * Since 2026-10-05 the indexer no longer reports uncollected fees, so this job is
 * their ONLY source: a chain with no `EVM_RPC_URLS` entry serves `unmeasured`
 * ("Pending") for every open position, forever. `[alert] fees.no_rpc` is raised for
 * exactly these, and `feeRefreshChains` schedules exactly the complement.
 */
import { describe, expect, it } from 'vitest';
import { feeRefreshUncovered } from '../src/queues/queue.service.js';

const v4 = (chainId: number) => ({ chainId, protocol: 'uniswap-v4' });

describe('feeRefreshUncovered', () => {
  it('returns every enabled chain with no RPC url, and only those', () => {
    // The local dev .env as found on 2026-10-05: four live chains, RPC for two.
    const enabled = [v4(1), v4(43114), v4(42161), v4(4663)];
    const rpc = new Map([
      [1, 'https://eth.example'],
      [8453, 'https://base.example'], // an RPC for a chain with no integration is irrelevant
      [42161, 'https://arb.example'],
    ]);
    expect(feeRefreshUncovered(enabled, rpc).map((i) => i.chainId)).toEqual([43114, 4663]);
  });

  it('is empty when every enabled chain has a url', () => {
    expect(feeRefreshUncovered([v4(1), v4(43114)], new Map([[1, 'a'], [43114, 'b']]))).toEqual([]);
  });

  it('returns the integration objects themselves, so the complement can be taken by identity', () => {
    const avax = v4(43114);
    const [only] = feeRefreshUncovered([v4(1), avax], new Map([[1, 'a']]));
    expect(only).toBe(avax);
  });
});
