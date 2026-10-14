import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import type { Model } from 'mongoose';
import { AppConfigService } from '../config/app-config.service.js';
import { CollectionResolver } from './collection-resolver.js';
import { isDexBacked } from '../pricing/quote-consensus.js';
import { isAnchorTokenStandalone } from '../pricing/pricing-policy.js';
import { priceMissNotHeldClauses } from '../pricing/price-ledger.js';
import { isDenied, resolveTokenTrust, trustPolicyOf, type StoredTokenTrust } from '../pricing/token-trust.js';
import { identitySpamReason, identitySymbolPrefilter } from '../security/token-identity.js';
import { Token, type TokenDocument } from './schemas/token.schema.js';
import { USER_READ_PREFERENCE } from './user-read.js';
import { budgetedBulkWrite } from './budgeted-write.js';
import { WRITE_UNITS } from '../common/write-budget-model.js';
import { can, leasesEnabled } from '../common/process-role.js';
import { CoordinationRedis } from '../common/coordination-redis.js';
import { LeaderLoop } from '../common/leader-loop.js';
import {
  exclusionBlobKey,
  exclusionContentHash,
  exclusionMetaKey,
  decodeExclusionSnapshot,
  parseExclusionMeta,
  publishExclusionSnapshot,
} from './exclusion-snapshot.js';

/** Structured GoPlus signals (no `verified` — spam is computed at read-time). */
export interface TokenSignals {
  isHoneypot?: boolean;
  isBlacklisted?: boolean;
  cannotSellAll?: boolean;
  personalSlippageModifiable?: boolean;
  /** GoPlus `fake_token.value === 1`: GoPlus names another contract as the real token. */
  fakeToken?: boolean;
  cannotBuy?: boolean;
  honeypotWithSameCreator?: boolean;
  trustList?: boolean;
  isOpenSource?: boolean;
  isProxy?: boolean;
  buyTax?: number;
  sellTax?: number;
  holderCount?: number;
  creatorPercent?: number;
  tokenName?: string;
  tokenSymbol?: string;
}

export interface TokenSecurityRecord extends TokenSignals {
  chainId: number;
  address: string;
}

export interface TokenPriceRecord {
  address: string;
  priceUsd: number;
  pricedAt?: Date;
  symbol?: string;
  decimals?: number;
  priceConfidence?: string;
  priceSources?: string[];
  /** Best 24h DEX volume (USD) across the token's pairs (active-market signal). */
  dexVolume24h?: number;
  /** Counter-side reserve (USD) of the deepest DEX pair (wash-resistant signal). */
  dexCounterLiquidity?: number;
  /** Active-market verdict baked at sweep time (DEX source + volume ≥ floor + counter ≥ floor). */
  dexActive?: boolean;
  // Quote provenance (written only with the guard / trust evidence on; see token.schema.ts).
  priceQuoteSource?: string;
  /** null = the quote behind the price carries no provider date (overwrites an older dated one). */
  priceQuotedAt?: Date | null;
  priceQuoteRejected?: string[];
  priceGuardUsd?: number;
  /** Sweep: ≥ 2 accepted quotes were positive and disagreed (token.schema.ts). */
  priceSourcesDisagreed?: boolean;
}

/**
 * The provenance / guard fields of a price write. A write that carries ANY of
 * them is the complete evidence for the price it writes: `upsertPrices` stamps
 * `priceEvidenceAt` (= its `pricedAt`) and unsets the ones it does not carry,
 * so the stored set always describes one write (never a hot-path source beside
 * an older sweep's guard price).
 */
// `priceSourcesDisagreed` is NOT one of them: it is the sweep's verdict on the
// token's sources (read by the quote guard), not provenance of one write, and
// a hot-path write between two sweeps must not erase it.
const PRICE_EVIDENCE_FIELDS = ['priceQuoteSource', 'priceQuotedAt', 'priceQuoteRejected', 'priceGuardUsd'] as const;

/** One saved price the quote guard may clear, with the providers whose quotes this sweep rejected for it. */
export interface GuardedPriceClear {
  address: string;
  /** Provider names (no `:stale` / `:thin` suffix). The saved price is cleared only if every source behind it is one of these. */
  rejectedSources: string[];
}

/** Earned-trust evidence the consensus sweep stores (shadow or live; see token.schema.ts). */
export interface TokenTrustRecord {
  address: string;
  trustEarned: boolean;
  trustReason: string;
  trustEvaluatedAt: Date;
  trustSources: string[];
  dexPoolCount: number;
  dexOutsideLiquidityUsd: number;
  dexTopCounterUsd: number;
  dexTopCounterShare: number;
  dexTopPoolId?: string;
}

/** `findLookupPriority`: what a waiting token-pairs request is ordered by (each field absent when not stored). */
export interface TokenLookupPriority {
  trustEarned?: boolean;
  trustEvaluatedAt?: Date;
  /** The raw stored served verdict (never a fallback). */
  dexActive?: boolean;
}

/** What the pricing layer reads per page when the guard / earned trust is on (ONE query). */
export interface TokenMarketState {
  /** The DEX-market verdict `findDexMarketState` returns (absent when the doc has no sources). */
  dexBacked?: boolean;
  /**
   * The last guard / evidence sweep recorded that ≥ 2 accepted quotes for the
   * token disagreed (`priceSourcesDisagreed`). undefined = never recorded.
   */
  disagreed?: boolean;
  /**
   * The sweep's stored consensus verdict (`priceConfidence`, written only by
   * the consensus sweep — the hot path never writes it): true = ≥ 2
   * independent sources agreed within 10% (`external-verified`), false = one
   * source or disagreeing sources (`external-unverified`). undefined = no
   * swept sources recorded. Read by the quote guard's listed-pair cross-check.
   */
  consensus?: boolean;
  trust: StoredTokenTrust;
}

/**
 * The hard-flag spam rule, in ONE place. `isSpamSignals` (in-memory) and
 * `SPAM_MONGO_PREDICATE` (query) MUST stay equivalent — add a future condition
 * (e.g. `honeypotWithSameCreator`, tax thresholds) to BOTH together.
 * `fakeToken` (GoPlus `fake_token`, 2026-10-06) is the fifth: GoPlus itself
 * naming another contract as the real token has no false-positive case worth
 * keeping a fake USDT on a ranked list for.
 */
