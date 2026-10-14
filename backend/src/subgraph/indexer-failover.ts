/*
 * Envio ⇄ Ponder failover, at the fetch layer.
 *
 * Both indexers serve IDENTICAL data in the subgraph dialect (Envio natively or
 * through `hyperindex/`, Ponder through its `/subgraph` route), so failing over
 * needs no query document to change: `subgraphFetch` hands every caller a fetch
 * that tries the integration's sources in priority order and returns the first
 * healthy answer. graphql-request calls fetch once per request and only reads
 * `.ok`, `.status`, `.headers` and `.text()` (see `hyperindex/fetch.ts`), so a
 * fetch that makes several upstream attempts before returning one Response is
 * within its contract.
 *
 * WHAT COUNTS AS DOWN
 *
 *  - a thrown fetch (network error, DNS, reset) or a non-2xx status (429, 5xx,
 *    and 4xx too — a 404 is a mis-pointed url, which is down for every query):
 *    cooled down at once.
 *  - a 200 whose body carries GraphQL `errors[]`. This fails over FOR THAT
 *    REQUEST (a statement timeout or "too far behind" is a reason the OTHER
 *    indexer may answer), but only cools the source down after
 *    `GRAPHQL_ERROR_COOLDOWN_AFTER` such answers in a row: one heavy query timing
 *    out says nothing about the source, and cooling it down would push every
 *    other query onto a possibly lagging fallback.
 *  - a source more than `INDEXER_FAILOVER_MAX_LAG_SECONDS` of blocks behind the
 *    freshest source, measured by a background `_meta` probe. It still answers,
 *    but its data is stale, so it is only used when nothing fresher answers —
 *    which is exactly the window an indexer spends re-syncing after a redeploy.
 *
 * A source that fails is skipped for a cooldown (15s, doubling per consecutive
 * failure, capped at 5 min) and tried again afterwards; one success, or one
 * successful probe, clears it. When EVERY source is down, all are still tried in
 * order, so the failover can never make an outage worse than the primary alone.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not pin a multi-page walk to one source. That is safe because the two
 * serve the same rows in the same order (every walk orders by an immutable key
 * with an id tiebreak); a switch mid-walk can only cost a duplicate (deduped by
 * id) or a row the fallback has not indexed yet. That last case is why the sync
 * stale sweep consults `indexerFallbackServes` and skips itself whenever a
 * fallback answered during the pass — a lagging fallback must never close a live
 * position.
 *
 * State is per process and per chain (one multi-source integration per chain,
 * which is what `buildIntegrations` declares).
 */

import { Logger } from '@nestjs/common';
import type { IndexerSource, IndexerSourceKind } from '../config/integrations.config.js';
import { getChainConfig } from '../config/chains.config.js';
import { runInLane } from './hyperindex/indexer-context.js';

/** The fetch that talks to ONE source (translating for `hyperindex`, plain otherwise). */
export type SourceFetchFor = (source: IndexerSource) => typeof fetch;

export type IndexerSourceState = 'ok' | 'lagging' | 'down';

export interface IndexerSourceSnapshot {
  readonly kind: IndexerSourceKind;
  readonly state: IndexerSourceState;
  /** Last block the background probe read, or null before the first probe. */
  readonly indexedBlock: number | null;
  readonly lastError?: string;
}

export interface IndexerFailoverSnapshot {
  /** The source that answered the most recent request. */
  readonly serving: IndexerSourceKind | null;
  readonly sources: readonly IndexerSourceSnapshot[];
}

interface SourceHealth {
  failures: number;
  /** Consecutive GraphQL-error answers; a success resets it. */
  gqlStreak: number;
  downUntil: number;
  lastError?: string;
  block: number | null;
}

interface ChainFailover {
  sources: readonly IndexerSource[];
  fetchFor: SourceFetchFor;
  fallbackServes: number;
  serving: IndexerSource | null;
  probe?: NodeJS.Timeout;
  probing?: Promise<void>;
}

const META_QUERY = 'query FailoverProbe { _meta { block { number } } }';
const PROBE_TIMEOUT_MS = 10_000;
const COOLDOWN_MAX_MS = 5 * 60_000;
const GRAPHQL_ERROR_COOLDOWN_AFTER = 3;

const logger = new Logger('IndexerFailover');
const chains = new Map<number, ChainFailover>();
const health = new Map<string, SourceHealth>();
let clock: () => number = () => Date.now();

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const cooldownBaseMs = () => envNumber('INDEXER_FAILOVER_COOLDOWN_MS', 15_000);
const probeIntervalMs = () => envNumber('INDEXER_FAILOVER_PROBE_MS', 30_000);
const maxLagSeconds = () => envNumber('INDEXER_FAILOVER_MAX_LAG_SECONDS', 300);

function keyOf(chainId: number, source: IndexerSource): string {
  return `${chainId}|${source.kind}|${source.url}`;
}

