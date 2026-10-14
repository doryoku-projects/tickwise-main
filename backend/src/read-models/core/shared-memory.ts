/**
 * Shared memory for the read-model engines (design §4.1).
 *
 * Everything a worker thread reads — catalog columns, permutations, list
 * flags, the shard dictionaries — lives on SharedArrayBuffers, so a task
 * message carries handles, never copies. Allocation happens at LOAD (and at a
 * planned reallocation when a shard outgrows its capacity), never per
 * generation: permutations alternate between two buffers allocated once
 * (A/B), and columns are mutated in place at the generation swap (after the
 * passes drained). F15 measured why: SharedArrayBuffers are freed only by a
 * major GC, so a buffer per generation grows `arrayBuffers` by gigabytes.
 *
 * Where SharedArrayBuffer is unavailable (it always is on Node ≥ 20) the
 * buffers are plain ArrayBuffers and only the in-thread engine can run.
 */

export const SHARED_MEMORY = typeof SharedArrayBuffer === 'function';

/** A zero-filled buffer of `bytes`, shared when the platform allows it. */
export function sharedBuffer(bytes: number): ArrayBufferLike {
  const size = Math.max(0, Math.ceil(bytes));
  return SHARED_MEMORY ? new SharedArrayBuffer(size) : new ArrayBuffer(size);
}

export function sharedU8(length: number): Uint8Array {
  return new Uint8Array(sharedBuffer(length));
}

export function sharedU32(length: number): Uint32Array {
  return new Uint32Array(sharedBuffer(length * 4));
}

export function sharedI32(length: number): Int32Array {
  return new Int32Array(sharedBuffer(length * 4));
}

export function sharedF64(length: number): Float64Array {
  return new Float64Array(sharedBuffer(length * 8));
}

/** Total bytes of the distinct buffers behind `views` (status). */
export function bufferBytes(views: Iterable<ArrayBufferView | undefined>): number {
  const seen = new Set<ArrayBufferLike>();
  let total = 0;
  for (const view of views) {
    if (!view || seen.has(view.buffer)) continue;
    seen.add(view.buffer);
    total += view.buffer.byteLength;
  }
  return total;
}
