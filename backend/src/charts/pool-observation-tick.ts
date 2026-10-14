/** Preserve the indexer's canonical tick; a missing observation is never tick 0. */
export function poolObservationTick(input: unknown): number | null {
  if (typeof input !== 'number' && (typeof input !== 'string' || !/^-?\d+$/.test(input))) return null;
  const tick = Number(input);
  return Number.isSafeInteger(tick) && tick >= -887272 && tick <= 887272 ? tick : null;
}