export function isSpamSignals(s: TokenSignals): boolean {
  return Boolean(s.isHoneypot || s.cannotSellAll || s.personalSlippageModifiable || s.isBlacklisted || s.fakeToken);
}
export const SPAM_MONGO_PREDICATE = {
  $or: [
    { isHoneypot: true },
    { cannotSellAll: true },
    { personalSlippageModifiable: true },
    { isBlacklisted: true },
    { fakeToken: true },
  ],
};

/**
 * How often the leaderboard exclusion set is REBUILT — two full scans of every
 * enabled chain's tokens collection (no index serves either filter). Was 60 s;
 * 300 s since 2026-10-07: on the M10 those scans were a top consumer of the
 * primary's CPU (Atlas Real Time, `{chain}_tokens` hottest, a 79 s GETMORE on
 * `4663_tokens`), and a spam flag reaching the lists 5 min later instead of
 * 1 min is cheap next to that.
 */
export const EXCLUSION_REFRESH_MS = 300_000;
/**
 * Leases on: how often a FOLLOWER checks the leader's published set. One small
 * GET per chain while it is unchanged, so it stays at 60 s — a follower's
 * staleness is the leader's 5 min build plus at most this, not 2 × 5 min.
 */
export const EXCLUSION_FOLLOW_MS = 60_000;
/**
 * Server-side limit on each exclusion scan. Generous (the build is a background
 * job, not a request), but finite: before it, one scan on a saturated primary
 * ran 79 s with nothing to cut it off. A timed-out build keeps the last good
 * set (`loadExclusions`).
 */
export const EXCLUSION_SCAN_MAX_TIME_MS = 120_000;
/** Leases on: the lease the ONE rebuilding process holds. */
export const EXCLUSIONS_LEASE = 'exclusions';
/** Leases on: the published set's key TTL (> 2 intervals; > the 3-interval staleness rule). */
export const EXCLUSION_SNAPSHOT_TTL_MS = Math.round(3.5 * EXCLUSION_REFRESH_MS);
/** Leases on: a follower rebuilds locally once the published set is older than this. */
export const EXCLUSION_SNAPSHOT_MAX_AGE_MS = 3 * EXCLUSION_REFRESH_MS;

/**
 * The read-time leaderboard exclusion for one chain: every token that is spam
 * (GoPlus-flagged, GoPlus `fake_token`, or identity spam on its stored symbol —
 * `findSpamAddresses`) OR has no real active DEX market, merged and
 * de-duplicated so each leg carries ONE `$nin` instead of two.
 */
/** Do two address lists hold the same members (each list is already de-duplicated)? */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const members = new Set(a);
  for (const address of b) if (!members.has(address)) return false;
  return true;
}

export interface LeaderboardExclusions {
  addresses: string[];
  /**
   * False while no scan has ever succeeded for this chain — `addresses` is then
   * empty (fail-open, as before) and callers must not cache what they computed
   * with it, or a spam row would be served from cache after the set recovers.
   */
  ok: boolean;
}

/**
 * Read/write access to the per-chain `{chainId}_tokens` collection: GoPlus
 * security signals (written by the sweep) + current USD price (written by the
 * pricing layer). Resolved through `CollectionResolver` (never `@InjectModel`).
 *
 * Also owns the ONE per-chain leaderboard exclusion set that the positions and
 * pools leaderboards read. Both scans are full passes over the chain's tokens,
 * so they are rebuilt on a background timer and read synchronously; a request
 * only ever waits for the very first build of a chain the timer has not reached.
 */
