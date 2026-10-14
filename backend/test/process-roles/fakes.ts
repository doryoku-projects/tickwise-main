import { ACQUIRE_FENCED_SCRIPT, RENEW_OWNED_SCRIPT, type LeaseRunnerClock } from '../../src/common/lease-runner.js';
import { RELEASE_SCRIPT } from '../../src/common/redis-lease.js';

/** A manual clock: `sleep` resolves only when `advance` passes its deadline (or its signal aborts). */
export class ManualClock implements LeaseRunnerClock {
  t = 1_000_000;
  private timers: Array<{ at: number; resolve: () => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  now = (): number => this.t;

  sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer: { at: number; resolve: () => void; signal?: AbortSignal; onAbort?: () => void } = {
        at: this.t + Math.max(0, ms),
        resolve,
        signal,
      };
      timer.onAbort = () => {
        this.timers = this.timers.filter((x) => x !== timer);
        resolve();
      };
      signal?.addEventListener('abort', timer.onAbort, { once: true });
      this.timers.push(timer);
    });

  get pending(): number {
    return this.timers.length;
  }

  /** Move time forward in small steps, letting promise chains run between them. */
  async advance(ms: number, step = 1_000): Promise<void> {
    const end = this.t + ms;
    await flush();
    while (this.t < end) {
      this.t = Math.min(end, this.t + step);
      const due = this.timers.filter((x) => x.at <= this.t);
      this.timers = this.timers.filter((x) => x.at > this.t);
      for (const d of due) {
        if (d.signal && d.onAbort) d.signal.removeEventListener('abort', d.onAbort);
        d.resolve();
      }
      await flush();
    }
  }
}

export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/**
 * Enough Redis for the lease scripts, status fan-in and the memory sample.
 * TTLs follow the injected clock.
 */
export class FakeLeaseRedis {
  readonly kv = new Map<string, { v: string; exp?: number }>();
  readonly zsets = new Map<string, Map<string, number>>();
  /** EXPIRE seconds last set per key (the fake does not expire ZSETs; specs read the value). */
  readonly ttls = new Map<string, number>();
  /** Every command name, in order. */
  readonly calls: string[] = [];
  failing = false;
  info_memory = 'used_memory:100\r\nmaxmemory:1000\r\n';

  constructor(private readonly now: () => number) {}

  private live(key: string): { v: string; exp?: number } | undefined {
    const e = this.kv.get(key);
    if (!e) return undefined;
    if (e.exp !== undefined && e.exp <= this.now()) {
      this.kv.delete(key);
      return undefined;
    }
    return e;
  }

  private guard(name: string): void {
    this.calls.push(name);
    if (this.failing) throw new Error('redis down');
  }

  async get(key: string): Promise<string | null> {
    this.guard('get');
    return this.live(key)?.v ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    this.guard('set');
    return this.setSync(key, value, args);
  }

  private setSync(key: string, value: string, args: Array<string | number>): 'OK' | null {
    let exp: number | undefined;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === 'NX') nx = true;
      if (a === 'PX') exp = this.now() + Number(args[++i]);
      if (a === 'EX') exp = this.now() + Number(args[++i]) * 1000;
    }
    if (nx && this.live(key)) return null;
    this.kv.set(key, { v: value, exp });
    return 'OK';
  }

  async exists(key: string): Promise<number> {
    this.guard('exists');
    return this.live(key) ? 1 : 0;
  }

  async info(): Promise<string> {
    this.guard('info');
    return this.info_memory;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    this.guard('mget');
    return keys.map((k) => this.live(k)?.v ?? null);
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    this.guard('zrangebyscore');
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .filter(([, s]) => s >= lo && s <= hi)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }

  multi() {
    const ops: Array<() => unknown> = [];
    const chain = {
      set: (k: string, v: string, ...args: Array<string | number>) => {
        ops.push(() => this.setSync(k, v, args));
        return chain;
      },
      zadd: (k: string, score: number, member: string) => {
        ops.push(() => {
          const z = this.zsets.get(k) ?? new Map<string, number>();
          z.set(member, score);
          this.zsets.set(k, z);
        });
        return chain;
      },
      zremrangebyscore: (k: string, min: string | number, max: string | number) => {
        ops.push(() => {
          const z = this.zsets.get(k);
          if (!z) return;
          const lo = min === '-inf' ? -Infinity : Number(min);
          const hi = Number(max);
          for (const [m, s] of z) if (s >= lo && s <= hi) z.delete(m);
        });
        return chain;
      },
      expire: (k: string, seconds: number) => {
        ops.push(() => {
          this.ttls.set(k, seconds);
          return 1;
        });
        return chain;
      },
      del: (k: string) => {
        ops.push(() => (this.kv.delete(k) ? 1 : 0));
        return chain;
      },
      zrem: (k: string, member: string) => {
        ops.push(() => (this.zsets.get(k)?.delete(member) ? 1 : 0));
        return chain;
      },
      exec: async () => {
        this.guard('exec');
        return ops.map((op) => [null, op()]);
      },
    };
    return chain;
  }

  async eval(script: string, _numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    this.guard('eval');
    if (script === ACQUIRE_FENCED_SCRIPT) {
      const [key, fenceKey, owner, ttl] = args.map(String);
      if (!this.live(key!)) {
        this.kv.set(key!, { v: owner!, exp: this.now() + Number(ttl) });
        const next = Number(this.live(fenceKey!)?.v ?? 0) + 1;
        this.kv.set(fenceKey!, { v: String(next) });
        return [1, next];
      }
      if (this.live(key!)!.v === owner) {
        this.kv.get(key!)!.exp = this.now() + Number(ttl);
        return [2, Number(this.live(fenceKey!)?.v ?? 0)];
      }
      return [0, 0];
    }
    if (script === RENEW_OWNED_SCRIPT) {
      const [key, owner, ttl] = args.map(String);
      const e = this.live(key!);
      if (e && e.v === owner) {
        e.exp = this.now() + Number(ttl);
        return 1;
      }
      return 0;
    }
    if (script === RELEASE_SCRIPT) {
      const [key, owner] = args.map(String);
      const e = this.live(key!);
      if (e && e.v === owner) {
        this.kv.delete(key!);
        return 1;
      }
      return 0;
    }
    throw new Error('unknown script');
  }

  /** Force another owner onto a key (simulates a takeover). */
  steal(key: string, owner = 'thief', ttlMs = 30_000): void {
    this.kv.set(key, { v: owner, exp: this.now() + ttlMs });
  }
}
