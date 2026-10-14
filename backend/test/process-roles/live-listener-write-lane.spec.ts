/*
 * The live listener's poll loop charges its Mongo writes (the live cursor) to
 * the `live` write lane of the shared write budget (P2.4).
 */
import { describe, expect, it, vi } from 'vitest';
import { currentWriteLane } from '../../src/common/write-lane.js';

const mocks = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('graphql-request', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({ request: mocks.requestMock })),
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

const { LiveEventListenerService } = await import('../../src/sync/live-event-listener.service.js');

describe('LiveEventListenerService write lane', () => {
  it('runs every cursor read/write of the poll loop in the live write lane', async () => {
    const lanes: string[] = [];
    mocks.requestMock.mockImplementation(async (query: string) => {
      if (query.includes('orderDirection: asc')) return { positions: [] };
      return { positions: [{ updatedAtBlock: '100', updatedAtTimestamp: '1700000000' }] };
    });
    const service = new LiveEventListenerService(
      {
        liveRefreshEnabled: true,
        livePollMinMs: 1,
        livePollIntervalFallbackMs: 1,
        liveRefreshConcurrency: 1,
        enabledIntegrations: [
          { chainId: 1, protocol: 'uniswap-v4', subgraphUrl: 'https://indexer.example.test/v1/graphql', enabled: true },
        ],
      } as never,
      {
        getCursor: vi.fn(async () => {
          lanes.push(currentWriteLane());
          return null;
        }),
        markLiveCursor: vi.fn(async () => {
          lanes.push(currentWriteLane());
        }),
      } as never,
      { resolve: () => ({ recomputeMode: 'aggregates' }) } as never,
    );
    service.registerEnqueue(vi.fn(async () => undefined));

    await service.onModuleInit();
    await new Promise((r) => setTimeout(r, 60));
    await service.onModuleDestroy();

    expect(lanes.length).toBeGreaterThan(0);
    expect(new Set(lanes)).toEqual(new Set(['live']));
    expect(currentWriteLane()).toBe('other');
  });
});
