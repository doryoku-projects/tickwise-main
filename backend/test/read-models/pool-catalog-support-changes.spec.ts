import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { MODULE_METADATA, OPTIONAL_DEPS_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants.js';
import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { PositionsRepository } from '../../src/database/positions.repository.js';
import { ReadModelsService } from '../../src/read-models/read-models.service.js';
import { describe, expect, it, vi } from 'vitest';
import { PoolsModule } from '../../src/pools/pools.module.js';
import { PoolsService } from '../../src/pools/pools.service.js';
import { ReadModelsModule } from '../../src/read-models/read-models.module.js';
import { PoolCatalogService } from '../../src/read-models/pools/pool-catalog.service.js';
import { RankEngineService } from '../../src/read-models/rank/rank-engine.service.js';
import { PoolsRepository } from '../../src/database/pools.repository.js';
import { TokensRepository } from '../../src/database/token.repository.js';
import { LeaderboardCountService, resolveCountRoute, unmeteredCount } from '../../src/leaderboard/count-cache.js';
import { ReadBudgetTimeoutError } from '../../src/common/read-budget.js';
import { shardKey } from '../../src/read-models/core/fields.js';
import { Dictionary } from '../../src/read-models/core/dictionary.js';
import { buildStore, catalogFor, CHAINS, fakeReadModels, makeConfig, positionsFake, PROTO, poolsRepo, poolsService, shardsFor, tokensFake } from './pools-support.js';
import { SHARED_MEMORY } from '../../src/read-models/core/shared-memory.js';

/**
 * The shared code R2 changed: engine counts share the list-count cache but
 * not the read budget; the exclusion set keeps its identity while its content
 * does not change; rows are read at a clusterTime with a RAW command (the
 * driver's helpers drop `atClusterTime`) and fall back to a plain read; the
 * dictionary lives on shared memory; a poolId outside the BMP quarantines.
 */

describe('count cache: engine (unmetered) counts', () => {
  it('skip the read budget and the count slots, and share keys with Mongo counts', async () => {
    const budget = { reserve: vi.fn(async () => { throw new ReadBudgetTimeoutError('count', 1); }), chargeTime: vi.fn(), charge: vi.fn() };
    const counts = new LeaderboardCountService(undefined, budget as never);
    const engine = unmeteredCount(async () => ({ count: 5, capped: false, dataAt: Date.now() - 1_000 }) as never);
    expect(await resolveCountRoute({ route: 'pools', counts, tasks: async () => [{ key: 'k', run: engine }] })).toEqual({ total: 5, capped: false });
    expect(budget.reserve).not.toHaveBeenCalled();
    // A Mongo count of the same key is served from the cache the engine filled.
    const mongo = vi.fn(async () => ({ count: 9, capped: false }));
    expect(counts.peek('k', mongo)).toMatchObject({ count: 5 });
    expect(mongo).not.toHaveBeenCalled();
    // A Mongo count still takes the budget (and here answers pending).
    expect(await resolveCountRoute({ route: 'pools', counts, tasks: async () => [{ key: 'other', run: mongo }] })).toMatchObject({ pending: true });
    expect(budget.reserve).toHaveBeenCalled();
  });

  it('keep the data time an engine count carries (staleness flags)', async () => {
    const counts = new LeaderboardCountService();
    const old = Date.now() - 120_000;
    const out = await resolveCountRoute({ route: 'pools', counts, tasks: async () => [{ key: 'k', run: unmeteredCount(async () => ({ count: 1, capped: false, dataAt: old }) as never) }] });
    expect(out).toMatchObject({ total: 1, stale: true, dataAsOf: new Date(old).toISOString() });
  });
});

describe('TokensRepository exclusion identity', () => {
  it('keeps the published array while the content is unchanged (in any order), replaces it when it changes', async () => {
    const repo = new TokensRepository({} as never);
    let spam = ['0xa', '0xb'];
    let noMarket = ['0xc'];
    (repo as unknown as { findSpamAddresses: () => Promise<string[]> }).findSpamAddresses = async () => spam;
    (repo as unknown as { findNoRealMarketAddresses: () => Promise<string[]> }).findNoRealMarketAddresses = async () => noMarket;
    const load = (repo as unknown as { loadExclusions: (c: number) => Promise<{ addresses: string[] }> }).loadExclusions.bind(repo);
    const first = await load(1);
    spam = ['0xb', '0xa'];
    noMarket = ['0xc', '0xa'];
    expect((await load(1)).addresses).toBe(first.addresses);
    noMarket = ['0xd'];
    const third = await load(1);
    expect(third.addresses).not.toBe(first.addresses);
    expect(third.addresses.sort()).toEqual(['0xa', '0xb', '0xd']);
  });
});

describe('PoolsRepository.findRowsByPoolIds', () => {
  function repoWith(command: (cmd: Record<string, unknown>, opts: unknown) => Promise<unknown>, rows: unknown[] = [{ poolId: 'plain' }]) {
    const find = vi.fn(() => ({ read: () => ({ maxTimeMS: () => ({ lean: async () => rows }) }) }));
    const model = { find, db: { db: { command: vi.fn(command) } }, collection: { collectionName: '1_uniswap_v4_pools' } };
    return { repo: new PoolsRepository({ poolModel: () => model } as never, {} as never), model, find };
  }

  it('reads at the clusterTime with a raw snapshot find (single batch, user read preference)', async () => {
    const { repo, model, find } = repoWith(async () => ({ cursor: { firstBatch: [{ poolId: 'at-ct' }], id: 0 } }));
    const rows = await repo.findRowsByPoolIds(1, PROTO, ['a', 'b'], { atClusterTime: { t: 100, i: 3 } });
    expect(rows).toEqual([{ poolId: 'at-ct' }]);
    expect(find).not.toHaveBeenCalled();
    const [cmd] = model.db.db.command.mock.calls[0]! as [Record<string, unknown>];
    expect(cmd).toMatchObject({ find: '1_uniswap_v4_pools', filter: { chainId: 1, protocol: PROTO, poolId: { $in: ['a', 'b'] } }, singleBatch: true, batchSize: 3 });
    expect((cmd.readConcern as { level: string; atClusterTime: { high: number; low: number } }).level).toBe('snapshot');
    expect((cmd.readConcern as { atClusterTime: { high: number; low: number } }).atClusterTime).toMatchObject({ high: 100, low: 3 });
  });

  it('falls back to a plain read when the server cannot read at that time (too old, ahead, unsupported)', async () => {
    for (const error of [Object.assign(new Error('x'), { code: 239, codeName: 'SnapshotTooOld' }), Object.assign(new Error('atClusterTime must not be greater'), { code: 72 })]) {
      const { repo, find } = repoWith(async () => {
        throw error;
      });
      const meta: { snapshotFallback?: boolean } = {};
      expect(await repo.findRowsByPoolIds(1, PROTO, ['a'], { atClusterTime: { t: 1, i: 1 }, meta })).toEqual([{ poolId: 'plain' }]);
      expect(find).toHaveBeenCalledTimes(1);
      expect(meta.snapshotFallback).toBe(true);
    }
    const { repo } = repoWith(async () => {
      throw Object.assign(new Error('boom'), { code: 6 });
    });
    await expect(repo.findRowsByPoolIds(1, PROTO, ['a'], { atClusterTime: { t: 1, i: 1 } })).rejects.toThrow('boom');
  });
});

describe('shared memory and quarantine', () => {
  it('the dictionary is readable from shared memory, and stays valid for its old ids after a growth', () => {
    const dict = new Dictionary(16, 1024);
    dict.intern('first');
    const before = dict.sharedView();
    for (let i = 0; i < 5_000; i++) dict.intern(`entry-${i}`);
    expect(SHARED_MEMORY ? before.bytes.buffer instanceof SharedArrayBuffer : true).toBe(true);
    expect(new TextDecoder().decode(before.bytes.subarray(before.offsets[0], before.offsets[1]))).toBe('first');
    expect(dict.sharedView().size).toBe(5_001);
  });

  it('a poolId outside the BMP quarantines the shard’s poolId (UTF-8 vs UTF-16 order would differ)', async () => {
    const shards = shardsFor(21, { 1: 20, 42161: 20, 4663: 40 });
    shards.get(42161)![0]!.poolId = '0x🍏';
    const store = buildStore(shards);
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config);
    expect(catalog.catalog!.current!.shards.get(shardKey(42161, PROTO))!.cols.poolIdQuarantine).toBe(1);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    await engine.getTopPools({ chainId: 42161, protocol: PROTO, sort: 'tvl', page: 1, limit: 20, minTvlUsd: 0, includeRisky: true } as never);
    await engine.getTopPools({ chainId: 1, protocol: PROTO, sort: 'tvl', page: 1, limit: 20, minTvlUsd: 0, includeRisky: true } as never);
    const requests = catalog.status().requests as { served: number; fallback: Record<string, number> };
    expect(requests.served).toBe(1);
    expect(requests.fallback).toMatchObject({ 'quarantine:2': 1 });
  });
});

