import { HttpException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { RateLimiterRes } from 'rate-limiter-flexible';
import { AppConfigService } from '../config/app-config.service.js';
import { currentIndexerContext, type IndexerRequestStats } from '../subgraph/hyperindex/indexer-context.js';
import { classifyApiCost, type AnonCostKind, type ApiCost } from './api-cost.js';
import { ApiLimitMeter, formatHour, formatMinute } from './api-limit-meter.js';
import { clientLimiterKey } from './client-ip.js';
import { LimiterFactory, MEMORY_LIMITER_FACTORY, type AuthLimiter } from './limiter-factory.js';
import { onceAMinute } from './redis-gcra.js';

/** The request and response members the budget reads: Express's satisfy them, a spec's fakes can too. */
export interface LimitedRequest {
  ip?: string;
  query?: Record<string, unknown>;
}
export interface LimitedResponse {
  statusCode: number;
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): unknown;
  once(event: 'close', listener: () => void): unknown;
}

/** What the 429 says. Only a script reads it: the website never shows it. */
export const API_LIMIT_MESSAGE = 'Automated access: use the /v1 API with a free key (sign in at /portal).';

type LimitReason = 'rate-10s' | 'rate-hour' | 'count-miss' | 'in-flight';

interface Verdict {
  reason: LimitReason;
  retryAfterMs: number;
}

interface Limiters {
  short: AuthLimiter;
  hour: AuthLimiter;
  countMiss: AuthLimiter;
}

/** One admitted request, carried to its `close` for the refund. */
interface Admission {
  key: string;
  cost: ApiCost;
  /**
   * The points were taken and stay taken: false for a request refused (or let
   * through as would-be refused, whose points were given back at once), so its
   * `close` has nothing to refund.
   */
  charged: boolean;
  stats?: IndexerRequestStats;
}

/**
 * The per-IP budget for the keyless `/api/*` routes — the website's own data
 * API, which a script can call with a forged `Origin` header just as well as a
 * browser can. It never tries to tell scripts from people; it prices every
 * request by what it costs the database and the indexer and gives each client
 * address a budget a real visitor stays far under (`api-cost.ts` has the
 * prices; the numbers come from observe-mode data).
 *
 * Per client address, three windows:
 *  - points per 10 s and per hour: a request is charged its `base + surcharge`
 *    UP FRONT, and the surcharge is given back on `close` when the answer came
 *    from a cache (or needed no indexer call). Up front, because a request the
 *    client aborts never reaches `finish`, and a script that fires and drops
 *    its requests must still pay for what it started;
 *  - requests running at once (per process): stops a burst of cold reads from
 *    landing before any surcharge applies;
 *  - count requests that missed the count cache per minute: the one route whose
 *    miss can read ~100k documents. Charged up front, refunded on a hit.
 *
 * `API_LIMIT_MODE`: `off` (today: nothing is read or written), `observe` (the
 * same counters, never refuses, logs who WOULD be refused), `enforce` (429).
 * A refused request is given its points back, so an observe-mode run models
 * enforce exactly: the counters hold what an enforcing server would have served.
 *
 * Fails OPEN: a request with no usable address, or a limiter store that errors,
 * is let through (and counted).
 */
