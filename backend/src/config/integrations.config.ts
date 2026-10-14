import type { ProtocolKey } from './protocols.config.js';

export interface IntegrationConfig {
  chainId: number;
  protocol: ProtocolKey;
  /**
   * The PRIMARY indexer endpoint (`sources[0]`) — the one query path for
   * positions, position transactions, pool stats (TVL/volume/fees), charts, the
   * interval snapshots AND the `derivedETH` that feeds subgraph-sourced pricing.
   * With a fallback configured, `subgraphFetch` fails over to it transparently.
   *
   * It is named `subgraphUrl` because everything in this backend speaks The
   * Graph's QUERY DIALECT to it (see `dialect`). It is NOT a The Graph hosted
   * deployment — that dependency, its API key and its gateway URL rewriting were
   * removed in the Envio cutover, and `validateRegistries` now REFUSES a
   * `gateway.thegraph.com` URL at boot rather than letting one quietly work.
   */
  subgraphUrl?: string;
  /**
    * Which GraphQL dialect the primary source speaks. Ponder always speaks
    * `thegraph` on its `/subgraph` route; only Envio's source dialect is
    * configurable.
    *
    *   `thegraph`   the endpoint already answers the subgraph dialect natively
    *                (Envio's graph-api mode or Ponder's `/subgraph` route), so
    *                queries go out untouched.
    *   `hyperindex` a raw Envio HyperIndex/Hasura endpoint
    *                (`indexer.hyperindex.xyz`), which `src/subgraph/hyperindex/`
    *                converts.
   *
   * Set EXPLICITLY, never sniffed from the hostname: an Envio deployment can
   * serve either dialect, and a wrong guess fails in the silent direction —
   * unprefixed ids against a `<chainId>_` id space return a well-formed empty
   * list, indistinguishable from end-of-walk.
   */
  dialect: SubgraphDialect;
  /**
   * Every indexer that can serve this integration, in PRIORITY order: the first
   * is the primary, the rest are fallbacks tried when it is down or too far
   * behind (`subgraph/indexer-failover.ts`).
   *
   * `subgraphUrl` / `dialect` above always equal `sources[0]`, so every
   * "is there an indexer?" check and every single-source code path is unchanged.
   * Optional only so hand-built configs (tests, scripts) keep compiling; absent
   * means the one source described by `subgraphUrl` / `dialect`.
   */
  sources?: readonly IndexerSource[];
  enabled: boolean;
}

export type SubgraphDialect = 'thegraph' | 'hyperindex';

const DIALECTS: readonly SubgraphDialect[] = ['thegraph', 'hyperindex'];

/**
 * Which indexer a source is. Both serve IDENTICAL data in the subgraph dialect:
 *   `envio`  — the Envio indexer, in either of its serving modes (`dialect`).
 *   `ponder` — the Ponder indexer's `/subgraph` route: The Graph's dialect with
 *              bare ids, pinned to ONE chain per process, so it is always
 *              `thegraph` and always configured per chain.
 */
export type IndexerSourceKind = 'envio' | 'ponder';

export interface IndexerSource {
  readonly kind: IndexerSourceKind;
  readonly url: string;
  readonly dialect: SubgraphDialect;
}

const SOURCE_KINDS: readonly IndexerSourceKind[] = ['envio', 'ponder'];

/**
 * Parse a `*_INDEXER_SOURCES` value: a comma-separated priority list such as
 * `envio`, `ponder`, `envio,ponder` or `ponder,envio`. Throws on an unknown or
 * repeated name — a typo must not silently drop a source.
 */
export function parseSourceOrder(raw: string, where: string): IndexerSourceKind[] {
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(`${where} is empty; expected a comma-separated list of ${SOURCE_KINDS.join(', ')}`);
  }
  for (const name of names) {
    if (!SOURCE_KINDS.includes(name as IndexerSourceKind)) {
      throw new Error(
        `${where} names an unknown indexer source ${JSON.stringify(name)}; expected ${SOURCE_KINDS.join(', ')}`,
      );
    }
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`${where} lists a source more than once: ${JSON.stringify(raw)}`);
  }
  return names as IndexerSourceKind[];
}

