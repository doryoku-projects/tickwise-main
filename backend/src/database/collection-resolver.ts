import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { AppConfigService } from '../config/app-config.service.js';
import {
  PoolSchema,
  type PoolDocument,
} from './schemas/pool.schema.js';
import {
  PositionSchema,
  type PositionDocument,
} from './schemas/position.schema.js';
import {
  PositionTransactionSchema,
  type PositionTransactionDocument,
} from './schemas/position-transaction.schema.js';
import {
  TokenPriceHistoricalSchema,
  type TokenPriceHistoricalDocument,
} from './schemas/token-price-historical.schema.js';
import {
  TokenSchema,
  type TokenDocument,
} from './schemas/token.schema.js';
import { auditIndexes, declaredIndexes, declaredNamedIndexes, type ExistingIndex } from './index-audit.js';

/** A shard whose `listIndexes` has not answered by then is not audited (boot goes on). */
const INDEX_PREFLIGHT_TIMEOUT_MS = 5_000;
/** Building the declared indexes of a brand-new (empty) shard collection. */
const NEW_COLLECTION_INDEX_TIMEOUT_MS = 30_000;

/**
 * The schemas of the SHARD collections — the big ones, where a boot-time index
 * build is a collection scan on the primary and a dropped index must stay
 * dropped. Their autoIndex follows `MONGO_SHARD_AUTO_INDEX` (off in production
 * unless set); every other schema (billing, identity, payments, tokens …) keeps
 * Mongoose's autoIndex, because its indexes are small and several are integrity
 * guarantees (unique identities, payments).
 */
const SHARD_SCHEMAS = [PositionSchema, PositionTransactionSchema, PoolSchema] as const;

/**
 * Resolves the right Mongo model + collection name for a given
 * `(chainId, protocol)` pair.
 *
 * At boot, registers one Mongoose model per `(chainId, protocol)` for
 * positions + transactions, and one model per `chainId` for token prices.
 * Collection names follow:
 *   - `{chainId}_{protocol}_positions`
 *   - `{chainId}_{protocol}_position_transactions`
 *   - `{chainId}_token_price_historical`
 *
 * Indexes on the shard collections (positions, position transactions,
 * pools): with `MONGO_SHARD_AUTO_INDEX` on (unset outside production) Mongoose
 * builds every declared index at registration, as it always did; OFF
 * (production) nothing is built at boot on an existing collection — indexes
 * come from `scripts/positions-index-migration.mjs` — and only a shard
 * collection that does not exist yet gets its declared indexes here, against
 * zero documents. Either way a read-only pre-flight first reports the position
 * indexes the shard lacks or carries with a different spec
 * (`preflightPositionIndexes`). Repositories call `positionModel()` /
 * `transactionModel()` / `priceModel()` on every operation; the resolver
 * caches each model after first construction.
 */
