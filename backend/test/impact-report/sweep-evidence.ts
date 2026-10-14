import { PricingService } from '../../src/pricing/pricing.service.js';
import type { TokenPriceRecord } from '../../src/database/token.repository.js';

export type SweepEvidence = Pick<TokenPriceRecord, 'priceQuoteRejected' | 'priceGuardUsd' | 'priceQuotedAt' | 'priceSourcesDisagreed'>;

/**
 * The guard evidence the shadow / guarded sweep stores for a token, produced
 * by the REAL `PricingService.guardEvidence` (private; it reads nothing off
 * `this`) — so a field-name drift between the sweep and the report fails here
 * instead of silently turning every verdict into a candidate.
 */
export function sweepEvidence(
  dated: Array<{ source: string; priceUsd: number; quotedAtMs?: number; rejected: boolean }>,
  chosenSources: string[],
  rejected: string[] | undefined,
): SweepEvidence {
  const fn = (PricingService.prototype as unknown as Record<string, (...a: unknown[]) => unknown>).guardEvidence!;
  return fn.call({}, dated, chosenSources, rejected) as SweepEvidence;
}
