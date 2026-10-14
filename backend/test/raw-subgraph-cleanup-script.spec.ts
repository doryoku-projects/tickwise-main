/*
 * `scripts/positions-raw-subgraph-cleanup.mjs` — the pure parts: flags, shard
 * selection, the one filter + update a batch sends, and the pace. (The walk
 * itself was run end to end on a throwaway mongod: closed rows cleaned, every
 * other byte of every document unchanged, resumable, idempotent.)
 */
import { describe, expect, it } from 'vitest';
import {
  BATCH_UPDATE,
  batchFilter,
  DEFAULTS,
  LIMITS,
  paceDelayMs,
  parseArgs,
  selectShards,
} from '../scripts/positions-raw-subgraph-cleanup.mjs';

describe('parseArgs', () => {
  it('defaults: a dry run over closed positions on every shard, paced', () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      shard: undefined,
      scope: 'closed',
      docsPerSec: DEFAULTS.docsPerSec,
      batch: DEFAULTS.batch,
      maxDocs: undefined,
      after: undefined,
      slowBatchMs: DEFAULTS.slowBatchMs,
    });
  });

  it('reads every flag', () => {
    expect(
      parseArgs([
        '--apply',
        '--shard=4663',
        '--scope=all',
        '--docs-per-sec=100',
        '--batch=250',
        '--max-docs=20000',
        '--after=6AC50408F1AB4A842B227A65',
        '--slow-batch-ms=5000',
      ]),
    ).toEqual({
      apply: true,
      shard: 4663,
      scope: 'all',
      docsPerSec: 100,
      batch: 250,
      maxDocs: 20000,
      after: '6ac50408f1ab4a842b227a65',
      slowBatchMs: 5000,
    });
  });

  it('a misspelt flag is an error, never "the operator declined"', () => {
    expect(() => parseArgs(['--aply'])).toThrow(/unrecognized argument\(s\): --aply/);
    expect(() => parseArgs(['--apply', 'extra'])).toThrow(/unrecognized/);
  });

  it('refuses a pace or batch above the ceiling, and anything that is not a positive whole number', () => {
    expect(() => parseArgs([`--docs-per-sec=${LIMITS.docsPerSec + 1}`])).toThrow(/above the limit/);
    expect(() => parseArgs([`--batch=${LIMITS.batch + 1}`])).toThrow(/above the limit/);
    expect(parseArgs([`--docs-per-sec=${LIMITS.docsPerSec}`]).docsPerSec).toBe(LIMITS.docsPerSec);
    for (const bad of ['--docs-per-sec=0', '--docs-per-sec=-5', '--docs-per-sec=1.5', '--docs-per-sec=', '--batch=abc', '--max-docs=0']) {
      expect(() => parseArgs([bad]), bad).toThrow(/positive whole number/);
    }
  });

  it('refuses an unknown scope, a non-numeric shard and a malformed _id', () => {
    expect(() => parseArgs(['--scope=open'])).toThrow(/closed or all/);
    expect(() => parseArgs(['--shard=robinhood'])).toThrow(/numeric chainId/);
    expect(() => parseArgs(['--shard=4663', '--after=123'])).toThrow(/24-hex _id/);
  });

  it('--after needs --shard: an _id belongs to one collection', () => {
    expect(() => parseArgs(['--after=6ac50408f1ab4a842b227a65'])).toThrow(/--after needs --shard/);
    expect(parseArgs(['--shard=1', '--after=6ac50408f1ab4a842b227a65']).after).toBe('6ac50408f1ab4a842b227a65');
  });
});

describe('selectShards', () => {
  const names = [
    '4663_uniswap_v4_positions',
    '1_uniswap_v4_positions',
    '1_uniswap_v4_pools',
    '1_uniswap_v4_position_transactions',
    '4663_tokens',
    'sync_cursors',
    '42161_uniswap_v4_positions',
    'positions',
  ];

  it('picks the positions shards only, in chain order', () => {
    expect(selectShards(names, undefined)).toEqual([
      '1_uniswap_v4_positions',
      '4663_uniswap_v4_positions',
      '42161_uniswap_v4_positions',
    ]);
  });

  it('narrows to one chain', () => {
    expect(selectShards(names, 4663)).toEqual(['4663_uniswap_v4_positions']);
    expect(selectShards(names, 10)).toEqual([]);
  });
});

describe('the batch write', () => {
  it('unsets rawSubgraph and nothing else', () => {
    expect(BATCH_UPDATE).toEqual({ $unset: { rawSubgraph: '' } });
  });

  it('closed scope: the _id range, rows that still carry the field, closed positions only', () => {
    expect(batchFilter('a', 'b', 'closed')).toEqual({
      _id: { $gte: 'a', $lte: 'b' },
      rawSubgraph: { $exists: true },
      isActive: false,
    });
  });

  it('all scope: the same without the status clause', () => {
    const filter = batchFilter('a', 'b', 'all');
    expect(filter).toEqual({ _id: { $gte: 'a', $lte: 'b' }, rawSubgraph: { $exists: true } });
    expect(filter).not.toHaveProperty('isActive');
  });
});

describe('paceDelayMs', () => {
  it('waits out the rest of the time the batch is allowed', () => {
    // 500 documents at 200/s may take 2,500 ms.
    expect(paceDelayMs(500, 400, 200)).toBe(2100);
    expect(paceDelayMs(500, 0, 200)).toBe(2500);
    expect(paceDelayMs(100, 0, 1000)).toBe(100);
  });

  it('never waits when the batch already took longer, or there is nothing to pace', () => {
    expect(paceDelayMs(500, 2500, 200)).toBe(0);
    expect(paceDelayMs(500, 9000, 200)).toBe(0);
    expect(paceDelayMs(0, 0, 200)).toBe(0);
    expect(paceDelayMs(500, 0, 0)).toBe(0);
  });
});
