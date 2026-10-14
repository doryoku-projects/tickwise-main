import type { IntegrationConfig, SubgraphDialect } from '../../config/integrations.config.js';

/** An endpoint plus the dialect it speaks, for providers that cache URLs. */
export interface SubgraphTarget {
  chainId: number;
  subgraphUrl: string;
  dialect: SubgraphDialect;
  /** Every indexer for the chain, primary first; more than one means failover. */
  sources?: IntegrationConfig['sources'];
}
import { subgraphFetch } from '../../subgraph/hyperindex/client.js';
import { Logger } from '@nestjs/common';
import { request, type Dispatcher } from 'undici';
import type {
  HistoricalReq,
  PriceMetrics,
  PriceOutcome,
  PriceProvider,
  PriceQuote,
} from './price-provider.interface.js';

export interface HttpJsonResult<T> {
  statusCode: number;
  data?: T;
  retryAfterMs?: number;
}

export interface BaseProviderOptions {
  name: string;
  maxConcurrency: number;
  defaultBackoffMs: number;
}

/**
 * Common state machine + helpers for HTTP-based price providers. Owns the
 * rate-limit window, concurrency slot waiter queue, outcome counters, and
 * `Retry-After` parsing.
 */
export abstract class BaseProvider implements PriceProvider {
  protected readonly logger: Logger;
  private rateLimitedUntil = 0;
  private rateLimitLoggedUntil = 0;
  private activeRequests = 0;
  private readonly slotWaiters: Array<() => void> = [];
  private readonly metrics: PriceMetrics = {
    success: 0,
    miss: 0,
    ratelimit: 0,
    error: 0,
    skip: 0,
  };

  abstract readonly name: string;
  abstract readonly supportsCurrentBatch: boolean;
  abstract readonly supportsHistoricalBatch: boolean;
  abstract readonly maxBatchSize: number;
  abstract readonly singleConcurrency: number;
  abstract readonly defaultBackoffMs: number;

  private readonly maxConcurrency: number;

  constructor(options: BaseProviderOptions) {
    this.logger = new Logger(options.name);
    this.maxConcurrency = Math.max(1, options.maxConcurrency);
  }

  abstract isEnabled(): boolean;

  isAvailable(): boolean {
    return this.isEnabled() && Date.now() >= this.rateLimitedUntil;
  }

  abstract getCurrentSingle(chainId: number, address: string): Promise<PriceQuote | null>;
  abstract getHistoricalSingle(request: HistoricalReq): Promise<PriceQuote | null>;

  getMetrics(): PriceMetrics {
    return { ...this.metrics };
  }

  protected recordOutcome(outcome: PriceOutcome): void {
    this.metrics[outcome] += 1;
  }

  /**
   * Public marker used by the orchestrator when a provider call throws,
   * times out, or otherwise can't complete. Defaults to the provider's
   * built-in backoff if no explicit duration is supplied.
   */
  markBackoff(ms?: number, reason?: string): void {
    this.markRateLimited(ms, undefined);
    if (reason) this.logger.warn(`backoff: ${reason}`);
  }

  /**
   * Mark the provider rate-limited until either `retryAfterMs` from now or
   * the provider's default backoff. Subsequent `isAvailable()` calls return
   * `false` until the window expires.
   */
  protected markRateLimited(retryAfterMs?: number, statusCode?: number): void {
    const backoff = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : this.defaultBackoffMs;
    this.rateLimitedUntil = Date.now() + backoff;
    this.recordOutcome('ratelimit');
    const now = Date.now();
    if (now < this.rateLimitLoggedUntil) return;
    this.rateLimitLoggedUntil = now + this.defaultBackoffMs;
    this.logger.warn(
      `rate limited${statusCode ? ` (${statusCode})` : ''}, backing off ${Math.round(backoff / 1000)}s`,
    );
  }

