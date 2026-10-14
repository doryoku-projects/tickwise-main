import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { RateLimiterAbstract, RateLimiterMemory } from 'rate-limiter-flexible';
import { of, throwError as rxThrowError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeteringService } from '../src/billing/metering.service.js';
import { trackRequestUsage } from '../src/billing/request-usage.js';
import type { CachedPlan } from '../src/billing/settings-cache.service.js';
import { UsageBucketService } from '../src/billing/usage-bucket.service.js';
import type { MeteringContext, MeteredRequest } from '../src/v1/metering-context.js';
import { MeteringGuard } from '../src/v1/metering.guard.js';
import { MeteringInterceptor } from '../src/v1/metering.interceptor.js';

/**
 * The `usage_buckets` CAPTURE path, driven end to end through the three pieces
 * that actually produce a row: `MeteringGuard` (stamps the context and charges),
 * `MeteringInterceptor` (zeroes the charge when it refunds) and
 * `UsageBucketService.record` (the single upsert at response finish).
 *
 * Everything runs against the REAL guard, interceptor and writer over the real
 * `MeteringService` with an in-memory limiter — the seam `createLimiter` exists
 * for — so each case asserts what a customer's report would actually say rather
 * than what a spy was told. Only the two Mongo models are stubs, and both
 * record every write so the monthly snapshot can be asserted alongside the new
 * detail rows: the house rule (the internal design notes) is that charge and refund stay
 * SYMMETRIC across both stores, and a third store now rides along with them.
 */

// Subclass swaps the Redis-backed limiter for an in-memory one so the test
// exercises real consume/reward semantics without a live Redis. Same seam and
// same reason as `metering-service.spec.ts`; duplicated rather than imported
// because importing from that file would re-run its suites here.
class TestMetering extends MeteringService {
  protected override createLimiter(_keyPrefix: string, points: number, duration: number): RateLimiterAbstract {
    return new RateLimiterMemory({ points, duration });
  }
}

const configStub = { redisUrl: 'redis://localhost:6379' } as any;

const CUSTOMER = '6650aaaaaaaaaaaaaaaaaaaa';
const KEY_ID = '6650bbbbbbbbbbbbbbbbbbbb';
const KEY_PREFIX = 'tk_live_a3f9';
const KEY_LABEL = 'prod-backend';
const ROUTE_KEY = 'v1.positions.charts';
const UNIT_COST = 10;

/** Records every monthly-snapshot write, so the OLD store stays assertable. */
function recordingUsage() {
  const writes: Array<{ filter: any; update: any; options?: any }> = [];
  const model = {
    updateOne: (filter: any, update: any, options?: any) => {
      writes.push({ filter, update, options });
      return { exec: async () => ({ matchedCount: 1, upsertedCount: 0 }) };
    },
  };
  return { writes, model };
}

/**
 * Records every `usage_buckets` upsert. `exec` can be made to REJECT, because
 * the writer's whole contract is that a failed detail write is a gap in a
 * report and never an effect on the response.
 */
function recordingBuckets(opts: { failWith?: Error } = {}) {
  const writes: Array<{ filter: any; update: any; options?: any }> = [];
  const model = {
    updateOne: (filter: any, update: any, options?: any) => {
      writes.push({ filter, update, options });
      return {
        exec: async () => {
          if (opts.failWith) throw opts.failWith;
          return { matchedCount: 0, upsertedCount: 1 };
        },
      };
    },
  };
  return { writes, model };
}

function plan(over: Partial<CachedPlan> = {}): CachedPlan {
  return {
    key: 'free',
    name: 'Free',
    monthlyUnits: 100,
    rateLimitPerMin: 1000,
    price: 0,
    enabled: true,
    selfServe: true,
    maxApiKeys: 1,
    allowBrowserKeys: false,
    description: '',
    features: [],
    prices: [],
    ...over,
  };
}

/**
 * A response that behaves like the Express one at the seam that matters: it
 * carries a mutable `statusCode` and emits `finish` AFTER the status is set,
 * which is the ordering the writer depends on — a listener that read
 * `res.statusCode` before the response was written would class every request
 * as `2xx`.
 */