function healthOf(chainId: number, source: IndexerSource): SourceHealth {
  const key = keyOf(chainId, source);
  let h = health.get(key);
  if (!h) {
    h = { failures: 0, gqlStreak: 0, downUntil: 0, block: null };
    health.set(key, h);
  }
  return h;
}

/** The lag budget in THIS chain's blocks: a wall-clock budget over its block time. */
function maxLagBlocks(chainId: number): number {
  const blockTimeMs = getChainConfig(chainId)?.blockTimeMs ?? 1_000;
  return Math.max(1, Math.round((maxLagSeconds() * 1_000) / blockTimeMs));
}

function stateOf(chainId: number, source: IndexerSource, freshest: number | null): IndexerSourceState {
  const h = healthOf(chainId, source);
  if (h.downUntil > clock()) return 'down';
  if (freshest !== null && h.block !== null && freshest - h.block > maxLagBlocks(chainId)) return 'lagging';
  return 'ok';
}

function freshestBlock(chainId: number, sources: readonly IndexerSource[]): number | null {
  let best: number | null = null;
  for (const s of sources) {
    const b = healthOf(chainId, s).block;
    if (b !== null && (best === null || b > best)) best = b;
  }
  return best;
}

/**
 * The order a request tries the sources in: healthy ones in configured priority,
 * then lagging ones, then ones cooling down. Stable within each group, so with
 * everything healthy the configured primary always goes first.
 */
export function routeOrder(chainId: number, sources: readonly IndexerSource[]): IndexerSource[] {
  const freshest = freshestBlock(chainId, sources);
  const rank: Record<IndexerSourceState, number> = { ok: 0, lagging: 1, down: 2 };
  return sources
    .map((source, i) => ({ source, i, r: rank[stateOf(chainId, source, freshest)] }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.source);
}

function markFailure(chainId: number, source: IndexerSource, reason: string): void {
  const h = healthOf(chainId, source);
  const wasUp = h.downUntil <= clock();
  h.failures += 1;
  h.downUntil = clock() + Math.min(COOLDOWN_MAX_MS, cooldownBaseMs() * 2 ** (h.failures - 1));
  // `/health` shows this, so no url (a deployment id or a key can sit in one).
  h.lastError = reason.replace(/https?:\/\/\S+/gi, '<url>').slice(0, 300);
  if (wasUp) {
    logger.warn(
      `chain ${chainId}: ${source.kind} indexer failed (${h.lastError}) — skipping it for ` +
        `${Math.round((h.downUntil - clock()) / 1000)}s`,
    );
  }
}

function markSuccess(chainId: number, source: IndexerSource): void {
  const h = healthOf(chainId, source);
  if (h.failures > 0) {
    logger.log(`chain ${chainId}: ${source.kind} indexer answering again after ${h.failures} failure(s)`);
  }
  h.failures = 0;
  h.gqlStreak = 0;
  h.downUntil = 0;
  h.lastError = undefined;
}

/**
 * A GraphQL-error answer: the request fails over, but the source is only cooled
 * down once it has answered this way `GRAPHQL_ERROR_COOLDOWN_AFTER` times running.
 */
function markGraphqlError(chainId: number, source: IndexerSource, reason: string): void {
  const h = healthOf(chainId, source);
  h.gqlStreak += 1;
  if (h.gqlStreak >= GRAPHQL_ERROR_COOLDOWN_AFTER) markFailure(chainId, source, reason);
}

/**
 * Read a response fully and decide whether it is a usable answer. The body is
 * consumed here, so the caller rebuilds the Response from `text`.
 */
async function inspect(res: Response): Promise<{ ok: boolean; text: string; reason?: string; graphql?: boolean }> {
  const text = await res.text();
  if (!res.ok) return { ok: false, text, reason: `HTTP ${res.status}` };
  // Cheap pre-check: only a body that mentions errors is parsed a second time.
  if (text.includes('"errors"')) {
    try {
      const body = JSON.parse(text) as { errors?: Array<{ message?: string }> };
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        return { ok: false, text, reason: body.errors[0]?.message ?? 'GraphQL error', graphql: true };
      }
    } catch {
      return { ok: false, text, reason: 'response is not JSON' };
    }
  }
  return { ok: true, text };
}

