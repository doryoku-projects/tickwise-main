import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type PipelineStage } from 'mongoose';
import { InvalidationBus } from '../common/invalidation-bus.js';
import { ApiKey } from './api-key.schema.js';
import { generateApiKey, hashApiKey, normalizeOrigin } from './api-key.util.js';
import { Customer } from './customer.schema.js';
import { seedCostFor } from './endpoint-costs.seed.js';
import { DEFAULT_PLAN_KEY } from './plans.seed.js';
import { SettingsCacheService } from './settings-cache.service.js';
import { UsageBucket } from './usage-bucket.schema.js';
import { Usage } from './usage.schema.js';

export type ApiKeyType = 'server' | 'browser';

export interface ResolvedKey {
  apiKeyId: string;
  customerId: string;
  planKey: string;
  /** Trust context: 'server' rejects browser calls, 'browser' is origin-bound. */
  keyType: ApiKeyType;
  /** Allowed browser origins (non-empty ⟺ keyType==='browser'; see schema). */
  allowedOrigins: string[];
  /**
   * The key's public prefix and operator label, carried so the per-request
   * usage writer can denormalise them without a second query — `resolveByRawKey`
   * already holds the full key document. They identify a key in the usage
   * detail AFTER it is deleted, which is a hard delete.
   */
  keyPrefix: string;
  keyLabel: string;
}

// ─── Usage detail (the `usage_buckets` read model) ───────────────────────────

/** The four breakdowns `getUsageDetail` can produce. */
export const USAGE_DETAIL_GROUPS = ['day', 'routeKey', 'apiKey', 'status'] as const;
export type UsageDetailGroup = (typeof USAGE_DETAIL_GROUPS)[number];

/**
 * What the caller asked for. Every field is optional and every field is
 * re-validated inside the service — see `resolveUsageRange`.
 */
export interface UsageDetailQuery {
  from?: string;
  to?: string;
  groupBy?: UsageDetailGroup;
}

export interface UsageDetailDay {
  day: string;
  units: number;
  requests: number;
}

export interface UsageDetailRoute {
  routeKey: string;
  label: string;
  unitCost: number;
  units: number;
  requests: number;
}

export interface UsageDetailKey {
  apiKeyId: string;
  keyPrefix: string;
  keyLabel: string;
  units: number;
  requests: number;
}

export interface UsageDetailStatus {
  statusClass: string;
  requests: number;
  units: number;
}

/**
 * ONE shape for both realms. The customer portal and the admin panel render the
 * same report against the same numbers, so a discrepancy between what a
 * customer sees and what support sees cannot be a rendering difference.
 */
export interface UsageDetail {
  range: { from: string; to: string };
  /** `limit` is the plan's monthly unit allowance; `0` = unlimited. */
  totals: { units: number; requests: number; limit: number };
  series: UsageDetailDay[];
  byRoute: UsageDetailRoute[];
  byKey: UsageDetailKey[];
  byStatus: UsageDetailStatus[];
}

/**
 * Window ceiling. A detail read fans out over one customer's buckets for the
 * whole window, so the range is what bounds the work — three months covers a
 * quarter, and a longer look-back is a rollup question the monthly `usage`
 * snapshot already answers.
 */
const MAX_USAGE_DETAIL_DAYS = 92;

/**
 * Row ceiling for the two open-ended breakdowns. `byStatus` has four possible
 * values and `series` is bounded by the window above, but `byRoute` grows with
 * the route table and `byKey` grows with every key a customer has EVER used —
 * including deleted ones, whose buckets deliberately outlive them.
 */
const MAX_USAGE_DETAIL_ROWS = 200;

/**
 * Canonical order for the status breakdown. Sorting on the stored string would
 * put `429` between `2xx` and `4xx`, reading as an error family it is not.
 */
const STATUS_CLASS_ORDER: readonly string[] = ['2xx', '4xx', '5xx', '429'];

/** Raw `$facet` output. Only `totals` is unconditional — see `getUsageDetail`. */
interface UsageDetailFacets {
  totals: Array<{ units: number; requests: number }>;
  series?: Array<{ _id: string; units: number; requests: number }>;
  byRoute?: Array<{ _id: string; units: number; requests: number }>;
  byKey?: Array<{
    _id: Types.ObjectId;
    keyPrefix: string;
    keyLabel: string;
    units: number;
    requests: number;
  }>;
  byStatus?: Array<{ _id: string; units: number; requests: number }>;
}

