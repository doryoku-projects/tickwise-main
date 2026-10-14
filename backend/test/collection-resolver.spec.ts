import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_SPECS, SET_R_SPECS } from '../scripts/positions-index-migration.mjs';
import { CollectionResolver, normalizeProtocol } from '../src/database/collection-resolver.js';

type Index = { name: string; key: Record<string, unknown>; collation?: Record<string, unknown>; partialFilterExpression?: Record<string, unknown>; [k: string]: unknown };
type Spec = { name: string; key: Record<string, number>; collation?: Record<string, unknown>; partialFilterExpression?: Record<string, unknown> };

/** A server-side `listIndexes` entry for a spec: expanded ICU collation, none for simple. */
function serverShape(spec: Spec): Index {
  const out: Index = { v: 2, key: { ...spec.key }, name: spec.name };
  if (spec.collation && spec.collation.locale !== 'simple') {
    out.collation = {
      locale: spec.collation.locale, caseLevel: false, caseFirst: 'off', strength: 3,
      numericOrdering: spec.collation.numericOrdering ?? false, alternate: 'non-ignorable',
      maxVariable: 'punct', normalization: false, backwards: false, version: '57.1',
    };
  }
  if (spec.partialFilterExpression) out.partialFilterExpression = { ...spec.partialFilterExpression };
  return out;
}
const ALL_HINTED: Index[] = [...(SET_R_SPECS as Spec[]), ...(BACKGROUND_SPECS as Spec[])].map(serverShape);

/**
 * `listIndexes` per collection: an array, an Error to throw, or 'hang' (never
 * answers). `order` records listIndexes and model registrations as they happen.
 */
function makeConnection(indexesByCollection?: Record<string, Index[] | Error | 'hang'>) {
  const order: string[] = [];
  const model = vi.fn((name: string, _schema: unknown, collection: string) => {
    order.push(`model:${collection}`);
    return { __testName: name, __testCollection: collection };
  });
  const db = indexesByCollection && {
    collection: (name: string) => ({
      indexes: async () => {
        order.push(`listIndexes:${name}`);
        const entry = indexesByCollection[name];
        if (entry === 'hang') return new Promise<Index[]>(() => {});
        if (entry instanceof Error) throw entry;
        return entry ?? [];
      },
    }),
  };
  return { model, db, order };
}

function makeConfig(integrations: Array<{ chainId: number; protocol: string }>) {
  return { enabledIntegrations: integrations };
}

function instantiate(
  integrations: Array<{ chainId: number; protocol: string }> = [],
  indexesByCollection?: Record<string, Index[] | Error | 'hang'>,
) {
  const connection = makeConnection(indexesByCollection);
  const resolver = new CollectionResolver(connection as never, makeConfig(integrations) as never);
  const logger = (resolver as unknown as { logger: { warn: (m: string) => void; log: (m: string) => void } }).logger;
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'log').mockImplementation(() => {});
  const alerts = () => warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('[alert]'));
  return { resolver, connection, warn, alerts };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CollectionResolver', () => {
  it('registers one position + transaction model per integration at boot', async () => {
    const { resolver, connection } = instantiate([
      { chainId: 1, protocol: 'uniswap-v4' },
      { chainId: 1, protocol: 'uniswap-v3' },
      { chainId: 137, protocol: 'uniswap-v4' },
    ]);
    await resolver.onModuleInit();

    const collectionNames = connection.model.mock.calls.map((call) => call[2]);
    expect(collectionNames).toContain('1_uniswap_v4_positions');
    expect(collectionNames).toContain('1_uniswap_v4_position_transactions');
    expect(collectionNames).toContain('1_uniswap_v3_positions');
    expect(collectionNames).toContain('137_uniswap_v4_positions');
    expect(collectionNames).toContain('1_token_price_historical');
    expect(collectionNames).toContain('137_token_price_historical');
  });

  it('produces the documented collection name shape', () => {
    const { resolver } = instantiate();
    expect(resolver.positionCollectionName(1, 'uniswap-v4')).toBe('1_uniswap_v4_positions');
    expect(resolver.transactionCollectionName(1, 'uniswap-v4')).toBe(
      '1_uniswap_v4_position_transactions',
    );
    expect(resolver.priceCollectionName(1)).toBe('1_token_price_historical');
  });

  it('caches per-(chainId, protocol) models so repeated calls return the same model', () => {
    const { resolver, connection } = instantiate();
    const first = resolver.positionModel(1, 'uniswap-v4');
    const second = resolver.positionModel(1, 'uniswap-v4');
    expect(first).toBe(second);
    const positionCalls = connection.model.mock.calls.filter((call) =>
      call[2].endsWith('_positions'),
    );
    expect(positionCalls).toHaveLength(1);
  });

  it('caches price models per chain only', () => {
    const { resolver, connection } = instantiate();
    const first = resolver.priceModel(1);
    const second = resolver.priceModel(1);
    expect(first).toBe(second);
    const priceCalls = connection.model.mock.calls.filter((call) =>
      call[2].endsWith('token_price_historical'),
    );
    expect(priceCalls).toHaveLength(1);
  });

  it('deduplicates chains when registering price models at boot', async () => {
    const { resolver, connection } = instantiate([
      { chainId: 1, protocol: 'uniswap-v4' },
      { chainId: 1, protocol: 'uniswap-v3' },
      // Two protocols share chain 1 — should still be a single price model.
    ]);
    await resolver.onModuleInit();
    const priceCalls = connection.model.mock.calls.filter((call) =>
      call[2].endsWith('token_price_historical'),
    );
    expect(priceCalls).toHaveLength(1);
    expect(priceCalls[0]?.[2]).toBe('1_token_price_historical');
  });
});