class FakeResponse extends EventEmitter {
  statusCode = 200;
  writableFinished = false;
  readonly headers: Record<string, string | number> = {};

  setHeader(name: string, value: string | number): void {
    this.headers[name] = value;
  }

  finish(statusCode: number): void {
    this.statusCode = statusCode;
    this.writableFinished = true;
    this.emit('finish');
  }
}

/**
 * The usage half of the access-log middleware in `main.ts` — the REAL
 * `trackRequestUsage`, which `main.ts` calls; the final test in this file pins
 * that call. Every request here finishes, so the abort refund is never reached
 * (it is covered by `request-usage.spec.ts`).
 */
function attachUsageSeam(buckets: UsageBucketService, req: MeteredRequest, res: FakeResponse): void {
  trackRequestUsage(req, res, { usageBuckets: buckets, refund: () => undefined });
}

function contextFor(req: unknown, res?: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

function rig(over: { plan?: CachedPlan; bucketFailure?: Error } = {}) {
  const p = over.plan ?? plan();
  const usage = recordingUsage();
  const buckets = recordingBuckets({ failWith: over.bucketFailure });
  const metering = new TestMetering(configStub, usage.model as never);
  const cache = {
    getEndpointCost: () => UNIT_COST,
    getPlan: (key: string) => (key === p.key ? p : undefined),
  };
  const reflector = { get: () => ({ routeKey: ROUTE_KEY, fallback: 1 }) };
  return {
    plan: p,
    usage,
    buckets,
    metering,
    guard: new MeteringGuard(reflector as never, cache as never, metering),
    interceptor: new MeteringInterceptor(metering, cache as never),
    writer: new UsageBucketService(buckets.model as never),
  };
}

/**
 * Run the interceptor over a handler that throws (or succeeds), resolving on
 * the MICROTASK queue only — never `setTimeout`. `reward` on
 * `RateLimiterMemory` mutates its store inline, and letting a timer fire would
 * break the quota assertions: `QUOTA_DURATION_SEC` (35 days) overflows a 32-bit
 * timeout, so Node clamps the record's expiry to 1ms and the consumed counter
 * silently resets between two awaited ticks. Same constraint as
 * `metering-service.spec.ts`.
 */
async function runThrough(interceptor: MeteringInterceptor, req: unknown, err?: unknown): Promise<void> {
  const handler = {
    handle: () => (err ? rxThrowError(() => err) : of({ ok: true })),
  } as unknown as CallHandler;
  interceptor.intercept(contextFor(req), handler).subscribe({
    next: () => undefined,
    error: () => undefined,
  });
  await Promise.resolve();
}

/**
 * One whole request: guard → handler (through the interceptor) → response
 * finish, in that order and with the same object identity throughout, because
 * the context the writer reads is the one the guard and interceptor mutated.
 *
 * `finishAt` moves the clock before `finish` fires, which is how a request that
 * crosses midnight is modelled.
 */
async function serve(
  r: ReturnType<typeof rig>,
  opts: { handlerError?: unknown; finishAt?: Date } = {},
): Promise<{ req: MeteredRequest; status: number; res: FakeResponse }> {
  const req: MeteredRequest = {
    apiClient: {
      apiKeyId: KEY_ID,
      customerId: CUSTOMER,
      planKey: r.plan.key,
      keyType: 'server',
      allowedOrigins: [],
      keyPrefix: KEY_PREFIX,
      keyLabel: KEY_LABEL,
    },
  };
  const res = new FakeResponse();
  attachUsageSeam(r.writer, req, res);

  let status: number = HttpStatus.OK;
  try {
    await r.guard.canActivate(contextFor(req, res));
    if (opts.handlerError !== undefined) {
      await runThrough(r.interceptor, req, opts.handlerError);
      status =
        opts.handlerError instanceof HttpException
          ? opts.handlerError.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;
    }
  } catch (err) {
    // The guard's 429. It reaches the seam exactly as any other status does,
    // because the middleware wraps the whole pipeline.
    status = err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  }
  if (opts.finishAt) vi.setSystemTime(opts.finishAt);
  res.finish(status);
  return { req, status, res };
}

/** Today's UTC bucket, computed the way the writer does. */
function utcDay(at = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
}

describe('usage_buckets — one row per request', () => {
  it('writes exactly one row carrying all five key dimensions and the denormalised key', async () => {
    const r = rig();

    await serve(r);

    expect(r.buckets.writes).toHaveLength(1);
    const [write] = r.buckets.writes;
    expect(write.filter).toEqual({
      customerId: new Types.ObjectId(CUSTOMER),
      day: utcDay(),
      routeKey: ROUTE_KEY,
      apiKeyId: new Types.ObjectId(KEY_ID),
      statusClass: '2xx',
    });
    // ObjectIds, not strings. The read path matches `customerId: owner` as an
    // ObjectId, so a string here would store rows no report can ever find —
    // and Mongo would accept every one of them.
    expect(write.filter.customerId).toBeInstanceOf(Types.ObjectId);
    expect(write.filter.apiKeyId).toBeInstanceOf(Types.ObjectId);
    expect(write.update.$inc).toEqual({ units: UNIT_COST, requests: 1 });
    // The prefix and label are the only thing that keeps this row readable after
    // the key is hard-deleted, and `period` is written here rather than left to
    // a schema default because `updateOne` runs no required validators.
    expect(write.update.$setOnInsert).toEqual({
      period: utcDay().slice(0, 7),
      keyPrefix: KEY_PREFIX,
      keyLabel: KEY_LABEL,
    });
    expect(write.options?.upsert).toBe(true);
  });

  it('needs no read of its own — the whole row comes off the request context', async () => {
    const r = rig();
    // Nothing but the two models is wired: no api-key model, no customer model,
    // no settings lookup at finish time. A writer that had to resolve the key's
    // prefix would have to be given one, and this rig would fail to construct.
    await serve(r);
    expect(r.buckets.writes[0].update.$setOnInsert.keyPrefix).toBe(KEY_PREFIX);
    expect(r.buckets.writes[0].update.$setOnInsert.keyLabel).toBe(KEY_LABEL);
  });

  it('keys a second identical request onto the SAME bucket, so the upsert accumulates', async () => {
    const r = rig();

    await serve(r);
    await serve(r);

    expect(r.buckets.writes).toHaveLength(2);
    // Same filter twice ⇒ the unique index makes these one document with
    // `requests: 2`. If any dimension differed the report would split one
    // endpoint's traffic across two rows.
    expect(r.buckets.writes[0].filter).toEqual(r.buckets.writes[1].filter);
  });
});

describe('usage_buckets — units net, requests gross', () => {
  it('records a refunded 5xx as requests 1 / units 0, with no compensating row', async () => {
    const r = rig();

    const { req } = await serve(r, { handlerError: new InternalServerErrorException('boom') });

    expect(r.buckets.writes).toHaveLength(1); // NOT a charge row plus a credit row
    expect(r.buckets.writes[0].filter.statusClass).toBe('5xx');
    expect(r.buckets.writes[0].update.$inc).toEqual({ units: 0, requests: 1 });
    // The mechanism: the interceptor zeroed the context the writer then read.
    expect(req.metering?.unitsCharged).toBe(0);
    expect(req.metering?.refunded).toBe(true);
    // And the enforced quota really did come back — 100 units, all of them.
    const next = await r.metering.checkAndConsume({
      apiKeyId: KEY_ID,
      customerId: CUSTOMER,
      plan: r.plan,
      unitCost: UNIT_COST,
    });
    expect(next.quota?.remaining).toBe(90);
  });

  it('records a refunded 4xx the same way — a refused request is not billable', async () => {
    const r = rig();

    await serve(r, { handlerError: new BadRequestException('Unsupported protocol') });

    expect(r.buckets.writes[0].filter.statusClass).toBe('4xx');
    expect(r.buckets.writes[0].update.$inc).toEqual({ units: 0, requests: 1 });
  });

  it('leaves a served 2xx charged', async () => {
    const r = rig();
    await serve(r);
    expect(r.buckets.writes[0].update.$inc).toEqual({ units: UNIT_COST, requests: 1 });
  });
});

describe('usage_buckets — the 429 case', () => {
  it('still records the rejection, as statusClass 429 with zero units', async () => {
    // THE case that justifies writing from the response-finish seam. A quota
    // rejection is raised by `MeteringGuard`, so it never reaches an
    // interceptor, and `MeteringService` never sees a status code at all — the
    // access log's `res.on('finish')` is the ONLY hook that observes it. If
    // this assertion ever fails, the capture design is wrong: rate-limited
    // traffic would be invisible in the very report a customer opens to find
    // out why their integration is failing. Do not weaken it to make it pass.
    const r = rig({ plan: plan({ monthlyUnits: UNIT_COST }) });

    const served = await serve(r); // spends the entire monthly allowance
    const rejected = await serve(r); // …so this one is refused

    expect(served.status).toBe(HttpStatus.OK);
    expect(rejected.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(r.buckets.writes).toHaveLength(2);

    const [charge, rejection] = r.buckets.writes;
    expect(charge.filter.statusClass).toBe('2xx');
    expect(charge.update.$inc).toEqual({ units: UNIT_COST, requests: 1 });
    // A rejected `rate-limiter-flexible` consume takes no points, so the row
    // must carry none either — a 429 that billed units would charge a customer
    // for being told no.
    expect(rejection.filter.statusClass).toBe('429');
    expect(rejection.update.$inc).toEqual({ units: 0, requests: 1 });
    // Attributed to the customer AND the endpoint that caused it, which is the
    // only reason the row is worth having.
    expect(String(rejection.filter.customerId)).toBe(CUSTOMER);
    expect(rejection.filter.routeKey).toBe(ROUTE_KEY);
    // The context survived the guard's throw because the guard mutates the
    // object hanging off the request rather than replacing it.
    expect(rejected.req.metering?.unitsCharged).toBe(0);
    expect(rejected.res.headers['X-RateLimit-Reason']).toBe('quota');
  });

  it('maps every status boundary exactly once', () => {
    const r = rig();
    const ctx: MeteringContext = {
      customerId: CUSTOMER,
      planKey: 'free',
      routeKey: ROUTE_KEY,
      apiKeyId: KEY_ID,
      keyPrefix: KEY_PREFIX,
      keyLabel: KEY_LABEL,
      unitCost: UNIT_COST,
      unitsCharged: UNIT_COST,
      quotaCharged: true,
      chargedAt: new Date(),
    };
    const classOf = (status: number) => {
      r.buckets.writes.length = 0;
      r.writer.record(ctx, status);
      return r.buckets.writes[0].filter.statusClass;
    };

    expect(classOf(200)).toBe('2xx');
    expect(classOf(204)).toBe('2xx');
    // 3xx is not its own class — the mapping's final `otherwise` catches it.
    expect(classOf(304)).toBe('2xx');
    expect(classOf(399)).toBe('2xx');
    expect(classOf(400)).toBe('4xx');
    expect(classOf(428)).toBe('4xx');
    // 429 is broken OUT of 4xx: "you were rate-limited" and "you sent a bad
    // request" are the two things an error spike most needs to distinguish.
    expect(classOf(429)).toBe('429');
    expect(classOf(430)).toBe('4xx');
    expect(classOf(499)).toBe('4xx');
    expect(classOf(500)).toBe('5xx');
    expect(classOf(503)).toBe('5xx');
  });
});

describe('usage_buckets — the charge day, not the finish day', () => {
  beforeEach(() => {
    // Only `Date` is faked. Faking timers as well would let the in-memory
    // limiter's clamped 1ms expiry fire between awaits and reset the counter.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('buckets a request charged at 23:59 that finishes after midnight to the CHARGE day', async () => {
    const r = rig();
    vi.setSystemTime(new Date('2026-01-31T23:59:59.500Z'));

    await serve(r, { finishAt: new Date('2026-02-01T00:00:01.200Z') });

    const [write] = r.buckets.writes;
    // The day AND the month come off `chargedAt`, which the guard captured once
    // — so a single charge is never split across two buckets, and the month
    // rollup a customer reads for January contains the request January billed.
    expect(write.filter.day).toBe('2026-01-31');
    expect(write.update.$setOnInsert.period).toBe('2026-01');
  });

  it('derives period from day, so the two cannot name different months', async () => {
    const r = rig();
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));

    await serve(r, { finishAt: new Date('2026-03-01T00:00:02.000Z') });

    const [write] = r.buckets.writes;
    expect(write.update.$setOnInsert.period).toBe(write.filter.day.slice(0, 7));
    expect(write.filter.day).toBe('2026-03-01');
  });

  it('holds the charge day across a refund that lands the next day', async () => {
    // The monthly snapshot has a known hazard here — `snapshotUsage` and
    // `compensateUsageSnapshot` each resolve `currentPeriod()` independently, so
    // a charge and its credit can land in different months. The bucket path
    // cannot reproduce it: there is no second write to disagree with the first,
    // only one row whose units were zeroed before it was written. That existing
    // hazard is deliberately NOT asserted here, so fixing it does not fail this
    // test.
    const r = rig();
    vi.setSystemTime(new Date('2026-01-31T23:59:58.000Z'));

    await serve(r, {
      handlerError: new InternalServerErrorException('boom'),
      finishAt: new Date('2026-02-01T00:00:03.000Z'),
    });

    expect(r.buckets.writes).toHaveLength(1);
    expect(r.buckets.writes[0].filter.day).toBe('2026-01-31');
    expect(r.buckets.writes[0].update.$inc).toEqual({ units: 0, requests: 1 });
  });
});