  protected async acquireSlot(): Promise<void> {
    if (this.activeRequests < this.maxConcurrency) {
      this.activeRequests += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.slotWaiters.push(resolve);
    });
    this.activeRequests += 1;
  }

  protected releaseSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const next = this.slotWaiters.shift();
    if (next) next();
  }

  /**
   * Wraps `undici.request` with consistent JSON parsing, status routing, and
   * Retry-After parsing. Returns `{ statusCode, data? }`. On 429/5xx the
   * provider is automatically marked rate-limited.
   */
  protected async httpJson<T>(
    url: string,
    options: {
      method?: Dispatcher.HttpMethod;
      headers?: Record<string, string>;
      body?: string;
      bodyTimeoutMs?: number;
      headersTimeoutMs?: number;
    } = {},
  ): Promise<HttpJsonResult<T>> {
    const response = await request(url, {
      method: options.method ?? 'GET',
      headers: { accept: 'application/json', ...(options.headers ?? {}) },
      body: options.body,
      bodyTimeout: options.bodyTimeoutMs ?? 8000,
      headersTimeout: options.headersTimeoutMs ?? 8000,
    });

    const status = response.statusCode;

    if (status === 429 || status >= 500) {
      const retryAfterMs = parseRetryAfter(response.headers['retry-after']);
      await response.body.dump();
      // Caller decides how to mark rate-limited (per-provider vs per-key).
      return { statusCode: status, retryAfterMs };
    }

    if (status !== 200) {
      await response.body.dump();
      return { statusCode: status };
    }

    try {
      const data = (await response.body.json()) as T;
      return { statusCode: status, data };
    } catch (error) {
      this.logger.warn(`failed to parse JSON from ${url}: ${error}`);
      this.recordOutcome('error');
      return { statusCode: status };
    }
  }

  /**
   * A GraphQL POST that converts dialect when the integration needs it.
   *
   * Delegates to `httpJson` UNCHANGED so every status branch the callers rely on
   * — `429 || >= 500 -> markRateLimited(retryAfterMs, statusCode)` — behaves
   * byte-identically. Only the 200-with-data path is reshaped.
   *
   * A CONVERSION failure deliberately returns a data-less 200, never a 5xx.
   * The providers treat >= 500 as congestion and back off for 30s, so a 5xx here
   * would mask a permanent translation bug behind retries; a data-less 200 lands
   * in each provider's existing `error` branch and is reported immediately.
   */
  protected async graphqlJson<T>(
    url: string,
    integration: {
      chainId: number;
      dialect: SubgraphDialect;
      subgraphUrl?: string;
      sources?: IntegrationConfig['sources'];
    },
    options: {
      query: string;
      variables?: Record<string, unknown>;
      bodyTimeoutMs?: number;
      headersTimeoutMs?: number;
    },
  ): Promise<HttpJsonResult<T>> {
    const body = JSON.stringify({ query: options.query, variables: options.variables ?? {} });
    const post = {
      method: 'POST' as const,
      headers: { 'content-type': 'application/json' },
      body,
      ...(options.bodyTimeoutMs !== undefined ? { bodyTimeoutMs: options.bodyTimeoutMs } : {}),
      ...(options.headersTimeoutMs !== undefined ? { headersTimeoutMs: options.headersTimeoutMs } : {}),
    };

    // Several indexers (Envio + Ponder) go through the failover fetch below, which
    // reports a status only once EVERY source has failed — so a fallback that
    // answers never trips `markRateLimited` for the primary's 429.
    const failover = (integration.sources?.length ?? 0) > 1;
    if (integration.dialect !== 'hyperindex' && !failover) {
      return this.httpJson<T>(url, post);
    }

    const translating = subgraphFetch(integration).fetch;
    try {
      const res = await translating(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      } as RequestInit);
      // Preserve the transport semantics the callers branch on.
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get('retry-after');
        return {
          statusCode: res.status,
          ...(retryAfter ? { retryAfterMs: Number(retryAfter) * 1000 } : {}),
        };
      }
      const parsed = (await res.json()) as T;
      return { statusCode: res.status, data: parsed };
    } catch {
      // Data-less 200 on purpose — see the note above.
      return { statusCode: 200 };
    }
  }
}

/**
 * Parse HTTP `Retry-After` header. Returns milliseconds from now, or undefined
 * if absent/invalid. Supports both delta-seconds and HTTP-date formats.
 */
export function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  if (!header) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}
