import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { detectFeeSweepBlock, detectFeeSweepBlocks } from './fee-sweep-detection.js';
import { GraphQLClient, gql } from 'graphql-request';
import { subgraphFetch } from '../subgraph/hyperindex/client.js';
import { runInLane } from '../subgraph/hyperindex/indexer-context.js';
import { runInWriteLane } from '../common/write-lane.js';
import { CoordinationRedis } from '../common/coordination-redis.js';
import { LeaseRunner } from '../common/lease-runner.js';
import { can, currentProcessRole, leasesEnabled } from '../common/process-role.js';
import { AppConfigService } from '../config/app-config.service.js';
import { getChainConfig } from '../config/chains.config.js';
import type { IntegrationConfig } from '../config/integrations.config.js';
import { SyncRepository } from '../database/sync.repository.js';
import { AdapterRegistryService } from '../subgraph/adapter-registry.service.js';
import { PositionFeeRefreshService } from './position-fee-refresh.service.js';

/*
 * The change feed: positions whose state actually changed.
 *
 * `updatedAtBlock` is bumped by modify / transfer / burn. The indexer no longer
 * re-reads uncollected fees at all — its fee sweep, and the `feesUpdatedAtBlock`
 * watermark it kept apart from `updatedAtBlock`, are gone — so nothing but a
 * position change moves it. (Measured on the previous indexer, where the sweep
 * still existed and wrote that separate column: it touched 400 positions every
 * 300 blocks on mainnet and moved NONE of their `updatedAtBlock`; over a
 * 50,000-block window there were 12,301 changed positions across 8,713 distinct
 * blocks, largest single-block cluster 50.) See `detectFeeSweepBlock` below for
 * why the old suppression survives anyway.
 *
 * Fee freshness is NOT this feed's job: it arrives from the backend's own
 * on-chain fee refresh (`PositionFeeRefreshService`), which this listener pokes
 * for every changed position (`markDirty`) and the `POSITIONS_SYNC_INTERVAL_MS`
 * refresh cron re-reads for every tracked active position.
 */
const UPDATED_QUERY = gql`
  query Updated($where: Position_filter, $first: Int!) {
    positions(where: $where, orderBy: updatedAtBlock, orderDirection: asc, first: $first) {
      tokenId
      updatedAtBlock
      updatedAtTimestamp
    }
  }
`;

// Latest indexed `updatedAtBlock` — used to seed the cursor on a cold start so
// the listener watches from "now" rather than enqueuing the entire index.
const HEAD_QUERY = gql`
  query Head($where: Position_filter) {
    positions(where: $where, orderBy: updatedAtBlock, orderDirection: desc, first: 1) {
      updatedAtBlock
      updatedAtTimestamp
    }
  }
`;

const EVENT_PAGE_SIZE = 500;
/**
 * How often an IDLE listener re-checks that its cursor is still at or behind the
 * indexer's own frontier. Bounded by wall clock rather than by the sleep backoff,
 * so it costs the same one query per chain per interval whatever the intervals
 * are tuned to. The FIRST idle poll always probes (the guard starts unstamped),
 * because a stranded cursor is exactly what a restart inherits.
 */
const CURSOR_GUARD_INTERVAL_MS = 5 * 60 * 1000;

const ERROR_BACKOFF_MAX_MS = 60_000;
const ADAPTIVE_BACKOFF_MULTIPLIER = 8;
const PAGINATION_HARD_CAP = 20; // 20 × 500 = 10k rows / poll

/**
 * P2.1 (leases on only): one poll loop per chain FLEET-WIDE, under lease
 * `live:<chainId>:<protocol>` (TTL 30 s, renew 10 s, design §2.3). A deposed
 * holder's loop exits before its next poll (`stillHeld()`); an overlap
 * enqueue collapses on the BullMQ de-duplication id (one pending refresh per
 * position), and the new holder starts from the persisted `liveBlockNumber`.
 */
export const LIVE_LEASE_TTL_MS = 30_000;
export const LIVE_LEASE_RENEW_MS = 10_000;
export function liveLeaseName(chainId: number, protocol: string): string {
  return `live:${chainId}:${protocol}`;
}

export interface LiveRefreshEnqueueRequest {
  chainId: number;
  protocol: string;
  tokenId: string;
  blockNumber: number;
}