@Injectable()
export class TokensRepository implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TokensRepository.name);
  private readonly exclusions = new Map<number, LeaderboardExclusions>();
  private readonly exclusionLoads = new Map<number, Promise<LeaderboardExclusions>>();
  /** Chains the timer rebuilds: the enabled integrations plus any chain read since boot. */
  private readonly exclusionChains = new Set<number>();
  private exclusionTimer?: ReturnType<typeof setInterval>;
  /**
   * Leases on only: the `exclusions` lease. Its holder rebuilds and PUBLISHES
   * every set; every other process adopts the published copy (see
   * `loadExclusions`). Undefined with leases off — today's per-process timer.
   */
  private exclusionLeader?: LeaderLoop;
  /** Content hash of the set this process serves per chain (leases on). */
  private readonly exclusionHashes = new Map<number, string>();
  private exclusionRedisLoggedAt = 0;
  private exclusionMismatchLoggedAt = 0;

  constructor(
    @Inject(CollectionResolver) private readonly resolver: CollectionResolver,
    // APPENDED and optional: specs construct this repository positionally with
    // the resolver alone, and without config there is simply no timer — the set
    // is then built lazily on first read.
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    // APPENDED and optional: the coordination client (global module). Only read
    // when leases are on; without it every process rebuilds its own set (today).
    @Optional() @Inject(CoordinationRedis) private readonly coordination?: CoordinationRedis,
  ) {}

  private model(chainId: number): Model<TokenDocument> {
    return this.resolver.tokenModel(chainId);
  }

  onModuleInit(): void {
    if (!this.config) return;
    // P2.1: the exclusion-set rebuild (every EXCLUSION_REFRESH_MS) serves the read path (all, api);
    // sync / fee / feeder never serve a list (design §2.2).
    if (!can('exclusion-timer')) return;
    for (const integration of this.config.enabledIntegrations) this.exclusionChains.add(integration.chainId);
    if (this.exclusionChains.size === 0) return;
    if (leasesEnabled() && this.coordination) {
      // Leases on (capacity plan step 1): ONE process — the `exclusions` lease
      // holder — scans and publishes every EXCLUSION_REFRESH_MS; every other
      // replica adopts the published copy every EXCLUSION_FOLLOW_MS (one small
      // GET per chain while it is unchanged). The same `refreshAllExclusions` serves both: whether this
      // process leads is decided per load (`loadExclusions`).
      this.exclusionLeader = new LeaderLoop({
        name: EXCLUSIONS_LEASE,
        coordination: this.coordination,
        intervalMs: EXCLUSION_REFRESH_MS,
        followIntervalMs: EXCLUSION_FOLLOW_MS,
        lead: () => this.refreshAllExclusions(),
        follow: () => this.refreshAllExclusions(),
        logger: this.logger,
      });
      this.exclusionLeader.start();
    } else {
      this.exclusionTimer = setInterval(() => void this.refreshAllExclusions(), EXCLUSION_REFRESH_MS);
      this.exclusionTimer.unref?.();
    }
    // Warm at boot WITHOUT holding boot: a request that arrives before the
    // first build finishes joins that same in-flight build (single-flight in
    // `loadExclusions`), so nothing is gained by delaying `listen`.
    void this.refreshAllExclusions();
  }

  onModuleDestroy(): void {
    if (this.exclusionTimer) clearInterval(this.exclusionTimer);
    void this.exclusionLeader?.stop();
  }

  /** Leases on and another process holds `exclusions`: adopt its published sets. */
  private followsExclusionLeader(): boolean {
    return this.exclusionLeader !== undefined && !this.exclusionLeader.leading;
  }

  /**
   * Follower: serve the leader's published set for `chainId`. True when the
   * in-memory set is now the published one (unchanged → one small GET, the
   * object kept so its array identity — the read models' content version —
   * survives); false when the copy is missing, older than
   * `EXCLUSION_SNAPSHOT_MAX_AGE_MS`, malformed, or Redis is unreachable — the
   * caller then rebuilds locally, exactly as with leases off.
   */
  private async adoptPublishedExclusions(chainId: number): Promise<boolean> {
    const coordination = this.coordination;
    if (!coordination) return false;
    try {
      const redis = await coordination.client();
      if (!redis) return false;
      const meta = parseExclusionMeta(await redis.get(exclusionMetaKey(coordination.namespace, chainId)), chainId);
      if (!meta || Date.now() - meta.builtAt > EXCLUSION_SNAPSHOT_MAX_AGE_MS) return false;
      const current = this.exclusions.get(chainId);
      if (current?.ok && this.exclusionHashes.get(chainId) === meta.hash) return true;
      const decoded = decodeExclusionSnapshot(
        await redis.getBuffer(exclusionBlobKey(coordination.namespace, chainId)),
        chainId,
      );
      if (!decoded || decoded.hash !== meta.hash) {
        // Every publish leaves a consistent pair (EXCLUSION_EXTEND_SCRIPT / MULTI),
        // so this should not happen; when it does, every follower without the
        // set rescans Mongo each minute — say so (at most once a minute).
        this.logExclusionMismatch(chainId, meta.hash, decoded?.hash);
        return false;
      }
      const next =
        current?.ok && sameMembers(current.addresses, decoded.addresses)
          ? current
          : { addresses: decoded.addresses, ok: true };
      if (!current?.ok || current.addresses.length !== next.addresses.length) {
        this.logger.log(`Leaderboard exclusion set chain=${chainId}: ${next.addresses.length} addresses (adopted from the leader)`);
      }
      this.exclusions.set(chainId, next);
      this.exclusionHashes.set(chainId, meta.hash);
      return true;
    } catch (err) {
      this.logExclusionRedis(`read chain=${chainId}`, err);
      return false;
    }
  }

  /** Leader: publish a freshly built set. A Redis failure is logged (at most once a minute) and ignored. */
  private async publishExclusions(chainId: number, set: LeaderboardExclusions): Promise<void> {
    const coordination = this.coordination;
    if (!coordination || !set.ok) return;
    try {
      const redis = await coordination.client();
      if (!redis) return;
      const hash = this.exclusionHashes.get(chainId) ?? exclusionContentHash(set.addresses);
      this.exclusionHashes.set(chainId, hash);
      // Extends the stored pair only when Redis already holds this content
      // (checked atomically against what is stored, never against what this
      // process last wrote — another publisher may have written in between);
      // otherwise rewrites blob + meta together.
      await publishExclusionSnapshot(redis, coordination.namespace, chainId, set.addresses, Date.now(), EXCLUSION_SNAPSHOT_TTL_MS, hash);
    } catch (err) {
      this.logExclusionRedis(`publish chain=${chainId}`, err);
    }
  }

  private logExclusionMismatch(chainId: number, metaHash: string, blobHash: string | undefined): void {
    const now = Date.now();
    if (now - this.exclusionMismatchLoggedAt < 60_000) return;
    this.exclusionMismatchLoggedAt = now;
    this.logger.warn(
      `[alert] exclusions.snapshot_mismatch chain=${chainId} meta=${metaHash} blob=${blobHash ?? 'missing/undecodable'} ` +
        `— the published set is not adopted; this replica rebuilds from Mongo until the holder republishes`,
    );
  }

  private logExclusionRedis(what: string, err: unknown): void {
    const now = Date.now();
    if (now - this.exclusionRedisLoggedAt < 60_000) return;
    this.exclusionRedisLoggedAt = now;
    this.logger.warn(`Leaderboard exclusion set Redis ${what} failed (ignored): ${(err as Error)?.message ?? String(err)}`);
  }

  /**
   * The current exclusion set for a chain, synchronously. Undefined only before
   * the chain's first build has finished (which this call starts).
   */
  leaderboardExclusions(chainId: number): LeaderboardExclusions | undefined {
    this.exclusionChains.add(chainId);
    const current = this.exclusions.get(chainId);
    if (!current) void this.loadExclusions(chainId).catch(() => undefined);
    return current;
  }

  /**
   * The exclusion set, waiting only when this chain has never been built. In
   * steady state this resolves from memory with no I/O.
   */
  async readyLeaderboardExclusions(chainId: number): Promise<LeaderboardExclusions> {
    return this.leaderboardExclusions(chainId) ?? this.loadExclusions(chainId);
  }

  private async refreshAllExclusions(): Promise<void> {
    await Promise.all([...this.exclusionChains].map((chainId) => this.loadExclusions(chainId).catch(() => undefined)));
  }

  /**
   * Rebuild one chain's set, single-flight. On failure the last good set stays
   * in place; with no good set yet the chain reads as an EMPTY, not-ok set
   * (fail-open, matching the old behaviour) until a later rebuild succeeds.
   */
  private loadExclusions(chainId: number): Promise<LeaderboardExclusions> {
    const pending = this.exclusionLoads.get(chainId);
    if (pending) return pending;
    const run = (async (): Promise<LeaderboardExclusions> => {
      try {
        // Leases on, another process leads: adopt its published set; rebuild
        // locally (below) only when that copy is missing / stale / unreachable.
        if (this.followsExclusionLeader() && (await this.adoptPublishedExclusions(chainId))) {
          return this.exclusions.get(chainId) as LeaderboardExclusions;
        }
        const [spam, noMarket] = await Promise.all([
          this.findSpamAddresses(chainId),
          this.findNoRealMarketAddresses(chainId),
        ]);
        const fresh: LeaderboardExclusions = { addresses: [...new Set([...spam, ...noMarket])], ok: true };
        const previous = this.exclusions.get(chainId);
        // Same CONTENT as the set already published → keep the published
        // object. Its array identity is then a content version: the read
        // models' exclusion flags (R2, keyed by the array) survive the
        // rebuild instead of being recomputed on every rebuild. Order is not
        // content: the two reads come back in no fixed order.
        const next = previous?.ok && sameMembers(previous.addresses, fresh.addresses) ? previous : fresh;
        if (!previous?.ok || previous.addresses.length !== next.addresses.length) {
          this.logger.log(
            `Leaderboard exclusion set chain=${chainId}: ${next.addresses.length} addresses ` +
              `(spam ${spam.length}, no-market ${noMarket.length})`,
          );
        }
        this.exclusions.set(chainId, next);
        if (this.exclusionLeader) {
          // Leases on: a new set object = new content → a new content hash.
          if (next !== previous) this.exclusionHashes.delete(chainId);
          // Only the leader publishes; a follower's local fallback serves itself.
          if (this.exclusionLeader.leading) await this.publishExclusions(chainId, next);
        }
        return next;
      } catch (err) {
        this.logger.warn(
          `Leaderboard exclusion rebuild failed chain=${chainId}, keeping the last set: ${(err as Error)?.message ?? err}`,
        );
        const kept = this.exclusions.get(chainId) ?? { addresses: [], ok: false };
        this.exclusions.set(chainId, kept);
        return kept;
      } finally {
        this.exclusionLoads.delete(chainId);
      }
    })();
    this.exclusionLoads.set(chainId, run);
    return run;
  }

  /**
   * Fetch stored security signals for a batch of addresses.
   *
   * Every by-address lookup here leads with `chainId`, although the collection
   * is already per chain: the only index is `{chainId, address}`, and a filter
   * on `address` alone cannot use it — it scans the whole collection. The
   * refresh cron runs one of these per unpriced position leg, hundreds at a
   * time, which is what held the shared Mongo pool on 2026-10-01.
   */
  async findMany(chainId: number, addresses: string[]): Promise<Token[]> {
    if (addresses.length === 0) return [];
    return this.model(chainId)
      .find({ chainId, address: { $in: addresses.map((a) => a.toLowerCase()) } })
      .lean<Token[]>();
  }

  /**
   * Spam addresses for a chain — the leaderboard scam filter excludes positions
   * and pools touching one. Two rules, ONE scan (the same pass this read always
   * made — no index serves either, so a second `find` would be a second
   * collection scan every rebuild):
   *  - the GoPlus hard-flag rule (`isSpamSignals`, `fakeToken` included);
   *  - token IDENTITY spam (`identitySpamReason`, 2026-10-06): a stored symbol
   *    — the pricing layer's `symbol` or GoPlus's `tokenSymbol` — that spoofs
   *    a protected major at a non-canonical address or carries a phishing
   *    link. Anchors and allowlisted tokens are exempt, as GoPlus exempts
   *    them. The server-side `$regex` is only a pre-filter (a superset,
   *    `identitySymbolPrefilter`); the JS rule decides, so a candidate row
   *    that is neither is dropped here.
   * Lowercased.
   */
  async findSpamAddresses(chainId: number): Promise<string[]> {
    // chainId leads, like every other read here: the collection is per chain
    // today, but the filter must not depend on that to stay correct.
    const identity = identitySymbolPrefilter(chainId);
    const rows = await this.model(chainId)
      .find({ chainId, $or: [...SPAM_MONGO_PREDICATE.$or, { symbol: identity }, { tokenSymbol: identity }] })
      .select({
        address: 1, isHoneypot: 1, cannotSellAll: 1, personalSlippageModifiable: 1, isBlacklisted: 1, fakeToken: 1,
        symbol: 1, tokenSymbol: 1, _id: 0,
      })
      // Off the primary and time-limited: a rebuild tolerates a secondary up to
      // `USER_READ_PREFERENCE.maxStalenessSeconds` behind (it already serves
      // sets up to one interval old) and never needs read-your-writes.
      .read(USER_READ_PREFERENCE)
      .maxTimeMS(EXCLUSION_SCAN_MAX_TIME_MS)
      .lean<Array<{ address?: unknown; symbol?: unknown; tokenSymbol?: unknown } & TokenSignals>>();
    const out: string[] = [];
    for (const r of rows) {
      if (typeof r.address !== 'string' || r.address.length === 0) continue;
      const addr = r.address.toLowerCase();
      // `=== true` per flag, exactly what the `{flag: true}` predicate matched:
      // a row the identity branch returned with a hand-edited `"true"` string
      // in a flag must not count as flagged by the hard-flag rule.
      const hardFlag = SPAM_MONGO_PREDICATE.$or.some((clause) => {
        const [field] = Object.keys(clause) as Array<keyof TokenSignals>;
        return r[field] === true;
      });
      if (hardFlag || identitySpamReason(chainId, addr, [r.symbol, r.tokenSymbol]) !== undefined) out.push(addr);
    }
    return out;
  }

  /** Most-recent stored current price per address (for last-known-good fallback). */
  async findLatestPrices(
    chainId: number,
    addresses: string[],
  ): Promise<Map<string, { priceUsd: number; pricedAt?: Date }>> {
    const out = new Map<string, { priceUsd: number; pricedAt?: Date }>();
    if (addresses.length === 0) return out;
    const rows = await this.model(chainId)
      .find({ chainId, address: { $in: addresses.map((a) => a.toLowerCase()) }, priceUsd: { $gt: 0 } })
      .select({ address: 1, priceUsd: 1, pricedAt: 1, _id: 0 })
      .lean<{ address: string; priceUsd: number; pricedAt?: Date }[]>();
    for (const r of rows) out.set(r.address.toLowerCase(), { priceUsd: r.priceUsd, pricedAt: r.pricedAt });
    return out;
  }

  /**
   * `findLatestPrices` for a USER read (the pools list and detail, through
   * `TokenPriceCache`): the same `{chainId, address $in, priceUsd > 0}` read on
   * the `{chainId, address}` index, but `secondaryPreferred` (maxStaleness
   * 120 s) with a server-side `maxTimeMS`. `findLatestPrices` itself stays on
   * the primary — the pricing layer's last-known-good wants read-your-writes.
   */
  async findLatestPricesForRead(
    chainId: number,
    addresses: string[],
    maxTimeMS: number,
  ): Promise<Map<string, { priceUsd: number; pricedAt?: Date }>> {
    const out = new Map<string, { priceUsd: number; pricedAt?: Date }>();
    if (addresses.length === 0) return out;
    const rows = await this.model(chainId)
      .find({ chainId, address: { $in: addresses.map((a) => a.toLowerCase()) }, priceUsd: { $gt: 0 } })
      .select({ address: 1, priceUsd: 1, pricedAt: 1, _id: 0 })
      .read(USER_READ_PREFERENCE)
      .maxTimeMS(maxTimeMS)
      .lean<{ address: string; priceUsd: number; pricedAt?: Date }[]>();
    for (const r of rows) out.set(r.address.toLowerCase(), { priceUsd: r.priceUsd, pricedAt: r.pricedAt });
    return out;
  }

  /**
   * Active-DEX-market state per address, from the consensus sweep. Returned ONLY
   * for tokens that HAVE a consensus record (a definite KNOWN answer): value
   * `true` = a REAL ACTIVE on-chain market priced it (DEX source + 24h volume ≥
   * the sweep-time floor → `dexActive`), `false` = no DEX pair OR a dead seeded
   * pool (symbol/FX-matched, or a DEX pair with ~no volume — BT77-class).
   * Pre-sweep rows (no `dexActive` baked yet) fall back to the volume-UNAWARE
   * `isDexBacked(priceSources)` so they're not mis-gated during the transition.
   * Absent address = UNKNOWN (not yet swept) → callers fail OPEN.
   */
  async findDexMarketState(chainId: number, addresses: string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    if (addresses.length === 0) return out;
    const rows = await this.model(chainId)
      .find({ chainId, address: { $in: addresses.map((a) => a.toLowerCase()) }, priceSources: { $exists: true, $ne: [] } })
      .select({ address: 1, priceSources: 1, dexActive: 1, _id: 0 })
      .lean<{ address: string; priceSources?: string[]; dexActive?: boolean }[]>();
    for (const r of rows) {
      if (Array.isArray(r.priceSources) && r.priceSources.length > 0) {
        // dexActive (volume-aware) wins when baked; else fall back to the
        // volume-unaware source check (transition for pre-sweep rows).
        out.set(r.address.toLowerCase(), r.dexActive ?? isDexBacked(r.priceSources));
      }
    }
    return out;
  }

  /**
   * Stored trust evidence per address (`pricing/token-trust.ts`): the earned
   * verdict, its reason and age, and the operator deny flag. Only addresses
   * whose document carries any of them are returned. Same `{chainId,
   * address}` index read as the others here.
   */
  async findTrustState(chainId: number, addresses: string[]): Promise<Map<string, StoredTokenTrust>> {
    const out = new Map<string, StoredTokenTrust>();
    if (addresses.length === 0) return out;
    const rows = await this.model(chainId)
      .find({ chainId, address: { $in: addresses.map((a) => a.toLowerCase()) } })
      .select({ address: 1, trustEarned: 1, trustReason: 1, trustEvaluatedAt: 1, trustDenied: 1, _id: 0 })
      .lean<Array<{ address: string } & StoredTokenTrust>>();
    for (const r of rows) out.set(r.address.toLowerCase(), storedTrustOf(r));
    return out;
  }

  /**
   * What the consensus sweep orders a batch's waiting token-pairs requests by
   * (`PricingService.orderPairRequests`): the stored earned verdict and its
   * age, and the RAW stored `dexActive` (absent stays absent — never the
   * `isDexBacked` fallback `findDexMarketState` applies, which would put a
   * never-swept token beside one an own-market re-check rescued). Only
   * addresses with a document are returned. Same `{chainId, address}` index
   * read as the others here; one per batch, and only when two or more
   * requests wait.
   */
  async findLookupPriority(chainId: number, addresses: string[]): Promise<Map<string, TokenLookupPriority>> {
    const out = new Map<string, TokenLookupPriority>();
    if (addresses.length === 0) return out;
    const rows = await this.model(chainId)
      .find({ chainId, address: { $in: addresses.map((a) => a.toLowerCase()) } })
      .select({ address: 1, trustEarned: 1, trustEvaluatedAt: 1, dexActive: 1, _id: 0 })
      .lean<Array<{ address: string; trustEarned?: unknown; trustEvaluatedAt?: unknown; dexActive?: unknown }>>();
    for (const r of rows) {
      const p: TokenLookupPriority = {};
      if (typeof r.trustEarned === 'boolean') p.trustEarned = r.trustEarned;
      if (r.trustEvaluatedAt instanceof Date && Number.isFinite(r.trustEvaluatedAt.getTime())) p.trustEvaluatedAt = r.trustEvaluatedAt;
      if (typeof r.dexActive === 'boolean') p.dexActive = r.dexActive;
      out.set(r.address.toLowerCase(), p);
    }
    return out;
  }

  /**
   * `findDexMarketState` + the stored consensus flag + the trust evidence, in
   * ONE read — what the pricing layer warms per page when the quote guard or
   * earned trust is on (`findDexMarketState` alone, today, otherwise).
   * `dexBacked` follows `findDexMarketState`'s rule exactly (present only for
   * a doc with recorded sources).
   */
  async findMarketState(chainId: number, addresses: string[]): Promise<Map<string, TokenMarketState>> {
    const out = new Map<string, TokenMarketState>();
    if (addresses.length === 0) return out;
    const rows = await this.model(chainId)
      .find({ chainId, address: { $in: addresses.map((a) => a.toLowerCase()) } })
      .select({
        address: 1, priceSources: 1, dexActive: 1, priceSourcesDisagreed: 1, priceConfidence: 1,
        trustEarned: 1, trustReason: 1, trustEvaluatedAt: 1, trustDenied: 1, _id: 0,
      })
      .lean<
        Array<
          {
            address: string;
            priceSources?: string[];
            dexActive?: boolean;
            priceSourcesDisagreed?: boolean;
            priceConfidence?: string;
          } & StoredTokenTrust
        >
      >();
    for (const r of rows) {
      const hasSources = Array.isArray(r.priceSources) && r.priceSources.length > 0;
      out.set(r.address.toLowerCase(), {
        dexBacked: hasSources ? (r.dexActive ?? isDexBacked(r.priceSources)) : undefined,
        disagreed: typeof r.priceSourcesDisagreed === 'boolean' ? r.priceSourcesDisagreed : undefined,
        consensus: hasSources ? storedConsensusOf(r.priceConfidence) : undefined,
        trust: storedTrustOf(r),
      });
    }
    return out;
  }

  /**
   * Earned-trust evidence from the consensus sweep (`TOKEN_TRUST_SHADOW=on` or
   * `TOKEN_TRUST_MODE=earned` / `combined` only — `trustEvidenceOn`). `$set` of the trust fields alone — the
   * price fields are written by `upsertPrices`, so a token whose price did not
   * change still gets its verdict re-derived (and revoked). Upserts like
   * `upsertPrices` (a covered token with no price has a row to carry it).
   */
  async upsertTrustEvidence(chainId: number, records: TokenTrustRecord[]): Promise<void> {
    if (records.length === 0) return;
    try {
      await budgetedBulkWrite(
        this.model(chainId),
        records.map((r) => {
          const set: Record<string, unknown> = {
            trustEarned: r.trustEarned,
            trustReason: r.trustReason,
            trustEvaluatedAt: r.trustEvaluatedAt,
            trustSources: r.trustSources,
            dexPoolCount: r.dexPoolCount,
            dexOutsideLiquidityUsd: r.dexOutsideLiquidityUsd,
            dexTopCounterUsd: r.dexTopCounterUsd,
            dexTopCounterShare: r.dexTopCounterShare,
          };
          if (r.dexTopPoolId !== undefined) set.dexTopPoolId = r.dexTopPoolId;
          return {
            updateOne: { filter: { chainId, address: r.address.toLowerCase() }, update: { $set: set }, upsert: true },
          };
        }),
        { unitsPerOp: WRITE_UNITS.other, bulkOptions: { ordered: false } },
      );
    } catch (err) {
      this.logger.warn(`Failed to upsert ${records.length} trust verdicts on chain ${chainId}: ${(err as Error)?.message}`);
    }
  }

  /**
   * Quote guard (`PRICE_QUOTE_GUARD=on`): clear the saved price of tokens the
   * sweep got a DEFINITE answer for (every provider ran and covered them —
   * the caller's rule) in which every quote was rejected (stale / thin). Only
   * when every source BEHIND the saved price is one of the providers rejected
   * this sweep: `priceSources` (a sweep's agreeing cluster) or, for a hot-path
   * price with no recorded cluster, `priceQuoteSource`. A saved price another
   * provider supplied (DeFiLlama yesterday, missed today) is not that quote's
   * and is kept; a price with no recorded provenance at all is kept too (the
   * purge script's DIA probe decides those). `priceUsd: 0` takes the row out of
   * the last-known reads (`priceUsd > 0`); `pricePurgedAt` keeps it in the
   * no-market scan. `pricedAt` is left alone. Never creates a row.
   */
  async clearGuardedPrices(chainId: number, entries: GuardedPriceClear[], reason: string, at: Date = new Date()): Promise<number> {
    if (entries.length === 0) return 0;
    try {
      const byAddr = new Map(entries.map((e) => [e.address.toLowerCase(), new Set(e.rejectedSources)]));
      const rows = await this.model(chainId)
        .find({ chainId, address: { $in: [...byAddr.keys()] }, priceUsd: { $gt: 0 } })
        .select({ address: 1, priceUsd: 1, pricedAt: 1, priceSources: 1, priceQuoteSource: 1, _id: 0 })
        .lean<Array<{ address: string; priceUsd: number; pricedAt?: Date; priceSources?: string[]; priceQuoteSource?: string }>>();
      const ops = [];
      for (const r of rows) {
        const rejected = byAddr.get(r.address.toLowerCase());
        if (!rejected || !savedPriceBackedOnlyBy(r, rejected)) continue;
        ops.push({
          updateOne: {
            // Pinned to the price that was judged: a sweep / hot-path write
            // landing in between is not cleared.
            filter: { chainId, address: r.address.toLowerCase(), priceUsd: r.priceUsd, pricedAt: r.pricedAt ?? null },
            update: { $set: { priceUsd: 0, pricePurgedAt: at, pricePurgedReason: reason } },
          },
        });
      }
      if (ops.length === 0) return 0;
      const res = await budgetedBulkWrite(this.model(chainId), ops, { unitsPerOp: WRITE_UNITS.other, bulkOptions: { ordered: false } });
      return res.modifiedCount;
    } catch (err) {
      this.logger.warn(`Failed to clear ${entries.length} guarded prices on chain ${chainId}: ${(err as Error)?.message}`);
      return 0;
    }
  }

  /**
   * Addresses with NO real-active-DEX-market corroboration (for the leaderboard
   * read-time exclusion — mirrors `findSpamAddresses`). Excluded when:
   *  - `dexActive === false` — sweep verdict: no DEX pair (GOLDX/EUR/fake-USDA)
   *    or a dead seeded pool (BT77: $240M one-sided, ~$8/day volume); OR
   *  - the doc carries a positive price with NO DEX source recorded — the
   *    hot-path's first-positive-wins walk persisted a single uncorroborated
   *    aggregator quote (`priceSources` empty/missing — Mongoose defaults the
   *    array to [] on insert — or non-DEX). WAPT-class: priced $0.77 by one
   *    aggregator, $77B position, zero on-chain market.
   * Fail-OPEN only for: a pre-volume-era sweep row with a DEX source but no
   * baked `dexActive` (heals on re-sweep), and tokens with no priced doc at all.
   * TRUSTED tokens are never excluded — the ONE trust rule
   * (`pricing/token-trust.ts` `resolveTokenTrust`): config anchors always, and
   * in `TOKEN_TRUST_MODE=allowlist` (default) the committed CoinGecko allowlist
   * too (user-confirmed 2026-06-12: listed tokens like BZR/apxUSD carry real,
   * independently-listed prices even when DexScreener misses or truncates their
   * pairs in a sweep batch — a DEX-coverage gap must not hide them); in
   * `earned` mode a token with a fresh earned-trust verdict instead, and in
   * `combined` mode either (the scan selects the trust fields, so an earned
   * token is judged on its verdict and an allowlisted one needs none). The
   * WAPT-class hole stays closed: scam tokens are neither allowlisted nor
   * earned. EMERGENCY DENY (`TOKEN_TRUST_DENY` env, any mode; `trustDenied`
   * on the doc, earned / combined mode only — `isDenied`) excludes a
   * non-anchor token outright, whatever its market. Lowercased.
   */
  async findNoRealMarketAddresses(chainId: number): Promise<string[]> {
    const policy = trustPolicyOf(this.config);
    const rows = await this.model(chainId)
      .find({
        chainId,
        $or: [
          // `pricePurgedAt`: a price the quote guard / purge script cleared to
          // 0 stays as excluded as it was while positive (matches nothing
          // unless a flag-on feature cleared one).
          { dexActive: { $ne: true }, $or: [{ dexActive: false }, { priceUsd: { $gt: 0 } }, { pricePurgedAt: { $exists: true } }] },
          // The operator's emergency deny flag, whatever the market verdict
          // (matches nothing unless someone set it by hand; honoured in earned /
          // combined mode only — `isDenied` — otherwise the row is judged like
          // any other).
          { trustDenied: true },
        ],
      })
      .select({
        address: 1, priceSources: 1, dexActive: 1,
        trustEarned: 1, trustReason: 1, trustEvaluatedAt: 1, trustDenied: 1, _id: 0,
      })
      .read(USER_READ_PREFERENCE)
      .maxTimeMS(EXCLUSION_SCAN_MAX_TIME_MS)
      .lean<Array<{ address: string; priceSources?: string[]; dexActive?: boolean } & StoredTokenTrust>>();
    const out = new Set<string>();
    for (const r of rows) {
      const addr = r.address.toLowerCase();
      const stored = storedTrustOf(r);
      // NEVER exclude a config anchor (stable/native) — a missed sweep must not
      // $nin-exclude every position holding USDC/WETH.
      if (isAnchorTokenStandalone(chainId, addr)) continue;
      if (isDenied(policy, chainId, addr, stored)) {
        out.add(addr);
        continue;
      }
      if (resolveTokenTrust(chainId, addr, stored, policy).trusted) continue;
      const knownNoMarket = r.dexActive === false || !isDexBacked(r.priceSources);
      if (knownNoMarket) out.add(addr);
    }
    // Env-denied addresses with no matching row (an active market, or no doc yet).
    for (const entry of policy.deny) {
      const [scope, addr] = entry.split(':') as [string, string];
      if ((scope === '*' || scope === String(chainId)) && !isAnchorTokenStandalone(chainId, addr)) out.add(addr);
    }
    return [...out];
  }

  /** Upsert GoPlus security signals (idempotent, non-blocking). */
  async upsertSecurity(records: TokenSecurityRecord[]): Promise<void> {
    if (records.length === 0) return;
    const byChain = groupByChain(records);
    try {
      await Promise.all(
        [...byChain.entries()].map(([chainId, recs]) =>
          // P2.4: through the shared write budget (charged to the caller's
          // lane). Budget off + MONGO_BULK_WRITE_MAX_OPS unset = exactly
          // today's one `bulkWrite(ops, {ordered:false})`.
          budgetedBulkWrite(
            this.model(chainId),
            recs.map((r) => {
              const { chainId: _c, address, ...signals } = r;
              return {
                updateOne: {
                  filter: { chainId: r.chainId, address: address.toLowerCase() },
                  update: { $set: { ...signals, lastCheckedAt: new Date() } },
                  upsert: true,
                },
              };
            }),
            { unitsPerOp: WRITE_UNITS.other, bulkOptions: { ordered: false } },
          ),
        ),
      );
    } catch (err) {
      this.logger.error('Failed to bulk upsert token security signals', err as Error);
    }
  }

  /**
   * Stored miss-ledger entries (`pricing/price-ledger.ts`) for these
   * addresses — only rows that HAVE one. Primary read on the `{chainId,
   * address}` index: the ledger decides whether to call a provider, so it
   * wants read-your-writes like the last-known-good.
   */
  async findPriceMisses(chainId: number, addresses: string[]): Promise<Map<string, { at: Date; streak: number }>> {
    const out = new Map<string, { at: Date; streak: number }>();
    if (addresses.length === 0) return out;
    const rows = await this.model(chainId)
      .find({
        chainId,
        address: { $in: addresses.map((a) => a.toLowerCase()) },
        priceMissStreak: { $gt: 0 },
      })
      .select({ address: 1, priceMissAt: 1, priceMissStreak: 1, _id: 0 })
      .lean<{ address: string; priceMissAt?: Date; priceMissStreak?: number }[]>();
    for (const r of rows) {
      if (r.priceMissAt instanceof Date && typeof r.priceMissStreak === 'number' && r.priceMissStreak > 0) {
        out.set(r.address.toLowerCase(), { at: r.priceMissAt, streak: r.priceMissStreak });
      }
    }
    return out;
  }

  /**
   * One more consecutive miss for each address — once per miss EPISODE. Two
   * ops per address, in order: (1) insert the row with streak 1 if there is
   * none (`$setOnInsert`; a token no provider ever priced has no row yet — the
   * inserted row carries the schema defaults, `priceUsd: 0`, which neither the
   * last-known-good read (`priceUsd > 0`) nor either exclusion scan matches);
   * (2) `$inc priceMissStreak` + `$set priceMissAt` only on a row with NO live
   * hold at `at` (`priceMissNotHeldClauses`). A row another walk or process
   * already holds for this episode is left alone, so concurrent askers cannot
   * climb the 30 min → 6 h ladder once each. `ordered: true` so (1) lands
   * before (2) (a fresh row is then held and (2) skips it). Throws on a write
   * error — the ledger treats that as "this process remembers, the others
   * re-ask".
   */
  async recordPriceMisses(chainId: number, addresses: string[], at: Date): Promise<void> {
    if (addresses.length === 0) return;
    const notHeld = priceMissNotHeldClauses(at.getTime());
    // P2.4: budgeted; the two ops of an address stay in order (chunks run
    // sequentially, `ordered: true` inside each, and a chunk cap is even).
    await budgetedBulkWrite(
      this.model(chainId),
      [...new Set(addresses.map((a) => a.toLowerCase()))].flatMap((address) => [
        {
          updateOne: {
            filter: { chainId, address },
            update: { $setOnInsert: { priceMissStreak: 1, priceMissAt: at } },
            upsert: true,
          },
        },
        {
          updateOne: {
            filter: { chainId, address, $or: notHeld },
            update: { $inc: { priceMissStreak: 1 }, $set: { priceMissAt: at } },
          },
        },
      ]),
      { unitsPerOp: WRITE_UNITS.other, bulkOptions: { ordered: true } },
    );
  }

  /** Forget the ledger entries of tokens that were just priced (`$unset` both fields). */
  async clearPriceMisses(chainId: number, addresses: string[]): Promise<void> {
    if (addresses.length === 0) return;
    await this.model(chainId).updateMany(
      { chainId, address: { $in: addresses.map((a) => a.toLowerCase()) }, priceMissStreak: { $exists: true } },
      { $unset: { priceMissAt: '', priceMissStreak: '' } },
    );
  }

  /** Upsert current USD prices (idempotent, non-blocking). Creates the row if
   * the security sweep hasn't reached this token yet. */
  async upsertPrices(chainId: number, records: TokenPriceRecord[]): Promise<void> {
    if (records.length === 0) return;
    try {
      // P2.4: budgeted (budget off + MONGO_BULK_WRITE_MAX_OPS unset = today's one bulkWrite).
      await budgetedBulkWrite(
        this.model(chainId),
        records.map((r) => {
          const set: Record<string, unknown> = { priceUsd: r.priceUsd, pricedAt: r.pricedAt ?? new Date() };
          if (r.symbol !== undefined) set.symbol = r.symbol;
          if (r.decimals !== undefined) set.decimals = r.decimals;
          if (r.priceConfidence !== undefined) set.priceConfidence = r.priceConfidence;
          if (r.priceSources !== undefined) set.priceSources = r.priceSources;
          if (r.dexVolume24h !== undefined) set.dexVolume24h = r.dexVolume24h;
          if (r.dexCounterLiquidity !== undefined) set.dexCounterLiquidity = r.dexCounterLiquidity;
          if (r.dexActive !== undefined) set.dexActive = r.dexActive;
          // Quote provenance — only ever set with the quote guard / trust
          // evidence on (undefined otherwise, so today's write is unchanged).
          if (r.priceQuoteSource !== undefined) set.priceQuoteSource = r.priceQuoteSource;
          if (r.priceQuotedAt !== undefined) set.priceQuotedAt = r.priceQuotedAt;
          if (r.priceQuoteRejected !== undefined) set.priceQuoteRejected = r.priceQuoteRejected;
          if (r.priceGuardUsd !== undefined) set.priceGuardUsd = r.priceGuardUsd;
          if (r.priceSourcesDisagreed !== undefined) set.priceSourcesDisagreed = r.priceSourcesDisagreed;
          // A write carrying evidence is the complete evidence for its price:
          // stamp it with this write's `pricedAt` and drop what it does not
          // carry. A write carrying none (every flag off) is today's write.
          const carried = PRICE_EVIDENCE_FIELDS.filter((f) => r[f] !== undefined);
          let update: Record<string, unknown> = { $set: set };
          if (carried.length > 0) {
            set.priceEvidenceAt = set.pricedAt;
            const unset: Record<string, ''> = {};
            for (const f of PRICE_EVIDENCE_FIELDS) if (r[f] === undefined) unset[f] = '';
            if (Object.keys(unset).length > 0) update = { $set: set, $unset: unset };
          }
          return {
            updateOne: {
              filter: { chainId, address: r.address.toLowerCase() },
              update,
              upsert: true,
            },
          };
        }),
        { unitsPerOp: WRITE_UNITS.other, bulkOptions: { ordered: false } },
      );
    } catch (err) {
      this.logger.warn(`Failed to upsert ${records.length} token prices on chain ${chainId}: ${(err as Error)?.message}`);
    }
  }
}

