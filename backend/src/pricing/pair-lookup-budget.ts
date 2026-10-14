/**
 * The consensus sweep's DexScreener token-pairs lookups
 * (`/token-pairs/v1/{chain}/{addr}`, `PriceProvider.getTokenPairs`): earned
 * trust's (b) / (c) evidence and `DEXSCREENER_BATCH_ENDPOINT=per-chain`'s served
 * re-check (`PricingService.pairLookup`). What one token-price sweep RUN of a
 * chain may send, and the process-wide rate every chain's run draws from.
 *
 * Why both exist (prod, 2026-10-06, per-chain mode). The budgets used to be
 * PER 500-TOKEN BATCH (100 earned trust + 100 served re-check), so a chain-1
 * sweep (~31,000 active-position tokens, 63 batches) could send ~12,600
 * token-pairs requests on top of its ~1,049 batch calls, back to back, against
 * DexScreener's ~300 requests/min per IP — which every batch call (/latest or
 * /tokens/v1) and the served hot path's DexScreener calls also spend. The
 * 429s benched DexScreener for everyone (`defaultBackoffMs` 30 s at a time):
 * Avalanche's sweeps (1,074 tokens) took 500–990 s and earned trust 0 of up to
 * 809 verdicts, and no sweep line ever appeared for chains 1 and 4663 in 13 h.
 *
 * The numbers:
 *  - `PAIR_LOOKUPS_PER_MIN` 60 (one a second) with a burst of
 *    `PAIR_LOOKUP_BURST` 10: at most 70 lookups in any 60 s window, the whole
 *    process — every chain's sweep — together, i.e. ≤ ~23% of DexScreener's
 *    ~300/min. The other ~230/min stay with the batch calls (a chain-1 sweep:
 *    17 per 500-token batch, ≈ 1,049 a run) and the served hot path, which
 *    must never be benched by evidence-gathering. A lookup that finds the
 *    bucket empty does not wait: it is a spent budget for that token (no
 *    verdict / the sample's rule), and the next batch finds the bucket
 *    refilled (a batch's provider walk takes far longer than 10 s).
 *  - Per RUN (`runPairLookupBudget`): for earned trust, 25 per 500-token
 *    batch the run feeds, and never under 300 (`runVerdictLookups`; either
 *    mode); in per-chain mode, 300 for the served re-check (every per-chain
 *    token's batch evidence is a ONE-pair sample). The earned-trust floor is
 *    latest mode's per-call allowance from before runs existed (25 per
 *    `prefetchConsensus` call — chain 1: 63 batches, ≤ 1,575 a run): under
 *    `TOKEN_TRUST_MODE=combined` / `earned` those verdicts are SERVED (a
 *    non-allowlisted token is trusted only while it holds one < 24 h old), and
 *    a flat 300 a run — ~5 a chain-1 batch — let tokens whose (c) needs their
 *    own pairs go `stale-verdict` and lose served trust. The cap was never
 *    what protects DexScreener: the shared rate below is, whatever the
 *    budgets add up to, and it binds before either does on a busy batch (a
 *    batch's lookups go out back to back after its provider walk, so it gets
 *    the burst plus ~1/s — ~14–20 at DexScreener's latency). The served
 *    re-check stays at 300 a run.
 *  - SPREAD over the run (`batchShare`): each batch may spend its pro-rata
 *    share of what is left (left × batch tokens / tokens still to feed), and
 *    what a batch does not spend rolls on to the next ones. The sweep feeds
 *    tokens in the same (sorted) order every run, so a budget spent first come
 *    first served would go to the first ~50 batches of chain 1 every run —
 *    their answers expire (6 h) long before the run reaches the rest — and the
 *    last batches would never get a lookup. Chain 1: ~26 earned trust (+ ~5
 *    served re-check in per-chain mode) a batch.
 *    Answers are cached for a quarter of the quote window (6 h) and a cached
 *    answer costs nothing, so each run's lookups move on to tokens without one.
 *  - WITHIN a batch the requests a share pays for go out in priority order,
 *    not batch order (`PricingService.prefetchConsensus`): with the feed
 *    order fixed and answers cached 6 h, batch order handed the same first
 *    tokens of every batch the share each time their answer expired and the
 *    rest of the batch never got one (verdicts lapsing to `stale-verdict`,
 *    served re-checks never reaching the tail).
 *  - A lone `prefetchConsensus` call (no run: specs, other callers) keeps the
 *    per-call budgets it always had (`batchPairLookupBudget`: 25 latest / 100
 *    + 100 per-chain) and no shared rate.
 * Process-wide, not fleet-wide: two processes sweeping at once (a split
 * `sync` role scaled past one replica) each spend 60/min.
 */