// Registered-origin set cache for the dynamic CORS callback (per-process,
// fail-soft) — same TTL discipline as the leaderboard bad-token sets.
const ORIGIN_SET_TTL_MS = 60_000;

/**
 * `resolveByRawKey` results are cached per key hash for this long. Every
 * ClientsService write that can change a resolution (revoke, delete, origins,
 * plan) drops the affected entries at once, so the TTL only bounds changes made
 * OUTSIDE this service — a customer suspended by hand in Mongo, or a plan moved
 * by the payments lifecycle — which take effect within it.
 */
const RESOLVED_KEY_TTL_MS = 30_000;
/** Entry ceiling for that cache (it is cleared rather than grown past this). */
const RESOLVED_KEY_CACHE_MAX = 10_000;
/** `lastUsedAt` is written at most once per key per this window. */
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;
/**
 * Entry ceiling of each invalidation-generation map (per key hash, per
 * customer). Past it the map is cleared and EVERY resolve in flight is treated
 * as invalidated — conservative: at worst one result is not cached.
 */
const INVALIDATION_GEN_MAX = 10_000;

@Injectable()
export class ClientsService {
  private originSetCache: { origins: Set<string>; expiresAt: number } | null = null;
  /** Advanced by every origin-set invalidation (see `isRegisteredOrigin`). */
  private originsGen = 0;
  /** key hash → resolution (see `RESOLVED_KEY_TTL_MS`). */
  private readonly resolvedKeys = new Map<string, { value: ResolvedKey; expiresAt: number }>();
  /** api key id → when this process last wrote its `lastUsedAt`. */
  private readonly lastUsedWrittenAt = new Map<string, number>();
  /**
   * Invalidation generations (P2.2 §3.2). Every forget — local, or applied
   * from another replica — advances `invalidationSeq` and stamps what it
   * covered. A resolve records the seq at its START and does not cache its
   * result if anything covering it was stamped meanwhile: a load that read
   * the key BEFORE a revoke must not put the pre-revoke answer back for 30 s.
   */
  private invalidationSeq = 0;
  private allInvalidatedAt = 0;
  private readonly keyInvalidatedAt = new Map<string, number>();
  private readonly customerInvalidatedAt = new Map<string, number>();

  constructor(
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(ApiKey.name) private readonly apiKeys: Model<ApiKey>,
    @InjectModel(Usage.name) private readonly usage: Model<Usage>,
    // APPENDED, never inserted — three specs construct this service
    // positionally, and a surplus argument is ignored while a missing one is
    // only noticed by whichever assertion happens to read the wrong slot.
    @InjectModel(UsageBucket.name) private readonly usageBuckets: Model<UsageBucket>,
    @Inject(SettingsCacheService) private readonly settings: SettingsCacheService,
    /**
     * APPENDED and optional (P2.2): cross-replica invalidation. Absent, or
     * `CACHE_INVALIDATION=off`, this service behaves exactly as before.
     */
    @Optional() @Inject(InvalidationBus) private readonly bus?: InvalidationBus,
  ) {
    // Messages from OTHER replicas go through the local-only paths — never
    // `forgetResolvedKeys`, which would publish again.
    this.bus?.on('apikey', (msg) =>
      this.forgetLocal(msg.all ? {} : { keyHash: msg.keyHash, customerId: msg.customerId }),
    );
    this.bus?.on('origins', () => this.forgetOriginsLocal());
  }

