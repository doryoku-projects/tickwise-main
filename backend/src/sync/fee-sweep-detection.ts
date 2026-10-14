/*
 * Telling a periodic fee sweep apart from real position activity.
 *
 * Its own module, with no framework imports, for two reasons: the rule is pure
 * and deserves a direct test, and importing the listener service into a test
 * drags in Nest, GraphQL and every repository it depends on — which also means
 * any spec that mocks that service would mock this rule along with it.
 */

/**
 * Positions sharing ONE block before the poll is treated as a periodic fee
 * sweep rather than that many individual changes.
 *
 * Set to a full page: fewer than this can plausibly be genuine activity in a
 * busy block, while a whole page attributed to a single block is the signature
 * of an indexer-side sweep. The old indexer's sweep touched the entire active
 * set, so in practice the count was in the thousands, not near this floor.
 */
export const SWEEP_BLOCK_MIN_ROWS = 500;

/**
 * The block a periodic fee sweep committed at, or `undefined` when this poll
 * looks like genuine position activity.
 *
 * WHY IT EXISTS. The previous indexer's fee handler re-read uncollected fees for
 * every active position and stamped `updatedAtBlock` on all of them in one
 * commit — the same column the live listener watches as a change feed. So one
 * sweep arrived as the entire active set "changing" at a single block, and
 * fanning out from it enqueued a refresh per position for data whose token-unit
 * quantities never moved. Measured live on avalanche: 2,597 positions, one
 * identical block.
 *
 * Real position changes spread across blocks, because unrelated transactions
 * modify unrelated positions. A single block accounting for a whole page or more
 * is therefore the sweep, not activity.
 *
 * WHY IT IS STILL HERE. The durable fix was for the indexer to stop conflating
 * the two, and it HAS SHIPPED, then gone further: the indexer first wrote fee
 * re-reads to a separate `feesUpdatedAtBlock` column, and the current one has no
 * fee sweep and no such column at all. Measured on chain 1 while the separate
 * column still existed — a sweep touched 400 positions every 300 blocks and
 * moved NONE of their `updatedAtBlock`; across a 50,000-block window, 12,301
 * changed positions spread over 8,713 distinct blocks with a largest
 * single-block cluster of 50, i.e. an order of magnitude below the floor below.
 *
 * So this is now a BACKSTOP against a regression in an indexer this repo does not
 * contain and cannot check at build time. One line added to a handler there that
 * stamps `updatedAtBlock` on every row turns the feed back into a
 * whole-active-set firehose, and that is the one failure in this subsystem that
 * writes to stored values at scale. It reads only per-block row counts, so it
 * does not depend on the removed fee sweep. It costs one Map insert per row. If
 * it ever fires, the indexer is the thing to look at.
 */
export function detectFeeSweepBlock(
  perBlockCount: ReadonlyMap<number, number>,
  minRows: number = SWEEP_BLOCK_MIN_ROWS,
): [block: number, count: number] | undefined {
  let worst: [number, number] | undefined;
  for (const [block, count] of perBlockCount) {
    if (count >= minRows && (!worst || count > worst[1])) worst = [block, count];
  }
  return worst;
}

/**
 * EVERY block that meets the floor, not just the worst one.
 *
 * `detectFeeSweepBlock` above returns the single worst block, which was fine
 * while the caller used it as a boolean and abandoned the whole poll. It is NOT
 * fine now that the caller suppresses fan-out per block: a sweep whose batch
 * commit straddles two blocks would have its larger half suppressed and its
 * smaller half fanned out — thousands of refresh jobs for quantities that never
 * moved, which is precisely the failure the detector exists to prevent.
 *
 * Kept as a separate function so the single-worst form stays available for the
 * log line (naming one block and one count reads better than naming a set).
 */
export function detectFeeSweepBlocks(
  perBlockCount: ReadonlyMap<number, number>,
  minRows: number = SWEEP_BLOCK_MIN_ROWS,
): ReadonlySet<number> {
  const blocks = new Set<number>();
  for (const [block, count] of perBlockCount) {
    if (count >= minRows) blocks.add(block);
  }
  return blocks;
}
