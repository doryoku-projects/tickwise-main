/*
 * In-memory stand-ins for the batched usage writer's two stores.
 *
 * `FakeUsageRedis` emulates, step for step, the Lua scripts in
 * `src/billing/usage-flush.ts` plus the plain commands the service sends. The
 * REAL Lua is checked against this fake by the opt-in `redis-contract.spec.ts`
 * (`USAGE_FLUSH_TEST_REDIS_URL`).
 *
 * `FakeMongoCollection` applies `updateOne` / `bulkWrite` with real upsert
 * semantics on an equality filter (`$inc`, `$setOnInsert`), so a spec asserts
 * the ROWS a customer would read, not what a spy was told.
 */
import { Types } from 'mongoose';
import {
  USAGE_ACK_SCRIPT,
  USAGE_CLAIM_SCRIPT,
  USAGE_INCR_SCRIPT,
  USAGE_RETIRE_SCRIPT,
  USAGE_TAKEOVER_SCRIPT,
  USAGE_TOUCH_SCRIPT,
} from '../../src/billing/usage-flush.js';
import type { UsageBufferRedis } from '../../src/billing/usage-flush.service.js';

export class FakeUsageRedis implements UsageBufferRedis {
  readonly hashes = new Map<string, Map<string, number>>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly calls: string[] = [];
  /** Op markers set by INCR and ACK markers (TTL not modelled — specs run well inside it). */
  readonly ops = new Set<string>();
  failing = false;
  /** The error a failing command throws (default: an AMBIGUOUS one — the outcome is unknown to the caller). */
  failWith: (name: string) => Error = (name) => new Error(`redis down (${name})`);
  /** Called before each command runs (interleaving hook). */
  before?: (name: string) => Promise<void> | void;
  /** Called after an EVAL ran, before its reply is returned (interleaving hook). */
  after?: (name: string, reply: unknown) => Promise<void> | void;

  private async check(name: string): Promise<void> {
    this.calls.push(name);
    await this.before?.(name);
    if (this.failing) throw this.failWith(name);
  }

  private zset(key: string): Map<string, number> {
    let z = this.zsets.get(key);
    if (!z) {
      z = new Map();
      this.zsets.set(key, z);
    }
    return z;
  }

  private dropEmpty(key: string): void {
    const h = this.hashes.get(key);
    if (h && h.size === 0) this.hashes.delete(key);
    const z = this.zsets.get(key);
    if (z && z.size === 0) this.zsets.delete(key);
  }

  async eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const reply = await this.evalInner(script, numKeys, ...args);
    await this.after?.(this.scriptName(script), reply);
    return reply;
  }

  private scriptName(script: string): string {
    return script === USAGE_INCR_SCRIPT
      ? 'INCR'
      : script === USAGE_CLAIM_SCRIPT
        ? 'CLAIM'
        : script === USAGE_TAKEOVER_SCRIPT
          ? 'TAKEOVER'
          : script === USAGE_TOUCH_SCRIPT
            ? 'TOUCH'
            : script === USAGE_ACK_SCRIPT
              ? 'ACK'
              : script === USAGE_RETIRE_SCRIPT
                ? 'RETIRE'
                : 'UNKNOWN';
  }

  private async evalInner(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const name =
      script === USAGE_INCR_SCRIPT
        ? 'INCR'
        : script === USAGE_CLAIM_SCRIPT
          ? 'CLAIM'
          : script === USAGE_TAKEOVER_SCRIPT
            ? 'TAKEOVER'
            : script === USAGE_TOUCH_SCRIPT
              ? 'TOUCH'
              : script === USAGE_ACK_SCRIPT
                ? 'ACK'
                : script === USAGE_RETIRE_SCRIPT
                  ? 'RETIRE'
                  : 'UNKNOWN';
    await this.check(name);
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);
    switch (name) {
      case 'INCR': {
        if (this.ops.has(keys[1])) return 0;
        this.ops.add(keys[1]);
        const h = this.hashes.get(keys[0]) ?? new Map<string, number>();
        for (let i = 1; i < argv.length; i += 2) {
          const delta = Number(argv[i + 1]);
          if (!Number.isInteger(delta)) throw new Error('ERR value is not an integer or out of range');
          h.set(argv[i], (h.get(argv[i]) ?? 0) + delta);
        }
        this.hashes.set(keys[0], h);
        return 1;
      }
      case 'CLAIM': {
        const live = this.hashes.get(keys[0]);
        if (!live) return 0;
        if ((this.zsets.get(keys[2])?.size ?? 0) > 0) return -3;
        if (this.hashes.has(keys[1])) return -2;
        this.hashes.delete(keys[0]);
        this.hashes.set(keys[1], live);
        this.zset(keys[2]).set(keys[1], Number(argv[0]));
        return 1;
      }
      case 'TAKEOVER': {
        if (this.hashes.has(keys[2])) return -2;
        const z = this.zset(keys[0]);
        const s = z.get(keys[1]);
        if (s === undefined || s > Number(argv[1])) {
          this.dropEmpty(keys[0]);
          return 0;
        }
        z.delete(keys[1]);
        const h = this.hashes.get(keys[1]);
        if (!h) {
          this.dropEmpty(keys[0]);
          return -1;
        }
        this.hashes.delete(keys[1]);
        this.hashes.set(keys[2], h);
        z.set(keys[2], Number(argv[0]));
        return 1;
      }
      case 'TOUCH': {
        const z = this.zset(keys[0]);
        if (!z.has(keys[1])) {
          this.dropEmpty(keys[0]);
          return 0;
        }
        z.set(keys[1], Number(argv[0]));
        return 1;
      }
      case 'ACK': {
        if (this.ops.has(keys[2])) return 1;
        const z = this.zset(keys[0]);
        if (!z.has(keys[1])) {
          this.dropEmpty(keys[0]);
          return 0;
        }
        const h = this.hashes.get(keys[1]);
        for (const f of argv.slice(1)) h?.delete(f);
        this.dropEmpty(keys[1]);
        if (!this.hashes.has(keys[1])) z.delete(keys[1]);
        this.dropEmpty(keys[0]);
        this.ops.add(keys[2]);
        return 1;
      }
      case 'RETIRE': {
        const z = this.zset(keys[0]);
        if (!z.has(keys[1])) {
          this.dropEmpty(keys[0]);
          return 0;
        }
        if ((this.hashes.get(keys[1])?.size ?? 0) > 0) return 0;
        this.hashes.delete(keys[1]);
        z.delete(keys[1]);
        this.dropEmpty(keys[0]);
        return 1;
      }
      default:
        throw new Error('NOSCRIPT unknown script');
    }
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    await this.check('HGETALL');
    const h = this.hashes.get(key);
    const out: Record<string, string> = {};
    for (const [f, v] of h ?? []) out[f] = String(v);
    return out;
  }

  async zrangebyscore(key: string, min: string | number, max: string | number, _limit: 'LIMIT', offset: number, count: number): Promise<string[]> {
    await this.check('ZRANGEBYSCORE');
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    return [...(this.zsets.get(key) ?? [])]
      .filter(([, s]) => s >= lo && s <= hi)
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      .slice(offset, offset + count)
      .map(([m]) => m);
  }

  async hlen(key: string): Promise<number> {
    await this.check('HLEN');
    return this.hashes.get(key)?.size ?? 0;
  }

  async zcard(key: string): Promise<number> {
    await this.check('ZCARD');
    return this.zsets.get(key)?.size ?? 0;
  }

  /** Sum of every buffered delta for a metric suffix across all hashes (live + claims). */
  totalBuffered(): number {
    let n = 0;
    for (const h of this.hashes.values()) n += h.size;
    return n;
  }
}

