import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * The leaderboard exclusion set, published by ONE process (the `exclusions`
 * lease holder) for every other replica — leases on only (capacity plan step
 * 1: each api replica used to read ~88k token docs a minute to rebuild it).
 *
 * Two keys per chain, both `PX = EXCLUSION_SNAPSHOT_TTL_MS` (3.5 rebuild
 * intervals — longer than the 3-interval staleness rule a follower applies, so
 * the age check, not the key expiry, decides a fallback):
 *
 *   tw:excl:v1:<ns>:<chainId>:meta  JSON {v:1, chainId, builtAt, hash, count}
 *   tw:excl:v1:<ns>:<chainId>       the set, binary (below)
 *
 * A follower GETs the small `meta` every interval and fetches the blob only
 * when `hash` differs from the set it already serves — in steady state one
 * ~100-byte GET per chain per minute instead of two collection scans.
 *
 * Blob: `TWX1` | uint32BE header length | header JSON | packed addresses.
 * Every `0x` + 40-hex address is packed as its 20 raw bytes (half the size of
 * the hex text); anything else (none expected) rides in `header.other`
 * verbatim. `hash` = sha1 over the SORTED addresses, so it names the CONTENT
 * (the two scans return in no fixed order) and lets the reader verify the blob.
 */
export const EXCLUSION_SNAPSHOT_VERSION = 1;
const MAGIC = Buffer.from('TWX1', 'ascii');
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/;

export interface ExclusionSnapshotMeta {
  v: 1;
  chainId: number;
  /** Epoch ms the leader's scan finished. */
  builtAt: number;
  hash: string;
  count: number;
}

export interface DecodedExclusionSnapshot {
  chainId: number;
  builtAt: number;
  hash: string;
  addresses: string[];
}

export function exclusionBlobKey(namespace: string, chainId: number): string {
  return `tw:excl:v1:${namespace}:${chainId}`;
}

export function exclusionMetaKey(namespace: string, chainId: number): string {
  return `${exclusionBlobKey(namespace, chainId)}:meta`;
}

/** sha1 (hex, 16 chars) over the sorted addresses: a content version. */
export function exclusionContentHash(addresses: readonly string[]): string {
  const hash = createHash('sha1');
  for (const address of [...addresses].sort()) hash.update(address).update('\n');
  return hash.digest('hex').slice(0, 16);
}

export function encodeExclusionSnapshot(
  chainId: number,
  builtAt: number,
  addresses: readonly string[],
  hash: string = exclusionContentHash(addresses),
): Buffer {
  const packed: string[] = [];
  const other: string[] = [];
  for (const address of addresses) (HEX_ADDRESS.test(address) ? packed : other).push(address);
  const header = Buffer.from(
    JSON.stringify({ v: EXCLUSION_SNAPSHOT_VERSION, chainId, builtAt, hash, count: packed.length, other }),
    'utf8',
  );
  const body = Buffer.allocUnsafe(packed.length * 20);
  packed.forEach((address, i) => body.write(address.slice(2), i * 20, 20, 'hex'));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(header.length, 0);
  return Buffer.concat([MAGIC, length, header, body]);
}

/** Undefined for anything that is not a well-formed v1 snapshot of `chainId` whose content matches its hash. */
export function decodeExclusionSnapshot(raw: Buffer | null | undefined, chainId: number): DecodedExclusionSnapshot | undefined {
  try {
    if (!raw || raw.length < 8 || !raw.subarray(0, 4).equals(MAGIC)) return undefined;
    const headerLength = raw.readUInt32BE(4);
    if (8 + headerLength > raw.length) return undefined;
    const header = JSON.parse(raw.subarray(8, 8 + headerLength).toString('utf8')) as {
      v?: unknown;
      chainId?: unknown;
      builtAt?: unknown;
      hash?: unknown;
      count?: unknown;
      other?: unknown;
    };
    if (header.v !== EXCLUSION_SNAPSHOT_VERSION || header.chainId !== chainId) return undefined;
    if (typeof header.builtAt !== 'number' || typeof header.hash !== 'string' || typeof header.count !== 'number') return undefined;
    const other = Array.isArray(header.other) ? header.other.filter((a): a is string => typeof a === 'string') : [];
    const body = raw.subarray(8 + headerLength);
    if (body.length !== header.count * 20) return undefined;
    const addresses: string[] = new Array(header.count);
    for (let i = 0; i < header.count; i++) addresses[i] = `0x${body.toString('hex', i * 20, i * 20 + 20)}`;
    addresses.push(...other);
    if (exclusionContentHash(addresses) !== header.hash) return undefined;
    return { chainId, builtAt: header.builtAt, hash: header.hash, addresses };
  } catch {
    return undefined;
  }
}