/**
 * Is a saved price backed ONLY by providers in `rejected`? Its sources are the
 * sweep's agreeing cluster (`priceSources`) or, with no cluster recorded, the
 * hot-path provider (`priceQuoteSource`). No provenance at all → false (kept).
 */
export function savedPriceBackedOnlyBy(
  r: { priceSources?: string[] | null; priceQuoteSource?: string | null },
  rejected: ReadonlySet<string>,
): boolean {
  const cluster = Array.isArray(r.priceSources) ? r.priceSources.filter((x) => typeof x === 'string' && x.length > 0) : [];
  if (cluster.length > 0) return cluster.every((x) => rejected.has(x));
  return typeof r.priceQuoteSource === 'string' && rejected.has(r.priceQuoteSource);
}

/**
 * The consensus sweep's verdict from a stored `priceConfidence`: `true` for
 * `external-verified` (≥ 2 independent sources agreed), `false` for
 * `external-unverified` (one source, or sources that disagreed), `undefined`
 * for anything else (no verdict to act on).
 */
export function storedConsensusOf(priceConfidence: unknown): boolean | undefined {
  if (priceConfidence === 'external-verified') return true;
  if (priceConfidence === 'external-unverified') return false;
  return undefined;
}

/**
 * Do a row's provenance / guard fields describe its CURRENT price? Only when
 * they were written by the write that wrote `pricedAt` (`priceEvidenceAt`,
 * stamped by `upsertPrices`). A later price write with every flag off leaves
 * them describing an older price.
 */