/** The shared token-pairs rate: requests per minute, process-wide. */
export const PAIR_LOOKUPS_PER_MIN = 60;
/** The shared rate's burst (bucket capacity). */
export const PAIR_LOOKUP_BURST = 10;

/** Per-run budgets (one token-price sweep of a chain, every batch of it). */
export const RUN_VERDICT_LOOKUPS = 300;
export const RUN_SERVED_LOOKUPS_PER_CHAIN = 300;

/** Tokens per `prefetchConsensus` batch the token-price sweep feeds (`TokenPriceSyncService`). */
export const SWEEP_BATCH_TOKENS = 500;

/**
 * Earned trust's latest-mode allowance per `prefetchConsensus` call: a lone
 * call's budget (`batchPairLookupBudget`) and, per batch fed, the floor of a
 * run's (`runVerdictLookups`).
 */
export const VERDICT_LOOKUPS_PER_BATCH = 25;

/**
 * A run's earned-trust budget: `VERDICT_LOOKUPS_PER_BATCH` per
 * `SWEEP_BATCH_TOKENS` tokens it will feed, never under `RUN_VERDICT_LOOKUPS`
 * (a run not told its size gets that). Chain 1 (~31,456 tokens, 63 batches):
 * 1,575 — what latest mode spent before runs existed, which the module doc
 * explains it must not fall below.
 */
export function runVerdictLookups(tokens?: number): number {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return RUN_VERDICT_LOOKUPS;
  return Math.max(RUN_VERDICT_LOOKUPS, VERDICT_LOOKUPS_PER_BATCH * Math.ceil(tokens / SWEEP_BATCH_TOKENS));
}

/**
 * A token bucket that never waits: `tryTake` takes one token if there is one.
 * Refills continuously at `perMinute`, capped at `burst`; starts full.
 */
export class PairLookupBucket {
  private tokens: number;
  private at: number;

  constructor(
    readonly perMinute: number = PAIR_LOOKUPS_PER_MIN,
    readonly burst: number = PAIR_LOOKUP_BURST,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = burst;
    this.at = now();
  }