describe('CollectionResolver position-index pre-flight (before autoIndex)', () => {
  const V4 = [{ chainId: 1, protocol: 'uniswap-v4' }, { chainId: 42161, protocol: 'uniswap-v4' }];

  it('reads every shard\'s indexes BEFORE any position model (= autoIndex) exists, and is quiet when all are present', async () => {
    const { resolver, connection, alerts } = instantiate(V4, {
      '1_uniswap_v4_positions': ALL_HINTED,
      '42161_uniswap_v4_positions': ALL_HINTED,
    });
    await resolver.onModuleInit();
    const firstModel = connection.order.findIndex((o) => o.startsWith('model:'));
    const lastListing = connection.order.map((o) => o.startsWith('listIndexes:')).lastIndexOf(true);
    expect(connection.order.filter((o) => o.startsWith('listIndexes:')).sort()).toEqual([
      'listIndexes:1_uniswap_v4_positions',
      'listIndexes:42161_uniswap_v4_positions',
    ]);
    expect(lastListing).toBeLessThan(firstModel);
    expect(alerts()).toEqual([]);
    expect(resolver.hintUnusable(1, 'uniswap-v4', 'lbr_pnl')).toBeUndefined();
  });

  it('a shard missing hinted indexes raises ONE [alert] naming them (autoIndex is about to build them on the primary)', async () => {
    const { resolver, alerts } = instantiate(V4, {
      '1_uniswap_v4_positions': ALL_HINTED.filter((ix) => ix.name !== 'lbr_created' && ix.name !== 'bg_active_pool_owner'),
      '42161_uniswap_v4_positions': ALL_HINTED,
    });
    await resolver.onModuleInit();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('positions.index_preflight collection=1_uniswap_v4_positions missing=lbr_created,bg_active_pool_owner');
    expect(alerts()[0]).toContain('PRIMARY');
    // A missing index is not "unusable": hints fall back until the build lands (withHint).
    expect(resolver.hintUnusable(1, 'uniswap-v4', 'lbr_created')).toBeUndefined();
  });

  it('an index under a hinted name with a DIFFERENT spec is alerted and reported unusable for that shard only', async () => {
    const narrower = { ...serverShape((SET_R_SPECS as Spec[]).find((s) => s.name === 'lbr_apr_active')!), partialFilterExpression: { isActive: true, 'metrics.inRange': true } };
    const simple = { ...serverShape((SET_R_SPECS as Spec[]).find((s) => s.name === 'lbr_created')!), collation: undefined };
    const { resolver, alerts } = instantiate(V4, {
      '1_uniswap_v4_positions': [...ALL_HINTED.filter((ix) => ix.name !== 'lbr_apr_active' && ix.name !== 'lbr_created'), narrower, simple],
      '42161_uniswap_v4_positions': ALL_HINTED,
    });
    await resolver.onModuleInit();
    expect(resolver.hintUnusable(1, 'uniswap-v4', 'lbr_apr_active')).toMatch(/partialFilterExpression/);
    expect(resolver.hintUnusable(1, 'uniswap-v4', 'lbr_created')).toMatch(/collation simple/);
    expect(resolver.hintUnusable(1, 'uniswap-v4', 'lbr_pnl')).toBeUndefined();
    expect(resolver.hintUnusable(42161, 'uniswap-v4', 'lbr_apr_active')).toBeUndefined();
    expect(alerts().filter((m) => m.includes('positions.index_mismatch'))).toHaveLength(2);
    expect(alerts().join('\n')).toContain('index=lbr_apr_active');
  });

  it('never blocks or fails boot: a missing collection is not an alert, an unreadable or hung shard is skipped', async () => {
    vi.useFakeTimers();
    const notFound = Object.assign(new Error('ns does not exist'), { code: 26, codeName: 'NamespaceNotFound' });
    const { resolver, connection, alerts, warn } = instantiate(
      [...V4, { chainId: 43114, protocol: 'uniswap-v4' }],
      {
        '1_uniswap_v4_positions': notFound,
        '42161_uniswap_v4_positions': new Error('not authorized on copypools_positions to execute command'),
        '43114_uniswap_v4_positions': 'hang',
      },
    );
    const boot = resolver.onModuleInit();
    await vi.advanceTimersByTimeAsync(5_000);
    await boot;
    expect(alerts()).toEqual([]);
    expect(warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('could not read'))).toHaveLength(2);
    // Boot went on and registered every shard.
    expect(connection.model.mock.calls.map((call) => call[2])).toEqual(
      expect.arrayContaining(['1_uniswap_v4_positions', '42161_uniswap_v4_positions', '43114_uniswap_v4_positions']),
    );
  });

  it('no database handle (unit wiring) skips the pre-flight entirely', async () => {
    const { resolver, connection } = instantiate([{ chainId: 1, protocol: 'uniswap-v4' }]);
    await resolver.onModuleInit();
    expect(connection.order.some((o) => o.startsWith('listIndexes:'))).toBe(false);
    expect(connection.model).toHaveBeenCalled();
  });
});