function rebuild(res: Response, text: string): Response {
  return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function registerChain(chainId: number, sources: readonly IndexerSource[], fetchFor: SourceFetchFor): ChainFailover {
  let chain = chains.get(chainId);
  if (!chain) {
    chain = { sources, fetchFor, fallbackServes: 0, serving: null };
    chains.set(chainId, chain);
  } else {
    chain.sources = sources;
    chain.fetchFor = fetchFor;
  }
  ensureProbe(chainId, chain);
  return chain;
}

/**
 * The failover fetch for one chain's sources. Callers get it from
 * `subgraphFetch`; nothing else needs to know failover exists.
 */
export function failoverFetch(
  chainId: number,
  sources: readonly IndexerSource[],
  fetchFor: SourceFetchFor,
): typeof fetch {
  const chain = registerChain(chainId, sources, fetchFor);
  const primary = sources[0];

  return async function indexerFailoverFetch(_input, init): Promise<Response> {
    let firstResponse: Response | undefined;
    let firstError: unknown;
    for (const source of routeOrder(chainId, chain.sources)) {
      if (init?.signal?.aborted) throw init.signal.reason ?? new Error('indexer request aborted');
      try {
        const res = await chain.fetchFor(source)(source.url, init);
        const verdict = await inspect(res);
        if (verdict.ok) {
          markSuccess(chainId, source);
          if (chain.serving !== source) {
            if (chain.serving !== null || source !== primary) {
              logger.log(
                `chain ${chainId}: now served by ${source.kind}${source === primary ? ' (primary)' : ' (fallback)'}`,
              );
            }
            chain.serving = source;
          }
          if (source !== primary) chain.fallbackServes += 1;
          return rebuild(res, verdict.text);
        }
        if (verdict.graphql) markGraphqlError(chainId, source, verdict.reason ?? 'GraphQL error');
        else markFailure(chainId, source, verdict.reason ?? 'unusable response');
        firstResponse ??= rebuild(res, verdict.text);
      } catch (err) {
        if (init?.signal?.aborted) throw err;
        markFailure(chainId, source, err instanceof Error ? err.message : String(err));
        if (firstError === undefined) firstError = err;
      }
    }
    // Nothing answered. Hand back what the highest-priority source said, so the
    // caller's own error handling and retry classification see the same thing
    // they would have seen with that source alone.
    if (firstResponse) return firstResponse;
    throw firstError ?? new Error(`indexer failover: no source answered for chain ${chainId}`);
  } as typeof fetch;
}

async function probeSource(chainId: number, chain: ChainFailover, source: IndexerSource): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const request = chain.fetchFor(source)(source.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: META_QUERY }),
    } as RequestInit);
    const res = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    const verdict = await inspect(res);
    if (!verdict.ok) {
      markFailure(chainId, source, `probe: ${verdict.reason}`);
      return;
    }
    const number = (JSON.parse(verdict.text) as { data?: { _meta?: { block?: { number?: unknown } } } })?.data?._meta
      ?.block?.number;
    const block = typeof number === 'number' ? number : Number(number);
    if (Number.isFinite(block) && block > 0) healthOf(chainId, source).block = block;
    markSuccess(chainId, source);
  } catch (err) {
    markFailure(chainId, source, `probe: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Probe every source of a chain once. Exposed so tests and ops can force a round. */
export async function probeIndexerSources(chainId: number): Promise<void> {
  const chain = chains.get(chainId);
  if (!chain) return;
  if (chain.probing) return chain.probing;
  chain.probing = runInLane({ lane: 'health', job: 'indexer-failover-probe', chainId }, () =>
    Promise.all(chain.sources.map((s) => probeSource(chainId, chain, s))).then(() => undefined),
  ).finally(() => {
    chain.probing = undefined;
  });
  return chain.probing;
}

function ensureProbe(chainId: number, chain: ChainFailover): void {
  const every = probeIntervalMs();
  if (chain.probe || every <= 0 || chain.sources.length < 2) return;
  void probeIndexerSources(chainId);
  chain.probe = setInterval(() => void probeIndexerSources(chainId), every);
  chain.probe.unref?.();
}

/**
 * How many requests on this chain a FALLBACK source has answered since boot.
 * Compare two readings to learn whether a fallback served in between — the sync
 * stale sweep skips itself when one did.
 */
export function indexerFallbackServes(chainId: number): number {
  return chains.get(chainId)?.fallbackServes ?? 0;
}

/** Per-source state for `/health`. Undefined for a single-source chain. */
export function indexerFailoverSnapshot(chainId: number): IndexerFailoverSnapshot | undefined {
  const chain = chains.get(chainId);
  if (!chain || chain.sources.length < 2) return undefined;
  const freshest = freshestBlock(chainId, chain.sources);
  return {
    serving: chain.serving?.kind ?? null,
    sources: chain.sources.map((source) => {
      const h = healthOf(chainId, source);
      return {
        kind: source.kind,
        state: stateOf(chainId, source, freshest),
        indexedBlock: h.block,
        ...(h.lastError && h.downUntil > clock() ? { lastError: h.lastError } : {}),
      };
    }),
  };
}

/** Test seam: forget all state and stop every probe timer. */
export function __resetIndexerFailover(): void {
  for (const chain of chains.values()) if (chain.probe) clearInterval(chain.probe);
  chains.clear();
  health.clear();
  clock = () => Date.now();
}

/** Test seam: drive cooldowns with a fake clock. */
export function __setIndexerFailoverClock(now: () => number): void {
  clock = now;
}

/** Test seam: set a source's probed block without a network round trip. */
export function __setIndexerSourceBlock(chainId: number, source: IndexerSource, block: number | null): void {
  healthOf(chainId, source).block = block;
}
