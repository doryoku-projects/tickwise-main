import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { FlowLocks, sweepFlowLockName } from '../common/flow-lock.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PositionsRepository } from '../database/positions.repository.js';
import { SWEEP_BATCH_TOKENS } from '../pricing/pair-lookup-budget.js';
import { PricingService } from '../pricing/pricing.service.js';

// Addresses per prefetch call (prefetch chunks internally). The run's
// earned-trust budget is sized per batch of this many (`runVerdictLookups`).
const BATCH = SWEEP_BATCH_TOKENS;
const INTER_BATCH_DELAY_MS = Math.max(0, Number(process.env.TOKEN_PRICE_BATCH_DELAY_MS) || 500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Decoupled background sweep that keeps every ACTIVE-position token's current
 * price fresh in `{chainId}_tokens` (via `PricingService.prefetchPrices`, which
 * walks the full provider chain — incl. the paid fallbacks — and persists
 * non-pool-derived quotes as last-known-good). Position valuation then reads a
 * complete, fresh cache instead of depending on whether a given position-sync
 * happened to catch a live quote. Mirrors `TokenSecuritySyncService`: its own
 * BullMQ `token-price-sync` cron, never on the resync hot path.
 */
@Injectable()
export class TokenPriceSyncService {
  private readonly logger = new Logger(TokenPriceSyncService.name);
  private readonly inFlight = new Map<string, Promise<{ priced: number }>>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PositionsRepository) private readonly positions: PositionsRepository,
    @Inject(PricingService) private readonly pricing: PricingService,
    // P2.1, APPENDED and optional: fleet flow lock `flow:token-price:<chain>:<protocol>`
    // (pass-through while leases are off; absent = the in-process guard only, today).
    @Optional() @Inject(FlowLocks) private readonly flowLocks?: FlowLocks,
  ) {}

  async syncAll(): Promise<{ priced: number }> {
    let priced = 0;
    for (const integration of this.config.enabledIntegrations) {
      const r = await this.syncChain(integration.chainId, integration.protocol);
      priced += r.priced;
    }
    return { priced };
  }

  async syncChain(chainId: number, protocol: string): Promise<{ priced: number }> {
    const key = `${chainId}:${protocol}`;
    const existing = this.inFlight.get(key);
    // A sweep is already running → return IMMEDIATELY (don't await the shared
    // promise). Sweeps now WAIT OUT DEX-provider rate limits and can run 15+
    // minutes; the 5-min repeat cron kept stacking jobs that each awaited the
    // same in-flight promise while HOLDING a BullMQ worker slot — 8 coalesced
    // sweep-waiters + pool-syncs ate the whole `positions-sync` queue and
    // admin backfills sat in `waiting` forever.
    if (existing) return { priced: 0 };
    const run = this.runSweepLocked(chainId, protocol).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  /** In-process claim first (above), then the fleet lock; held elsewhere → skip (the next tick runs). */
  private async runSweepLocked(chainId: number, protocol: string): Promise<{ priced: number }> {
    if (!this.flowLocks) return this.runSweep(chainId, protocol);
    const out = await this.flowLocks.run(sweepFlowLockName('token-price', chainId, protocol), () => this.runSweep(chainId, protocol));
    if (out.held) {
      this.logger.log(`Token-price sweep for ${chainId}:${protocol} held elsewhere — skipped`);
      return { priced: 0 };
    }
    return out.value;
  }

  private async runSweep(chainId: number, protocol: string): Promise<{ priced: number }> {
    const startedAt = Date.now();
    let addresses: string[] = [];
    try {
      addresses = await this.positions.distinctActiveTokenAddresses(chainId, protocol);
    } catch (err) {
      this.logger.warn(`Token-price sweep: failed to read active tokens for ${key(chainId, protocol)}: ${(err as Error)?.message}`);
      return { priced: 0 };
    }
    let priced = 0;
    const trust = { verdicts: 0, earned: 0, unknown: 0, rejected: 0, cleared: 0 };
    // ONE run for the whole sweep: DexScreener token-pairs lookups (earned
    // trust, per-chain's served re-check) are budgeted per RUN — spread over
    // the tokens fed, so the last batches get their share too — and draw from
    // the process-wide rate every chain's sweep shares. Budgeted per 500-token
    // batch, a chain-1 per-chain sweep (63 batches) could send ~12,600 of them
    // against DexScreener's ~300/min, benching it for the hot path too.
    const run = this.pricing.startConsensusSweep({ tokens: addresses.length });
    for (let i = 0; i < addresses.length; i += BATCH) {
      const batch = addresses.slice(i, i + BATCH);
      try {
        // CONSENSUS pricing: gather every independent aggregator's quote,
        // reconcile (median + outlier rejection), and persist priceUsd +
        // priceConfidence + priceSources to {chainId}_tokens. Background +
        // rate-limit-aware, so the multi-source cost is fine here (the hot path
        // reads the cached consensus result).
        const out = await this.pricing.prefetchConsensus(chainId, batch, run);
        priced += batch.length;
        if (out) {
          trust.verdicts += out.trustVerdicts;
          trust.earned += out.trustEarned;
          trust.unknown += out.trustUnknown ?? 0;
          trust.rejected += out.guardRejected;
          trust.cleared += out.guardCleared;
        }
      } catch (err) {
        this.logger.warn(`Token-price sweep batch failed (${key(chainId, protocol)} @${i}): ${(err as Error)?.message}`);
      }
      if (i + BATCH < addresses.length && INTER_BATCH_DELAY_MS > 0) await sleep(INTER_BATCH_DELAY_MS);
    }
    // Quote guard / earned-trust evidence (`PRICE_QUOTE_GUARD`, `TOKEN_TRUST_SHADOW`,
    // `TOKEN_TRUST_MODE=earned` / `combined`): a suffix only when something was computed, so
    // the line is unchanged with them off. `unknown` = swept tokens no verdict
    // could be stored for (no definite answer — `ConsensusSweepStats`); it
    // counts toward printing the suffix, since "every verdict withheld" is
    // exactly the case worth seeing.
    const trustPart =
      trust.verdicts + trust.unknown + trust.rejected + trust.cleared > 0
        ? ` trust=${trust.earned}/${trust.verdicts} unknown=${trust.unknown} quoteGuard{rejected=${trust.rejected} cleared=${trust.cleared}}`
        : '';
    // Token-pairs requests this run actually SENT (DexScreener available,
    // the shared rate had a token), appended after every field so each one
    // before it reads as it always did; only when a batch could look pairs up
    // (trust evidence on, or per-chain mode), so with every flag off the line
    // is unchanged. ≤ the run's budget (earned trust 25 per 500 tokens, at
    // least 300; + 300 per-chain), and every chain's sweeps together ≤ ~60/min
    // (+ a burst of 10). `pairDenied` = lookups the run REFUSED because the
    // shared rate was empty or DexScreener benched (attempts, not tokens — a
    // token's served re-check and its verdict's request can each be refused).
    // Without it a starved run logged `pairLookups=0`, exactly like a run
    // whose every answer was cached: a large pairDenied beside a small
    // pairLookups is contention or a bench, not a quiet run.
    const lookupPart = run.lookupsPossible ? ` pairLookups=${run.pairLookups.sent} pairDenied=${run.pairLookups.denied}` : '';
    this.logger.log(
      `Token-price sweep ${key(chainId, protocol)} fed=${priced}/${addresses.length} durationMs=${Date.now() - startedAt}${trustPart}${lookupPart}`,
    );
    return { priced };
  }
}

function key(chainId: number, protocol: string): string {
  return `${chainId}:${protocol}`;
}
