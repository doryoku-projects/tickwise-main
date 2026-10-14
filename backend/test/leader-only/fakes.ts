import { FakeLeaseRedis } from '../process-roles/fakes.js';
import { EXCLUSION_EXTEND_SCRIPT } from '../../src/database/exclusion-snapshot.js';

export { ManualClock, flush } from '../process-roles/fakes.js';

/**
 * `FakeLeaseRedis` (lease scripts, TTL-aware GET/SET) plus what the leader-only
 * pollers use: binary values (`getBuffer`), `pexpire`, and a hash
 * (`hset`/`hgetall`). Values may be Buffers; TTLs follow the injected clock.
 */
export class LeaderRedis extends FakeLeaseRedis {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly hashExp = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {
    super(clock);
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const v = (await this.get(key)) as unknown;
    if (v === null || v === undefined) return null;
    return Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8');
  }

  async pexpire(key: string, ms: number): Promise<number> {
    this.calls.push('pexpire');
    if (this.failing) throw new Error('redis down');
    if (this.hashes.has(key)) {
      this.hashExp.set(key, this.clock() + Number(ms));
      return 1;
    }
    const e = this.kv.get(key);
    if (!e || (e.exp !== undefined && e.exp <= this.clock())) return 0;
    e.exp = this.clock() + Number(ms);
    return 1;
  }

  private liveHash(key: string): Map<string, string> | undefined {
    const exp = this.hashExp.get(key);
    if (exp !== undefined && exp <= this.clock()) {
      this.hashes.delete(key);
      this.hashExp.delete(key);
      return undefined;
    }
    return this.hashes.get(key);
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.calls.push('hset');
    if (this.failing) throw new Error('redis down');
    const h = this.liveHash(key) ?? new Map<string, string>();
    const added = h.has(field) ? 0 : 1;
    h.set(field, String(value));
    this.hashes.set(key, h);
    return added;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.calls.push('hgetall');
    if (this.failing) throw new Error('redis down');
    return Object.fromEntries(this.liveHash(key) ?? new Map());
  }

  /** Every EVAL not handled here goes to the lease scripts of `FakeLeaseRedis`. */
  override async eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    if (script !== EXCLUSION_EXTEND_SCRIPT) return super.eval(script, numKeys, ...args);
    this.calls.push('eval');
    if (this.failing) throw new Error('redis down');
    // Step for step with the Lua: the stored meta must name this hash, and the blob must still exist.
    const [metaKey, blobKey, hash, metaJson, ttl] = args.map(String);
    const now = this.clock();
    const live = (key: string) => {
      const e = this.kv.get(key);
      return e && (e.exp === undefined || e.exp > now) ? e : undefined;
    };
    const meta = live(metaKey!);
    if (!meta) return 0;
    let stored: unknown;
    try {
      stored = JSON.parse(String(meta.v));
    } catch {
      return 0;
    }
    if (!stored || typeof stored !== 'object' || (stored as { hash?: unknown }).hash !== hash) return 0;
    const blob = live(blobKey!);
    if (!blob) return 0;
    blob.exp = now + Number(ttl);
    this.kv.set(metaKey!, { v: metaJson!, exp: now + Number(ttl) });
    return 1;
  }

  /** Expire a plain key now (test helper). */
  drop(key: string): void {
    this.kv.delete(key);
  }
}

/** The `CoordinationRedis` surface the services use: `client()` + `namespace`. */
export function coordinationOf(redis: LeaderRedis | undefined, namespace = 'spec') {
  return {
    namespace,
    client: async () => (redis && !redis.failing ? redis : undefined),
  };
}
