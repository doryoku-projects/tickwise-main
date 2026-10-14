import type { ReadModelName } from './core/fields.js';

/**
 * Redis key layout of the read models (design §2.3).
 *
 * `tw:rm:v1` is the key-LAYOUT version (not a codec version: columns are
 * self-describing, so adding a field never changes it). The deployment
 * namespace (`leaderboardSnapshotNamespace`: NODE_ENV + Mongo hosts/db,
 * hashed) keeps a dev backend pointed at a shared Redis out of production's
 * keys. It is wrapped in a hash tag (`{…}`) so every key of a deployment
 * hashes to ONE slot: the multi-key Lua scripts (fenced append, fenced
 * manifest) stay valid on a clustered Redis.
 *
 * redis-models (`REDIS_MODELS_URL`, else `REDIS_URL`) holds DATA only:
 * incarnation, the fence COPY, the delta stream and its cursor, snapshot
 * manifest and chunks. redis-state (`REDIS_URL`, AOF) holds AUTHORITY and
 * control: the feeder lease, the fence authority, the kill switch, the fleet
 * heartbeats and the shadow-coverage records (one HASH each — read with one
 * `HGETALL`, never a SCAN of `REDIS_URL`, which BullMQ shares), admin
 * commands. The two fences have different names on
 * purpose: with `REDIS_MODELS_URL` unset both live on one instance.
 */

export const RM_LAYOUT = 'tw:rm:v1';

export interface RmKeys {
  readonly prefix: string;
  // redis-models
  readonly incarnation: string;
  readonly fenceCopy: string;
  readonly deltas: string;
  readonly cursor: string;
  readonly manifest: string;
  /** Prefix of every snapshot chunk key. */
  readonly snapPrefix: string;
  snapSet(fence: number, epoch: number, snapSeq: number): string;
  snapChunk(fence: number, epoch: number, snapSeq: number, model: ReadModelName, column: string, chunk: number): string;
  // redis-state
  readonly lease: string;
  readonly fenceAuthority: string;
  readonly killswitch: string;
  readonly commands: string;
  readonly lastCommand: string;
  /** ONE hash per deployment: field = replica, value = its heartbeat (stale fields dropped by readers). */
  readonly fleet: string;
  /** ONE hash per deployment: field = `<replica>:<bootAt>`, value = that process's lane counters. */
  readonly shadowCoverage: string;
  shadowCounter(minute: number): string;
}

export function rmKeys(namespace: string): RmKeys {
  const prefix = `${RM_LAYOUT}:{${namespace}}`;
  const snapPrefix = `${prefix}:snap:`;
  return {
    prefix,
    incarnation: `${prefix}:inc`,
    fenceCopy: `${prefix}:fence:copy`,
    deltas: `${prefix}:deltas`,
    cursor: `${prefix}:cursor`,
    manifest: `${prefix}:snap:manifest`,
    snapPrefix,
    snapSet: (fence, epoch, snapSeq) => `${snapPrefix}${fence}:${epoch}:${snapSeq}:`,
    snapChunk: (fence, epoch, snapSeq, model, column, chunk) => `${snapPrefix}${fence}:${epoch}:${snapSeq}:${model}:${column}:${chunk}`,
    lease: `${prefix}:lease:feeder`,
    fenceAuthority: `${prefix}:fence:authority`,
    killswitch: `${prefix}:killswitch`,
    commands: `${prefix}:cmd`,
    lastCommand: `${prefix}:cmd:last`,
    fleet: `${prefix}:fleet`,
    shadowCoverage: `${prefix}:shadowcov`,
    shadowCounter: (minute) => `${prefix}:shadow:${minute}`,
  };
}

/** `{fence}:{epoch}:{snapSeq}` of a snapshot chunk key, or undefined for any other key. */
export function snapSetOf(keys: RmKeys, key: string): string | undefined {
  if (!key.startsWith(keys.snapPrefix) || key === keys.manifest) return undefined;
  const parts = key.slice(keys.snapPrefix.length).split(':');
  return parts.length >= 3 && parts.slice(0, 3).every((p) => /^\d+$/.test(p)) ? parts.slice(0, 3).join(':') : undefined;
}
