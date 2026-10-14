/*
 * The detail-view fee re-read depends on Nest wiring that nothing else checks.
 *
 * `LeaderboardService` takes `PositionFeeRefreshService` as an @Optional
 * constructor parameter, so if `LeaderboardModule` stopped importing
 * `SyncModule` (or `SyncModule` stopped exporting the service) Nest would
 * inject `undefined` with no boot error, and opening a position would silently
 * stop queueing its fee re-read. Same for the backfill lane in `SyncService`.
 * Pinned here from the decorator metadata.
 */
import 'reflect-metadata';
import { MODULE_METADATA, OPTIONAL_DEPS_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { LeaderboardModule } from '../src/leaderboard/leaderboard.module.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ReadModelsModule } from '../src/read-models/read-models.module.js';
import { RankEngineService } from '../src/read-models/rank/rank-engine.service.js';
import { PositionFeeRefreshService } from '../src/sync/position-fee-refresh.service.js';
import { SyncModule } from '../src/sync/sync.module.js';
import { SYNC_FLOW_LOCKS, SyncService } from '../src/sync/sync.service.js';
import { SyncRepository } from '../src/database/sync.repository.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { PoolsRepository } from '../src/database/pools.repository.js';
import { TokensRepository } from '../src/database/token.repository.js';
import { CoordinationModule } from '../src/common/coordination.module.js';
import { FlowLocks } from '../src/common/flow-lock.js';

function injected(target: unknown): Array<{ index: number; param: unknown }> {
  return (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target as object) ?? []) as Array<{ index: number; param: unknown }>;
}

describe('fee refresh wiring', () => {
  it('LeaderboardModule imports SyncModule, which exports PositionFeeRefreshService', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, LeaderboardModule)).toContain(SyncModule);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, SyncModule)).toContain(PositionFeeRefreshService);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SyncModule)).toContain(PositionFeeRefreshService);
  });

  it('LeaderboardService and SyncService ask for it as an appended, optional parameter (at its fixed position)', () => {
    // LeaderboardService: the fee refresh, then (P-R R3) the rank engine, appended after it.
    // SyncService: the fee refresh at index 7, then (P2.5) the fleet flow locks appended after it.
    for (const [svc, index] of [
      [LeaderboardService, 6],
      [SyncService, 7],
    ] as const) {
      const fee = injected(svc).find((d) => d.param === PositionFeeRefreshService);
      expect(fee, svc.name).toBeDefined();
      expect(fee!.index).toBe(index);
      expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, svc)).toContain(fee!.index);
    }
  });

  it('SyncService takes the fleet flow locks (SYNC_FLOW_LOCKS) as its LAST, optional parameter, bound by the global CoordinationModule', () => {
    const locks = injected(SyncService).find((d) => d.param === SYNC_FLOW_LOCKS);
    expect(locks).toBeDefined();
    expect(locks!.index).toBe(SyncService.length - 1);
    expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, SyncService)).toContain(locks!.index);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CoordinationModule) as Array<{ provide?: unknown; useExisting?: unknown }>;
    expect(providers.find((p) => p?.provide === SYNC_FLOW_LOCKS)?.useExisting).toBe(FlowLocks);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, CoordinationModule)).toContain(SYNC_FLOW_LOCKS);
  });
});

describe('rank engine wiring (P-R R3)', () => {
  it('LeaderboardService takes the rank engine as its 8th, optional parameter (specs construct it positionally)', () => {
    const rank = injected(LeaderboardService).find((d) => d.param === RankEngineService);
    expect(rank).toBeDefined();
    expect(rank!.index).toBe(7);
    expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, LeaderboardService)).toContain(rank!.index);
  });

  it('LeaderboardService takes SyncRepository (the P2.3 overlay\'s lastCleanRefreshAt) as its 9th, optional parameter', () => {
    const repo = injected(LeaderboardService).find((d) => d.param === SyncRepository);
    expect(repo).toBeDefined();
    expect(repo!.index).toBe(8);
    expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, LeaderboardService)).toContain(repo!.index);
  });

  // Without the repository Nest injects `undefined` with no boot error, and every
  // position row would silently lose `hooks` / `customAccounting`.
  it('LeaderboardService takes PoolsRepository (the rows\' pool hook, 2026-10-06) as its 10th, optional parameter, from the global DatabaseModule', () => {
    const pools = injected(LeaderboardService).find((d) => d.param === PoolsRepository);
    expect(pools).toBeDefined();
    expect(pools!.index).toBe(9);
    expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, LeaderboardService)).toContain(pools!.index);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DatabaseModule)).toContain(PoolsRepository);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, DatabaseModule)).toContain(PoolsRepository);
  });

  it('LeaderboardService takes TokensRepository (the per-row risk flags\' exclusion set, 2026-10-06) as its LAST, optional parameter', () => {
    const tokens = injected(LeaderboardService).find((d) => d.param === TokensRepository);
    expect(tokens).toBeDefined();
    expect(tokens!.index).toBe(LeaderboardService.length - 1);
    expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, LeaderboardService)).toContain(tokens!.index);
  });

  it('LeaderboardModule imports ReadModelsModule, which provides and exports RankEngineService', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, LeaderboardModule)).toContain(ReadModelsModule);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ReadModelsModule)).toContain(RankEngineService);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, ReadModelsModule)).toContain(RankEngineService);
  });
});
