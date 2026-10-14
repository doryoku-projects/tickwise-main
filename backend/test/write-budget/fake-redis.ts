/*
 * A tiny in-memory stand-in for the ioredis surface the write budget uses:
 * strings with PX, hashes, lists, SET NX, pipelines, and EVAL of the three
 * scripts it sends (ACQUIRE_SCRIPT emulated through the TS reference model
 * exactly as the Lua lays out its hash; RedisLease's renew/release). The real
 * Lua is checked against the model by the opt-in `redis-contract.spec.ts`.
 */
import { RELEASE_SCRIPT, RENEW_SCRIPT } from '../../src/common/redis-lease.js';
import { ACQUIRE_SCRIPT } from '../../src/common/write-budget.js';
import { htbAcquire, type HtbState } from '../../src/common/write-budget-model.js';
import { WRITE_LANES, type WriteLane } from '../../src/common/write-lane.js';

type Value = { kind: 'string'; v: string } | { kind: 'hash'; v: Map<string, string> } | { kind: 'list'; v: string[] };

export class FakeRedis {
  status = 'ready';
  readonly store = new Map<string, Value>();
  readonly expiry = new Map<string, number>();
  readonly calls: string[] = [];
  /** Throw on every command (Redis down). */
  failing = false;

  constructor(private readonly clock: () => number) {}

  private live(key: string): Value | undefined {
    const at = this.expiry.get(key);
    if (at !== undefined && at <= this.clock()) {
      this.store.delete(key);
      this.expiry.delete(key);
    }
    return this.store.get(key);
  }

  private check(name: string): void {
    this.calls.push(name);
    if (this.failing) throw new Error('redis down');
  }

  private hash(key: string, create = false): Map<string, string> | undefined {
    const value = this.live(key);
    if (value?.kind === 'hash') return value.v;
    if (!create) return undefined;
    const map = new Map<string, string>();
    this.store.set(key, { kind: 'hash', v: map });
    return map;
  }

  private list(key: string, create = false): string[] | undefined {
    const value = this.live(key);
    if (value?.kind === 'list') return value.v;
    if (!create) return undefined;
    const arr: string[] = [];
    this.store.set(key, { kind: 'list', v: arr });
    return arr;
  }

  // ── commands ──
  async get(key: string): Promise<string | null> {
    this.check('get');
    const value = this.live(key);
    return value?.kind === 'string' ? value.v : null;
  }

  async set(key: string, val: string, ...args: Array<string | number>): Promise<'OK' | null> {
    this.check('set');
    return this.setSync(key, val, args);
  }

  private setSync(key: string, val: string, args: Array<string | number>): 'OK' | null {
    const upper = args.map((a) => String(a).toUpperCase());
    if (upper.includes('NX') && this.live(key) !== undefined) return null;
    this.store.set(key, { kind: 'string', v: String(val) });
    this.expiry.delete(key);
    const px = upper.indexOf('PX');
    if (px >= 0) this.expiry.set(key, this.clock() + Number(args[px + 1]));
    return 'OK';
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.check('hgetall');
    return Object.fromEntries(this.hash(key)?.entries() ?? []);
  }

  async hmget(key: string, ...fields: string[]): Promise<Array<string | null>> {
    this.check('hmget');
    const h = this.hash(key);
    return fields.map((f) => h?.get(f) ?? null);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.check('lrange');
    const l = this.list(key) ?? [];
    const end = stop < 0 ? l.length + stop + 1 : stop + 1;
    return l.slice(start, end);
  }

  async eval(script: string, numKeys: number, ...rest: Array<string | number>): Promise<unknown> {
    this.check('eval');
    const keys = rest.slice(0, numKeys).map(String);
    const args = rest.slice(numKeys).map(String);
    if (script === ACQUIRE_SCRIPT) return this.acquire(keys, args);
    if (script === RENEW_SCRIPT) {
      if ((await this.getRaw(keys[0]!)) !== args[0]) return 0;
      this.expiry.set(keys[0]!, this.clock() + Number(args[1]));
      return 1;
    }
    if (script === RELEASE_SCRIPT) {
      if ((await this.getRaw(keys[0]!)) !== args[0]) return 0;
      this.store.delete(keys[0]!);
      this.expiry.delete(keys[0]!);
      return 1;
    }
    throw new Error('unknown script');
  }

  private async getRaw(key: string): Promise<string | null> {
    const value = this.live(key);
    return value?.kind === 'string' ? value.v : null;
  }