export type LiveRefreshEnqueueFn = (
  request: LiveRefreshEnqueueRequest,
) => Promise<void>;

@Injectable()
export class LiveEventListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveEventListenerService.name);
  private readonly stoppers = new Map<string, () => void>();
  private readonly runners = new Map<string, LeaseRunner>();
  private enqueueFn?: LiveRefreshEnqueueFn;
  private ownCoordination?: CoordinationRedis;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(SyncRepository) private readonly syncRepo: SyncRepository,
    @Inject(AdapterRegistryService) private readonly adapters: AdapterRegistryService,
    // APPENDED and optional: specs construct this service positionally.
    @Optional() @Inject(PositionFeeRefreshService) private readonly feeRefresh?: PositionFeeRefreshService,
    // P2.1, APPENDED and optional: the coordination client for the per-chain
    // live leases (leases on only). Absent → a local one on REDIS_URL.
    @Optional() @Inject(CoordinationRedis) private readonly coordination?: CoordinationRedis,
  ) {}

  registerEnqueue(fn: LiveRefreshEnqueueFn): void {
    this.enqueueFn = fn;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.liveRefreshEnabled) {
      this.logger.log(`Live event listener disabled at ${new Date().toISOString()}`);
      return;
    }
    // P2.1: only `all` and `sync` run the poll loops.
    if (!can('live-listener')) {
      this.logger.log(`Live event listener not started: role ${currentProcessRole()} does not run it`);
      return;
    }

    for (const integration of this.config.enabledIntegrations) {
      this.startLoop(integration);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const stop of this.stoppers.values()) stop();
    this.stoppers.clear();
    // Leases on: await each loop's poll in flight, then release its lease so
    // a standby takes over within one renew.
    await Promise.all([...this.runners.values()].map((runner) => runner.stop()));
    this.runners.clear();
    await this.ownCoordination?.close().catch(() => undefined);
  }

  private coordinationRedis(): CoordinationRedis {
    if (this.coordination) return this.coordination;
    this.ownCoordination ??= new CoordinationRedis(this.config);
    return this.ownCoordination;
  }

  private startLoop(integration: IntegrationConfig): void {
    /*
     * The feed below reads the indexer's per-position cashflow aggregates, so it
     * is only meaningful for an adapter in `aggregates` recompute mode. Today
     * that is every enabled integration; the gate exists so that re-enabling a
     * transactions-mode protocol (the dormant v3 row) skips this loop LOUDLY
     * rather than pointing an `orderBy: updatedAtBlock` query at a schema that
     * has no such column.
     */
    if (this.adapters.resolve(integration.protocol).recomputeMode !== 'aggregates') {
      this.logger.warn(
        `Live listener skipped (adapter is not aggregates-mode): chainId=${integration.chainId} protocol=${integration.protocol}`,
      );
      return;
    }
    if (!integration.subgraphUrl) {
      // A listener that skips a chain looks exactly like a quiet chain, and that
      // ambiguity is what let the previous one sit dead for weeks.
      this.logger.warn(
        `[alert] live.no_source chainId=${integration.chainId} protocol=${integration.protocol} — ` +
          `no indexer URL, so position changes for this chain arrive ONLY on the ` +
          `POSITIONS_SYNC_INTERVAL_MS refresh cron and new positions only on an admin backfill.`,
      );
      return;
    }

    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    const chain = getChainConfig(integration.chainId);
    const baseInterval = Math.max(
      this.config.livePollMinMs,
      chain?.blockTimeMs ?? this.config.livePollIntervalFallbackMs,
    );
    const maxIdleSleep = baseInterval * ADAPTIVE_BACKOFF_MULTIPLIER;

    const client = new GraphQLClient(integration.subgraphUrl, subgraphFetch(integration));
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    this.stoppers.set(integrationKey, stop);

    // The whole loop — every poll, head probe and cursor guard — runs in the
    // indexer's `live` lane, so the meter attributes it and an enforcing gateway
    // serves it after users but ahead of refresh and sweeps.
    // Its Mongo writes are charged to the `live` write lane (P2.4).
    const runLoop = (isStopped: () => boolean) =>
      runInLane({ lane: 'live', job: 'live-listener', chainId: integration.chainId }, () =>
        runInWriteLane('live', () =>
          this.runLoop({
            integration,
            integrationKey,
            client,
            baseInterval,
            maxIdleSleep,
            isStopped,
          }),
        ),
      );

    if (leasesEnabled()) {
      // P2.1: one loop per chain fleet-wide. Never awaited (a standby passes its
      // healthcheck while the holder lives). The loop stops before its next poll
      // once the lease is lost; the next holder starts from the persisted cursor.
      const coordination = this.coordinationRedis();
      const runner = new LeaseRunner({
        name: liveLeaseName(integration.chainId, integration.protocol),
        redis: () => coordination.client(),
        namespace: coordination.namespace,
        ttlMs: LIVE_LEASE_TTL_MS,
        renewMs: LIVE_LEASE_RENEW_MS,
        failOpen: currentProcessRole() === 'all',
        // A loop that returned (stillHeld lapsed, or any other exit) must not
        // leave the lease held with no poller behind it: the runner releases
        // it and re-acquires (new fence, loop restarted from the cursor).
        releaseWhenWorkReturns: true,
        work: (ctx) => runLoop(() => stopped || ctx.signal.aborted || !ctx.stillHeld()),
      });
      this.runners.set(integrationKey, runner);
      runner.start();
      this.logger.log(`Live event listener lease runner started: ${integrationKey} at ${new Date().toISOString()}`);
      return;
    }

    this.logger.log(
      `Live event listener started: ${integrationKey} at ${new Date().toISOString()}`,
    );
    void runLoop(() => stopped).catch((error) => {
      this.logger.error(
        `Live listener loop crashed: ${integrationKey} ${(error as Error).message}`,
      );
    });
  }

  private async runLoop(args: {
    integration: IntegrationConfig;
    integrationKey: string;
    client: GraphQLClient;
    baseInterval: number;
    maxIdleSleep: number;
    isStopped: () => boolean;
  }): Promise<void> {
    const { integration, integrationKey, client, baseInterval, maxIdleSleep, isStopped } = args;

    const cursor = await this.syncRepo.getCursor(integration.chainId, integration.protocol);
    // `null` = NOT YET SEEDED, which is a different thing from block 0 and must
    // stay different. The seed used to be `.catch(() => 0)`: a failed head probe
    // silently produced 0, and 0 makes every poll an `updatedAtBlock_gt: 0` walk
    // of the entire index — self-perpetuating, because that walk is itself what
    // times out on a large table. A probe failure must leave the cursor unseeded
    // and be retried, never fall through to "scan everything".
    let lastSeenBlock: number | null = (cursor?.liveBlockNumber ?? 0) > 0
      ? (cursor!.liveBlockNumber as number)
      : null;
    let currentSleep = baseInterval;
    let errorBackoff = baseInterval;
    let lastCursorGuardAt = 0;

    while (!isStopped()) {
      try {
        // Cold start: seed from the current head so we don't enqueue the whole
        // index (historical positions are owned by backfill + the cron refresh).
        // Retried here under the loop's own error backoff rather than once at
        // startup, so a transient failure costs one interval, not the process.
        if (lastSeenBlock === null) {
          const head = await this.headBlock(client, integration.chainId);
          if (head === null) {
            // The probe SUCCEEDED and the chain has nothing indexed yet. Stay
            // unseeded and try again next tick rather than seeding 0 — see
            // `headBlock`. There is nothing to poll for in the meantime anyway.
            this.logger.debug(
              `Live listener not yet seeded (${integrationKey}): no indexed positions for this chain`,
            );
            currentSleep = Math.min(currentSleep * 2, maxIdleSleep);
            await sleep(currentSleep, isStopped);
            continue;
          }
          lastSeenBlock = head.block;
          lastCursorGuardAt = Date.now();
          this.logger.log(
            `Live listener seeded: ${integrationKey} at block ${lastSeenBlock}`,
          );
        }
        const { maxBlock, maxTs } = await this.processNewEvents(
          integration,
          integrationKey,
          client,
          lastSeenBlock,
        );
        if (maxBlock > lastSeenBlock) {
          await this.syncRepo.markLiveCursor(integration.chainId, integration.protocol, maxBlock, maxTs);
          lastSeenBlock = maxBlock;
          currentSleep = baseInterval;
        } else {
          currentSleep = Math.min(currentSleep * 2, maxIdleSleep);
          // "Nothing new" has TWO causes and they are indistinguishable from
          // here: the chain is quiet, or the cursor sits ABOVE the indexer's own
          // frontier and `updatedAtBlock_gt lastSeenBlock` can therefore never
          // match again. The second is permanent and SILENT — no error, no log,
          // just a listener that looks like a quiet chain forever. It happens
          // whenever the indexer moves BACKWARDS under us (a redeploy of a fresh
          // build, a restored snapshot, a re-pointed url) while Mongo keeps the
          // older, higher cursor. The seeding path above guards hard against
          // seeding too LOW; this is the opposite direction, and it needs its own
          // guard because nothing else in the loop ever reads the head again.
          if (Date.now() - lastCursorGuardAt >= CURSOR_GUARD_INTERVAL_MS) {
            lastCursorGuardAt = Date.now();
            const head = await this.headBlock(client, integration.chainId);
            if (head !== null && lastSeenBlock > head.block) {
              this.logger.warn(
                `[alert] live.cursor_ahead_of_indexer ${integrationKey} ` +
                  `cursor=${lastSeenBlock} indexerHead=${head.block} — the indexer has gone ` +
                  `backwards; resetting the cursor to its head. Positions at or below that ` +
                  `block are owned by backfill + the cron refresh.`,
              );
              await this.syncRepo.markLiveCursor(
                integration.chainId,
                integration.protocol,
                head.block,
                head.timestamp,
              );
              lastSeenBlock = head.block;
              currentSleep = baseInterval;
            }
          }
        }
        errorBackoff = baseInterval;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Live listener poll failed: ${integrationKey} error=${message}`);
        currentSleep = errorBackoff;
        errorBackoff = Math.min(errorBackoff * 2, ERROR_BACKOFF_MAX_MS);
      }
      await sleep(currentSleep, isStopped);
    }

    this.logger.log(`Live event listener stopped: ${integrationKey} at ${new Date().toISOString()}`);
  }

  /**
   * `null` means NOT SEEDED — the caller retries next tick. An EMPTY result gets
   * that answer too, deliberately: seeding 0 pins `lastSeenBlock` at 0 for the
   * life of the process (the `=== null` re-seed check never runs again), and the
   * first poll after the indexer catches up then walks from block 0 — up to
   * PAGINATION_HARD_CAP × EVENT_PAGE_SIZE = 10,000 refresh jobs over the
   * historical corpus, each re-pricing a position and re-running the aggregate
   * recompute. That is the "scan everything" fall-through the comment in
   * `runLoop` forbids, reached through the success path instead of the throw.
   */
  private async headBlock(
    client: GraphQLClient,
    chainId: number,
  ): Promise<{ block: number; timestamp: number } | null> {
    const result = await client.request<{
      positions?: Array<{ updatedAtBlock?: string | number; updatedAtTimestamp?: string | number }>;
    }>(HEAD_QUERY, { where: { chainId } });
    const row = result.positions?.[0];
    const raw = row?.updatedAtBlock;
    if (raw === undefined || raw === null) return null;
    const block = Number(raw);
    if (!Number.isFinite(block) || block <= 0) return null;
    const ts = Number(row?.updatedAtTimestamp);
    return { block, timestamp: Number.isFinite(ts) && ts > 0 ? ts : 0 };
  }

  private async processNewEvents(
    integration: IntegrationConfig,
    integrationKey: string,
    client: GraphQLClient,
    sinceBlock: number,
  ): Promise<{ maxBlock: number; maxTs: number }> {
    if (!this.enqueueFn) return { maxBlock: sinceBlock, maxTs: 0 };

    // tokenId -> the block it was last updated at, this poll.
    const tokenBlocks = new Map<string, number>();
    let maxTs = 0;
    /*
     * THE INVARIANT, and the whole reason this loop is shaped the way it is:
     * every row with `updatedAtBlock <= cursorBlock` has been consumed. That is
     * what makes `_gt cursorBlock` correct both between pages and between polls,
     * and it is what gets PERSISTED — so it must never run ahead of what we
     * actually read.
     */
    let cursorBlock = sinceBlock;
    let pagesScanned = 0;

    /*
     * KEYSET paging, not `skip`. `updatedAtBlock` is a MUTABLE sort key — a
     * position updated while the walk is in flight moves within the ordering —
     * so an offset walk would step over rows.
     *
     * But a keyset bound alone is NOT enough here, because `updatedAtBlock` is
     * also NOT UNIQUE: many positions can share one block, and the converter's
     * `{id: asc}` tiebreak orders them deterministically without letting a
     * block-only bound express "resume inside block N". So when a full page ends
     * part-way through a block, the rest of that block sits above the page and
     * below `_gt pageMaxBlock` — skipped, every time, permanently, because the
     * bound is then persisted. The fix is to advance only to the last block we
     * saw ENTIRELY, and re-request the truncated one.
     *
     * The positions BACKFILL can legitimately use `skip` because it orders by
     * `createdAtTimestamp`, which never changes for a position. The two rules are
     * different for a reason; do not unify them.
     */
    while (pagesScanned < PAGINATION_HARD_CAP) {
      const result: {
        positions?: Array<{
          tokenId?: string;
          updatedAtBlock?: string | number;
          updatedAtTimestamp?: string | number;
        }>;
      } = await client.request(UPDATED_QUERY, {
        where: { chainId: integration.chainId, updatedAtBlock_gt: String(cursorBlock) },
        first: EVENT_PAGE_SIZE,
      });
      const items = result.positions ?? [];
      pagesScanned += 1;

      // Buffered rather than written straight into `tokenBlocks`, because a full
      // page's TOP block may be half-read and has to be dropped below.
      const pageRows: Array<[tokenId: string, block: number]> = [];
      let pageMaxBlock = cursorBlock;
      for (const row of items) {
        const block = Number(row.updatedAtBlock ?? 0);
        if (!Number.isFinite(block)) continue;
        if (block > pageMaxBlock) pageMaxBlock = block;
        const ts = Number(row.updatedAtTimestamp ?? 0);
        if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
        const tokenId = String(row.tokenId ?? '');
        if (tokenId && /^\d+$/.test(tokenId)) pageRows.push([tokenId, block]);
      }

      // A short page means the server had nothing more above the bound, so every
      // block on it — including the highest — is complete.
      if (items.length < EVENT_PAGE_SIZE) {
        for (const [tokenId, block] of pageRows) tokenBlocks.set(tokenId, block);
        cursorBlock = Math.max(cursorBlock, pageMaxBlock);
        break;
      }

      // Full page: the highest block on it may be truncated. The highest block
      // strictly BELOW it is the last one we can prove we read in full.
      let lastCompleteBlock = cursorBlock;
      for (const [, block] of pageRows) {
        if (block < pageMaxBlock && block > lastCompleteBlock) lastCompleteBlock = block;
      }

      if (lastCompleteBlock > cursorBlock) {
        for (const [tokenId, block] of pageRows) {
          if (block <= lastCompleteBlock) tokenBlocks.set(tokenId, block);
        }
        // The dropped rows are not lost — the next request starts at
        // `_gt lastCompleteBlock`, which returns that block again from its start.
        cursorBlock = lastCompleteBlock;
        continue;
      }

      /*
       * The whole page is ONE block, so there is no lower block to fall back to
       * and the bound cannot be split any finer. Two bad options: hold the bound
       * (the listener wedges on that block forever and never sees anything newer)
       * or step past it (the block's tail is left to the refresh cron, which
       * re-reads every tracked active position anyway). Stepping past is the
       * lesser harm, but it is a real gap, so it is an [alert] rather than a log.
       *
       * ≥500 positions in one block is already the fee-sweep signature, so
       * `detectFeeSweepBlock` below will normally suppress the fan-out for this
       * same block — the two mechanisms are meant to compose.
       */
      for (const [tokenId, block] of pageRows) tokenBlocks.set(tokenId, block);
      this.logger.warn(
        `[alert] live.block_overflow ${integrationKey} — block ${pageMaxBlock} holds at least ` +
          `${EVENT_PAGE_SIZE} changed positions, more than one page, and a block-keyed cursor ` +
          `cannot resume inside a block. Advancing past it; any remainder is left to the ` +
          `POSITIONS_SYNC_INTERVAL_MS refresh cron. This is the fee-sweep signature — check the indexer.`,
      );
      cursorBlock = pageMaxBlock;
      break;
    }
    if (pagesScanned >= PAGINATION_HARD_CAP) {
      this.logger.warn(`Live pagination cap hit: ${integrationKey} pages=${pagesScanned}`);
    }

    /*
     * Fee-sweep backstop, retained deliberately though it should never fire.
     *
     * On the previous indexer a periodic fee sweep stamped `updatedAtBlock` on
     * every active position in one commit, so ONE sweep arrived here as the whole
     * active set "changing" and fanned out a refresh per row — up to
     * PAGINATION_HARD_CAP × EVENT_PAGE_SIZE = 10,000 jobs per poll, each of which
     * re-prices a position and re-runs the aggregate recompute. The indexer that
     * followed it separated the two columns (measured live, the largest genuine
     * single-block cluster was ~50 against a threshold of 500), and the one after
     * that has no fee sweep at all — so this branch is unreachable in normal
     * operation.
     *
     * It stays because the guarantee lives in an indexer we do not control and
     * cannot read from this checkout: one line added to a fee handler there turns
     * the feed back into a firehose, and that is the one failure in this
     * subsystem that writes to stored values at scale. It is a pure, separately
     * tested function costing one Map insert per row. It reads only
     * `updatedAtBlock` counts per block, so it does not depend on the indexer's
     * fee sweep or its `feesUpdatedAtBlock` column — both gone — and stays valid
     * as a guard against ANY bulk stamp of `updatedAtBlock`.
     *
     * What CHANGED: it no longer abandons the whole poll. The old code returned
     * early and skipped the fan-out for EVERY tokenId in the page, not just the
     * ones at a sweep block — so a genuine burst alongside a sweep was deferred
     * too. Now only sweep blocks' rows are dropped. Note the suppression uses
     * `detectFeeSweepBlocks` (ALL blocks over the floor), not the single worst
     * one: a batch commit straddling two blocks would otherwise have its larger
     * half suppressed and its smaller half fanned out, which is the same
     * firehose in miniature. The log line names the worst block because one
     * block and one count read better than a set.
     */
    const perBlockCount = new Map<number, number>();
    for (const block of tokenBlocks.values()) {
      perBlockCount.set(block, (perBlockCount.get(block) ?? 0) + 1);
    }
    const sweepBlocks = detectFeeSweepBlocks(perBlockCount);
    if (sweepBlocks.size > 0) {
      const [block, count] = detectFeeSweepBlock(perBlockCount)!;
      const extra = sweepBlocks.size > 1 ? ` (and ${sweepBlocks.size - 1} more block(s) over the floor)` : '';
      this.logger.warn(
        `[alert] live.sweep_suspected ${integrationKey} — ${count} positions share block ${block}${extra}, ` +
          `which is the signature of a periodic fee sweep rather than ${count} position changes. ` +
          `Skipping fan-out for those blocks only; the cron refresh owns those rows. The indexer ` +
          `no longer sweeps fees, so a bulk updatedAtBlock stamp should not happen — check the indexer.`,
      );
    }

    // A modify settles fees, so what just changed is re-read on-chain on the
    // fee job's next 60 s tick instead of serving the modify's 0 until a pass
    // reaches it. In-memory and de-duplicated; sweep blocks are skipped for the
    // same reason as the fan-out below. The change's block rides along, so a
    // position whose stored reading already post-dates it costs no RPC call.
    const changed = new Map([...tokenBlocks].filter(([, block]) => !sweepBlocks.has(block)));
    this.feeRefresh?.markDirty(integration.chainId, [...changed.keys()], integration.protocol, changed);

    // Every tokenId comes from our own index → all "tracked"; no cross-filter
    // needed. Enqueue each for refresh + aggregate recompute.
    for (const [tokenId, block] of tokenBlocks) {
      if (sweepBlocks.has(block)) continue;
      await this.enqueueFn({
        chainId: integration.chainId,
        protocol: integration.protocol,
        tokenId,
        // The SAFE bound, not the highest block observed — see the invariant on
        // `cursorBlock`. A single value per poll also coalesces the per-token
        // jobIds, which is the intended de-duplication.
        blockNumber: cursorBlock,
      });
    }
    // `maxBlock` is the caller's name for "the bound it may persist". It is the
    // fully-consumed bound, which is the only value that is safe to write to
    // `sync_cursors.liveBlockNumber`: the next poll resumes at `_gt` it.
    return { maxBlock: cursorBlock, maxTs };
  }
}

async function sleep(ms: number, isStopped: () => boolean): Promise<void> {
  const step = 100;
  let remaining = ms;
  while (remaining > 0 && !isStopped()) {
    const next = Math.min(step, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, next));
    remaining -= next;
  }
}
