/*
 * The real `CommonModule` wiring: two feature modules that import it (the way
 * leaderboard, charts and pools do) and apply the guard by class must share ONE
 * `ApiLimitService`. If the budget's state lived in the guard, Nest would build
 * one guard per module and each module would have its own budget.
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Global, Module, UseGuards, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnonCost } from '../../src/common/api-cost.js';
import { ApiRateLimitGuard } from '../../src/common/api-rate-limit.guard.js';
import { CommonModule } from '../../src/common/common.module.js';
import { FirstPartyOriginGuard } from '../../src/common/first-party-origin.guard.js';
import { AppConfigService } from '../../src/config/app-config.service.js';

@Controller('api/a')
@UseGuards(FirstPartyOriginGuard, ApiRateLimitGuard)
class AController {
  @Get()
  @AnonCost('list')
  get() {
    return { module: 'a' };
  }
}

@Controller('api/b')
@UseGuards(FirstPartyOriginGuard, ApiRateLimitGuard)
class BController {
  @Get()
  @AnonCost('list')
  get() {
    return { module: 'b' };
  }
}

@Module({ imports: [CommonModule], controllers: [AController] })
class FeatureA {}
@Module({ imports: [CommonModule], controllers: [BController] })
class FeatureB {}

/** What the real app gets from its global AppConfigModule. */
@Global()
@Module({
  providers: [
    {
      provide: AppConfigService,
      useValue: {
        apiLimitMode: 'enforce',
        apiLimiterStore: 'memory',
        apiLimitPoints10s: 6,
        apiLimitPointsHour: 1_000_000,
        apiLimitMaxInFlight: 24,
        apiLimitCountMissPerMin: 3,
        apiReadShare: 1,
        isProduction: false,
        trustProxyHops: 1,
        corsOrigins: [],
        clientIpEcho: true,
      },
    },
  ],
  exports: [AppConfigService],
})
class FakeConfigModule {}

@Module({ imports: [FakeConfigModule, FeatureA, FeatureB] })
class Root {}

let app: INestApplication;
let base = '';

beforeAll(async () => {
  app = await NestFactory.create(Root, { logger: false });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
});

const get = (path: string, ip: string) => fetch(`${base}${path}`, { headers: { 'x-forwarded-for': ip } });

describe('CommonModule', () => {
  it('gives every module that imports it the SAME budget: a client spends it across routes in different modules', async () => {
    const ip = '198.51.100.80';
    expect((await get('/api/a', ip)).status).toBe(200); // 3 of 6
    expect((await get('/api/b', ip)).status).toBe(200); // 6 of 6, charged to the same address
    expect((await get('/api/a', ip)).status).toBe(429);
    expect((await get('/api/b', ip)).status).toBe(429);
    expect((await get('/api/b', '198.51.100.81')).status).toBe(200); // another address, untouched
  });

  it('serves /diag/client-ip once, from CommonModule, whatever number of modules import it', async () => {
    const res = await get('/diag/client-ip', '198.51.100.90');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ip: '198.51.100.90', limiterKey: '198.51.100.90', trustProxyHops: 1 });
  });
});