  /** ACQUIRE_SCRIPT, through the model, with the Lua's hash layout and TTLs. */
  private acquire(keys: string[], args: string[]): unknown {
    const [stateKey, rateKey, minuteKey] = keys as [string, string, string];
    const lane = args[0] as WriteLane;
    const units = Number(args[1]);
    const maxWait = Number(args[2]);
    const fallback = Number(args[3]);
    const laneCap = Number(args[4]);
    const observe = args[5] === '1';
    const ttl = Number(args[6]);
    const minuteTtl = Number(args[7]);
    const n = Number(args[8]);
    const shares = {} as Record<WriteLane, number>;
    for (let i = 1; i <= n; i++) shares[args[7 + 2 * i] as WriteLane] = Number(args[8 + 2 * i]);
    if (!WRITE_LANES.includes(lane)) throw new Error(`unknown lane ${lane}`);
    const now = this.clock();
    const stored = Number((this.live(rateKey) as { v: string } | undefined)?.v);
    const present = Number.isFinite(stored) && stored > 0;
    const rate = present ? stored : fallback;
    const h = this.hash(stateKey);
    let prev: HtbState | undefined;
    if (h?.get('ts') !== undefined) {
      const lanes = {} as Record<WriteLane, number>;
      for (const l of WRITE_LANES) {
        const raw = h.get(`b:${l}`);
        lanes[l] = raw === undefined ? shares[l] * rate : Number(raw);
      }
      const caps: Partial<Record<WriteLane, number>> = {};
      const c = h.get(`c:${lane}`);
      if (c !== undefined) caps[lane] = Number(c);
      prev = { ts: Number(h.get('ts')), g: Number(h.get('g') ?? rate), lanes, caps };
    }
    const { state, wait } = htbAcquire(prev, now, lane, units, maxWait, { rate, shares, laneCap, observe });
    const out = this.hash(stateKey, true)!;
    out.set('ts', String(state.ts));
    out.set('g', String(state.g));
    for (const l of WRITE_LANES) out.set(`b:${l}`, String(state.lanes[l]));
    if (state.caps[lane] !== undefined) out.set(`c:${lane}`, String(state.caps[lane]));
    let longest = 0;
    for (const l of WRITE_LANES) {
      const lr = shares[l] * rate;
      if (state.lanes[l] < 0 && lr > 0) longest = Math.max(longest, Math.ceil((-state.lanes[l] / lr) * 1000));
    }
    this.expiry.set(stateKey, now + ttl + longest);
    if (wait >= 0) {
      const m = this.hash(minuteKey, true)!;
      m.set('all', String(Number(m.get('all') ?? 0) + units));
      m.set(lane, String(Number(m.get(lane) ?? 0) + units));
      this.expiry.set(minuteKey, now + minuteTtl * 1000);
    }
    return [wait, String(rate), present ? 1 : 0, String(state.lanes[lane])];
  }

  pipeline(): FakePipeline {
    return new FakePipeline(this);
  }

  // Synchronous bodies the pipeline replays.
  run(cmd: string, args: unknown[]): unknown {
    this.check(cmd);
    switch (cmd) {
      case 'lpush': {
        const l = this.list(String(args[0]), true)!;
        for (const v of args.slice(1)) l.unshift(String(v));
        return l.length;
      }
      case 'ltrim': {
        const l = this.list(String(args[0]));
        if (!l) return 'OK';
        const start = Number(args[1]);
        const stop = Number(args[2]);
        const kept = l.slice(start, stop < 0 ? l.length + stop + 1 : stop + 1);
        l.length = 0;
        l.push(...kept);
        return 'OK';
      }
      case 'pexpire':
        if (this.live(String(args[0])) === undefined) return 0;
        this.expiry.set(String(args[0]), this.clock() + Number(args[1]));
        return 1;
      case 'set':
        return this.setSync(String(args[0]), String(args[1]), args.slice(2) as Array<string | number>);
      case 'hset': {
        const h = this.hash(String(args[0]), true)!;
        const obj = args[1] as Record<string, string>;
        for (const [k, v] of Object.entries(obj)) h.set(k, String(v));
        return Object.keys(obj).length;
      }
      case 'lrange': {
        const l = this.list(String(args[0])) ?? [];
        const stop = Number(args[2]);
        return l.slice(Number(args[1]), stop < 0 ? l.length + stop + 1 : stop + 1);
      }
      case 'hmget': {
        const h = this.hash(String(args[0]));
        return (args.slice(1) as string[]).map((f) => h?.get(f) ?? null);
      }
      default:
        throw new Error(`fake redis: ${cmd} not supported`);
    }
  }
}

export class FakePipeline {
  private readonly cmds: Array<[string, unknown[]]> = [];
  constructor(private readonly redis: FakeRedis) {}
  lpush(...a: unknown[]) {
    this.cmds.push(['lpush', a]);
    return this;
  }
  ltrim(...a: unknown[]) {
    this.cmds.push(['ltrim', a]);
    return this;
  }
  pexpire(...a: unknown[]) {
    this.cmds.push(['pexpire', a]);
    return this;
  }
  set(...a: unknown[]) {
    this.cmds.push(['set', a]);
    return this;
  }
  hset(...a: unknown[]) {
    this.cmds.push(['hset', a]);
    return this;
  }
  lrange(...a: unknown[]) {
    this.cmds.push(['lrange', a]);
    return this;
  }
  hmget(...a: unknown[]) {
    this.cmds.push(['hmget', a]);
    return this;
  }
  async exec(): Promise<Array<[Error | null, unknown]>> {
    return this.cmds.map(([cmd, args]) => {
      try {
        return [null, this.redis.run(cmd, args)] as [null, unknown];
      } catch (err) {
        return [err as Error, null] as [Error, null];
      }
    });
  }
}

/** A fake clock with a sleep that advances it. */
export function fakeClock(start = 1_760_000_000_000) {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}