  tryTake(): boolean {
    const t = this.now();
    // A clock that steps back refills nothing (never more than the rate).
    if (t > this.at) {
      this.tokens = Math.min(this.burst, this.tokens + (t - this.at) * (this.perMinute / 60_000));
      this.at = t;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

let processBucket: PairLookupBucket | undefined;

/** THE process's token-pairs rate: one bucket every chain's sweep run draws from. */
export function processPairLookupBucket(): PairLookupBucket {
  if (!processBucket) processBucket = new PairLookupBucket();
  return processBucket;
}

/**
 * What a sweep's pair lookups may still spend. Shared by every batch of a run
 * (`runPairLookupBudget`), or one call's own (`batchPairLookupBudget`).
 */
export interface PairLookupBudget {
  /** Earned trust's requests left ((b) on a sample, (c)). */
  verdictLeft: number;
  /** per-chain mode's served re-check's requests left (0 in latest mode). */
  servedLeft: number;
  /** The shared rate (a run only; absent = a lone call, no shared rate). */
  readonly bucket?: PairLookupBucket;
  /** A run: the tokens its sweep has still to feed (`batchShare`); absent = no spreading. */
  tokensLeft?: number;
  /** token-pairs requests sent (DexScreener available when the lookup went out). */
  sent: number;
  /** Lookups a run refused for want of the shared rate, or with DexScreener benched. */
  denied: number;
}

/** One batch's share of a budget: charged to both (`chargePairLookup`). */
export interface PairLookupShare {
  readonly budget: PairLookupBudget;
  verdictLeft: number;
  servedLeft: number;
}

/**
 * One token-price sweep RUN's budgets (see the module doc), drawing from
 * `bucket` and spread over the `tokens` its sweep will feed (absent = not
 * spread: the first batches may spend it all).
 */
export function runPairLookupBudget(endpoint: string | undefined, bucket: PairLookupBucket, tokens?: number): PairLookupBudget {
  const tokensLeft = tokens !== undefined && Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
  return {
    verdictLeft: runVerdictLookups(tokensLeft),
    servedLeft: endpoint === 'per-chain' ? RUN_SERVED_LOOKUPS_PER_CHAIN : 0,
    bucket,
    tokensLeft,
    sent: 0,
    denied: 0,
  };
}

/**
 * A lone `prefetchConsensus` call's budgets — what every call had before runs
 * existed. Earned trust ((b) on a sampled token and (c); one request serves
 * both): latest 25 — only a token a capped batch answer sampled needs one;
 * per-chain 100 — that endpoint answers ONE pair per token, so every token's
 * batch evidence is a sample. per-chain's served re-check (a floor failure on
 * a token's one batch pair, checked against its own pairs before
 * `dexActive:false` is baked) has its OWN 100, so neither can starve the
 * other — 100 floor-failing tokens whose verdict needs no pairs used to take
 * every lookup ahead of a token that could earn; latest never re-checks
 * served data (0). No shared rate. In both, a cached answer costs nothing
 * (`PricingService.pairLookup`), so the budget moves on through the tokens
 * from sweep to sweep instead of being spent on the same first ones.
 */
export function batchPairLookupBudget(endpoint: string | undefined): PairLookupBudget {
  const perChain = endpoint === 'per-chain';
  return { verdictLeft: perChain ? 100 : VERDICT_LOOKUPS_PER_BATCH, servedLeft: perChain ? 100 : 0, sent: 0, denied: 0 };
}

/**
 * A batch of `batchTokens` (as fed, before de-duplication): its pro-rata share
 * of what the run has left over the tokens still to feed (rounded up, never
 * more than is left), and those tokens are no longer to feed. What the batch
 * does not spend stays in the run for the batches after it; the last batch
 * may spend all of it. A budget that is not spread (a lone call, or a run that
 * was not told its size) is all one share.
 */
export function batchShare(budget: PairLookupBudget, batchTokens: number): PairLookupShare {
  const left = budget.tokensLeft;
  if (left === undefined) return { budget, verdictLeft: budget.verdictLeft, servedLeft: budget.servedLeft };
  const fed = Math.max(0, batchTokens);
  budget.tokensLeft = Math.max(0, left - fed);
  if (fed >= left) return { budget, verdictLeft: budget.verdictLeft, servedLeft: budget.servedLeft };
  const part = (n: number) => Math.ceil((n * fed) / left);
  return { budget, verdictLeft: part(budget.verdictLeft), servedLeft: part(budget.servedLeft) };
}

/**
 * Whether one more token-pairs request may go out on `share` (`kind`: earned
 * trust's 'verdict' or the served re-check's 'served'), charging the share and
 * its budget when so. A run's request goes out only while DexScreener is not
 * benched AND the shared rate has a token — otherwise it is exactly a spent
 * budget for this lookup (no wait; nothing charged, so the run's budget is
 * left for requests that can be sent). A lone call keeps its old rule:
 * charged whether or not the provider will send it (the provider answers null
 * when benched).
 */
export function chargePairLookup(share: PairLookupShare, kind: 'verdict' | 'served', providerAvailable: boolean): boolean {
  const budget = share.budget;
  if ((kind === 'served' ? share.servedLeft : share.verdictLeft) <= 0) return false;
  if (budget.bucket && (!providerAvailable || !budget.bucket.tryTake())) {
    budget.denied += 1;
    return false;
  }
  if (kind === 'served') {
    share.servedLeft -= 1;
    budget.servedLeft -= 1;
  } else {
    share.verdictLeft -= 1;
    budget.verdictLeft -= 1;
  }
  if (providerAvailable) budget.sent += 1;
  return true;
}
