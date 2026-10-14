/*
 * The live listener feeds the fee refresh's dirty set: every position whose
 * `updatedAtBlock` moved is re-read on-chain on the next 60 s tick (a modify
 * settles fees, so a compounder would otherwise serve the modify's 0 until a
 * tier pass reached it). Suspected fee-sweep blocks are skipped exactly as the
 * refresh fan-out skips them. Same harness shape as live-event-listener.spec.
 */
import { describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();

vi.mock('graphql-request', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({ request: requestMock })),
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

import { LiveEventListenerService } from '../src/sync/live-event-listener.service.js';

const integration = {
  chainId: 4663,
  protocol: 'uniswap-v4',
  subgraphUrl: 'https://indexer.hyperindex.xyz/abc123/v1/graphql',
  dialect: 'hyperindex',
  enabled: true,
};

function makeService(feeRefresh?: { markDirty: ReturnType<typeof vi.fn> }) {
  const syncRepo = {
    getCursor: vi.fn(async () => ({ liveBlockNumber: 100, liveBlockTimestamp: 0 })),
    markLiveCursor: vi.fn(async () => undefined),
  };
  const config = {
    liveRefreshEnabled: true,
    livePollMinMs: 500,
    livePollIntervalFallbackMs: 3000,
    liveRefreshConcurrency: 8,
    enabledIntegrations: [integration],
  };
  const adapters = { resolve: vi.fn(() => ({ recomputeMode: 'aggregates' })) };
  const service = new LiveEventListenerService(config as never, syncRepo as never, adapters as never, feeRefresh as never);
  const enqueueFn = vi.fn(async () => undefined);
  service.registerEnqueue(enqueueFn);
  vi.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
  return { service, enqueueFn };
}

function row(tokenId: string, block: number) {
  return { tokenId, updatedAtBlock: String(block), updatedAtTimestamp: String(1_700_000_000 + block) };
}

async function runOnce(service: LiveEventListenerService, ms = 80) {
  await service.onModuleInit();
  await new Promise((resolve) => setTimeout(resolve, ms));
  await service.onModuleDestroy();
}

describe('live listener → fee refresh dirty set', () => {
  it('marks every changed position dirty, once, for its chain and protocol', async () => {
    requestMock.mockReset();
    const markDirty = vi.fn();
    const { service, enqueueFn } = makeService({ markDirty });
    requestMock
      .mockResolvedValueOnce({ positions: [row('40', 101), row('41', 102), row('40', 104)] })
      .mockImplementation(async () => ({ positions: [] }));

    await runOnce(service);

    expect(markDirty).toHaveBeenCalledTimes(1);
    const [chainId, ids, protocol] = markDirty.mock.calls[0] as [number, string[], string];
    expect(chainId).toBe(4663);
    expect(protocol).toBe('uniswap-v4');
    expect([...ids].sort()).toEqual(['40', '41']);
    // Each id carries the block of its (latest) change, so a position whose
    // stored on-chain reading already post-dates it costs no RPC call.
    const blocks = markDirty.mock.calls[0]![3] as Map<string, number>;
    expect([...blocks].sort()).toEqual([
      ['40', 104],
      ['41', 102],
    ]);
    // The refresh fan-out is unchanged.
    expect(enqueueFn).toHaveBeenCalledTimes(2);
  });

  it('skips a suspected fee-sweep block, like the fan-out does', async () => {
    requestMock.mockReset();
    const markDirty = vi.fn();
    const { service } = makeService({ markDirty });
    requestMock
      .mockResolvedValueOnce({ positions: Array.from({ length: 500 }, (_, i) => row(String(5000 + i), 777)) })
      .mockImplementation(async () => ({ positions: [] }));

    await runOnce(service);

    const marked = markDirty.mock.calls.flatMap((c) => [...(c[1] as string[])]);
    expect(marked).toEqual([]);
  });

  it('works without a fee refresh (the optional dependency is absent in older harnesses)', async () => {
    requestMock.mockReset();
    const { service, enqueueFn } = makeService(undefined);
    requestMock
      .mockResolvedValueOnce({ positions: [row('40', 101)] })
      .mockImplementation(async () => ({ positions: [] }));
    await runOnce(service);
    expect(enqueueFn).toHaveBeenCalledTimes(1);
  });
});