  /**
   * Create an operator-managed client. `customers.email` carries a PARTIAL
   * UNIQUE index (`{ email: { $type: 'string' } }`), so a second client with
   * the same address is rejected by Mongo with E11000 — surface that as a 409
   * in the house error shape instead of letting the raw MongoServerError escape
   * as a 500. Same idiom as the self-serve signup path
   * (`CustomerAuthService.signup`); the index is the single guard, no
   * check-then-act read (which would race).
   */
  async createClient(input: { name: string; email?: string; planKey?: string }) {
    try {
      const created = await this.customers.create({
        name: input.name,
        email: input.email,
        planKey: input.planKey ?? DEFAULT_PLAN_KEY,
      });
      return created.toObject();
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException({ error: 'A client with that email already exists' });
      }
      throw err;
    }
  }

  listClients() {
    return this.customers.find().sort({ createdAt: -1 }).lean().exec();
  }

  async getClient(id: string) {
    const client = await this.customers.findById(id).lean().exec();
    if (!client) throw new NotFoundException({ error: 'Client not found' });
    return client;
  }

  /**
   * Move a client onto a plan by hand.
   *
   * **STAMPS `planSource: 'admin'`**, which it did not before, and the omission
   * was load-bearing in the wrong direction. `SubscriptionSweepService` treats
   * that field as the record of "an operator chose this": `dropToFree` filters
   * on `planSource: { $ne: 'admin' }` and the self-heal on
   * `planSource: 'subscription'`. Writing `planKey` alone left the field
   * `undefined`, which `$ne: 'admin'` MATCHES — so an operator who granted a
   * customer Pro from the panel had it silently reverted to Free the next time
   * any subscription of theirs lapsed, and the audit trail said nothing.
   *
   * The other direction was already safe (the self-heal skips a customer whose
   * `planSource` is not `'subscription'`), which is exactly why this was
   * invisible: the grant survived the pass that looks for drift and was undone
   * by the pass that does not.
   */
  async assignPlan(id: string, planKey: string) {
    const client = await this.customers
      .findByIdAndUpdate(id, { planKey, planSource: 'admin' }, { new: true })
      .lean()
      .exec();
    if (!client) throw new NotFoundException({ error: 'Client not found' });
    this.forgetResolvedKeys({ customerId: String(client._id) }); // the plan rides on every cached resolution
    return client;
  }

  /**
   * Validate + normalize a list of browser origins to canonical
   * `scheme://host[:port]` form (deduped). Throws 400 on the first invalid
   * entry so a typo can't silently disable the customer's site.
   */
  private normalizeOrigins(origins: string[]): string[] {
    const out: string[] = [];
    for (const raw of origins) {
      const origin = normalizeOrigin(raw);
      if (!origin) {
        throw new BadRequestException({
          error: `Invalid origin "${raw}" — expected scheme://host[:port], e.g. https://app.example.com`,
        });
      }
      if (!out.includes(origin)) out.push(origin);
    }
    return out;
  }

  /**
   * Issue a new key for a client. Returns the raw secret ONCE; only its hash is
   * stored. `keyType` defaults to `server` (backend-only, safe default — it
   * rejects browser use). A `browser` key REQUIRES at least one origin
   * (default-deny: a browser key with no origins would be useless); a `server`
   * key must NOT carry origins.
   */
  async issueKey(
    customerId: string,
    opts: { label?: string; keyType?: ApiKeyType; origins?: string[] } = {},
  ) {
    await this.getClient(customerId); // 404 if missing
    const keyType: ApiKeyType = opts.keyType ?? 'server';
    let allowedOrigins: string[] = [];
    if (keyType === 'browser') {
      allowedOrigins = this.normalizeOrigins(opts.origins ?? []);
      if (allowedOrigins.length === 0) {
        throw new BadRequestException({
          error: 'A browser key requires at least one allowed origin (scheme://host[:port]).',
        });
      }
    } else if (opts.origins && opts.origins.length > 0) {
      throw new BadRequestException({
        error: 'A server key cannot have origins — it rejects all browser calls. Issue a browser key to bind origins.',
      });
    }
    const generated = generateApiKey();
    const doc = await this.apiKeys.create({
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      customerId: new Types.ObjectId(customerId),
      label: opts.label ?? '',
      status: 'active',
      keyType,
      allowedOrigins,
    });
    if (allowedOrigins.length > 0) this.forgetOrigins(); // CORS sees the new origins immediately
    return {
      id: String(doc._id),
      apiKey: generated.raw, // shown once
      keyPrefix: doc.keyPrefix,
      label: doc.label,
      status: doc.status,
      keyType: doc.keyType,
      allowedOrigins: doc.allowedOrigins,
      createdAt: (doc as unknown as { createdAt?: Date }).createdAt,
    };
  }

  async listKeys(customerId: string) {
    const keys = await this.apiKeys
      .find({ customerId: new Types.ObjectId(customerId) })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    // never expose keyHash
    return keys.map(({ keyHash, ...rest }) => rest);
  }

  async revokeKey(keyId: string) {
    const updated = await this.apiKeys
      .findByIdAndUpdate(keyId, { status: 'revoked' }, { new: true })
      .lean()
      .exec();
    if (!updated) throw new NotFoundException({ error: 'API key not found' });
    this.forgetOrigins(); // drop the revoked key's origins from the CORS allowlist immediately
    this.forgetResolvedKeys({ keyHash: updated.keyHash }); // a revoked key stops resolving now, not in 30 s
    const { keyHash, ...rest } = updated;
    return rest;
  }

  /** Permanently delete a key (vs. revoke which keeps the row for audit). */
  async deleteKey(keyId: string) {
    const deleted = await this.apiKeys.findByIdAndDelete(keyId).lean().exec();
    if (!deleted) throw new NotFoundException({ error: 'API key not found' });
    this.forgetOrigins();
    this.forgetResolvedKeys({ keyHash: deleted.keyHash });
    return { deleted: keyId };
  }

  /**
   * Replace a key's allowed browser origins (admin panel) — the single knob
   * that also drives its type: a NON-empty list makes it a `browser` key bound
   * to exactly those origins; an EMPTY list converts it to a `server` key
   * (backend-only, rejects browsers). Each entry must be a clean http(s) origin
   * (normalized to the canonical `Origin`-header form; paths/wildcards → 400 so
   * a typo can't silently disable the customer's site).
   */
  async setKeyOrigins(keyId: string, origins: string[]) {
    const normalized = this.normalizeOrigins(origins);
    const keyType: ApiKeyType = normalized.length > 0 ? 'browser' : 'server';
    const updated = await this.apiKeys
      .findByIdAndUpdate(keyId, { allowedOrigins: normalized, keyType }, { new: true })
      .lean()
      .exec();
    if (!updated) throw new NotFoundException({ error: 'API key not found' });
    this.forgetOrigins(); // CORS picks the change up immediately
    this.forgetResolvedKeys({ keyHash: updated.keyHash }); // so does the guard's origin check
    const { keyHash, ...rest } = updated;
    return rest;
  }

  // ─── Ownership-scoped key operations (customer portal) ─────────────────────
  //
  // The three methods above take a bare `keyId` and query by `_id` ALONE. That
  // is safe only because they sit behind `AdminJwtGuard`; exposing them to a
  // self-serve portal would be cross-tenant key revocation/deletion, and via
  // `setKeyOrigins` would let one tenant point a competitor's browser key at
  // their own domain. The `*Owned` variants below are what the portal calls.
  //
  // Each is a SINGLE SCOPED MONGO WRITE whose filter carries the customerId:
  // the filter IS the authorization. Deliberately NOT check-then-act (fetch the
  // key, compare its owner, then write) — that leaves a TOCTOU window between
  // the comparison and the write. A key belonging to someone else simply does
  // not match, which also refuses to confirm that it exists.

  /**
   * `{ _id, customerId }` for a scoped key write. Both ids are parsed here so a
   * malformed path segment is a clean 404 rather than the BSONError-shaped 500
   * that `new Types.ObjectId()` throws on the unscoped admin paths.
   */
  private ownedKeyFilter(keyId: string, customerId: string): { _id: Types.ObjectId; customerId: Types.ObjectId } {
    try {
      return { _id: new Types.ObjectId(keyId), customerId: new Types.ObjectId(customerId) };
    } catch {
      throw new NotFoundException({ error: 'API key not found' });
    }
  }

  /** Revoke a key the caller owns. See the block comment above. */
  async revokeKeyOwned(keyId: string, customerId: string) {
    const updated = await this.apiKeys
      .findOneAndUpdate(this.ownedKeyFilter(keyId, customerId), { status: 'revoked' }, { new: true })
      .lean()
      .exec();
    if (!updated) throw new NotFoundException({ error: 'API key not found' });
    this.forgetOrigins(); // drop the revoked key's origins from the CORS allowlist immediately
    this.forgetResolvedKeys({ keyHash: updated.keyHash });
    const { keyHash, ...rest } = updated;
    return rest;
  }

  /** Permanently delete a key the caller owns. See the block comment above. */
  async deleteKeyOwned(keyId: string, customerId: string) {
    const deleted = await this.apiKeys
      .findOneAndDelete(this.ownedKeyFilter(keyId, customerId))
      .lean()
      .exec();
    if (!deleted) throw new NotFoundException({ error: 'API key not found' });
    this.forgetOrigins();
    this.forgetResolvedKeys({ keyHash: deleted.keyHash });
    return { deleted: keyId };
  }

  /**
   * Replace the allowed origins of a key the caller owns — same single-knob
   * semantics as `setKeyOrigins` (non-empty ⇒ `browser` bound to those origins,
   * empty ⇒ back to `server`). See the block comment above.
   */
  async setKeyOriginsOwned(keyId: string, customerId: string, origins: string[]) {
    const normalized = this.normalizeOrigins(origins);
    const keyType: ApiKeyType = normalized.length > 0 ? 'browser' : 'server';
    const updated = await this.apiKeys
      .findOneAndUpdate(
        this.ownedKeyFilter(keyId, customerId),
        { allowedOrigins: normalized, keyType },
        { new: true },
      )
      .lean()
      .exec();
    if (!updated) throw new NotFoundException({ error: 'API key not found' });
    this.forgetOrigins(); // CORS picks the change up immediately
    this.forgetResolvedKeys({ keyHash: updated.keyHash });
    const { keyHash, ...rest } = updated;
    return rest;
  }

  /**
   * How many ACTIVE keys a customer holds — the input to the portal's
   * `Plan.maxApiKeys` ceiling. Revoked rows stay for audit and don't count.
   */
  async countActiveKeys(customerId: string): Promise<number> {
    let owner: Types.ObjectId;
    try {
      owner = new Types.ObjectId(customerId);
    } catch {
      throw new BadRequestException({ error: 'Invalid client id' });
    }
    return this.apiKeys.countDocuments({ customerId: owner, status: 'active' }).exec();
  }

  /**
   * True when `origin` (already canonical from the browser's Origin header) is
   * registered on ANY active key — the dynamic CORS allowlist. Cached 60s,
   * fail-soft to the last set on a read error: a Mongo blip must not strip
   * CORS headers from every paying customer's site at once. The per-key
   * binding is still enforced exactly in ApiKeyGuard; this only decides
   * whether the browser gets CORS headers at all.
   */
  async isRegisteredOrigin(origin: string): Promise<boolean> {
    const lower = origin.toLowerCase();
    const cached = this.originSetCache;
    if (cached && cached.expiresAt > Date.now()) return cached.origins.has(lower);
    const startGen = this.originsGen;
    try {
      const origins = await this.apiKeys
        .distinct('allowedOrigins', { status: 'active' })
        .exec();
      const set = new Set((origins as string[]).map((o) => o.toLowerCase()));
      // An origin change landed while this read ran: answer from it, but do
      // not cache a set that may predate the change.
      if (this.originsGen === startGen) {
        this.originSetCache = { origins: set, expiresAt: Date.now() + ORIGIN_SET_TTL_MS };
      }
      return set.has(lower);
    } catch {
      return cached?.origins.has(lower) ?? false;
    }
  }

  /**
   * Resolve a raw API key to its client + plan for the public guard. Active keys
   * only. Cached per key hash for `RESOLVED_KEY_TTL_MS` — every metered `/v1`
   * request runs this, and uncached it was two reads and a write on the primary
   * per request. Unknown keys are NOT cached, so a key issued a moment ago
   * resolves on its first use.
   */
  async resolveByRawKey(rawKey: string): Promise<ResolvedKey | null> {
    const hash = hashApiKey(rawKey);
    const now = Date.now();
    const cached = this.resolvedKeys.get(hash);
    if (cached && cached.expiresAt > now) {
      this.touchLastUsed(cached.value.apiKeyId, now);
      return cached.value;
    }
    if (cached) this.resolvedKeys.delete(hash);

    // Recorded BEFORE the reads: see `invalidationSeq`.
    const startSeq = this.invalidationSeq;
    const key = await this.apiKeys.findOne({ keyHash: hash, status: 'active' }).exec();
    if (!key) return null;
    const client = await this.customers.findById(key.customerId).lean().exec();
    if (!client || client.status !== 'active') return null;
    const allowedOrigins = key.allowedOrigins ?? [];
    // Legacy rows have no keyType — infer it: origins present ⇒ a browser key
    // someone deliberately bound; otherwise treat as a backend (server) key.
    const keyType: ApiKeyType = key.keyType ?? (allowedOrigins.length > 0 ? 'browser' : 'server');
    const resolved: ResolvedKey = {
      apiKeyId: String(key._id),
      customerId: String(key.customerId),
      planKey: client.planKey,
      keyType,
      allowedOrigins,
      // Free: `key` is the full document this method already loaded, so the two
      // fields below cost no query. Do not turn them into a lookup later.
      keyPrefix: key.keyPrefix,
      keyLabel: key.label,
    };
    if (this.invalidatedSince(startSeq, hash, resolved.customerId)) {
      // The answer may predate a revoke/plan move that landed while it was
      // read: serve it to THIS request (it was valid when read) but do not
      // cache it — the next request reads again.
      this.bus?.noteStaleLoadNotCached();
      this.touchLastUsed(resolved.apiKeyId, now);
      return resolved;
    }
    if (this.resolvedKeys.size >= RESOLVED_KEY_CACHE_MAX) this.resolvedKeys.clear();
    this.resolvedKeys.set(hash, { value: resolved, expiresAt: now + RESOLVED_KEY_TTL_MS });
    this.touchLastUsed(resolved.apiKeyId, now);
    return resolved;
  }

  /** Did a forget covering this key hash or customer land after `startSeq`? */
  private invalidatedSince(startSeq: number, keyHash: string, customerId: string): boolean {
    return (
      this.allInvalidatedAt > startSeq ||
      (this.keyInvalidatedAt.get(keyHash) ?? 0) > startSeq ||
      (this.customerInvalidatedAt.get(customerId) ?? 0) > startSeq
    );
  }

  /**
   * Drop cached resolutions — one key (by hash), every key of a customer, or
   * (no argument) all of them. Called by every write here that can change a
   * resolution; public so a write elsewhere (the payments lifecycle moving a
   * `planKey`) can make its change visible before the TTL.
   */
  forgetResolvedKeys(scope: { keyHash?: string; customerId?: string } = {}): void {
    this.forgetLocal(scope);
    // Then the other replicas (P2.2; a no-op unless CACHE_INVALIDATION=redis).
    if (scope.keyHash === undefined && scope.customerId === undefined) {
      this.bus?.publish({ t: 'apikey', all: true });
    } else {
      this.bus?.publish({ t: 'apikey', keyHash: scope.keyHash, customerId: scope.customerId });
    }
  }

  /**
   * The LOCAL half of `forgetResolvedKeys`: drop the cached resolutions and
   * advance the generations. Also the path a message from another replica is
   * applied through — it never publishes.
   */
  forgetLocal(scope: { keyHash?: string; customerId?: string } = {}): void {
    const seq = ++this.invalidationSeq;
    if (scope.keyHash === undefined && scope.customerId === undefined) {
      this.allInvalidatedAt = seq;
      this.resolvedKeys.clear();
      return;
    }
    if (scope.keyHash !== undefined) {
      this.stampInvalidation(this.keyInvalidatedAt, scope.keyHash, seq);
      this.resolvedKeys.delete(scope.keyHash);
    }
    if (scope.customerId !== undefined) {
      this.stampInvalidation(this.customerInvalidatedAt, scope.customerId, seq);
      for (const [hash, entry] of this.resolvedKeys) {
        if (entry.value.customerId === scope.customerId) this.resolvedKeys.delete(hash);
      }
    }
  }

  private stampInvalidation(map: Map<string, number>, id: string, seq: number): void {
    if (map.size >= INVALIDATION_GEN_MAX && !map.has(id)) {
      // Bounded: forget the per-id stamps and treat everything in flight as
      // invalidated instead (never under-invalidates).
      map.clear();
      this.allInvalidatedAt = seq;
    }
    map.set(id, seq);
  }

  /** Drop the CORS origin set here and on the other replicas. */
  private forgetOrigins(): void {
    this.forgetOriginsLocal();
    this.bus?.publish({ t: 'origins' });
  }

  /** The local half of `forgetOrigins` (also how a remote message is applied). */
  forgetOriginsLocal(): void {
    this.originsGen += 1;
    this.originSetCache = null;
  }

  /**
   * Best-effort `lastUsedAt` bump, at most once per key per
   * `LAST_USED_WRITE_INTERVAL_MS` — the portal's "last used" stays accurate to
   * a few minutes without a primary write on every request.
   */
  private touchLastUsed(apiKeyId: string, now: number): void {
    const last = this.lastUsedWrittenAt.get(apiKeyId);
    if (last !== undefined && now - last < LAST_USED_WRITE_INTERVAL_MS) return;
    if (this.lastUsedWrittenAt.size >= RESOLVED_KEY_CACHE_MAX) this.lastUsedWrittenAt.clear();
    this.lastUsedWrittenAt.set(apiKeyId, now);
    this.apiKeys.updateOne({ _id: apiKeyId }, { lastUsedAt: new Date(now) }).exec().catch(() => undefined);
  }

  getUsage(customerId: string) {
    return this.usage
      .find({ customerId: new Types.ObjectId(customerId) })
      .sort({ period: -1 })
      .lean()
      .exec();
  }

  /**
   * The usage-detail report: one customer's `usage_buckets` over a window,
   * broken down by day, route, key and response class, plus the totals and the
   * plan allowance those numbers sit against.
   *
   * Two things it deliberately does that `getUsage` above does NOT, and both
   * are the reason this is a new method rather than an extension of that one:
   * the customer id is parsed inside a try/catch so a malformed path segment is
   * a clean 404 instead of the BSONError-shaped 500 `new Types.ObjectId()`
   * throws, and both the window and the returned row counts are bounded — an
   * unbounded read of a per-request collection is a free way to make the API
   * do arbitrary work.
   *
   * ONE round trip: a `$facet` computes every breakdown over the same `$match`,
   * so the totals can never disagree with the rows beside them.
   */
  async getUsageDetail(customerId: string, query: UsageDetailQuery = {}): Promise<UsageDetail> {
    const owner = this.customerObjectId(customerId);
    const range = resolveUsageRange(query.from, query.to);
    const groupBy = assertUsageDetailGroup(query.groupBy);

    // The allowance comes from the customer record, which also means an id that
    // parses but belongs to nobody 404s rather than answering with an empty
    // report for a tenant that does not exist.
    const client = await this.customers.findById(owner).lean().exec();
    if (!client) throw new NotFoundException({ error: 'Client not found' });
    const limit = this.settings.getPlan(client.planKey)?.monthlyUnits ?? 0;

    const wanted = (group: UsageDetailGroup): boolean => groupBy === undefined || groupBy === group;
    const facet: Record<string, PipelineStage.FacetPipelineStage[]> = {
      // Unconditional: `totals` is in the response whatever the grouping.
      totals: [{ $group: { _id: null, units: { $sum: '$units' }, requests: { $sum: '$requests' } } }],
    };
    if (wanted('day')) {
      facet.series = [
        { $group: { _id: '$day', units: { $sum: '$units' }, requests: { $sum: '$requests' } } },
        { $sort: { _id: 1 } },
        { $limit: MAX_USAGE_DETAIL_DAYS },
      ];
    }
    if (wanted('routeKey')) {
      facet.byRoute = [
        { $group: { _id: '$routeKey', units: { $sum: '$units' }, requests: { $sum: '$requests' } } },
        { $sort: { units: -1, _id: 1 } },
        { $limit: MAX_USAGE_DETAIL_ROWS },
      ];
    }
    if (wanted('apiKey')) {
      facet.byKey = [
        // Newest day first so `$first` below picks the prefix and label the key
        // carried MOST RECENTLY: both are snapshotted per bucket, so a key
        // relabelled mid-window legitimately has two spellings in this range.
        { $sort: { day: -1 } },
        {
          $group: {
            _id: '$apiKeyId',
            keyPrefix: { $first: '$keyPrefix' },
            keyLabel: { $first: '$keyLabel' },
            units: { $sum: '$units' },
            requests: { $sum: '$requests' },
          },
        },
        { $sort: { units: -1, _id: 1 } },
        { $limit: MAX_USAGE_DETAIL_ROWS },
      ];
    }
    if (wanted('status')) {
      facet.byStatus = [
        { $group: { _id: '$statusClass', units: { $sum: '$units' }, requests: { $sum: '$requests' } } },
      ];
    }

    // `day` is a `YYYY-MM-DD` string, so a lexicographic range IS a date range,
    // and the match rides the `{customerId: 1, day: -1}` index.
    const [facets] = await this.usageBuckets
      .aggregate<UsageDetailFacets>([
        { $match: { customerId: owner, day: { $gte: range.from, $lte: range.to } } },
        { $facet: facet },
      ])
      .exec();

    const totals = facets?.totals?.[0];
    return {
      range,
      totals: { units: totals?.units ?? 0, requests: totals?.requests ?? 0, limit },
      // SPARSE by design: a day with no traffic has no bucket and gets no
      // entry, rather than a fabricated zero row. Filling the gaps is a
      // charting decision and belongs where the chart is drawn.
      series: (facets?.series ?? []).map((row) => ({
        day: row._id,
        units: row.units,
        requests: row.requests,
      })),
      byRoute: (facets?.byRoute ?? []).map((row) => ({
        routeKey: row._id,
        label: this.settings.getEndpointLabel(row._id),
        // The SAME lookup `MeteringGuard` charges through, so the price this
        // report shows is provably the price the request paid.
        unitCost: this.settings.getEndpointCost(row._id, seedCostFor(row._id)),
        units: row.units,
        requests: row.requests,
      })),
      byKey: (facets?.byKey ?? []).map((row) => ({
        apiKeyId: String(row._id),
        keyPrefix: row.keyPrefix ?? '',
        keyLabel: row.keyLabel ?? '',
        units: row.units,
        requests: row.requests,
      })),
      byStatus: (facets?.byStatus ?? [])
        .map((row) => ({ statusClass: row._id, requests: row.requests, units: row.units }))
        .sort((a, b) => statusRank(a.statusClass) - statusRank(b.statusClass)),
    };
  }

  /**
   * A customer id as an ObjectId, or a 404. Same fail-closed shape as
   * `ownedKeyFilter` above, and for the same reason: a malformed id must be
   * "not found", never a 500 and never — as `AdminPaymentsController` does on
   * its list routes — a filter silently dropped, which answers with every
   * customer's rows.
   */
  private customerObjectId(customerId: string): Types.ObjectId {
    try {
      return new Types.ObjectId(customerId);
    } catch {
      throw new NotFoundException({ error: 'Client not found' });
    }
  }
}