export function priceEvidenceIsCurrent(r: { pricedAt?: Date | string | null; priceEvidenceAt?: Date | string | null }): boolean {
  const at = timeOf(r.priceEvidenceAt);
  const priced = timeOf(r.pricedAt);
  return Number.isFinite(at) && Number.isFinite(priced) && Math.abs(at - priced) <= 1_000;
}

function timeOf(v: Date | string | null | undefined): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

/** The trust fields of a lean token row, with types checked (a hand-edited flag may be anything). */
function storedTrustOf(r: Partial<StoredTokenTrust>): StoredTokenTrust {
  const out: StoredTokenTrust = {};
  if (typeof r.trustEarned === 'boolean') out.trustEarned = r.trustEarned;
  if (typeof r.trustReason === 'string') out.trustReason = r.trustReason;
  if (r.trustEvaluatedAt instanceof Date) out.trustEvaluatedAt = r.trustEvaluatedAt;
  if (r.trustDenied === true) out.trustDenied = true;
  return out;
}

function groupByChain(records: TokenSecurityRecord[]): Map<number, TokenSecurityRecord[]> {
  const byChain = new Map<number, TokenSecurityRecord[]>();
  for (const r of records) {
    const list = byChain.get(r.chainId);
    if (list) list.push(r);
    else byChain.set(r.chainId, [r]);
  }
  return byChain;
}
