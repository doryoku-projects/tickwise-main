import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { GraphQLClient, gql } from 'graphql-request';
import { AppConfigService } from '../config/app-config.service.js';
import { FlowLocks, sweepFlowLockName } from '../common/flow-lock.js';
import type { IntegrationConfig } from '../config/integrations.config.js';
import { PositionsRepository } from '../database/positions.repository.js';
import { GoplusService } from '../security/goplus.service.js';
import { subgraphFetch } from '../subgraph/hyperindex/client.js';
import { requestWithRetry } from '../subgraph/request-retry.js';

/*
 * Page the indexer's token universe, id-ordered. Only `id` is needed — GoplusService
 * decides per-address whether a GoPlus call is warranted.
 *
 * KEYSET, not offset. The walk takes tens of minutes on mainnet (~46k addresses)
 * and the universe MOVES underneath it — a token indexed mid-walk shifts every
 * subsequent offset by one and silently drops a row. `Token.id` is an immutable
 * lowercase 0x address, so `id_gt` is a total order with no ties and the cursor
 * cannot skip. (Verified against the live indexer: 0 of 46,153 mainnet ids fall
 * outside /^0x[0-9a-f]{40}$/, so the lowercasing the converter applies on the way
 * out cannot corrupt the cursor.)
 */
const TOKENS_PAGE_QUERY = gql`
  query SecurityTokens($where: Token_filter, $first: Int!) {
    tokens(where: $where, orderBy: id, orderDirection: asc, first: $first) {
      id
    }
  }
`;

const PAGE_SIZE = 1000; // MAX_FIRST — the converter rejects anything larger.
const CHUNK = 300; // addresses fed to assessTokens at a time (one cache read per chunk)

interface TokenPage {
  tokens: { id: string }[];
}

/**
 * Decoupled background sweep that keeps `{chainId}_tokens` security signals populated.
 * Pages the indexer's token universe and feeds addresses to `GoplusService`, which
 * skips security-certain (anchor/allowlisted) tokens, serves the 7-day cache,
 * and rate-limit-fetches the rest. NEVER invoked from the resync hot path — it
 * rides its own BullMQ cron (`token-security-sync`).
 */
