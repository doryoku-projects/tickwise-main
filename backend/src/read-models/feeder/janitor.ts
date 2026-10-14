import { RM_LAYOUT, snapSetOf, type RmKeys } from '../keys.js';
import type { ModelsTransport } from '../transport.js';

/**
 * The redis-models janitor (design §2.3). Every key there carries a TTL, so
 * nothing leaks forever; this is the faster backstop, run when a holder takes
 * the lease and on `POST /admin/read-models/redis/sweep`:
 *  - every snapshot set that is NOT the live manifest's and is older than
 *    `minAgeMs` (2 min) is unlinked. Age comes from the TTL: a set being
 *    written carries `writingTtlMs` (10 min), so a key with more than
 *    `writingTtlMs − minAgeMs` left was written less than `minAgeMs` ago — a
 *    set some holder is writing right now, left alone;
 *  - keys of this deployment under an older key LAYOUT (`tw:rm:v0:{ns}:…`)
 *    are unlinked.
 * Other deployments' namespaces are never touched (a dev backend may share
 * the instance).
 */

export interface SetInventory {
  set: string;
  keys: number;
  bytes: number;
  /** Smallest remaining TTL among its keys (ms; -1 = no TTL). */
  minTtlMs: number;
  live: boolean;
}

export interface Inventory {
  usedMemory: number | null;
  maxMemory: number | null;
  policy: string | null;
  liveSet: string | null;
  sets: SetInventory[];
  otherLayoutKeys: number;
  streamTail: string | null;
}

export interface SweepResult {
  liveSet: string | null;
  sweptSets: string[];
  sweptKeys: number;
  keptYoung: string[];
  otherLayoutKeys: number;
}

async function collect(transport: ModelsTransport, keys: RmKeys) {
  const bySet = new Map<string, string[]>();
  for await (const page of transport.scan(`${keys.snapPrefix}*`)) {
    for (const key of page) {
      const set = snapSetOf(keys, key);
      if (!set) continue;
      const list = bySet.get(set) ?? [];
      list.push(key);
      bySet.set(set, list);
    }
  }
  const otherLayouts: string[] = [];
  const nsTag = keys.prefix.slice(RM_LAYOUT.length); // `:{ns}`
  for await (const page of transport.scan('tw:rm:*')) {
    for (const key of page) {
      if (key.startsWith(`${RM_LAYOUT}:`)) continue;
      // `tw:rm:<layout>:{ns}:…` of THIS deployment only.
      const rest = key.slice('tw:rm:'.length);
      const colon = rest.indexOf(':');
      if (colon > 0 && rest.slice(colon).startsWith(`${nsTag}:`)) otherLayouts.push(key);
    }
  }
  return { bySet, otherLayouts };
}

export async function inventoryModels(transport: ModelsTransport, keys: RmKeys): Promise<Inventory> {
  const manifest = await transport.manifest();
  const liveSet = manifest ? `${manifest.fence}:${manifest.epoch}:${manifest.snapSeq}` : null;
  const { bySet, otherLayouts } = await collect(transport, keys);
  const sets: SetInventory[] = [];
  for (const [set, list] of bySet) {
    const [ttls, sizes] = await Promise.all([transport.pttl(list), transport.sizes(list)]);
    sets.push({
      set,
      keys: list.length,
      bytes: sizes.reduce((a, b) => a + b, 0),
      minTtlMs: ttls.reduce((a, b) => (a < 0 ? b : b < 0 ? a : Math.min(a, b)), -1),
      live: set === liveSet,
    });
  }
  const memory = await transport.memory().catch(() => null);
  return {
    usedMemory: memory?.used ?? null,
    maxMemory: memory?.max ?? null,
    policy: memory?.policy ?? null,
    liveSet,
    sets: sets.sort((a, b) => a.set.localeCompare(b.set)),
    otherLayoutKeys: otherLayouts.length,
    streamTail: await transport.tailId().catch(() => null),
  };
}

export async function sweepModels(
  transport: ModelsTransport,
  keys: RmKeys,
  opts: { minAgeMs?: number; writingTtlMs: number },
): Promise<SweepResult> {
  const minAgeMs = opts.minAgeMs ?? 120_000;
  const manifest = await transport.manifest();
  const liveSet = manifest ? `${manifest.fence}:${manifest.epoch}:${manifest.snapSeq}` : null;
  const { bySet, otherLayouts } = await collect(transport, keys);
  const sweptSets: string[] = [];
  const keptYoung: string[] = [];
  let sweptKeys = 0;
  for (const [set, list] of bySet) {
    if (set === liveSet) continue;
    const ttls = await transport.pttl(list);
    const young = ttls.some((ttl) => ttl > opts.writingTtlMs - minAgeMs);
    if (young) {
      keptYoung.push(set);
      continue;
    }
    sweptKeys += await transport.unlink(list);
    sweptSets.push(set);
  }
  if (otherLayouts.length > 0) sweptKeys += await transport.unlink(otherLayouts);
  return { liveSet, sweptSets, sweptKeys, keptYoung, otherLayoutKeys: otherLayouts.length };
}
