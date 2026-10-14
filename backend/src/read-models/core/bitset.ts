/**
 * Row bitsets (design §4.5): one bit per slot in `Uint32Array` words. The
 * engines build one per predicate atom with a tight column scan, combine
 * them word by word (a clause is the OR of its atoms, a query the AND of its
 * clauses) and count with a SWAR popcount — at 1 M rows a scan is ~1 ms and
 * an AND + popcount well under that (F16).
 */

export function wordsFor(bits: number): number {
  return (bits + 31) >>> 5;
}

export function newBitset(bits: number): Uint32Array {
  return new Uint32Array(wordsFor(bits));
}

export function setBit(words: Uint32Array, bit: number): void {
  words[bit >>> 5] |= 1 << (bit & 31);
}

export function testBit(words: Uint32Array, bit: number): boolean {
  return (words[bit >>> 5] & (1 << (bit & 31))) !== 0;
}

/** Bits set in one 32-bit word. */
export function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

export function popcount(words: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w !== 0) total += popcount32(w);
  }
  return total;
}

/** `target &= other` (over the shorter length; target words past it are cleared). */
export function andInto(target: Uint32Array, other: Uint32Array): void {
  const n = Math.min(target.length, other.length);
  for (let i = 0; i < n; i++) target[i] &= other[i];
  for (let i = n; i < target.length; i++) target[i] = 0;
}

/** `target |= other`. */
export function orInto(target: Uint32Array, other: Uint32Array): void {
  const n = Math.min(target.length, other.length);
  for (let i = 0; i < n; i++) target[i] |= other[i];
}

/** `target = ~target`, limited to the first `bits` bits. */
export function invertInto(target: Uint32Array, bits: number): void {
  for (let i = 0; i < target.length; i++) target[i] = ~target[i];
  const tail = bits & 31;
  const last = bits >>> 5;
  if (tail !== 0 && last < target.length) target[last] &= (1 << tail) - 1;
  for (let i = tail === 0 ? last : last + 1; i < target.length; i++) target[i] = 0;
}