describe('usage_buckets — what is deliberately NOT recorded', () => {
  it('writes nothing for a request that was never metered', async () => {
    const r = rig();
    // An unmetered `/v1` route, `/health`, the portal, the admin panel, or a
    // 401 on a bad key: no plan and no customer ever resolved, so there is
    // nobody to attribute the request to. Inventing an attribution would put
    // one customer's traffic on another's bill.
    const req: MeteredRequest = {};
    const res = new FakeResponse();
    attachUsageSeam(r.writer, req, res);

    res.finish(401);

    expect(r.buckets.writes).toHaveLength(0);
  });

  it('writes nothing when the guard rejected before it stamped a context', async () => {
    const r = rig();
    // `ApiKeyGuard` passed but the plan has been deleted: `MeteringGuard`
    // throws 403 ABOVE the stamp, so the seam sees a request with no context.
    const req: MeteredRequest = {
      apiClient: {
        apiKeyId: KEY_ID,
        customerId: CUSTOMER,
        planKey: 'deleted-plan',
        keyType: 'server',
        allowedOrigins: [],
        keyPrefix: KEY_PREFIX,
        keyLabel: KEY_LABEL,
      },
    };
    const res = new FakeResponse();
    attachUsageSeam(r.writer, req, res);

    await expect(r.guard.canActivate(contextFor(req, res))).rejects.toMatchObject({ status: 403 });
    res.finish(403);

    expect(req.metering).toBeUndefined();
    expect(r.buckets.writes).toHaveLength(0);
  });
});

