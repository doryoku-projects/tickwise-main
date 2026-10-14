/*
 * An in-memory stand-in for the Redis commands the fee package sends
 * (`FeeRedis`): sets, sorted sets, hashes, strings with PX, streams with
 * MAXLEN trimming, and EVAL of the four fee-signal scripts — each emulated in
 * TypeScript step for step as its Lua is written. The REAL Lua is checked
 * against `MemoryFeeSignals` by the opt-in `signals-redis-contract.spec.ts`.
 */
import {
  MARK_DIRTY_SCRIPT,
  MARK_VIEWED_SCRIPT,
  REQUEUE_VIEWS_SCRIPT,
  SET_MODE_SCRIPT,
  TAKE_DIRTY_SCRIPT,
  type FeeRedis,
} from '../../src/sync/fee-signals.js';

type Value =
  | { kind: 'string'; v: string }
  | { kind: 'set'; v: Set<string> }
  | { kind: 'zset'; v: Map<string, number> }
  | { kind: 'hash'; v: Map<string, string> }
  | { kind: 'stream'; v: Array<[string, string[]]>; seq: number; lastMs: number };

export class FakeFeeRedis implements FeeRedis {
  readonly store = new Map<string, Value>();
  readonly expiry = new Map<string, number>();
  readonly calls: string[] = [];
  /** Throw on every command (Redis down). */
  failing = false;
  /** Throw on these commands only. */
  readonly failOn = new Set<string>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  private check(name: string): void {
    this.calls.push(name);
    if (this.failing || this.failOn.has(name)) throw new Error(`redis down (${name})`);
  }

  private live(key: string): Value | undefined {
    const at = this.expiry.get(key);
    if (at !== undefined && at <= this.clock()) {
      this.store.delete(key);
      this.expiry.delete(key);
    }
    return this.store.get(key);
  }

  private set(key: string, create = false): Set<string> | undefined {
    const v = this.live(key);
    if (v?.kind === 'set') return v.v;
    if (!create) return undefined;
    const s = new Set<string>();
    this.store.set(key, { kind: 'set', v: s });
    return s;
  }

  private zset(key: string, create = false): Map<string, number> | undefined {
    const v = this.live(key);
    if (v?.kind === 'zset') return v.v;
    if (!create) return undefined;
    const z = new Map<string, number>();
    this.store.set(key, { kind: 'zset', v: z });
    return z;
  }

  private hash(key: string, create = false): Map<string, string> | undefined {
    const v = this.live(key);
    if (v?.kind === 'hash') return v.v;
    if (!create) return undefined;
    const h = new Map<string, string>();
    this.store.set(key, { kind: 'hash', v: h });
    return h;
  }

  private exists(key: string): boolean {
    const v = this.live(key);
    if (!v) return false;
    if (v.kind === 'set' || v.kind === 'zset' || v.kind === 'hash') {
      if (v.v.size === 0) {
        this.store.delete(key);
        return false;
      }
    }
    return true;
  }

  private pexpire(key: string, ms: number): void {
    if (this.exists(key)) this.expiry.set(key, this.clock() + ms);
  }

  private incrRaw(key: string): number {
    const v = this.live(key);
    const n = (v?.kind === 'string' ? Number(v.v) : 0) + 1;
    this.store.set(key, { kind: 'string', v: String(n) });
    return n;
  }

