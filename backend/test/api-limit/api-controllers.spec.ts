/*
 * What binds the budget to the right routes and the page cap to the right
 * place: the three keyless controllers carry the guards in the right order and a
 * price on every handler, the paid /v1 controllers carry neither, and `limit`
 * is 25 on /api while /v1 (which shares the DTO) still takes 100.
 */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ChartsController } from '../../src/charts/charts.controller.js';
import { ANON_COST_METADATA, API_MAX_PAGE_LIMIT } from '../../src/common/api-cost.js';
import { assertApiPageLimit } from '../../src/common/api-page-limit.js';
import { ApiRateLimitGuard } from '../../src/common/api-rate-limit.guard.js';
import { FirstPartyOriginGuard } from '../../src/common/first-party-origin.guard.js';
import { TopPositionsQueryDto } from '../../src/leaderboard/dto/top-positions-query.dto.js';
import { LeaderboardController } from '../../src/leaderboard/leaderboard.controller.js';
import { TopPoolsQueryDto } from '../../src/pools/dto/top-pools-query.dto.js';
import { PoolsController } from '../../src/pools/pools.controller.js';
import { V1PoolsController } from '../../src/v1/v1-pools.controller.js';
import { V1PositionsController } from '../../src/v1/v1-positions.controller.js';

const guardsOf = (controller: unknown): unknown[] => Reflect.getMetadata('__guards__', controller as object) ?? [];
const handlers = (controller: { prototype: object }): Array<[string, (...args: never[]) => unknown]> =>
  Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => [name, (controller.prototype as Record<string, (...args: never[]) => unknown>)[name]!]);

describe('the keyless /api controllers', () => {
  const keyless = [LeaderboardController, PoolsController, ChartsController];

  it('apply the origin check first and the budget second', () => {
    for (const controller of keyless) {
      expect(guardsOf(controller), controller.name).toEqual([FirstPartyOriginGuard, ApiRateLimitGuard]);
    }
  });

  it('name a price on EVERY handler, so a new route is never left out of the budget by accident', () => {
    for (const controller of keyless) {
      const list = handlers(controller);
      expect(list.length, controller.name).toBeGreaterThan(0);
      for (const [name, handler] of list) {
        expect(Reflect.getMetadata(ANON_COST_METADATA, handler), `${controller.name}.${name}`).toBeTypeOf('string');
      }
    }
  });

  it('price each route by what it does', () => {
    const kind = (controller: { prototype: object }, name: string) =>
      Reflect.getMetadata(ANON_COST_METADATA, (controller.prototype as Record<string, object>)[name]!);
    expect(kind(LeaderboardController, 'getTopPositions')).toBe('list');
    expect(kind(LeaderboardController, 'getTopPositionsCount')).toBe('count');
    expect(kind(LeaderboardController, 'getPosition')).toBe('detail');
    expect(kind(PoolsController, 'getTopPools')).toBe('list');
    expect(kind(PoolsController, 'getTopPoolsCount')).toBe('count');
    expect(kind(PoolsController, 'getPool')).toBe('detail');
    expect(kind(PoolsController, 'getPoolCharts')).toBe('chart');
    expect(kind(ChartsController, 'getCharts')).toBe('chart');
  });
});

describe('the paid /v1 controllers', () => {
  it('never carry the anonymous budget or its prices: /v1 is metered per key and must not meet a limit meant for scripts', () => {
    for (const controller of [V1PositionsController, V1PoolsController]) {
      expect(guardsOf(controller), controller.name).not.toContain(ApiRateLimitGuard);
      expect(guardsOf(controller), controller.name).not.toContain(FirstPartyOriginGuard);
      for (const [name, handler] of handlers(controller)) {
        expect(Reflect.getMetadata(ANON_COST_METADATA, handler), `${controller.name}.${name}`).toBeUndefined();
      }
    }
  });
});

describe('the page-size cap', () => {
  const res = { setHeader: () => undefined };
  const services = {
    getTopPositions: async () => ({ rows: [] }),
    getTopPools: async () => ({ rows: [] }),
  };

  it('is 25: the dashboards ask for exactly that and never more', () => {
    expect(API_MAX_PAGE_LIMIT).toBe(25);
  });

  it('refuses limit 26 on both keyless lists with a 400 that points at /v1, and serves 25', async () => {
    const positions = new LeaderboardController(services as never);
    const pools = new PoolsController(services as never, {} as never);
    expect(() => positions.getTopPositions({ limit: 26 } as never, res)).toThrow(BadRequestException);
    // A Nest exception's `.message` is generic ("Bad Request Exception"); what a script reads is the body.
    let body: { error?: string; max?: number } = {};
    try {
      positions.getTopPositions({ limit: '26' } as never, res);
    } catch (err) {
      body = (err as BadRequestException).getResponse() as typeof body;
    }
    expect(body.error).toMatch(/\/v1/);
    expect(body.max).toBe(25);
    expect(() => pools.getTopPools({ limit: 100 } as never, res)).toThrow(BadRequestException);
    await expect(positions.getTopPositions({ limit: 25 } as never, res)).resolves.toBeDefined();
    await expect(positions.getTopPositions({} as never, res)).resolves.toBeDefined();
    await expect(pools.getTopPools({ limit: '25' } as never, res)).resolves.toBeDefined();
  });

  it('reads the raw query: a string, an array, a missing value, garbage', () => {
    expect(() => assertApiPageLimit({ limit: '26' })).toThrow(BadRequestException);
    expect(() => assertApiPageLimit({ limit: ['5', '99'] })).toThrow(BadRequestException);
    for (const ok of [{}, { limit: undefined }, { limit: '25' }, { limit: 1 }, { limit: 'abc' }, { limit: { $gt: '1' } }, { limit: [] }]) {
      expect(() => assertApiPageLimit(ok as never), JSON.stringify(ok)).not.toThrow();
    }
    expect(() => assertApiPageLimit(undefined)).not.toThrow();
  });

  it('leaves the shared DTO alone: /v1 still accepts 100 and refuses 101', () => {
    const errors = (limit: number) => validateSync(plainToInstance(TopPositionsQueryDto, { limit }));
    expect(errors(100)).toEqual([]);
    expect(errors(101).map((e) => e.property)).toContain('limit');
    const poolErrors = (limit: number) => validateSync(plainToInstance(TopPoolsQueryDto, { limit }));
    expect(poolErrors(100)).toEqual([]);
    expect(poolErrors(101).map((e) => e.property)).toContain('limit');
  });
});

describe('the chart route', () => {
  it('refuses a position id that is not a token id before any lookup', () => {
    const charts = new ChartsController({ getPositionCharts: async () => ({}) } as never);
    const res = { setHeader: () => undefined };
    for (const bad of ['abc', '12a', '', '1 2', '0x12', '../1', '1'.repeat(31), '12345;DROP']) {
      expect(() => charts.getCharts(1, 'uniswap-v4', bad, res)).toThrow(BadRequestException);
    }
    for (const good of ['1', '926', '389046', '1'.repeat(30)]) {
      expect(() => charts.getCharts(1, 'uniswap-v4', good, res), good).not.toThrow();
    }
  });
});