describe('wiring (an @Optional dependency fails silently)', () => {
  it('PoolsModule imports ReadModelsModule, which provides and exports the catalog', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, PoolsModule)).toContain(ReadModelsModule);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ReadModelsModule)).toContain(PoolCatalogService);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, ReadModelsModule)).toContain(PoolCatalogService);
  });

  it('PoolsService takes the catalog, then (R3) the rank engine, as its appended optional parameters (specs construct it positionally)', () => {
    const deps = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, PoolsService) ?? []) as Array<{ index: number; param: unknown }>;
    const dep = deps.find((d) => d.param === PoolCatalogService);
    expect(dep).toBeDefined();
    expect(dep!.index).toBe(PoolsService.length - 2);
    expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, PoolsService)).toContain(dep!.index);
    const rank = deps.find((d) => d.param === RankEngineService);
    expect(rank).toBeDefined();
    expect(rank!.index).toBe(PoolsService.length - 1);
    expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, PoolsService)).toContain(rank!.index);
  });
});

describe('dependency injection', () => {
  it('Nest builds PoolsService with the catalog, and the catalog serves through it', async () => {
    const shards = shardsFor(22, { 1: 20, 42161: 20, 4663: 40 });
    const store = buildStore(shards);
    const config = makeConfig();
    const { repo } = poolsRepo(shards, config);
    @Module({
      providers: [
        PoolsService,
        PoolCatalogService,
        LeaderboardCountService,
        { provide: AppConfigService, useValue: config },
        { provide: ReadModelsService, useValue: fakeReadModels(store, CHAINS) },
        { provide: PoolsRepository, useValue: repo },
        { provide: PositionsRepository, useValue: positionsFake },
        { provide: TokensRepository, useValue: tokensFake },
      ],
    })
    class ProbeModule {}
    const app = await NestFactory.createApplicationContext(ProbeModule, { logger: false });
    try {
      const catalog = app.get(PoolCatalogService);
      await catalog.tick();
      const out = await app.get(PoolsService).getTopPools({ chainId: 4663, protocol: PROTO, sort: 'tvl', page: 1, limit: 5, minTvlUsd: 0, includeRisky: true } as never);
      expect(out.pools).toHaveLength(5);
      expect((catalog.status().requests as { served: number }).served).toBe(1);
    } finally {
      await app.close();
    }
  });
});
