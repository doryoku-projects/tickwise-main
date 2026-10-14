import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { allowlistSize, isAllowlisted } from './token-allowlist.js';
import { ALLOWLIST_META } from './data/token-allowlist.eth.js';

/**
 * Token-trust gate for valuation, backed by a COMMITTED CoinGecko-listed snapshot
 * (src/pricing/data/token-allowlist.eth.ts). A token contributes USD value only if
 * it is anchor (handled upstream) or in the committed allowlist ("priced on
 * CoinGecko, else $0" for spam and long-tail tokens).
 *
 * The trust decision is compiled into the binary: there is NO runtime network
 * fetch, so the gate cannot silently fail open the way the previous CoinGecko
 * runtime fetch did (free tier IP-blocks cloud servers). Refresh the snapshot at
 * commit/CI time via `node scripts/refresh-token-allowlist.mjs`.
 */
@Injectable()
export class TokenListingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TokenListingService.name);

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  onApplicationBootstrap(): void {
    this.logger.log(
      `committed token allowlist: ${ALLOWLIST_META.platform}=${allowlistSize(1)} ` +
        `(source=${ALLOWLIST_META.source}, generated=${ALLOWLIST_META.generatedAt}, ` +
        `gate=${this.config.tokenListingGateEnabled ? 'on' : 'off'})`,
    );
  }

  /** True when the token is trusted for valuation (committed allowlist or fail-open chain). */
  isListed(chainId: number, address: string): boolean {
    return isAllowlisted(chainId, address);
  }
}