@Injectable()
export class ApiLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApiLimitService.name);
  private readonly meter = new ApiLimitMeter(Date.now());
  private readonly inFlight = new Map<string, number>();
  private limiters?: Limiters;
  private timer?: ReturnType<typeof setInterval>;
  private sampled = new Set<string>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Optional() @Inject(LimiterFactory) private readonly factory?: LimiterFactory,
  ) {}

  /** `enforce` is never served behind a proxy that has not been counted: see `trustProxyGap`. */
  get mode(): 'off' | 'observe' | 'enforce' {
    const mode = this.config.apiLimitMode;
    return mode === 'enforce' && this.trustProxyGap ? 'observe' : mode;
  }

  /**
   * In production with `TRUST_PROXY_HOPS` at its default 0, `req.ip` is the
   * reverse proxy's own address for EVERY visitor: one shared bucket, so the
   * first busy minute would throttle the whole site. Enforcing is refused until
   * the hop count is set (and verified with `GET /diag/client-ip`).
   */
  get trustProxyGap(): boolean {
    return this.config.isProduction && this.config.trustProxyHops === 0;
  }

  onModuleInit(): void {
    const configured = this.config.apiLimitMode;
    if (configured === 'off') return;
    this.logger.log(
      `[api-limit] mode=${this.mode}${this.mode !== configured ? ` (configured ${configured})` : ''} ` +
        `store=${this.config.apiLimiterStore} points10s=${this.config.apiLimitPoints10s} ` +
        `pointsHour=${this.config.apiLimitPointsHour} maxInFlight=${this.config.apiLimitMaxInFlight} ` +
        `countMissPerMin=${this.config.apiLimitCountMissPerMin} (placeholders: size them from the observe-mode hour lines)`,
    );
    if (this.mode !== configured) {
      this.logger.warn(
        '[alert] api_limit.trust_proxy API_LIMIT_MODE=enforce was NOT applied: TRUST_PROXY_HOPS is 0 in production, so req.ip is the ' +
          "proxy's address for every visitor and one bucket would throttle the whole site. Set TRUST_PROXY_HOPS (Railway: 1), " +
          'check GET /diag/client-ip with CLIENT_IP_ECHO=on from two networks, then redeploy. Running as observe.',
      );
    }
    this.timer = setInterval(() => this.report(Date.now()), 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Admit (or refuse) one keyless `/api` request. Resolves when it may run;
   * throws a 429 in enforce mode when it may not.
   */
  async admit(kind: AnonCostKind, req: LimitedRequest, res: LimitedResponse): Promise<void> {
    // Whatever the mode: tell the read budget this is a keyless read, so
    // `API_READ_SHARE` can bound the share of the budget those take.
    const stats = currentIndexerContext().stats;
    if (stats) stats.keyless = true;
    const mode = this.mode;
    if (mode === 'off') return;

    const key = clientLimiterKey(req.ip);
    if (!key) {
      this.meter.failOpen();
      return;
    }
    const cost = classifyApiCost(kind, req.query);
    const admission: Admission = { key, cost, charged: false, ...(stats ? { stats } : {}) };

    const running = (this.inFlight.get(key) ?? 0) + 1;
    this.inFlight.set(key, running);
    this.meter.inFlight(running);
    // Registered before anything can refuse, so the slot is released whatever happens next.
    res.once('close', () => this.settle(admission, res));

    let verdict: Verdict | undefined;
    if (running > this.config.apiLimitMaxInFlight) {
      verdict = { reason: 'in-flight', retryAfterMs: 1000 };
    } else {
      try {
        verdict = await this.charge(key, cost);
        admission.charged = verdict === undefined;
      } catch (err) {
        this.meter.failOpen();
        if (onceAMinute('api_limit.store')) {
          this.logger.warn(`[alert] api_limit.store the limiter store failed, requests are let through: ${(err as Error)?.message ?? err}`);
        }
        return;
      }
    }

    if (verdict) {
      this.meter.limit(verdict.reason, mode === 'enforce');
      if (mode === 'enforce') throw this.tooManyRequests(res, verdict);
      this.logWouldLimit(key, cost, verdict);
      return;
    }
    this.meter.record(key, cost.base + cost.surcharge, Date.now());
  }

  /** Take the request's points from every window; on a refusal give back what was taken. */
  private async charge(key: string, cost: ApiCost): Promise<Verdict | undefined> {
    const limiters = (this.limiters ??= this.build());
    const points = cost.base + cost.surcharge;
    const taken: Array<[AuthLimiter, number]> = [];
    const take = async (limiter: AuthLimiter, n: number, reason: LimitReason): Promise<Verdict | undefined> => {
      try {
        await limiter.consume(key, n);
        taken.push([limiter, n]);
        return undefined;
      } catch (err) {
        if (!(err instanceof RateLimiterRes)) throw err;
        // The library counts the points before it refuses them.
        await limiter.reward(key, n).catch(() => undefined);
        return { reason, retryAfterMs: err.msBeforeNext };
      }
    };
    let verdict = await take(limiters.short, points, 'rate-10s');
    verdict ??= await take(limiters.hour, points, 'rate-hour');
    if (!verdict && cost.kind === 'count') verdict = await take(limiters.countMiss, 1, 'count-miss');
    if (verdict) await Promise.all(taken.map(([limiter, n]) => limiter.reward(key, n).catch(() => undefined)));
    return verdict;
  }

  /** On `close`: free the slot and, when the answer was cheap, give the surcharge back. */
  private settle(admission: Admission, res: LimitedResponse): void {
    const { key, cost } = admission;
    const running = (this.inFlight.get(key) ?? 1) - 1;
    if (running <= 0) this.inFlight.delete(key);
    else this.inFlight.set(key, running);

    if (!admission.charged || !this.limiters) return;
    // A request the API refused keeps its charge: a script sending junk pays for it.
    if (res.statusCode >= 400) return;
    if (!isCheap(res, admission)) return;
    const { short, hour, countMiss } = this.limiters;
    void short.reward(key, cost.surcharge).catch(() => undefined);
    void hour.reward(key, cost.surcharge).catch(() => undefined);
    if (cost.kind === 'count') void countMiss.reward(key, 1).catch(() => undefined);
  }

  private build(): Limiters {
    const store = this.config.apiLimiterStore;
    const factory = this.factory ?? MEMORY_LIMITER_FACTORY;
    return {
      short: factory.create('api-limit', '10s', { points: this.config.apiLimitPoints10s, duration: 10, store }),
      hour: factory.create('api-limit', 'hour', { points: this.config.apiLimitPointsHour, duration: 3600, store }),
      countMiss: factory.create('api-limit', 'count-miss', { points: this.config.apiLimitCountMissPerMin, duration: 60, store }),
    };
  }

  private tooManyRequests(res: LimitedResponse, verdict: Verdict): HttpException {
    const retryAfter = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('RateLimit-Limit', String(this.config.apiLimitPoints10s));
    res.setHeader('RateLimit-Remaining', '0');
    res.setHeader('RateLimit-Reset', String(retryAfter));
    return new HttpException({ error: API_LIMIT_MESSAGE, reason: verdict.reason, retryAfterSeconds: retryAfter }, 429);
  }

  /** The first would-be refusal per address and reason each minute, at most 20 lines. */
  private logWouldLimit(key: string, cost: ApiCost, verdict: Verdict): void {
    const id = `${key}|${verdict.reason}`;
    if (this.sampled.size >= 20 || this.sampled.has(id)) return;
    this.sampled.add(id);
    this.logger.warn(`[api-limit] would limit ip=${key} reason=${verdict.reason} class=${cost.class} points=${cost.base + cost.surcharge}`);
  }

  private report(now: number): void {
    this.sampled = new Set();
    const minute = this.meter.takeMinute();
    if (minute) this.logger.log(formatMinute(this.mode, minute));
    const hour = this.meter.takeHour(now);
    if (hour) this.logger.log(formatHour(this.mode, hour));
  }

  /** The per-process in-flight table, for specs and the status block. */
  get runningByAddress(): ReadonlyMap<string, number> {
    return this.inFlight;
  }
}

/**
 * Was the answer cheap? A cache answer says so in `X-Cache`; a detail or a chart
 * (which set no such header) is cheap when it made no indexer call.
 */
function isCheap(res: LimitedResponse, admission: Admission): boolean {
  const cache = res.getHeader('x-cache');
  const value = Array.isArray(cache) ? cache[0] : cache;
  if (value === 'hit' || value === 'stale') return true;
  if (admission.cost.kind === 'detail' || admission.cost.kind === 'chart') return admission.stats?.indexerCalls === 0;
  return false;
}