@Injectable()
export class CollectionResolver implements OnModuleInit {
  private readonly logger = new Logger(CollectionResolver.name);
  private readonly poolByKey = new Map<string, Model<PoolDocument>>();
  private readonly positionByKey = new Map<string, Model<PositionDocument>>();
  private readonly txByKey = new Map<string, Model<PositionTransactionDocument>>();
  private readonly priceByChain = new Map<number, Model<TokenPriceHistoricalDocument>>();
  private readonly tokensByChain = new Map<number, Model<TokenDocument>>();
  /** `chainId:protocol` → hinted index name → why it must NOT be hinted (its spec differs). */
  private readonly unusableHints = new Map<string, Map<string, string>>();

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Decided BEFORE any shard model is registered: registration is what
    // starts Mongoose's autoIndex. An absent getter (unit wiring) keeps it on.
    const autoIndex = this.config.mongoShardAutoIndex ?? true;
    for (const schema of SHARD_SCHEMAS) schema.set('autoIndex', autoIndex);
    // Only needed with autoIndex off: which shard collections are brand new.
    const existing = autoIndex ? null : await this.existingCollections();
    // BEFORE any position model exists: registering one starts autoIndex
    // (when on), which builds every declared index the shard lacks on the primary.
    await this.preflightPositionIndexes(autoIndex, existing);
    // Eagerly register per-(chainId, protocol) shard models so indexes are
    // built up-front rather than on the first read/write.
    const chainIds = new Set<number>();
    for (const integration of this.config.enabledIntegrations) {
      this.poolModel(integration.chainId, integration.protocol);
      this.positionModel(integration.chainId, integration.protocol);
      this.transactionModel(integration.chainId, integration.protocol);
      chainIds.add(integration.chainId);
    }
    for (const chainId of chainIds) {
      this.priceModel(chainId);
      this.tokenModel(chainId);
    }
    this.logger.log(
      `Registered ${this.poolByKey.size} pool model(s), ${this.positionByKey.size} position model(s), ${this.txByKey.size} transaction model(s), ${this.priceByChain.size} price model(s), ${this.tokensByChain.size} token model(s)` +
        ` — shard autoIndex ${autoIndex ? 'ON' : 'OFF (indexes come from scripts)'}`,
    );
    if (!autoIndex && existing) await this.indexNewShardCollections(existing);
  }

  /**
   * The collection names this database has, or null when they cannot be read
   * (then no collection is treated as new: nothing is built).
   */
  private async existingCollections(): Promise<Set<string> | null> {
    const db = this.connection.db;
    if (!db || typeof db.listCollections !== 'function') return null;
    try {
      const rows = await withTimeout(db.listCollections({}, { nameOnly: true }).toArray(), INDEX_PREFLIGHT_TIMEOUT_MS);
      return new Set(rows.map((row) => String((row as { name?: unknown }).name)));
    } catch (err) {
      this.logger.warn(
        `Could not list collections (${(err as Error)?.message ?? String(err)}) — with shard autoIndex off, no new shard ` +
          `collection gets its indexes at this boot`,
      );
      return null;
    }
  }

  /**
   * With shard autoIndex OFF, a shard collection that did not exist at boot (a
   * newly enabled chain) gets every declared index now — built against zero
   * documents, so it costs nothing, and it is what keeps the unique
   * `{chainId, protocol, positionId}` / `poolId` indexes in place before the
   * first sync writes. An existing collection is never touched here.
   */
  private async indexNewShardCollections(existing: Set<string>): Promise<void> {
    const shardModels: Array<[string, Model<unknown>]> = [];
    for (const { chainId, protocol } of this.config.enabledIntegrations) {
      shardModels.push([this.positionCollectionName(chainId, protocol), this.positionModel(chainId, protocol) as unknown as Model<unknown>]);
      shardModels.push([this.transactionCollectionName(chainId, protocol), this.transactionModel(chainId, protocol) as unknown as Model<unknown>]);
      shardModels.push([this.poolCollectionName(chainId, protocol), this.poolModel(chainId, protocol) as unknown as Model<unknown>]);
    }
    for (const [name, model] of shardModels) {
      if (existing.has(name) || typeof model.createIndexes !== 'function') continue;
      try {
        await withTimeout(
          (async () => {
            await model.init?.();
            await model.createIndexes();
          })(),
          NEW_COLLECTION_INDEX_TIMEOUT_MS,
        );
        this.logger.log(`New shard collection ${name}: built its declared indexes (empty collection, shard autoIndex off)`);
      } catch (err) {
        // P2.1 (design §2.1 C20): split roles boot side by side, so a second
        // process can meet the first one's build on the same new collection.
        // `IndexBuildAlreadyInProgress` (276) / `IndexAlreadyExists` (68) mean
        // somebody else is building or built exactly this — not a failure.
        if (isConcurrentIndexBuild(err)) {
          this.logger.log(`New shard collection ${name}: indexes built by a concurrent boot (${(err as { codeName?: string }).codeName ?? (err as { code?: number }).code})`);
          continue;
        }
        this.logger.warn(
          `[alert] mongo.new_collection_indexes_failed collection=${name} — ${(err as Error)?.message ?? String(err)}; ` +
            `run scripts/positions-index-migration.mjs --apply (positions) or create them by hand before the first sync`,
        );
      }
    }
  }

  /**
   * Why `index` must not be hinted on this shard — its spec differs from the
   * declaration (see `preflightPositionIndexes`) — or undefined. A hint naming
   * such an index is obeyed: a narrower partial filter returns incomplete pages
   * with no error, a wrong collation turns the sort walk into a full scan.
   * Learned at boot; a corrected index is picked up at the next boot.
   */
  hintUnusable(chainId: number, protocol: string, index: string): string | undefined {
    return this.unusableHints.get(positionKey(chainId, protocol))?.get(index);
  }

  /**
   * Compares every enabled positions shard's `listIndexes` with the hinted
   * `lbr_*` / `bg_*` indexes `PositionSchema` declares, before autoIndex runs:
   *  - MISSING ones: with shard autoIndex ON they are about to be built on the
   *    PRIMARY at this boot (one collection scan per index per shard) — the
   *    migration script's `--apply` did not run, or ran narrowed. With it OFF
   *    (production) nothing builds them: they stay missing until the script
   *    runs, and every declared index is checked, not only the hinted ones.
   *    Either way `[alert] positions.index_preflight` says so. (Hints on them
   *    fall back until the index exists — `withHint`.)
   *  - MISMATCHED ones (same name, different spec) stay as they are: autoIndex's
   *    createIndex fails with IndexOptionsConflict and the error is swallowed.
   *    `[alert] positions.index_mismatch`, and `hintUnusable` keeps every query
   *    off them for the life of the process.
   * Never throws and never blocks boot for long: a shard that cannot be read
   * within `INDEX_PREFLIGHT_TIMEOUT_MS` is skipped with a warning. A shard whose
   * collection does not exist yet (a newly enabled chain) is not an alert —
   * its indexes are built on the empty collection (by autoIndex, or by
   * `indexNewShardCollections` when autoIndex is off).
   */
  private async preflightPositionIndexes(autoIndex = true, existingCollections: Set<string> | null = null): Promise<void> {
    const db = this.connection.db;
    if (!db) return;
    const declared = declaredNamedIndexes(PositionSchema);
    if (declared.length === 0) return;
    // autoIndex off: every declared index (unnamed ones under their generated
    // name) — nothing else will build one the shard lacks.
    const required = autoIndex ? declared : declaredIndexes(PositionSchema).map(({ named: _named, ...index }) => index);
    const shards = new Map<string, { chainId: number; protocol: string }>();
    for (const { chainId, protocol } of this.config.enabledIntegrations) shards.set(positionKey(chainId, protocol), { chainId, protocol });
    await Promise.all(
      [...shards.entries()].map(async ([key, { chainId, protocol }]) => {
        const name = this.positionCollectionName(chainId, protocol);
        if (existingCollections && !existingCollections.has(name)) {
          this.logger.log(`Position index pre-flight: ${name} does not exist yet — its indexes are built on the empty collection`);
          return;
        }
        let existing: ExistingIndex[];
        try {
          existing = (await withTimeout(db.collection(name).indexes(), INDEX_PREFLIGHT_TIMEOUT_MS)) as unknown as ExistingIndex[];
        } catch (err) {
          const record = err as { code?: unknown; codeName?: unknown; message?: unknown };
          if (record?.code === 26 || record?.codeName === 'NamespaceNotFound') {
            this.logger.log(`Position index pre-flight: ${name} does not exist yet — its indexes are built on the empty collection`);
          } else {
            this.logger.warn(`Position index pre-flight could not read ${name}: ${String(record?.message ?? err)} — not audited`);
          }
          return;
        }
        const audit = auditIndexes(declared, existing);
        if (!autoIndex) audit.missing = auditIndexes(required, existing).missing;
        if (audit.mismatched.length > 0) {
          this.unusableHints.set(key, new Map(audit.mismatched.map((m) => [m.name, m.differences.join('; ')])));
          for (const m of audit.mismatched) {
            this.logger.warn(
              `[alert] positions.index_mismatch collection=${name} index=${m.name} — exists with a different spec ` +
                `(${m.differences.join('; ')}); it is never hinted by this process. The migration script reports it as a CONFLICT`,
            );
          }
        }
        if (audit.missing.length > 0) {
          this.logger.warn(
            autoIndex
              ? `[alert] positions.index_preflight collection=${name} missing=${audit.missing.join(',')} — autoIndex is building ` +
                  `${audit.missing.length === 1 ? 'it' : 'them'} on the PRIMARY now (one collection scan per index). ` +
                  `Run scripts/positions-index-migration.mjs --apply on every shard BEFORE a deploy that declares them`
              : `[alert] positions.index_preflight collection=${name} missing=${audit.missing.join(',')} — shard autoIndex is OFF, ` +
                  `so nothing builds ${audit.missing.length === 1 ? 'it' : 'them'}: queries hinted to ${audit.missing.length === 1 ? 'it' : 'them'} ` +
                  `fall back until built (scripts/positions-index-migration.mjs --apply builds the lbr_/bg_ ones; any other by hand, off-peak)`,
          );
        }
        if (audit.missing.length === 0 && audit.mismatched.length === 0) {
          this.logger.log(
            `Position index pre-flight: ${name} has all ${autoIndex ? declared.length : required.length} ${autoIndex ? 'hinted' : 'declared'} indexes as declared`,
          );
        }
      }),
    );
  }

  /** Resolves the Pool model for a given (chainId, protocol). */
  poolModel(chainId: number, protocol: string): Model<PoolDocument> {
    const key = positionKey(chainId, protocol);
    const cached = this.poolByKey.get(key);
    if (cached) return cached;
    const collectionName = `${chainId}_${normalizeProtocol(protocol)}_pools`;
    const modelName = `Pool_${chainId}_${normalizeProtocol(protocol)}`;
    const model = this.connection.model(modelName, PoolSchema, collectionName) as unknown as Model<PoolDocument>;
    this.poolByKey.set(key, model);
    return model;
  }

  /** Collection name for the pools collection of `(chainId, protocol)`. */
  poolCollectionName(chainId: number, protocol: string): string {
    return `${chainId}_${normalizeProtocol(protocol)}_pools`;
  }

  /** Resolves the Position model for a given (chainId, protocol). */
  positionModel(chainId: number, protocol: string): Model<PositionDocument> {
    const key = positionKey(chainId, protocol);
    const cached = this.positionByKey.get(key);
    if (cached) return cached;
    const collectionName = `${chainId}_${normalizeProtocol(protocol)}_positions`;
    const modelName = `Position_${chainId}_${normalizeProtocol(protocol)}`;
    const model = this.connection.model(modelName, PositionSchema, collectionName) as unknown as Model<PositionDocument>;
    this.positionByKey.set(key, model);
    return model;
  }

  /** Resolves the PositionTransaction model for a given (chainId, protocol). */
  transactionModel(chainId: number, protocol: string): Model<PositionTransactionDocument> {
    const key = positionKey(chainId, protocol);
    const cached = this.txByKey.get(key);
    if (cached) return cached;
    const collectionName = `${chainId}_${normalizeProtocol(protocol)}_position_transactions`;
    const modelName = `PositionTransaction_${chainId}_${normalizeProtocol(protocol)}`;
    const model = this.connection.model(modelName, PositionTransactionSchema, collectionName) as unknown as Model<PositionTransactionDocument>;
    this.txByKey.set(key, model);
    return model;
  }

  /**
   * Resolves the TokenPriceHistorical model for a given chainId. Token prices
   * have no protocol dimension — a USD price is the same for a token whether
   * it sits in a V3 or V4 pool — so we partition by chain only.
   */
  priceModel(chainId: number): Model<TokenPriceHistoricalDocument> {
    const cached = this.priceByChain.get(chainId);
    if (cached) return cached;
    const collectionName = `${chainId}_token_price_historical`;
    const modelName = `TokenPriceHistorical_${chainId}`;
    const model = this.connection.model(modelName, TokenPriceHistoricalSchema, collectionName) as unknown as Model<TokenPriceHistoricalDocument>;
    this.priceByChain.set(chainId, model);
    return model;
  }

  /**
   * Resolves the Token model for a given chainId. Like token prices, a token's
   * security signals + current price have no protocol dimension — partition by
   * chain only (`{chainId}_tokens`).
   */
  tokenModel(chainId: number): Model<TokenDocument> {
    const cached = this.tokensByChain.get(chainId);
    if (cached) return cached;
    const collectionName = `${chainId}_tokens`;
    const modelName = `Token_${chainId}`;
    const model = this.connection.model(modelName, TokenSchema, collectionName) as unknown as Model<TokenDocument>;
    this.tokensByChain.set(chainId, model);
    return model;
  }

  /**
   * Returns the actual collection name for the position-transactions
   * collection scoped to `(chainId, protocol)`. Used by aggregation `$lookup`
   * stages that need to reference the collection by name rather than via a
   * model reference.
   */
  transactionCollectionName(chainId: number, protocol: string): string {
    return `${chainId}_${normalizeProtocol(protocol)}_position_transactions`;
  }

  /** Collection name for positions of `(chainId, protocol)`. */
  positionCollectionName(chainId: number, protocol: string): string {
    return `${chainId}_${normalizeProtocol(protocol)}_positions`;
  }

  /** Collection name for the chain-scoped token price cache. */
  priceCollectionName(chainId: number): string {
    return `${chainId}_token_price_historical`;
  }
}

/**
 * Convert a protocol slug to its underscore-safe form for collection names
 * (`uniswap-v4` → `uniswap_v4`). Mongo allows hyphens but underscores are
 * friendlier to shell scripts and admin tooling.
 */
export function normalizeProtocol(protocol: string): string {
  return protocol.replace(/-/g, '_');
}

function positionKey(chainId: number, protocol: string): string {
  return `${chainId}:${protocol}`;
}

/** Rejects after `ms` (the underlying operation is abandoned, not cancelled). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A `createIndexes` refused only because another process is building / built the same index (P2.1 concurrent boots). */
export function isConcurrentIndexBuild(err: unknown): boolean {
  const e = err as { code?: unknown; codeName?: unknown } | null | undefined;
  return e?.code === 276 || e?.code === 68 || e?.codeName === 'IndexBuildAlreadyInProgress' || e?.codeName === 'IndexAlreadyExists';
}