describe('normalizeProtocol', () => {
  it('replaces hyphens with underscores so collection names are shell-safe', () => {
    expect(normalizeProtocol('uniswap-v4')).toBe('uniswap_v4');
    expect(normalizeProtocol('curve-v2-stable')).toBe('curve_v2_stable');
    expect(normalizeProtocol('plain')).toBe('plain');
  });
});

describe('CollectionResolver with shard autoIndex OFF (production, 2026-10-03)', () => {
  // Every index the positions schema declares, named or not, as the server lists it.
  const ALL_DECLARED: Index[] = [
    ...ALL_HINTED,
    { v: 2, key: { chainId: 1, protocol: 1, positionId: 1 }, name: 'chainId_1_protocol_1_positionId_1', unique: true },
    { v: 2, key: { chainId: 1, protocol: 1, poolId: 1 }, name: 'chainId_1_protocol_1_poolId_1' },
    {
      v: 2,
      key: { chainId: 1, protocol: 1, owner: 1 },
      name: 'chainId_1_protocol_1_owner_1',
      collation: {
        locale: 'en', caseLevel: false, caseFirst: 'off', strength: 3, numericOrdering: true,
        alternate: 'non-ignorable', maxVariable: 'punct', normalization: false, backwards: false, version: '57.1',
      },
    },
    { v: 2, key: { chainId: 1, protocol: 1, isActive: -1, tokenId: 1 }, name: 'chainId_1_protocol_1_isActive_-1_tokenId_1' },
    { v: 2, key: { chainId: 1, protocol: 1, 'token0.address': 1 }, name: 'chainId_1_protocol_1_token0.address_1' },
    { v: 2, key: { chainId: 1, protocol: 1, 'token1.address': 1 }, name: 'chainId_1_protocol_1_token1.address_1' },
  ];

  async function bootOff(
    existingCollections: string[] | Error,
    indexesByCollection: Record<string, Index[]>,
    opts: { createIndexesError?: Error } = {},
  ) {
    const { PositionSchema } = await import('../src/database/schemas/position.schema.js');
    const { PoolSchema } = await import('../src/database/schemas/pool.schema.js');
    const { PositionTransactionSchema } = await import('../src/database/schemas/position-transaction.schema.js');
    const order: string[] = [];
    const built: string[] = [];
    const autoIndexAtRegistration: Record<string, unknown> = {};
    const model = vi.fn((name: string, schema: { get: (k: string) => unknown }, collection: string) => {
      order.push(`model:${collection}`);
      autoIndexAtRegistration[collection] = schema.get('autoIndex');
      return {
        __testCollection: collection,
        init: async () => undefined,
        createIndexes: async () => {
          if (opts.createIndexesError) throw opts.createIndexesError;
          built.push(collection);
        },
      };
    });
    const db = {
      listCollections: () => ({
        toArray: async () => {
          if (existingCollections instanceof Error) throw existingCollections;
          return existingCollections.map((name) => ({ name }));
        },
      }),
      collection: (name: string) => ({
        indexes: async () => {
          order.push(`listIndexes:${name}`);
          return indexesByCollection[name] ?? [];
        },
      }),
    };
    const resolver = new CollectionResolver(
      { model, db } as never,
      { enabledIntegrations: [{ chainId: 1, protocol: 'uniswap-v4' }, { chainId: 4663, protocol: 'uniswap-v4' }], mongoShardAutoIndex: false } as never,
    );
    const logger = (resolver as unknown as { logger: { warn: (m: string) => void; log: (m: string) => void } }).logger;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'log').mockImplementation(() => {});
    try {
      await resolver.onModuleInit();
    } finally {
      // The schemas are module-level: put them back for every other spec.
      for (const schema of [PositionSchema, PoolSchema, PositionTransactionSchema]) schema.set('autoIndex', true);
    }
    const alerts = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('[alert]'));
    return { order, built, autoIndexAtRegistration, alerts, warn };
  }

  it('the shard schemas are registered with autoIndex OFF; tokens / prices keep theirs', async () => {
    const all = ['1_uniswap_v4_positions', '1_uniswap_v4_position_transactions', '1_uniswap_v4_pools', '4663_uniswap_v4_positions', '4663_uniswap_v4_position_transactions', '4663_uniswap_v4_pools'];
    const { autoIndexAtRegistration, built } = await bootOff(all, { '1_uniswap_v4_positions': ALL_DECLARED, '4663_uniswap_v4_positions': ALL_DECLARED });
    for (const name of all) expect(autoIndexAtRegistration[name], name).toBe(false);
    expect(autoIndexAtRegistration['1_tokens']).not.toBe(false);
    expect(autoIndexAtRegistration['1_token_price_historical']).not.toBe(false);
    expect(built).toEqual([]); // nothing is built on an existing collection
  });

  it('a missing declared index — hinted OR NOT — is alerted as NOT being built (nothing will build it)', async () => {
    const all = ['1_uniswap_v4_positions', '4663_uniswap_v4_positions', '1_uniswap_v4_pools', '4663_uniswap_v4_pools', '1_uniswap_v4_position_transactions', '4663_uniswap_v4_position_transactions'];
    const { alerts } = await bootOff(all, {
      '1_uniswap_v4_positions': ALL_DECLARED.filter((ix) => ix.name !== 'chainId_1_protocol_1_poolId_1' && ix.name !== 'lbr_pnl'),
      '4663_uniswap_v4_positions': ALL_DECLARED,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('collection=1_uniswap_v4_positions missing=chainId_1_protocol_1_poolId_1,lbr_pnl');
    expect(alerts[0]).toContain('shard autoIndex is OFF');
    expect(alerts[0]).not.toContain('PRIMARY now');
  });

  it('a shard collection that does not exist yet gets its declared indexes at boot (empty collection); existing ones are untouched', async () => {
    const existing = ['1_uniswap_v4_positions', '1_uniswap_v4_position_transactions', '1_uniswap_v4_pools'];
    const { built, order, alerts } = await bootOff(existing, { '1_uniswap_v4_positions': ALL_DECLARED });
    expect(built).toEqual(['4663_uniswap_v4_positions', '4663_uniswap_v4_position_transactions', '4663_uniswap_v4_pools']);
    // The new positions shard is not audited (there is nothing to audit) …
    expect(order).not.toContain('listIndexes:4663_uniswap_v4_positions');
    expect(alerts).toEqual([]);
  });

  it('P2.1 concurrent boots: a build another process already started / finished is not an alert; any other error still is', async () => {
    const racing = await bootOff([], {}, { createIndexesError: Object.assign(new Error('index build already in progress'), { code: 276, codeName: 'IndexBuildAlreadyInProgress' }) });
    expect(racing.alerts).toEqual([]);
    const exists = await bootOff([], {}, { createIndexesError: Object.assign(new Error('already exists'), { code: 68, codeName: 'IndexAlreadyExists' }) });
    expect(exists.alerts).toEqual([]);
    const conflict = await bootOff([], {}, { createIndexesError: Object.assign(new Error('options conflict'), { code: 85, codeName: 'IndexOptionsConflict' }) });
    expect(conflict.alerts.filter((m) => m.includes('mongo.new_collection_indexes_failed'))).toHaveLength(6);
  });

  it('a failed build on a new collection alerts; unreadable collection names build nothing', async () => {
    const failed = await bootOff([], {}, { createIndexesError: new Error('not primary') });
    expect(failed.alerts.filter((m) => m.includes('mongo.new_collection_indexes_failed'))).toHaveLength(6);
    const blind = await bootOff(new Error('not authorized'), {});
    expect(blind.built).toEqual([]);
    expect(blind.warn.mock.calls.map(([m]) => String(m)).some((m) => m.includes('Could not list collections'))).toBe(true);
  });
});