@Injectable()
export class TokenSecuritySyncService {
  private readonly logger = new Logger(TokenSecuritySyncService.name);
  // Coalesce concurrent sweeps for the same chain (boot kick + cron tick).
  private readonly inFlight = new Map<number, Promise<{ checked: number }>>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(GoplusService) private readonly goplus: GoplusService,
    // APPENDED and optional: the spec constructs this service positionally.
    // Required for `TOKEN_SECURITY_SCOPE=active` (the default).
    @Optional() @Inject(PositionsRepository) private readonly positions?: PositionsRepository,
    // P2.1, APPENDED and optional: fleet flow lock `flow:token-security:<chain>:<protocol>`
    // (pass-through while leases are off; absent = the in-process guard only, today).
    @Optional() @Inject(FlowLocks) private readonly flowLocks?: FlowLocks,
  ) {}

  /**
   * `integration` is the whole config row rather than a URL string, deliberately:
   * the client must be built with `subgraphFetch(integration)` so the query is
   * translated, and the dialect lives on the row. It also makes the parameter
   * type-distinct from `chainId`, so a wrong-slot argument is a compile error
   * rather than a runtime surprise — this is the repo's positional-constructor
   * hazard in a method signature.
   */
  async syncChain(
    chainId: number,
    integration: IntegrationConfig | undefined,
  ): Promise<{ checked: number }> {
    // Return IMMEDIATELY when a sweep is already running for this chain — do NOT
    // await the shared promise. This method is called from a BullMQ handler on
    // the `background-sweeps` queue (concurrency 8; it shared `positions-sync`
    // until 2026-10-01), so every coalesced waiter would hold a slot for the
    // whole sweep. A mainnet sweep is ~46k addresses at 30 per GoPlus batch with
    // a 2.2s inter-batch delay, i.e. the better part of an hour; the boot kick, a
    // cron tick and an admin trigger can easily coincide and starve the other
    // sweeps into `waiting`. Its sibling
    // `TokenPriceSyncService` was changed away from the await-the-promise shape
    // on 2026-06-12 for exactly this reason; this one had not caught up, and it
    // only stayed survivable while the sweep was returning in microseconds.
    if (this.inFlight.has(chainId)) {
      this.logger.debug(`Token-security sweep already in flight for chain ${chainId}; skipping tick`);
      return { checked: 0 };
    }
    const run = this.runSweepLocked(chainId, integration).finally(() => this.inFlight.delete(chainId));
    this.inFlight.set(chainId, run);
    return run;
  }

  /** In-process claim first (above), then the fleet lock; held elsewhere → skip (the next tick runs). */
  private async runSweepLocked(
    chainId: number,
    integration: IntegrationConfig | undefined,
  ): Promise<{ checked: number }> {
    if (!this.flowLocks) return this.runSweep(chainId, integration);
    const protocol = integration?.protocol ?? 'uniswap-v4';
    const out = await this.flowLocks.run(sweepFlowLockName('token-security', chainId, protocol), () =>
      this.runSweep(chainId, integration),
    );
    if (out.held) {
      this.logger.log(`Token-security sweep for ${chainId}:${protocol} held elsewhere — skipped`);
      return { checked: 0 };
    }
    return out.value;
  }

  private async runSweep(
    chainId: number,
    integration: IntegrationConfig | undefined,
  ): Promise<{ checked: number }> {
    if (this.config.tokenSecurityScope !== 'universe') return this.runActiveSweep(chainId, integration);
    if (!integration?.subgraphUrl) {
      this.logger.warn(
        `[alert] token_security.no_source chain=${chainId} — no indexer URL for this chain, so the ` +
          `GoPlus sweep is doing nothing and the leaderboard's spam filter is frozen at whatever ` +
          `verdicts are already stored.`,
      );
      return { checked: 0 };
    }
    // 0 = unlimited (default): sweep the whole universe; GoPlus rate-limit
    // backoff self-throttles. A positive value is an optional debugging bound.
    const cap = Math.max(0, this.config.tokenSecurityMaxPerRun);
    const capped = cap > 0;

    const client = new GraphQLClient(integration.subgraphUrl, subgraphFetch(integration));
    const startedAt = Date.now();
    let cursor: string | null = null;
    let checked = 0;
    let pending: string[] = [];

    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      // assessTokens persists verdicts; we ignore the returned map here.
      await this.goplus.assessTokens(chainId, batch);
    };

    // A transient indexer blip (UND_ERR_CONNECT_TIMEOUT / fetch failed / a 429)
    // must NOT discard the whole sweep — `requestWithRetry` re-tries the page, and
    // a hard failure after retries breaks the loop GRACEFULLY (we keep the GoPlus
    // verdicts already upserted; the next cron tick resumes, cache-short-
    // circuiting the tokens we already covered). The job stays successful so
    // BullMQ doesn't re-run the whole walk from zero.
    for (;;) {
      const where: Record<string, unknown> = { chainId };
      if (cursor !== null) where.id_gt = cursor;
      let data: TokenPage;
      try {
        data = await requestWithRetry<TokenPage>(client, TOKENS_PAGE_QUERY, {
          where,
          first: PAGE_SIZE,
        });
      } catch (err) {
        this.logger.warn(
          `Token-security sweep chain=${chainId} stopped early at fed=${checked} — indexer page fetch failed: ${(err as Error)?.message ?? String(err)}`,
        );
        break;
      }
      const items = data.tokens ?? [];
      for (const t of items) {
        if (!t.id) continue;
        pending.push(t.id.toLowerCase());
        checked += 1;
        if (pending.length >= CHUNK) await flush();
        if (capped && checked >= cap) break;
      }
      if (capped && checked >= cap) break;
      // A short page ends the walk.
      if (items.length < PAGE_SIZE) break;
      /*
       * The cursor is the last USABLE id on the page, read back out of `items`
       * — the rows the SERVER returned — and it is taken VERBATIM.
       *
       * Two properties, both load-bearing and both easy to lose:
       *
       * 1. It must come from `items`, not from `pending` or any other buffer this
       *    loop keeps. `pending` is EMPTIED by `flush()`, so a page that happened
       *    to end on a chunk boundary would leave it empty, the cursor undefined,
       *    and the sweep would break after that page having assessed a fraction of
       *    the universe — reporting success. (As written the two happen to
       *    coincide, because every truthy id is pushed; that is a coincidence of
       *    the current filter, not a guarantee, and the next filter added to this
       *    loop breaks it.)
       * 2. It must be the RAW value, not `toLowerCase()`d like the addresses fed
       *    to GoPlus. The bound has to be byte-identical to what the server sorts
       *    on, or `id_gt` skips or repeats rows. Ids arrive lowercase today
       *    (verified live: 0 of 46,153 mainnet ids fall outside
       *    /^0x[0-9a-f]{40}$/), so the two agree — again, coincidentally.
       *
       * The scan back covers the malformed case: the page is ordered by id
       * ascending, so a falsy id sorts FIRST and cannot legitimately be last —
       * but if one ever is, taking it verbatim would either stall the walk or
       * re-request the same page forever.
       */
      let lastId: string | undefined;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i]?.id) {
          lastId = items[i]!.id;
          break;
        }
      }
      if (lastId === undefined || lastId === cursor) break; // no progress — never loop forever
      cursor = lastId;
    }
    await flush();

    this.logger.log(
      `Token-security sweep chain=${chainId} fed=${checked} (cap=${capped ? cap : 'unlimited'}) durationMs=${Date.now() - startedAt}`,
    );
    return { checked };
  }

  /**
   * `TOKEN_SECURITY_SCOPE=active`: assess the tokens of ACTIVE positions only.
   * The spam filter's job is the rows people can see, and every token on an
   * open position is in this set; a trusted pool's legs are anchors or
   * allowlisted by construction, which `GoplusService` skips anyway. A closed
   * position keeps the verdicts already stored for its tokens.
   *
   * No indexer request at all (the universe walk paged ~46k mainnet tokens and
   * many more on 4663), and GoPlus sees a few thousand addresses, most of them
   * served from its 7-day cache. A failed read throws, so BullMQ retries it —
   * unlike the universe walk there is no partial progress to keep.
   */
  private async runActiveSweep(
    chainId: number,
    integration: IntegrationConfig | undefined,
  ): Promise<{ checked: number }> {
    if (!this.positions || !integration?.protocol) {
      this.logger.warn(
        `[alert] token_security.no_source chain=${chainId} — scope=active needs the positions store and ` +
          `an integration; the GoPlus sweep is doing nothing.`,
      );
      return { checked: 0 };
    }
    const startedAt = Date.now();
    const cap = Math.max(0, this.config.tokenSecurityMaxPerRun);
    const all = await this.positions.distinctActiveTokenAddresses(chainId, integration.protocol);
    const addresses = cap > 0 ? all.slice(0, cap) : all;
    for (let i = 0; i < addresses.length; i += CHUNK) {
      await this.goplus.assessTokens(chainId, addresses.slice(i, i + CHUNK));
    }
    this.logger.log(
      `Token-security sweep chain=${chainId} scope=active fed=${addresses.length}/${all.length} ` +
        `(cap=${cap > 0 ? cap : 'unlimited'}) durationMs=${Date.now() - startedAt}`,
    );
    return { checked: addresses.length };
  }
}
