/**
 * Long synchronous loads (a snapshot's columns, a dictionary's hash, an oid
 * index) written as generators that `yield` between slices: run to completion
 * in one go (`runSteps`, the sync API) or with an event-loop turn between
 * slices (`runStepsAsync`) so a replica that is already answering HTTP never
 * stalls for a whole table at once.
 */

/** Rows per slice of a sliced load (≈ a few ms per slice on one core). */
export const LOAD_SLICE_ROWS = 65_536;

export function runSteps<T>(steps: Generator<void, T, void>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

export async function runStepsAsync<T>(steps: Generator<void, T, void>): Promise<T> {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