  // ── commands ──
  async eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    this.check('eval');
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);
    const num = (s: string) => (s === 'inf' ? Number.POSITIVE_INFINITY : Number(s));
    if (script === MARK_VIEWED_SCRIPT) {
      if (this.exists(keys[1]!)) return 0;
      const views = this.set(keys[0]!);
      if (views?.has(argv[0]!)) return 2;
      if ((views?.size ?? 0) >= Number(argv[1])) return -1;
      this.set(keys[0]!, true)!.add(argv[0]!);
      this.pexpire(keys[0]!, Number(argv[3]));
      this.store.set(keys[1]!, { kind: 'string', v: '1' });
      this.expiry.set(keys[1]!, this.clock() + Number(argv[2]));
      return 1;
    }
    if (script === REQUEUE_VIEWS_SCRIPT) {
      const cap = Number(argv[0]);
      for (let i = 3; i < argv.length; i++) {
        const id = argv[i]!;
        const views = this.set(keys[0]!);
        if (views?.has(id)) continue;
        if ((views?.size ?? 0) < cap) this.set(keys[0]!, true)!.add(id);
        else {
          this.store.delete(argv[1]! + id);
          this.expiry.delete(argv[1]! + id);
        }
      }
      this.pexpire(keys[0]!, Number(argv[2]));
      return 0;
    }
    if (script === MARK_DIRTY_SCRIPT) {
      const [seqLive, blkLive, seqBf, blkBf, ctr] = keys as [string, string, string, string, string];
      const lane = argv[0];
      const liveCap = Number(argv[1]);
      const bfCap = Number(argv[2]);
      let dropped = 0;
      for (let i = 4; i + 1 < argv.length; i += 2) {
        const id = argv[i]!;
        const b = argv[i + 1]!;
        const inLive = this.hash(blkLive)?.get(id);
        if (inLive !== undefined) {
          if (num(b) > num(inLive)) this.hash(blkLive, true)!.set(id, b);
          continue;
        }
        const inBf = this.hash(blkBf)?.get(id);
        if (lane === 'backfill') {
          if (inBf !== undefined) {
            if (num(b) > num(inBf)) this.hash(blkBf, true)!.set(id, b);
          } else if ((this.zset(seqBf)?.size ?? 0) >= bfCap) {
            dropped++;
          } else {
            this.zset(seqBf, true)!.set(id, this.incrRaw(ctr));
            this.hash(blkBf, true)!.set(id, b);
          }
        } else if ((this.zset(seqLive)?.size ?? 0) >= liveCap) {
          if (inBf !== undefined) {
            if (num(b) > num(inBf)) this.hash(blkBf, true)!.set(id, b);
          } else dropped++;
        } else {
          let w = b;
          if (inBf !== undefined) {
            this.zset(seqBf)?.delete(id);
            this.hash(blkBf)?.delete(id);
            if (num(inBf) > num(b)) w = inBf;
          }
          this.zset(seqLive, true)!.set(id, this.incrRaw(ctr));
          this.hash(blkLive, true)!.set(id, w);
        }
      }
      for (const k of keys) this.pexpire(k, Number(argv[3]));
      return dropped;
    }
    if (script === TAKE_DIRTY_SCRIPT) {
      const z = this.zset(keys[0]!);
      const h = this.hash(keys[1]!);
      const out: string[] = [];
      if (!z) return out;
      const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]).slice(0, Number(argv[0]));
      for (const [id] of sorted) {
        z.delete(id);
        const b = h?.get(id);
        h?.delete(id);
        out.push(id, b ?? 'inf');
      }
      return out;
    }
    if (script === SET_MODE_SCRIPT) {
      this.store.set(keys[0]!, { kind: 'string', v: argv[0]! });
      this.expiry.set(keys[0]!, this.clock() + Number(argv[1]));
      return 1;
    }
    throw new Error('unknown script');
  }

  async spop(key: string, count: number): Promise<string[]> {
    this.check('spop');
    const s = this.set(key);
    if (!s) return [];
    const out = [...s].slice(0, count);
    for (const id of out) s.delete(id);
    return out;
  }

  async scard(key: string): Promise<number> {
    this.check('scard');
    return this.set(key)?.size ?? 0;
  }

  async zcard(key: string): Promise<number> {
    this.check('zcard');
    return this.zset(key)?.size ?? 0;
  }

  async incr(key: string): Promise<number> {
    this.check('incr');
    return this.incrRaw(key);
  }

  async get(key: string): Promise<string | null> {
    this.check('get');
    const v = this.live(key);
    return v?.kind === 'string' ? v.v : null;
  }

  async xadd(key: string, ...args: Array<string | number>): Promise<string | null> {
    this.check('xadd');
    let i = 0;
    let maxlen: number | undefined;
    if (args[0] === 'MAXLEN') {
      i = args[1] === '~' ? 3 : 2;
      maxlen = Number(args[i - 1]);
    }
    if (args[i] !== '*') throw new Error('fake xadd needs *');
    const fields = args.slice(i + 1).map(String);
    let v = this.live(key);
    if (!v || v.kind !== 'stream') {
      v = { kind: 'stream', v: [], seq: 0, lastMs: 0 };
      this.store.set(key, v);
    }
    const ms = Math.max(this.clock(), v.lastMs);
    v.seq = ms === v.lastMs ? v.seq + 1 : 0;
    v.lastMs = ms;
    const id = `${ms}-${v.seq}`;
    v.v.push([id, fields]);
    if (maxlen !== undefined && v.v.length > maxlen) v.v.splice(0, v.v.length - maxlen);
    return id;
  }

  private stream(key: string): Array<[string, string[]]> | undefined {
    const v = this.live(key);
    return v?.kind === 'stream' ? v.v : undefined;
  }

  async xrange(key: string, _start: string, _end: string, _count: 'COUNT', n: number): Promise<Array<[string, string[]]>> {
    this.check('xrange');
    return (this.stream(key) ?? []).slice(0, n);
  }

  async xrevrange(key: string, _end: string, _start: string, _count: 'COUNT', n: number): Promise<Array<[string, string[]]>> {
    this.check('xrevrange');
    return [...(this.stream(key) ?? [])].reverse().slice(0, n);
  }

  async xread(...args: Array<string | number>): Promise<Array<[string, Array<[string, string[]]>]> | null> {
    this.check('xread');
    let count = Number.POSITIVE_INFINITY;
    let i = 0;
    if (args[0] === 'COUNT') {
      count = Number(args[1]);
      i = 2;
    }
    if (args[i] !== 'STREAMS') throw new Error('fake xread: STREAMS expected');
    const rest = args.slice(i + 1).map(String);
    const n = rest.length / 2;
    const out: Array<[string, Array<[string, string[]]>]> = [];
    for (let k = 0; k < n; k++) {
      const key = rest[k]!;
      const after = rest[n + k]!;
      const entries = (this.stream(key) ?? []).filter(([id]) => cmpId(id, after) > 0).slice(0, count);
      if (entries.length > 0) out.push([key, entries]);
    }
    return out.length > 0 ? out : null;
  }

  /** Drop a key (a redis-models restart). */
  del(key: string): void {
    this.store.delete(key);
    this.expiry.delete(key);
  }
}

function cmpId(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  if (am !== bm) return am! - bm!;
  return (as ?? 0) - (bs ?? 0);
}
