/**
 * `UNISWAP_V4_INDEXER_URL` — one url for every v4 chain, with the per-chain keys
 * kept as overrides.
 *
 * The bug this exists to stop: four copies of the same url drift. In production
 * three chains were left on `gateway.thegraph.com` (refused at boot) while
 * Robinhood pointed at a deployment answering HTTP 404, and nothing surfaced it.
 */
import { describe, it, expect } from 'vitest';
import { buildIntegrations } from '../src/config/integrations.config.js';

const SHARED = 'https://indexer.hyperindex.xyz/shared123/v1/graphql';
const OWN = 'https://indexer.hyperindex.xyz/other123/v1/graphql';
const DECLARED = [1, 42161, 43114, 4663];

const v4 = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    buildIntegrations(env)
      .filter((i) => i.protocol === 'uniswap-v4')
      .map((i) => [i.chainId, i]),
  );

describe('shared v4 indexer url', () => {
  it('covers every DECLARED row from one variable, with no list to keep in sync', () => {
    /*
     * An env chain-list was tried and removed: the `row(...)` calls in
     * integrations.config.ts already enumerate the chains, so a list duplicated
     * them and reintroduced the very drift this variable deletes. Staging a chain
     * dark is a commented-out row — the convention the v3 integration uses.
     */
    const got = v4({
      UNISWAP_V4_INDEXER_URL: SHARED,
      UNISWAP_V4_INDEXER_DIALECT: 'hyperindex',
    } as NodeJS.ProcessEnv);

    for (const id of DECLARED) {
      expect(got[id].enabled, `chain ${id}`).toBe(true);
      expect(got[id].subgraphUrl, `chain ${id}`).toBe(SHARED);
      expect(got[id].dialect, `chain ${id}`).toBe('hyperindex');
    }
  });

  it('lets one chain sit on its own deployment while the rest share', () => {
    // The real case: a chain backfilling on a separate deployment.
    const got = v4({
      UNISWAP_V4_INDEXER_URL: SHARED,
      ROBINHOOD_UNISWAP_V4_SUBGRAPH_URL: OWN,
    } as NodeJS.ProcessEnv);

    expect(got[4663].subgraphUrl).toBe(OWN);
    expect(got[1].subgraphUrl).toBe(SHARED);
  });

  it('honours a per-chain dialect over the fleet-wide one', () => {
    const got = v4({
      UNISWAP_V4_INDEXER_URL: SHARED,
      UNISWAP_V4_INDEXER_DIALECT: 'hyperindex',
      AVALANCHE_UNISWAP_V4_SUBGRAPH_DIALECT: 'thegraph',
    } as NodeJS.ProcessEnv);

    expect(got[1].dialect).toBe('hyperindex');
    expect(got[43114].dialect).toBe('thegraph');
  });

  it('changes nothing when the shared keys are unset', () => {
    // Backwards compatibility: the per-chain keys alone behave exactly as before,
    // including `enabled` staying false for a chain with no url anywhere.
    const got = v4({
      ETHEREUM_UNISWAP_V4_SUBGRAPH_URL: OWN,
      ETHEREUM_UNISWAP_V4_SUBGRAPH_DIALECT: 'hyperindex',
    } as NodeJS.ProcessEnv);

    expect(got[1].subgraphUrl).toBe(OWN);
    expect(got[1].dialect).toBe('hyperindex');
    for (const id of DECLARED.filter((c) => c !== 1)) {
      expect(got[id].enabled, `chain ${id}`).toBe(false);
    }
  });

  it('still rejects an unknown dialect value rather than defaulting', () => {
    // A typo must not silently fall back to `thegraph`, which returns a
    // well-formed EMPTY list instead of an error.
    expect(() =>
      buildIntegrations({
        UNISWAP_V4_INDEXER_URL: SHARED,
        UNISWAP_V4_INDEXER_DIALECT: 'hyperindexx',
      } as NodeJS.ProcessEnv),
    ).toThrow(/unknown subgraph dialect/i);
  });
});