type Doc = Record<string, unknown>;

function norm(v: unknown): unknown {
  return v instanceof Types.ObjectId ? v.toHexString() : v;
}

function keyOf(filter: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(filter).sort().map((k) => [k, norm(filter[k])]));
}

export interface BulkCall {
  ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, any>; upsert?: boolean } }>;
  options: unknown;
}

export class FakeMongoCollection {
  readonly docs = new Map<string, Doc>();
  readonly updateOneCalls: Array<{ filter: any; update: any; options: any }> = [];
  readonly bulkCalls: BulkCall[] = [];
  /** Throw this from the next bulkWrite(s): an Error, or a function of the ops. */
  failBulk?: (ops: BulkCall['ops'], call: number) => Error | undefined;
  /** Runs inside bulkWrite after the ops applied (interleaving hook). */
  afterBulk?: (call: number) => Promise<void> | void;
  /** Runs inside bulkWrite BEFORE the ops apply (interleaving hook). */
  beforeBulk?: (call: number) => Promise<void> | void;

  private apply(filter: Record<string, unknown>, update: Record<string, any>, upsert: boolean): 'matched' | 'upserted' | 'none' {
    const k = keyOf(filter);
    let doc = this.docs.get(k);
    let result: 'matched' | 'upserted' = 'matched';
    if (!doc) {
      if (!upsert) return 'none';
      doc = {};
      for (const [f, v] of Object.entries(filter)) doc[f] = norm(v);
      for (const [f, v] of Object.entries(update.$setOnInsert ?? {})) doc[f] = v;
      this.docs.set(k, doc);
      result = 'upserted';
    }
    for (const [f, v] of Object.entries(update.$inc ?? {})) doc[f] = ((doc[f] as number | undefined) ?? 0) + (v as number);
    for (const [f, v] of Object.entries(update.$set ?? {})) doc[f] = v;
    return result;
  }

  updateOne(filter: any, update: any, options: any = {}) {
    this.updateOneCalls.push({ filter, update, options });
    return {
      exec: async () => {
        const r = this.apply(filter, update, options?.upsert === true);
        return { matchedCount: r === 'matched' ? 1 : 0, upsertedCount: r === 'upserted' ? 1 : 0 };
      },
    };
  }

  async bulkWrite(ops: BulkCall['ops'], options: unknown): Promise<unknown> {
    const call = this.bulkCalls.length;
    this.bulkCalls.push({ ops, options });
    await this.beforeBulk?.(call);
    const err = this.failBulk?.(ops, call);
    if (err) {
      const partial = (err as { writeErrors?: Array<{ index: number }> }).writeErrors?.[0]?.index;
      if (typeof partial === 'number') {
        for (const op of ops.slice(0, partial)) this.apply(op.updateOne.filter, op.updateOne.update, op.updateOne.upsert === true);
      }
      throw err;
    }
    for (const op of ops) this.apply(op.updateOne.filter, op.updateOne.update, op.updateOne.upsert === true);
    await this.afterBulk?.(call);
    return { ok: 1 };
  }

  /** Rows without timestamps, sorted, for parity assertions. */
  rows(): Doc[] {
    return [...this.docs.values()]
      .map((d) => ({ ...d }))
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }

  find(match: Record<string, unknown>): Doc | undefined {
    return [...this.docs.values()].find((d) => Object.entries(match).every(([k, v]) => d[k] === norm(v)));
  }
}

/** Let fire-and-forget enqueues land (several macrotask turns). */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}

/** A bulk write error with an ordered write error at `index`. */
export function bulkError(index: number, code: number, message = 'write error'): Error {
  const e = new Error(message) as Error & { writeErrors: Array<{ index: number; code: number }>; code: number };
  e.writeErrors = [{ index, code }];
  e.code = code;
  return e;
}
