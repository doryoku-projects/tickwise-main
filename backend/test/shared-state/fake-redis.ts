/*
 * An in-memory stand-in for the redis-state commands package B uses:
 *   - EVAL of GCRA_SCRIPT / GCRA_PAUSE_SCRIPT, executed by `LocalGcra` (the
 *     script's reference model — the opt-in redis-contract spec proves the
 *     Lua equals it on a real Redis);
 *   - the `rlflxIncr` command rate-limiter-flexible defines, plus DEL;
 *   - PUBLISH / SUBSCRIBE through a shared hub, so two "processes" can talk.
 * `failing = true` makes every command reject (Redis down mid-flight).
 */
import { EventEmitter } from 'node:events';
import { GCRA_PAUSE_SCRIPT, GCRA_SCRIPT, LocalGcra, type GcraRequest } from '../../src/common/redis-gcra.js';

export class FakePubSubHub {
  readonly subscribers = new Set<FakeSubscriber>();
  readonly published: Array<{ channel: string; message: string }> = [];

  subscriber(): FakeSubscriber {
    const sub = new FakeSubscriber(this);
    this.subscribers.add(sub);
    return sub;
  }

  deliver(channel: string, message: string): number {
    this.published.push({ channel, message });
    let n = 0;
    for (const sub of this.subscribers) n += sub.offer(channel, message);
    return n;
  }
}

export class FakeSubscriber extends EventEmitter {
  readonly channels = new Set<string>();
  quitted = false;

  constructor(private readonly hub: FakePubSubHub) {
    super();
  }

  async subscribe(channel: string): Promise<number> {
    this.channels.add(channel);
    return this.channels.size;
  }

  offer(channel: string, message: string): number {
    if (this.quitted || !this.channels.has(channel)) return 0;
    this.emit('message', channel, message);
    return 1;
  }

  async quit(): Promise<'OK'> {
    this.quitted = true;
    this.hub.subscribers.delete(this);
    return 'OK';
  }
}

/** Decode GCRA_SCRIPT's KEYS/ARGV back into the request `gcraArgs` encoded. */
export function decodeGcraCall(nkeys: number, args: string[]): GcraRequest {
  const keys = args.slice(0, nkeys);
  const argv = args.slice(nkeys);
  const n = Number(argv[0]);
  const hasPause = argv[3] === '1';
  const counterBy = Number(argv[4]);
  const buckets = [];
  for (let i = 0; i < n; i++) {
    const base = 6 + 3 * i;
    buckets.push({ key: keys[i], perSec: Number(argv[base]) * 1000, burst: Number(argv[base + 1]), cost: Number(argv[base + 2]) });
  }
  return {
    buckets,
    maxWaitMs: Number(argv[1]),
    ttlMs: Number(argv[2]),
    pauseKey: hasPause ? keys[n] : undefined,
    counter: counterBy > 0 ? { key: keys[n + (hasPause ? 1 : 0)], by: counterBy, ttlSec: Number(argv[5]) } : undefined,
  };
}

export class FakeSharedRedis {
  status = 'ready';
  failing = false;
  readonly gcra: LocalGcra;
  readonly kv = new Map<string, { value: number; expiresAt: number }>();
  readonly evals: GcraRequest[] = [];
  readonly pauses: Array<{ key: string; ms: number }> = [];
  calls = 0;

  constructor(
    private readonly now: () => number = Date.now,
    readonly hub: FakePubSubHub = new FakePubSubHub(),
  ) {
    this.gcra = new LocalGcra(now);
  }

  private check(): void {
    this.calls += 1;
    if (this.failing) throw new Error('fake redis: connection lost');
  }

  async eval(script: string, nkeys: number, ...args: Array<string | number>): Promise<unknown> {
    this.check();
    const strs = args.map(String);
    if (script === GCRA_SCRIPT) {
      const req = decodeGcraCall(nkeys, strs);
      this.evals.push(req);
      const res = this.gcra.take(req);
      if (res.status === 'paused') return [-res.waitMs, 2, 0];
      if (res.status === 'refused') return [-res.waitMs, 0, 0];
      return [res.waitMs, 1, res.counter ?? 0];
    }
    if (script === GCRA_PAUSE_SCRIPT) {
      this.pauses.push({ key: strs[0], ms: Number(strs[1]) });
      this.gcra.pause(strs[0], Number(strs[1]));
      return 1;
    }
    throw new Error('fake redis: unknown script');
  }

  // rate-limiter-flexible (ioredis flavour): defineCommand + the command it defines.
  defineCommand(name: string): void {
    (this as unknown as Record<string, unknown>)[name] = (arr: string[]) => this.incrTtl(arr);
  }

  async incrTtl([key, points, secDuration]: string[]): Promise<[number, number]> {
    this.check();
    const now = this.now();
    let entry = this.kv.get(key);
    if (!entry || entry.expiresAt <= now) {
      entry = { value: 0, expiresAt: now + Number(secDuration) * 1000 };
      this.kv.set(key, entry);
    }
    entry.value += Number(points);
    return [entry.value, entry.expiresAt - now];
  }

  /** `_upsert` builds a MULTI before choosing its path; the consume path never executes it. */
  multi(): unknown {
    return {};
  }

  async del(key: string): Promise<number> {
    this.check();
    return this.kv.delete(key) ? 1 : 0;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.check();
    return this.hub.deliver(channel, message);
  }
}

/** A `SharedStateRedisSource` over a fake: `client()` answers undefined while `down`. */
export function fakeSource(redis: FakeSharedRedis, namespace = 'test') {
  const source = {
    down: false,
    namespace,
    async client() {
      return source.down ? undefined : (redis as never);
    },
    subscriber() {
      return redis.hub.subscriber() as never;
    },
  };
  return source;
}