/**
 * The window to report on, defaulting to the current calendar month TO DATE
 * (UTC), and refusing anything the read cannot serve cheaply.
 *
 * Enforced HERE rather than only on the query DTO: the global ValidationPipe is
 * inert under `tsx` dev (esbuild drops the decorator metadata), so a decorator
 * bound is a courtesy to the caller and never a control — the same reasoning
 * that puts the portal's own input caps in `CustomerSelfService`.
 */
function resolveUsageRange(from: unknown, to: unknown): { from: string; to: string } {
  const resolvedTo = to === undefined ? utcDay(new Date()) : assertDay(to, 'to');
  // Anchored on `to`'s month, not today's, so `?to=2026-06-30` alone reports
  // June rather than a window that ends before it starts.
  const resolvedFrom = from === undefined ? `${resolvedTo.slice(0, 7)}-01` : assertDay(from, 'from');

  if (resolvedFrom > resolvedTo) {
    throw new BadRequestException({ error: '`from` must not be after `to`.' });
  }
  const days = Math.round((Date.parse(`${resolvedTo}T00:00:00Z`) - Date.parse(`${resolvedFrom}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MAX_USAGE_DETAIL_DAYS) {
    throw new BadRequestException({
      error: `A usage range covers at most ${MAX_USAGE_DETAIL_DAYS} days — narrow the window, or read the monthly totals.`,
    });
  }
  return { from: resolvedFrom, to: resolvedTo };
}

/**
 * One `YYYY-MM-DD` bound. Typed `unknown` deliberately: with the pipe inert a
 * caller can send `?from[$gt]=` and hand this an OBJECT, which would otherwise
 * reach the Mongo filter as an operator rather than a value.
 *
 * The round trip through UTC is what rejects a well-shaped impossibility like
 * `2026-02-31`, which the pattern alone accepts.
 */
function assertDay(value: unknown, field: 'from' | 'to'): string {
  const day = typeof value === 'string' ? value.trim() : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && utcDay(new Date(`${day}T00:00:00Z`)) === day) return day;
  throw new BadRequestException({ error: `\`${field}\` must be a calendar date as YYYY-MM-DD.` });
}

/** `YYYY-MM-DD` in UTC — the same bucketing `UsageBucketService` writes. */
function utcDay(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** An omitted `groupBy` means "all four"; an unrecognised one is a 400. */
function assertUsageDetailGroup(value: unknown): UsageDetailGroup | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'string' && (USAGE_DETAIL_GROUPS as readonly string[]).includes(value)) {
    return value as UsageDetailGroup;
  }
  throw new BadRequestException({
    error: `\`groupBy\` must be one of: ${USAGE_DETAIL_GROUPS.join(', ')}.`,
  });
}

/** Position in `STATUS_CLASS_ORDER`; anything unrecognised sorts last. */
function statusRank(statusClass: string): number {
  const index = STATUS_CLASS_ORDER.indexOf(statusClass);
  return index === -1 ? STATUS_CLASS_ORDER.length : index;
}

/** Mongo duplicate-key (E11000) — the partial-unique email index rejecting a dupe. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