describe('usage_buckets — fire and forget', () => {
  let warnings: string[] = [];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs and swallows a failed write instead of throwing into the response', async () => {
    const r = rig({ bucketFailure: new Error('E11000 duplicate key error') });

    await serve(r);
    await Promise.resolve(); // let the rejected `exec()` settle

    expect(r.buckets.writes).toHaveLength(1);
    expect(warnings.some((line) => line.includes('Usage bucket write failed'))).toBe(true);
  });

  it('skips a context whose ids cannot be cast, rather than throwing at finish', () => {
    const r = rig();
    const res = new FakeResponse();
    const req: MeteredRequest = {
      metering: {
        customerId: 'not-an-object-id',
        planKey: 'free',
        routeKey: ROUTE_KEY,
        apiKeyId: KEY_ID,
        keyPrefix: KEY_PREFIX,
        keyLabel: KEY_LABEL,
        unitCost: UNIT_COST,
        unitsCharged: UNIT_COST,
        quotaCharged: true,
        chargedAt: new Date(),
      },
    };
    attachUsageSeam(r.writer, req, res);

    // `new Types.ObjectId` throws SYNCHRONOUSLY, i.e. inside an Express
    // `finish` listener, where an escape is an unhandled exception in the
    // response teardown rather than a 500 the client can even see.
    expect(() => res.finish(200)).not.toThrow();
    expect(r.buckets.writes).toHaveLength(0);
    expect(warnings.some((line) => line.includes('Usage bucket write skipped'))).toBe(true);
  });
});

