export type ProtocolKey = 'uniswap-v3' | 'uniswap-v4' | string;

export interface ProtocolConfig {
  key: ProtocolKey;
  displayName: string;
  family: 'uniswap-clmm' | 'pancake-clmm' | 'other';
  version: 'v3' | 'v4' | string;
  /**
   * `envio-clmm` reads positions (and their per-position cashflow aggregates)
   * from the Envio indexer. `revert-compatible-clmm` is the vanilla-subgraph
   * Uniswap v3 adapter — kept for the dormant v3 row below, and the ONLY reason
   * this union still has two members.
   */
  adapter: 'revert-compatible-clmm' | 'envio-clmm';
  usesSqrtPriceX96: boolean;
  /**
   * Whether this protocol's adapter exposes pool snapshots with
   * `sqrtPriceX96` suitable for pool-ratio price derivation. CLMM
   * protocols typically do; orderbook/AMM-with-no-ratio protocols do not.
   * Pool-ratio derivation (both current and historical) is gated on this.
   */
  supportsPoolRatioDerivation: boolean;
}

export const PROTOCOLS: Record<string, ProtocolConfig> = {
  // 'uniswap-v3': {
  //   key: 'uniswap-v3',
  //   displayName: 'Uniswap V3',
  //   family: 'uniswap-clmm',
  //   version: 'v3',
  //   adapter: 'revert-compatible-clmm',
  //   usesSqrtPriceX96: true,
  //   supportsPoolRatioDerivation: true,
  // },
  'uniswap-v4': {
    key: 'uniswap-v4',
    displayName: 'Uniswap V4',
    family: 'uniswap-clmm',
    version: 'v4',
    // v4 positions come from the Envio indexer. This USED to say
    // `revert-compatible-clmm` while an env flag (`PONDER_V4_ENABLED`) overrode it
    // at runtime — so the registry and this file disagreed, and unsetting the flag
    // silently routed every v4 read through an adapter whose query shape the Envio
    // schema cannot answer. The flag is gone; this line is now the single answer.
    adapter: 'envio-clmm',
    usesSqrtPriceX96: true,
    supportsPoolRatioDerivation: true,
  },
};

export function getProtocolConfig(protocol: string): ProtocolConfig | undefined {
  return PROTOCOLS[protocol];
}

/**
 * The protocol keys a request DTO may accept, derived from the registry above
 * rather than written out again next to each `@IsIn`.
 *
 * WHY it is derived: three DTOs (`TopPositionsQueryDto`, `TopPoolsQueryDto`,
 * admin `RunSyncDto`) each hard-coded `['uniswap-v3', 'uniswap-v4']` while
 * `uniswap-v3` has been commented out of `PROTOCOLS` for months. The validator
 * therefore ADVERTISED v3 as a legal value and the service's `assertSupported`
 * then 400'd it — a documented parameter that cannot work, on a metered public
 * API. Deleting the literal in three places fixes today and re-forks the moment
 * someone adds a fourth DTO; reading the registry cannot drift, and
 * un-commenting v3 there re-admits it everywhere at once.
 *
 * Frozen: an allow-list a caller can push onto is a validator that changes its
 * mind at runtime. Call sites spread it into `@IsIn`, so no decorator holds a
 * reference to this array either.
 */
export const SUPPORTED_PROTOCOL_KEYS: readonly string[] = Object.freeze(Object.keys(PROTOCOLS));
