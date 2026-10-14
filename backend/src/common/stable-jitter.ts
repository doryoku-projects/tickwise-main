/**
 * A deterministic factor in [1 − spread, 1 + spread) from a hash (FNV-1a,
 * 32-bit) of `id`. Used to spread per-row deadlines that would otherwise all
 * come due together — the fee job's restamp windows (`restampJitter`), pool
 * sync's forced rewrites (`poolRewriteDueAt`) — over `spread` of the interval
 * either side. Deterministic, so a row's window does not move between runs,
 * processes or restarts.
 */
export function stableJitter(id: string, spread: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 1 - spread + (2 * spread * h) / 0x1_0000_0000;
}
