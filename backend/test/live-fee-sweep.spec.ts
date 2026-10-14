import { describe, expect, it } from 'vitest';
import { detectFeeSweepBlock, detectFeeSweepBlocks } from '../src/sync/fee-sweep-detection.js';

/**
 * Ponder's FeeSync stamps `updatedAtBlock` on EVERY active position in one
 * commit, and that is the column the live listener watches. Without this rule
 * one hourly sweep arrives as the whole active set "changing" and fans out a
 * refresh per position — thousands of jobs for data whose token-unit quantities
 * never moved. Measured live: 2,597 positions on avalanche, all carrying one
 * identical block.
 */
describe('detectFeeSweepBlock', () => {
  it('flags a whole page attributed to one block', () => {
    const found = detectFeeSweepBlock(new Map([[94765274, 2597]]));
    expect(found).toEqual([94765274, 2597]);
  });

  it('does NOT flag genuine activity spread across blocks', () => {
    // 2,600 changes, but spread — this is a busy period, not a sweep.
    const counts = new Map<number, number>();
    for (let b = 0; b < 260; b++) counts.set(1_000_000 + b, 10);
    expect(detectFeeSweepBlock(counts)).toBeUndefined();
  });

  it('does not flag a busy single block below the page threshold', () => {
    expect(detectFeeSweepBlock(new Map([[500, 499]]))).toBeUndefined();
  });

  it('fires exactly at the threshold', () => {
    expect(detectFeeSweepBlock(new Map([[500, 500]]))).toEqual([500, 500]);
  });

  it('picks the largest block when a sweep and real activity arrive together', () => {
    const counts = new Map([
      [900, 12],      // real changes
      [1000, 3100],   // the sweep
      [1001, 4],      // real changes
    ]);
    expect(detectFeeSweepBlock(counts)).toEqual([1000, 3100]);
  });

  it('is silent on an empty poll', () => {
    expect(detectFeeSweepBlock(new Map())).toBeUndefined();
  });

  it('honours an explicit threshold', () => {
    expect(detectFeeSweepBlock(new Map([[7, 20]]), 10)).toEqual([7, 20]);
    expect(detectFeeSweepBlock(new Map([[7, 20]]), 50)).toBeUndefined();
  });

  /*
   * EVERY block over the floor, not just the worst.
   *
   * `detectFeeSweepBlock` returns the single worst block, which was correct while
   * the caller used it as a boolean and abandoned the whole poll. The caller now
   * suppresses fan-out PER BLOCK, so a sweep whose batch commit straddles two
   * blocks would have its larger half suppressed and its smaller half fanned out —
   * the same firehose in miniature, on a queue shared with admin backfills.
   */
  describe('detectFeeSweepBlocks — the set the caller suppresses', () => {
    it('returns every block at or above the floor, not only the largest', () => {
      const counts = new Map([
        [900, 12],     // real changes
        [1000, 1400],  // a sweep, first half
        [1001, 1197],  // a sweep, second half — the old single-worst form missed this
        [1002, 4],     // real changes
      ]);
      expect(detectFeeSweepBlocks(counts)).toEqual(new Set([1000, 1001]));
      // …and the log line still names one block, which is why both forms exist.
      expect(detectFeeSweepBlock(counts)).toEqual([1000, 1400]);
    });

    it('is empty when nothing meets the floor, so nothing is suppressed', () => {
      expect(detectFeeSweepBlocks(new Map([[900, 12], [901, 499]])).size).toBe(0);
    });

    it('honours an explicit threshold', () => {
      expect(detectFeeSweepBlocks(new Map([[7, 20], [8, 9]]), 10)).toEqual(new Set([7]));
    });
  });
});
