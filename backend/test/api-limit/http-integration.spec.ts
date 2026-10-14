/*
 * The budget through a REAL Nest + Express stack on a real socket, because four
 * things the unit specs cannot show matter here:
 *  - Nest builds the guard with the real `Reflector` and the shared service;
 *  - the 429 reaches the client WITH the CORS headers (the guard runs after the
 *    CORS middleware, so the browser can read it instead of seeing a CORS error);
 *  - a client that aborts mid-request still pays;
 *  - `req.ip` behind `trust proxy` is the address the proxy appended, whatever
 *    the client forged before it (what TRUST_PROXY_HOPS=1 relies on).
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Inject, Module, Res, UseGuards, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnonCost } from '../../src/common/api-cost.js';
import { ApiLimitService } from '../../src/common/api-limit.service.js';
import { ApiRateLimitGuard } from '../../src/common/api-rate-limit.guard.js';
import { FirstPartyOriginGuard } from '../../src/common/first-party-origin.guard.js';
import { AppConfigService } from '../../src/config/app-config.service.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Controller('api/t')
@UseGuards(FirstPartyOriginGuard, ApiRateLimitGuard)
class KeylessController {
  @Get('hit')
  @AnonCost('list')
  hit(@Res({ passthrough: true }) res: { setHeader(n: string, v: string): void }) {
    res.setHeader('X-Cache', 'hit');
    return { ok: true };
  }

  @Get('miss')
  @AnonCost('list')
  miss() {
    return { ok: true };
  }

  @Get('slow')
  @AnonCost('list')
  async slow() {
    await sleep(300);
    return { ok: true };
  }
}

/** The paid side: no guard of ours, like /v1. */
@Controller('v1/t')
class PaidController {
  @Get()
  ok() {
    return { paid: true };
  }
}

const settings = {
  apiLimitMode: 'enforce',
  apiLimiterStore: 'memory',
  apiLimitPoints10s: 9,
  apiLimitPointsHour: 1_000_000,
  apiLimitMaxInFlight: 24,
  apiLimitCountMissPerMin: 3,
  apiReadShare: 1,
  isProduction: false,
  trustProxyHops: 1,
  corsOrigins: ['https://tickwise.xyz'],
};

@Module({
  controllers: [KeylessController, PaidController],
  providers: [
    { provide: AppConfigService, useValue: settings },
    ApiLimitService,
    ApiRateLimitGuard,
    FirstPartyOriginGuard,
  ],
})
class TestModule {}

let app: INestApplication;
let base = '';

beforeAll(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  // The same order as main.ts: trust proxy, then CORS, then the routes (and their guards).
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.enableCors({ origin: ['https://tickwise.xyz'], credentials: true });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
});

const get = (path: string, ip: string, extra: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers: { origin: 'https://tickwise.xyz', 'x-forwarded-for': ip, ...extra } });

describe('the budget over HTTP', () => {
  it('lets a visitor through, then refuses with a 429 a script can read AND a browser is allowed to see', async () => {
    const ip = '198.51.100.10';
    // Three misses at 3 points fill a window of 9.
    for (let i = 0; i < 3; i += 1) expect((await get('/api/t/miss', ip)).status).toBe(200);
    const refused = await get('/api/t/miss', ip);
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error: string; reason: string };
    expect(body.error).toMatch(/\/v1/);
    expect(body.reason).toBe('rate-10s');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(refused.headers.get('cache-control')).toBe('no-store');
    expect(refused.headers.get('ratelimit-limit')).toBe('9');
    // The browser can only read this if the CORS headers are on the 429 itself.
    expect(refused.headers.get('access-control-allow-origin')).toBe('https://tickwise.xyz');
    expect(refused.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('budgets each client address apart, as the proxy reports it', async () => {
    for (let i = 0; i < 3; i += 1) await get('/api/t/miss', '198.51.100.20');
    expect((await get('/api/t/miss', '198.51.100.20')).status).toBe(429);
    expect((await get('/api/t/miss', '198.51.100.21')).status).toBe(200);
  });

  it('is not fooled by addresses the client forged BEFORE the proxy appended the real one (TRUST_PROXY_HOPS=1)', async () => {
    const real = '198.51.100.30';
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await get('/api/t/miss', `203.0.113.${i}, ${real}`)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('gives the surcharge back for a cache hit, so cached pages go much further', async () => {
    const ip = '198.51.100.40';
    // A hit nets 1 point but is charged 3 up front: seven fit in a window of 9
    // (the seventh is admitted at 6 + 3), where misses would stop at three.
    for (let i = 0; i < 7; i += 1) {
      expect((await get('/api/t/hit', ip)).status, `hit ${i + 1}`).toBe(200);
      await sleep(15); // the refund runs on the response's `close`
    }
    expect((await get('/api/t/hit', ip)).status).toBe(429);
  });

  it('keeps the charge of a request the client gave up on', async () => {
    const ip = '198.51.100.50';
    for (let i = 0; i < 3; i += 1) {
      const controller = new AbortController();
      const aborted = fetch(`${base}/api/t/slow`, {
        headers: { origin: 'https://tickwise.xyz', 'x-forwarded-for': ip },
        signal: controller.signal,
      }).catch(() => 'aborted');
      await sleep(30);
      controller.abort();
      expect(await aborted).toBe('aborted');
    }
    await sleep(400); // let the slow handlers finish and every connection close
    expect((await get('/api/t/miss', ip)).status).toBe(429);
  });

  it('never touches the paid route', async () => {
    for (let i = 0; i < 30; i += 1) expect((await get('/v1/t', '198.51.100.60')).status).toBe(200);
  });
});
