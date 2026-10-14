/**
 * Cluster times and change-stream resume tokens (design §1 F4).
 *
 * A cluster time is a BSON Timestamp: `t` seconds since the epoch and `i` an
 * increment within that second. It is the order of everything in the oplog,
 * and a change stream delivers its events in that order.
 *
 * A resume token's `_data` is a hex KeyString whose first byte is `82` (the
 * KeyString type byte of a Timestamp) followed by the event's cluster time as
 * 8 big-endian bytes (`t` then `i`) — measured on the rig (MongoDB 8.0.32)
 * for event tokens AND for the idle stream's `postBatchResumeToken`. So the
 * high-water mark of a stream is known exactly without a server round trip.
 */

export interface ClusterTime {
  /** Seconds since the epoch. */
  readonly t: number;
  /** Increment within the second. */
  readonly i: number;
}

export const ZERO_TIME: ClusterTime = Object.freeze({ t: 0, i: 0 });

export function compareTimes(a: ClusterTime, b: ClusterTime): number {
  return a.t !== b.t ? a.t - b.t : a.i - b.i;
}

export function maxTime(a: ClusterTime, b: ClusterTime): ClusterTime {
  return compareTimes(a, b) >= 0 ? a : b;
}

/** `t:i` — the form carried in delta entries and manifests. */
export function formatTime(time: ClusterTime): string {
  return `${time.t}:${time.i}`;
}

export function parseTime(text: string | undefined | null): ClusterTime | undefined {
  if (!text) return undefined;
  const at = text.indexOf(':');
  if (at < 0) return undefined;
  const t = Number(text.slice(0, at));
  const i = Number(text.slice(at + 1));
  return Number.isInteger(t) && Number.isInteger(i) && t >= 0 && i >= 0 ? { t, i } : undefined;
}

/** Wall-clock milliseconds of a cluster time (second resolution). */
export function timeToMs(time: ClusterTime): number {
  return time.t * 1000;
}

/** A cluster time for a wall-clock instant (increment 0). */
export function timeFromMs(ms: number): ClusterTime {
  return { t: Math.max(0, Math.floor(ms / 1000)), i: 0 };
}

/**
 * Any BSON Timestamp the driver hands back (bson 7 exposes `t`/`i`; older
 * builds `getHighBits`/`getLowBits` or `high`/`low`), or undefined.
 */
export function timeFromBson(value: unknown): ClusterTime | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as {
    t?: unknown;
    i?: unknown;
    high?: unknown;
    low?: unknown;
    getHighBits?: () => number;
    getLowBits?: () => number;
  };
  if (typeof record.t === 'number' && typeof record.i === 'number') return { t: record.t >>> 0, i: record.i >>> 0 };
  if (typeof record.getHighBits === 'function' && typeof record.getLowBits === 'function') {
    return { t: record.getHighBits() >>> 0, i: record.getLowBits() >>> 0 };
  }
  if (typeof record.high === 'number' && typeof record.low === 'number') return { t: record.high >>> 0, i: record.low >>> 0 };
  return undefined;
}

/**
 * The cluster time inside a resume token: its `_data` hex (or the token
 * object). Undefined when the token is not in the `82`-prefixed form.
 */
export function tokenTime(token: string | { _data?: unknown } | null | undefined): ClusterTime | undefined {
  const data = typeof token === 'string' ? token : typeof token?._data === 'string' ? token._data : undefined;
  if (!data || data.length < 18 || data.slice(0, 2).toLowerCase() !== '82') return undefined;
  const t = Number.parseInt(data.slice(2, 10), 16);
  const i = Number.parseInt(data.slice(10, 18), 16);
  return Number.isFinite(t) && Number.isFinite(i) ? { t: t >>> 0, i: i >>> 0 } : undefined;
}

/** The `_data` hex of a resume token object, or undefined. */
export function tokenData(token: unknown): string | undefined {
  if (typeof token === 'string') return token;
  const data = (token as { _data?: unknown } | null | undefined)?._data;
  return typeof data === 'string' ? data : undefined;
}

/**
 * Order of two resume tokens by their cluster time (ties compare equal — two
 * events of one transaction share a cluster time; the token suffix orders
 * them, which this does not need: a token is only ever compared to a
 * cluster time or to the stream's own later tokens).
 */
export function compareTokens(a: string, b: string): number {
  const ta = tokenTime(a);
  const tb = tokenTime(b);
  if (!ta || !tb) return 0;
  return compareTimes(ta, tb);
}
