import { describe, expect, it } from 'vitest';
import { PositionsRepository } from '../src/database/positions.repository.js';

/** Minimal CollectionResolver stub for sort-mapping tests (no model access). */
function fakeResolver() {
  return {
    positionModel: () => ({}),
    transactionModel: () => ({}),
    priceModel: () => ({}),
    transactionCollectionName: () => 'position_transactions',
    positionCollectionName: () => 'positions',
    priceCollectionName: () => 'token_price_historical',
  };
}

describe('PositionsRepository sort mapping', () => {
  it('maps all public sort keys to indexed metric fields', () => {
    const repo = new PositionsRepository(fakeResolver() as never);
    expect(repo.sortFieldFor('apr')).toBe('metrics.aprExGas');
    expect(repo.sortFieldFor('fee_apr')).toBe('metrics.feeApr');
    expect(repo.sortFieldFor('roi')).toBe('metrics.roi');
    // newest first on every status: the immutable creation time (lbr_created), not ageSeconds
    expect(repo.sortFieldFor('age')).toBe('createdAtTimestamp');
    expect(repo.sortFieldFor('pnl')).toBe('metrics.poolPnlUsd');
    expect(repo.sortFieldFor('underlying_value')).toBe('metrics.underlyingValueUsd');
    expect(repo.sortFieldFor('nft_id_asc')).toBe('tokenId');
    expect(repo.sortFieldFor('nft_id_desc')).toBe('tokenId');
  });

  it('maps public sort keys to expected directions', () => {
    const repo = new PositionsRepository(fakeResolver() as never);
    expect(repo.sortDirectionFor('nft_id_asc')).toBe(1);
    expect(repo.sortDirectionFor('age')).toBe(-1); // createdAtTimestamp desc = newest first
    expect(repo.sortDirectionFor('nft_id_desc')).toBe(-1);
    expect(repo.sortDirectionFor('apr')).toBe(-1);
  });

  it('the positionId tie-break follows the primary direction on the nft sorts only', () => {
    const repo = new PositionsRepository(fakeResolver() as never);
    expect(repo.sortTieDirectionFor('nft_id_asc')).toBe(1);
    expect(repo.sortTieDirectionFor('nft_id_desc')).toBe(-1); // lbr_tokenid read backwards
    for (const sort of ['apr', 'fee_apr', 'roi', 'age', 'pnl', 'underlying_value']) {
      expect(repo.sortTieDirectionFor(sort)).toBe(1);
    }
  });

  it('requires completed cash-flow performance for performance sorts only', () => {
    const repo = new PositionsRepository(fakeResolver() as never);
    expect(repo.requiresPerformanceForSort('apr')).toBe(true);
    expect(repo.requiresPerformanceForSort('fee_apr')).toBe(true);
    expect(repo.requiresPerformanceForSort('roi')).toBe(true);
    expect(repo.requiresPerformanceForSort('pnl')).toBe(true);
    expect(repo.requiresPerformanceForSort('underlying_value')).toBe(false);
    expect(repo.requiresPerformanceForSort('age')).toBe(false);
  });
});