describe('usage_buckets — the monthly snapshot is unchanged', () => {
  it('still charges the `usage` row exactly as before, alongside the new bucket', async () => {
    const r = rig();

    await serve(r);

    expect(r.usage.writes).toHaveLength(1);
    const charge = r.usage.writes[0];
    expect(charge.update.$inc).toEqual({ unitsConsumed: UNIT_COST, requestCount: 1 });
    expect(charge.options?.upsert).toBe(true);
    expect(String(charge.filter.customerId)).toBe(CUSTOMER);
    expect(charge.filter.period).toMatch(/^\d{4}-\d{2}$/);
    // The two stores are written independently and neither is derived from the
    // other, but they must agree on the request they describe.
    expect(r.buckets.writes[0].update.$inc.requests).toBe(1);
  });

  it('still compensates units and never `requestCount`, with no upsert, on a refund', async () => {
    const r = rig();

    await serve(r, { handlerError: new InternalServerErrorException('boom') });

    expect(r.usage.writes).toHaveLength(2);
    const compensation = r.usage.writes[1];
    expect(compensation.update.$inc).toEqual({ unitsConsumed: -UNIT_COST });
    expect(compensation.update.$inc).not.toHaveProperty('requestCount');
    // A missing row means the snapshot never landed, so upserting would CREATE
    // negative units.
    expect(compensation.options?.upsert).toBeFalsy();
    // Symmetry across all three stores for one refunded request: Redis credited,
    // Mongo snapshot compensated, bucket row net-zero — and the request still
    // counted once in each place that counts requests.
    expect(r.buckets.writes).toHaveLength(1);
    expect(r.buckets.writes[0].update.$inc).toEqual({ units: 0, requests: 1 });
  });

  it('writes no snapshot compensation for a 429 — nothing was charged to reverse', async () => {
    const r = rig({ plan: plan({ monthlyUnits: UNIT_COST }) });

    await serve(r);
    await serve(r);

    // Exactly ONE snapshot write, from the request that was served. The
    // rejection never reached `snapshotUsage`, and the guard's 429 never
    // reaches the interceptor, so there is nothing to credit either.
    expect(r.usage.writes).toHaveLength(1);
    expect(r.usage.writes[0].update.$inc).toEqual({ unitsConsumed: UNIT_COST, requestCount: 1 });
    // The detail store, by contrast, records BOTH — that asymmetry is the
    // feature: the monthly rollup answers "how much did I spend", the buckets
    // answer "and how many calls did you refuse".
    expect(r.buckets.writes).toHaveLength(2);
  });
});

describe('usage_buckets — the seam in main.ts', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

  it('wires `trackRequestUsage` into the access-log middleware', () => {
    // Every assertion in this file is about a request that reached the seam,
    // and a seam that stopped being wired would leave them all green over a
    // feature that records nothing.
    expect(source).toContain('trackRequestUsage(req, res, usageDeps);');
    expect(source).toContain('usageBuckets: app.get(UsageBucketService),');
  });

  it('keeps `/health` (and the deploy probes `/health/ready` and P2.1 `/health/live`) out of the seam entirely', () => {
    expect(source).toContain(
      'if (req.url === "/health" || req.url === "/health/ready" || req.url === "/health/live") return next();',
    );
  });
});
