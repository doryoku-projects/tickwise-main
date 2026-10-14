import { describe, expect, it, vi } from 'vitest';
import { PositionTransactionsRepository } from '../src/database/position-transactions.repository.js';

/**
 * The background reprice scan must pick up BOTH never-priced rows (`'none'`)
 * and fastIngest's deferred subgraph-priced rows (`'revert-subgraph'`) so the
 * long-tail converges to pool-ratio/external over refresh ticks.
 */
function makeRepo() {
  const aggregatePipelines: unknown[][] = [];
  const findFilters: Record<string, unknown>[] = [];

  const model = {
    aggregate: vi.fn((pipeline: unknown[]) => {
      aggregatePipelines.push(pipeline);
      return { collation: () => Promise.resolve([]) };
    }),
    find: vi.fn((filter: Record<string, unknown>) => {
      findFilters.push(filter);
      return { lean: () => Promise.resolve([]) };
    }),
  };
  const resolver = { transactionModel: () => model } as never;
  const repo = new PositionTransactionsRepository(resolver);
  return { repo, aggregatePipelines, findFilters };
}

function matchStage(pipeline: unknown[]): Record<string, unknown> {
  const stage = pipeline.find((s) => (s as Record<string, unknown>).$match) as
    | { $match: Record<string, unknown> }
    | undefined;
  return stage?.$match ?? {};
}

describe('PositionTransactionsRepository — reprice selectors include revert-subgraph', () => {
  it('findPositionIdsWithUnpricedTransactions matches none + revert-subgraph', async () => {
    const { repo, aggregatePipelines } = makeRepo();
    await repo.findPositionIdsWithUnpricedTransactions(1, 'uniswap-v4', '', 100);

    const match = matchStage(aggregatePipelines[0] ?? []);
    expect(match.historicalPricingSource).toEqual({ $in: ['none', 'revert-subgraph'] });
  });

  it('findUnpricedTimestampsByPositions matches none + revert-subgraph', async () => {
    const { repo, findFilters } = makeRepo();
    await repo.findUnpricedTimestampsByPositions(1, 'uniswap-v4', ['40']);

    expect(findFilters[0]?.historicalPricingSource).toEqual({ $in: ['none', 'revert-subgraph'] });
  });
});