export function buildIntegrations(env: NodeJS.ProcessEnv = process.env): IntegrationConfig[] {
  /**
   * `enabled` means "we have at least one indexer endpoint" — Envio, Ponder, or
   * both. An integration with no source at all has nothing to serve and is
   * filtered out at boot.
   */
  /*
   * ONE URL FOR EVERY CHAIN, without losing the per-chain switch.
   *
   * Every v4 chain is normally served by the SAME multichain Envio deployment,
   * so repeating its url four times is pure drift surface — and it drifted: three
   * chains sat on `gateway.thegraph.com` (which `validateRegistries` refuses at
   * boot) while Robinhood pointed at a deployment that answered HTTP 404, and
   * nothing made that visible.
   *
   * Resolution order, per chain:
   *   1. `<CHAIN>_UNISWAP_V4_SUBGRAPH_URL`  — explicit override, still wins. This
   *      is what lets one chain sit on its own deployment while it backfills.
   *   2. `UNISWAP_V4_INDEXER_URL`           — the shared default, for every row
   *      declared below.
   *   3. nothing                            — the row is disabled, and
   *      `app-config.service.ts` warns once per dropped row at boot.
   *
   * THERE IS NO CHAIN LIST, deliberately. An env list was tried and removed: the
   * `row(...)` calls below already enumerate the chains, so a list duplicates
   * them and reintroduces exactly the drift the shared url exists to delete. To
   * stage a chain dark, comment out its row — the same way the v3 row is — which
   * is a reviewable one-line change rather than an env key nobody can see.
   *
   * Envio dialect resolves the same way, so switching the Envio source between
   * its two serving modes — or onto a different backend later — is one variable.
   *
   * PONDER, AND WHICH SOURCE WINS
   *
   * The Ponder indexer serves the same data through its `/subgraph` route.
   * Ponder runs one process per chain, so its url is per chain only:
   * `<CHAIN>_UNISWAP_V4_PONDER_URL` (the `/subgraph` url, not `/graphql`).
   *
   * `<CHAIN>_UNISWAP_V4_INDEXER_SOURCES`, else `UNISWAP_V4_INDEXER_SOURCES`, is
   * the priority list: `envio`, `ponder`, `envio,ponder` (Envio primary, Ponder
   * fallback) or `ponder,envio`. A listed source this chain has no url for is
   * skipped, so one fleet-wide list works while a chain runs on one indexer.
   * Unset: every configured source, Envio first — exactly today's behaviour for
   * a chain with no Ponder url.
   */
  const sharedUrl = env.UNISWAP_V4_INDEXER_URL || undefined;
  const sharedDialect = env.UNISWAP_V4_INDEXER_DIALECT || undefined;
  const sharedOrder = env.UNISWAP_V4_INDEXER_SOURCES?.trim() || undefined;

  const row = (
    chainId: number,
    protocol: ProtocolKey,
    perChainUrl: string | undefined,
    perChainDialect?: string,
    ponderUrl?: string,
    perChainOrder?: string,
  ): IntegrationConfig => {
    const envioUrl = perChainUrl || sharedUrl || undefined;
    // Per-chain dialect wins; otherwise the fleet-wide one, whatever url the
    // chain ended up with. Tying this to "did the url come from the shared key"
    // was tried and is too subtle to reason about at 3am — a chain pointed at its
    // own deployment of the SAME serving mode would silently fall back to
    // `thegraph`, which returns a well-formed EMPTY list rather than an error.
    const rawDialect = perChainDialect || sharedDialect;
    // A typo must not silently fall back to `thegraph` — that is the direction
    // that returns an empty list instead of an error.
    if (rawDialect && !DIALECTS.includes(rawDialect as SubgraphDialect)) {
      throw new Error(
        `Integration ${chainId}:${protocol} has an unknown subgraph dialect ` +
          `${JSON.stringify(rawDialect)}; expected one of ${DIALECTS.join(', ')}`,
      );
    }
    const envioDialect = (rawDialect as SubgraphDialect | undefined) ?? 'thegraph';

    const available: Partial<Record<IndexerSourceKind, IndexerSource>> = {};
    if (envioUrl) available.envio = { kind: 'envio', url: envioUrl, dialect: envioDialect };
    if (ponderUrl) available.ponder = { kind: 'ponder', url: ponderUrl, dialect: 'thegraph' };

    const rawOrder = perChainOrder?.trim() || sharedOrder;
    const order = rawOrder
      ? parseSourceOrder(
          rawOrder,
          perChainOrder?.trim() ? `The per-chain INDEXER_SOURCES for ${chainId}:${protocol}` : 'UNISWAP_V4_INDEXER_SOURCES',
        )
      : SOURCE_KINDS;
    const sources = order.flatMap((kind) => (available[kind] ? [available[kind]!] : []));
    const primary = sources[0];

    return {
      chainId,
      protocol,
      subgraphUrl: primary?.url,
      dialect: primary?.dialect ?? envioDialect,
      sources,
      enabled: sources.length > 0,
    };
  };

  return [
    // row(1, 'uniswap-v3', env.ETHEREUM_UNISWAP_V3_SUBGRAPH_URL),
    row(
      1,
      'uniswap-v4',
      env.ETHEREUM_UNISWAP_V4_SUBGRAPH_URL,
      env.ETHEREUM_UNISWAP_V4_SUBGRAPH_DIALECT,
      env.ETHEREUM_UNISWAP_V4_PONDER_URL || undefined,
      env.ETHEREUM_UNISWAP_V4_INDEXER_SOURCES,
    ),
    row(
      43114,
      'uniswap-v4',
      env.AVALANCHE_UNISWAP_V4_SUBGRAPH_URL,
      env.AVALANCHE_UNISWAP_V4_SUBGRAPH_DIALECT,
      env.AVALANCHE_UNISWAP_V4_PONDER_URL || undefined,
      env.AVALANCHE_UNISWAP_V4_INDEXER_SOURCES,
    ),
    row(
      42161,
      'uniswap-v4',
      env.ARBITRUM_UNISWAP_V4_SUBGRAPH_URL,
      env.ARBITRUM_UNISWAP_V4_SUBGRAPH_DIALECT,
      env.ARBITRUM_UNISWAP_V4_PONDER_URL || undefined,
      env.ARBITRUM_UNISWAP_V4_INDEXER_SOURCES,
    ),
    // Robinhood Chain. Enabled 2026-09-18: the multichain HyperIndex deployment now
    // covers 4663 with the full `Position` shape (liquidity, amounts, aggregates).
    // It was dark for a while on the opposite grounds, and the comment outlived the
    // fact — so check `chain_metadata` on the deployment rather than this line.
    // Leaving its env unset still disables the row at boot.
    row(
      4663,
      'uniswap-v4',
      env.ROBINHOOD_UNISWAP_V4_SUBGRAPH_URL,
      env.ROBINHOOD_UNISWAP_V4_SUBGRAPH_DIALECT,
      env.ROBINHOOD_UNISWAP_V4_PONDER_URL || undefined,
      env.ROBINHOOD_UNISWAP_V4_INDEXER_SOURCES,
    ),
  ];
}
