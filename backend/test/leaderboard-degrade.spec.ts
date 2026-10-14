import { describe, expect, it, vi } from 'vitest';

import { ChartInputsDeadlineError } from '../src/charts/chart-inputs.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';

/**
 * The position-detail endpoint used to 500 when the upstream indexer timed out
 * fetching the transaction list — blanking a page whose headline figures were
 * already loaded. It now degrades. These tests pin the contract, because the
 * whole point of the flag is that an empty list and a FAILED list must not be
 * indistinguishable to a client.
 */

const CHAIN = 4663;
const PROTO = 'uniswap-v4';

// Shaped to satisfy sanitizeStoredPosition, which reads metrics/poolStats/pricing
// unconditionally. Figures are chosen so the valuation guard ACCEPTS, keeping
// these tests about the degrade contract rather than about valuation.
const position = {
  chainId: CHAIN,
  protocol: PROTO,
  positionId: '463407',
  token0: { address: '0xaaa', symbol: 'USDG', priceUsd: 1 },
  token1: { address: '0xbbb', symbol: 'NVDA', priceUsd: 200 },
  amounts: { totalGasCostEth: 0.0001 },
  metrics: {
    totalGasCostUsd: 0.25,
    underlyingValueUsd: 16_113,
    isPriceable: true,
  },
  poolStats: {
    tvlUsd: 5_000_000,
    tvlUsdUntracked: 5_000_000,
    volumeUsd: 1_000_000,
    totalFeesUsd: 10_000,
  },
  pricing: { source: 'dex' },
};

function makeService(opts: {
  fetchPositionTransactions?: (...args: unknown[]) => Promise<unknown>;
  recomputeMode?: string;
}) {
  const warn = vi.fn();
  const log = vi.fn();
  const svc = new LeaderboardService(
    {
      isSupportedChain: () => true,
      isSupportedProtocol: () => true,
      getIntegration: () => ({ chainId: CHAIN, protocol: PROTO }),
    } as never,
    { findOneForRead: async () => position } as never,
    { findForPosition: async () => [{ txHash: '0xmongo' }] } as never,
    {
      resolve: () => ({
        recomputeMode: opts.recomputeMode ?? 'aggregates',
        fetchPositionTransactions: opts.fetchPositionTransactions,
      }),
    } as never,
  );
  // The alert line is the only trace a degraded response leaves once the 500 is
  // gone, so it is part of the contract rather than incidental logging.
  (svc as unknown as { logger: { warn: unknown } }).logger = { warn, log } as never;
  return { svc, warn, log };
}

describe('LeaderboardService.getPosition — upstream degrade', () => {
  it('serves the position with an empty list and transactionsDegraded=true when the fetch throws', async () => {
    const { svc, warn } = makeService({
      fetchPositionTransactions: async () => {
        throw new Error('canceling statement due to statement timeout');
      },
    });

    const res = (await svc.getPosition(CHAIN, PROTO, '463407')) as {
      transactions: unknown[];
      transactionsDegraded: boolean;
      token0: { symbol: string };
    };

    // It must NOT throw — that was the bug.
    expect(res.transactionsDegraded).toBe(true);
    expect(res.transactions).toEqual([]);
    // The rest of the payload still has to be intact; it was already loaded.
    expect(res.token0.symbol).toBe('USDG');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('[alert]');
    expect(String(warn.mock.calls[0][0])).toContain('positions.tx_fetch_degraded');
  });

  it('a walk still running at the request deadline degrades WITHOUT an [alert] (it is not an outage)', async () => {
    const { svc, warn, log } = makeService({
      fetchPositionTransactions: async () => {
        throw new ChartInputsDeadlineError(['transactions']);
      },
    });

    const res = (await svc.getPosition(CHAIN, PROTO, '463407')) as {
      transactions: unknown[];
      transactionsDegraded: boolean;
    };

    // Same response contract as a failure: the list is not there.
    expect(res.transactionsDegraded).toBe(true);
    expect(res.transactions).toEqual([]);
    // …but the alert stays reserved for a real upstream failure.
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('positions.tx_fetch_late');
  });

  it('reports transactionsDegraded=false on a successful upstream fetch', async () => {
    const { svc, warn } = makeService({
      fetchPositionTransactions: async () => ({
        transactions: [{ txHash: '0xabc', amount0: 1, amount1: 2, gasCostEth: 0.0001 }],
      }),
    });

    const res = (await svc.getPosition(CHAIN, PROTO, '463407')) as {
      transactions: unknown[];
      transactionsDegraded: boolean;
    };

    expect(res.transactionsDegraded).toBe(false);
    expect(res.transactions).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is always present, so a client can read it without an existence check', async () => {
    // Mongo-backed path: no upstream fetch involved at all.
    const { svc } = makeService({ recomputeMode: 'full', fetchPositionTransactions: undefined });

    const res = (await svc.getPosition(CHAIN, PROTO, '463407')) as Record<string, unknown>;

    expect('transactionsDegraded' in res).toBe(true);
    expect(res.transactionsDegraded).toBe(false);
    expect(res.transactions).toHaveLength(1); // came from Mongo
  });

  it('honours an adapter that reports degraded WITHOUT throwing (no source URL configured)', async () => {
    // Every uniswap-v4 chain resolves to the same adapter, including one with no
    // indexer URL — `AdapterRegistryService.resolve` takes a protocol and cannot
    // see a chainId. That returns an empty list and degraded:true rather than
    // throwing, and it must NOT be reported as a real empty history.
    const { svc } = makeService({
      fetchPositionTransactions: async () => ({ transactions: [], degraded: true }),
    });

    const res = (await svc.getPosition(CHAIN, PROTO, '463407')) as {
      transactions: unknown[];
      transactionsDegraded: boolean;
    };

    expect(res.transactionsDegraded).toBe(true);
    expect(res.transactions).toEqual([]);
  });

  it('still throws NotFound for a missing position — the catch must not swallow it', async () => {
    const { svc } = makeService({ fetchPositionTransactions: async () => ({ transactions: [] }) });
    (svc as unknown as { positions: { findOne: unknown } }).positions = {
      findOne: async () => null,
    } as never;

    await expect(svc.getPosition(CHAIN, PROTO, 'nope')).rejects.toThrow();
  });
});