export function parseExclusionMeta(raw: string | null | undefined, chainId: number): ExclusionSnapshotMeta | undefined {
  if (!raw) return undefined;
  try {
    const meta = JSON.parse(raw) as Partial<ExclusionSnapshotMeta>;
    if (meta?.v !== EXCLUSION_SNAPSHOT_VERSION || meta.chainId !== chainId) return undefined;
    if (typeof meta.builtAt !== 'number' || typeof meta.hash !== 'string' || typeof meta.count !== 'number') return undefined;
    return meta as ExclusionSnapshotMeta;
  } catch {
    return undefined;
  }
}

/**
 * Leader: extend the published pair in place — ONLY when the stored `meta`
 * names this exact content hash and the blob is still there. Atomic, so it can
 * never extend a blob another publisher wrote in between (an old holder
 * finishing its last cycle after losing the lease, or a process re-acquiring
 * the lease with stale knowledge of what is stored): a pair whose meta names
 * another hash is rewritten instead. Returns 1 when extended, 0 otherwise.
 *
 * KEYS[1] meta, KEYS[2] blob; ARGV[1] hash, ARGV[2] the new meta JSON, ARGV[3] TTL ms.
 */
export const EXCLUSION_EXTEND_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, meta = pcall(cjson.decode, raw)
if not ok or type(meta) ~= 'table' or meta['hash'] ~= ARGV[1] then return 0 end
if redis.call('PEXPIRE', KEYS[2], ARGV[3]) ~= 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

/**
 * Leader: publish one chain's set. Every publish leaves a CONSISTENT pair
 * (`meta.hash` = the blob's content hash), whoever else publishes at the same
 * time: first `EXCLUSION_EXTEND_SCRIPT` (one small EVAL — extends the stored
 * pair when it already holds this content, decided against what Redis HOLDS,
 * not against what this process last wrote), else blob + meta in ONE
 * `MULTI`. Throws on a Redis error (the caller logs and carries on).
 */
export async function publishExclusionSnapshot(
  redis: Pick<Redis, 'eval' | 'multi'>,
  namespace: string,
  chainId: number,
  addresses: readonly string[],
  builtAt: number,
  ttlMs: number,
  hash: string = exclusionContentHash(addresses),
): Promise<{ hash: string; extended: boolean }> {
  const blobKey = exclusionBlobKey(namespace, chainId);
  const metaKey = exclusionMetaKey(namespace, chainId);
  const ttl = String(Math.max(1, Math.floor(ttlMs)));
  const meta: ExclusionSnapshotMeta = { v: 1, chainId, builtAt, hash, count: addresses.length };
  const metaJson = JSON.stringify(meta);
  if (Number(await redis.eval(EXCLUSION_EXTEND_SCRIPT, 2, metaKey, blobKey, hash, metaJson, ttl)) === 1) {
    return { hash, extended: true };
  }
  const results = await redis
    .multi()
    .set(blobKey, encodeExclusionSnapshot(chainId, builtAt, addresses, hash), 'PX', ttl)
    .set(metaKey, metaJson, 'PX', ttl)
    .exec();
  const failed = results?.find(([err]) => err);
  if (!results || failed) throw failed?.[0] ?? new Error('exclusion snapshot MULTI aborted');
  return { hash, extended: false };
}
