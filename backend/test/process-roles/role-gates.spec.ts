import { afterEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('graphql-request', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({ request: requestMock })),
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

import { roleGateMiddleware, workerRoleAllows, WORKER_ALLOWED_PATHS } from '../../src/common/role-gate.middleware.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { leaseKey } from '../../src/common/coordination-redis.js';
import { resetLeaseRunnersForTests } from '../../src/common/lease-runner.js';
import { resetShutdownForTests } from '../../src/common/shutdown.js';
import { HealthController } from '../../src/health/health.controller.js';
import { IndexingStatusService } from '../../src/health/indexing-status.service.js';
import { LiveEventListenerService, liveLeaseName } from '../../src/sync/live-event-listener.service.js';
import { LeaderboardWarmupService } from '../../src/leaderboard/leaderboard-warmup.service.js';
import { LeaderboardCountService } from '../../src/leaderboard/count-cache.js';
import { PoolsSyncService } from '../../src/sync/pools-sync.service.js';
import { TokenPriceSyncService } from '../../src/sync/token-price-sync.service.js';
import { TokenSecuritySyncService } from '../../src/sync/token-security-sync.service.js';
import { TreasurySubmitterService } from '../../src/payments/providers/x402/treasury-submitter.service.js';
import { Eip3009DomainService } from '../../src/payments/providers/x402/eip3009-domain.service.js';
import { FakeLeaseRedis, ManualClock, flush } from './fakes.js';

afterEach(() => {
  resetProcessRoleForTests();
  resetLeaseRunnersForTests();
  resetShutdownForTests();
  requestMock.mockReset();
});

function gate(role: Parameters<typeof roleGateMiddleware>[0], method: string, url: string) {
  const next = vi.fn();
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  roleGateMiddleware(role)({ method, url, originalUrl: url }, { status }, next);
  return { next, status, json };
}

describe('roleGateMiddleware (design §2.1 HTTP gating)', () => {
  it.each(['all', 'api'] as const)('%s passes every request through untouched', (role) => {
    for (const url of ['/api/top-positions', '/v1/positions', '/admin/sync/status', '/account/me', '/webhooks/payments/radom', '/health']) {
      for (const method of ['GET', 'POST']) {
        const { next, status } = gate(role, method, url);
        expect(next).toHaveBeenCalledTimes(1);
        expect(status).not.toHaveBeenCalled();
      }
    }
  });

  it.each(['sync', 'fee', 'feeder'] as const)('%s answers only GET|HEAD /health and /health/live; everything else is a bare 404', (role) => {
    for (const url of ['/health', '/health/live', '/health?x=1', '/health/live/']) {
      expect(gate(role, 'GET', url).next).toHaveBeenCalled();
      expect(gate(role, 'HEAD', url).next).toHaveBeenCalled();
    }
    for (const [method, url] of [
      ['GET', '/api/top-positions'],
      ['GET', '/v1/positions'],
      ['GET', '/health/ready'],
      ['POST', '/health'],
      ['POST', '/webhooks/payments/radom'],
      ['GET', '/admin/sync/status'],
      ['GET', '/healthz'],
      ['GET', '/'],
    ]) {
      const { next, status, json } = gate(role, method!, url!);
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({ statusCode: 404, message: 'Not Found' });
    }
  });

  it('defaults to this process\'s role (all → pass-through, sync → gate)', () => {
    expect(gate(undefined, 'GET', '/api/x').next).toHaveBeenCalled();
    configureProcessRole({ processRole: 'sync' });
    expect(gate(undefined, 'GET', '/api/x').next).not.toHaveBeenCalled();
  });

  it('allowlist is exactly /health and /health/live', () => {
    expect(WORKER_ALLOWED_PATHS).toEqual(['/health', '/health/live']);
    expect(workerRoleAllows('get', '/health')).toBe(true);
    expect(workerRoleAllows('DELETE', '/health')).toBe(false);
  });
});

describe('/health and /health/live per role', () => {
  function controller() {
    const status = { getStatus: vi.fn(async () => ({ indexedBlock: 1 })) };
    const cfg = { enabledIntegrations: [{ chainId: 1, protocol: 'uniswap-v4', enabled: true }] };
    return { c: new HealthController(cfg as never, status as never), status };
  }

  it('all: full /health with indexer status (unchanged)', async () => {
    const { c, status } = controller();
    const body = (await c.health()) as { integrations: unknown[]; status: string };
    expect(status.getStatus).toHaveBeenCalledTimes(1);
    expect(body.status).toBe('ok');
    expect(body.integrations).toHaveLength(1);
  });

  it.each(['sync', 'fee', 'feeder'] as const)('%s: /health is liveness + role + leases, no indexer probe', async (role) => {
    configureProcessRole({ processRole: role });
    const { c, status } = controller();
    const body = await c.health();
    expect(status.getStatus).not.toHaveBeenCalled();
    expect(body).toMatchObject({ ok: true, status: 'ok', role, leases: { enabled: true, held: [] } });
  });

  it('/health/live answers in every role with no I/O', () => {
    for (const role of ['all', 'api', 'sync', 'fee', 'feeder'] as const) {
      configureProcessRole({ processRole: role });
      const { c, status } = controller();
      expect(c.live()).toMatchObject({ ok: true, status: 'ok', role });
      expect(status.getStatus).not.toHaveBeenCalled();
    }
  });

  it('IndexingStatusService warms at boot only in all/api', () => {
    for (const [role, warms] of [['all', true], ['api', true], ['sync', false], ['fee', false]] as const) {
      configureProcessRole({ processRole: role });
      const svc = new IndexingStatusService({ enabledIntegrations: [{ chainId: 1, protocol: 'p' }] } as never);
      const spy = vi.spyOn(svc, 'getStatus').mockResolvedValue({} as never);
      svc.onModuleInit();
      expect(spy.mock.calls.length > 0).toBe(warms);
    }
  });
});

describe('LiveEventListenerService × role / leases', () => {
  const integration = { chainId: 1, protocol: 'uniswap-v4', subgraphUrl: 'https://indexer.test/v1/graphql', dialect: 'hyperindex', enabled: true };
  function make(redis?: FakeLeaseRedis) {
    const syncRepo = { getCursor: vi.fn(async () => ({ liveBlockNumber: 100 })), markLiveCursor: vi.fn(async () => undefined) };
    const svc = new LiveEventListenerService(
      { liveRefreshEnabled: true, livePollMinMs: 50, livePollIntervalFallbackMs: 50, enabledIntegrations: [integration] } as never,
      syncRepo as never,
      { resolve: () => ({ recomputeMode: 'aggregates' }) } as never,
      undefined,
      (redis ? { client: async () => redis, namespace: 'spec' } : undefined) as never,
    );
    svc.registerEnqueue(vi.fn(async () => undefined));
    return { svc, syncRepo };
  }

  it.each(['api', 'fee', 'feeder'] as const)('%s never starts a poll loop', async (role) => {
    configureProcessRole({ processRole: role });
    const { svc, syncRepo } = make(new FakeLeaseRedis(Date.now));
    await svc.onModuleInit();
    await flush();
    expect(syncRepo.getCursor).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('sync with leases: the loop runs only under lease live:<chain>:<protocol>', async () => {
    configureProcessRole({ processRole: 'sync' });
    requestMock.mockResolvedValue({ positions: [] });
    const redis = new FakeLeaseRedis(Date.now);
    const { svc, syncRepo } = make(redis);
    await svc.onModuleInit();
    await flush();
    expect(redis.kv.get(leaseKey('spec', liveLeaseName(1, 'uniswap-v4')))).toBeDefined();
    expect(syncRepo.getCursor).toHaveBeenCalledTimes(1);
    await svc.onModuleDestroy();
    expect(redis.kv.get(leaseKey('spec', 'live:1:uniswap-v4'))).toBeUndefined();
  });

  it('sync: a deposed holder stops polling before its next poll (lease stolen → loop exits)', async () => {
    vi.useFakeTimers();
    try {
      configureProcessRole({ processRole: 'sync' });
      requestMock.mockResolvedValue({ positions: [] });
      const redis = new FakeLeaseRedis(Date.now);
      const { svc } = make(redis);
      await svc.onModuleInit();
      await vi.advanceTimersByTimeAsync(2_000);
      const polling = requestMock.mock.calls.length;
      expect(polling).toBeGreaterThan(0);
      redis.steal(leaseKey('spec', 'live:1:uniswap-v4'), 'new-holder', 600_000);
      await vi.advanceTimersByTimeAsync(10_000); // the next renew answers CAS-lost
      const atLoss = requestMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(requestMock.mock.calls.length).toBe(atLoss);
      await svc.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sync with the live lease held elsewhere: no loop here', async () => {
    configureProcessRole({ processRole: 'sync' });
    const redis = new FakeLeaseRedis(Date.now);
    redis.steal(leaseKey('spec', 'live:1:uniswap-v4'), 'other', 600_000);
    const { svc, syncRepo } = make(redis);
    await svc.onModuleInit();
    await flush();
    expect(syncRepo.getCursor).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('all + leases off (default): today\'s loop, no Redis', async () => {
    requestMock.mockResolvedValue({ positions: [] });
    const redis = new FakeLeaseRedis(Date.now);
    const { svc, syncRepo } = make(redis);
    await svc.onModuleInit();
    await flush();
    expect(syncRepo.getCursor).toHaveBeenCalledTimes(1);
    expect(redis.calls).toEqual([]);
    await svc.onModuleDestroy();
  });
});

describe('LeaderboardWarmupService × role', () => {
  it.each([['all', true], ['api', true], ['sync', false], ['fee', false], ['feeder', false]] as const)('%s starts the warm timer: %s', (role, starts) => {
    configureProcessRole({ processRole: role });
    const svc = new LeaderboardWarmupService(
      { leaderboardWarmupEnabled: true, leaderboardSnapshotRedisEnabled: false, leaderboardWarmupIntervalMs: 60_000, enabledIntegrations: [] } as never,
      {} as never,
      new LeaderboardCountService(),
    );
    const spy = vi.spyOn(svc, 'runCycle').mockResolvedValue(null);
    svc.onApplicationBootstrap();
    expect((svc as unknown as { timer?: unknown }).timer !== undefined).toBe(starts);
    svc.onModuleDestroy();
    spy.mockRestore();
  });
});

describe('sweeps × fleet flow locks', () => {
  const heldLocks = { run: vi.fn(async () => ({ held: true as const })) };
  const passLocks = { run: vi.fn(async (_n: string, fn: () => Promise<unknown>) => ({ held: false as const, value: await fn() })) };

  it('pool sync held elsewhere → skipped (0/0), the walk never starts, and the next scheduled tick is not suppressed', async () => {
    const config = { getIntegration: vi.fn(() => undefined), poolsSyncIntervalMs: 3_600_000 };
    let held = true;
    const locks = {
      run: vi.fn(async (_n: string, fn: () => Promise<unknown>) => (held ? { held: true as const } : { held: false as const, value: await fn() })),
    };
    const svc = new PoolsSyncService(config as never, {} as never, {} as never, undefined, locks as never);
    expect(await svc.syncPools(1, 'uniswap-v4')).toEqual({ upserted: 0, skipped: 0 });
    expect(locks.run).toHaveBeenCalledWith('flow:pool-sync:1:uniswap-v4', expect.any(Function));
    expect(config.getIntegration).not.toHaveBeenCalled();
    // Not recorded as a finished walk: a SCHEDULED run right after is not skipped as "recently walked".
    held = false;
    await svc.syncPools(1, 'uniswap-v4', { scheduled: true });
    expect(config.getIntegration).toHaveBeenCalledTimes(1);
  });

  it('token-price sweep held elsewhere → {priced: 0}, nothing read', async () => {
    const positions = { distinctActiveTokenAddresses: vi.fn() };
    const svc = new TokenPriceSyncService({} as never, positions as never, {} as never, heldLocks as never);
    expect(await svc.syncChain(1, 'p')).toEqual({ priced: 0 });
    expect(positions.distinctActiveTokenAddresses).not.toHaveBeenCalled();
    expect(heldLocks.run).toHaveBeenCalledWith('flow:token-price:1:p', expect.any(Function));
  });

  it('token-security sweep held elsewhere → {checked: 0}', async () => {
    const svc = new TokenSecuritySyncService({ tokenSecurityScope: 'active' } as never, {} as never, undefined, heldLocks as never);
    expect(await svc.syncChain(1, { chainId: 1, protocol: 'uniswap-v4' } as never)).toEqual({ checked: 0 });
    expect(heldLocks.run).toHaveBeenCalledWith('flow:token-security:1:uniswap-v4', expect.any(Function));
  });
});

describe('x402 relayer lock (leases on only)', () => {
  const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  function submitter(redis?: FakeLeaseRedis, clock?: ManualClock) {
    const svc = new TreasurySubmitterService(
      { x402SubmitterPrivateKey: PK, evmRpcUrls: new Map([[8453, 'https://rpc.test']]) } as never,
      (redis ? { client: async () => redis, namespace: 'spec' } : undefined) as never,
      clock,
    );
    svc.onModuleInit();
    const rpc = {
      transactionCount: vi.fn(async () => 7),
      gasPrice: vi.fn(async () => 1_000_000_000n),
      sendRawTransaction: vi.fn(async () => '0xhash'),
    };
    (svc as unknown as { clients: Map<number, unknown> }).clients.set(8453, rpc);
    return { svc, rpc };
  }
  const args = { chainId: 8453, tokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', calldata: '0x' as const, gas: 60_000n };

  it('leases off: relays unlocked, Redis untouched', async () => {
    const redis = new FakeLeaseRedis(Date.now);
    const { svc } = submitter(redis);
    expect(await svc.relay(args)).toBe('0xhash');
    expect(redis.calls).toEqual([]);
  });

  it('leases on: takes relayer:<address>, releases after the send', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new FakeLeaseRedis(Date.now);
    const { svc, rpc } = submitter(redis);
    const key = leaseKey('spec', `relayer:${svc.address!.toLowerCase()}`);
    rpc.sendRawTransaction.mockImplementation(async () => {
      expect(redis.kv.get(key)).toBeDefined();
      return '0xhash';
    });
    expect(await svc.relay(args)).toBe('0xhash');
    expect(redis.kv.get(key)).toBeUndefined();
  });

  it('leases on, lock held elsewhere for > 10 s: a retryable error, nothing signed or sent', async () => {
    configureProcessRole({ processRole: 'api' });
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const { svc, rpc } = submitter(redis, clock);
    redis.steal(leaseKey('spec', `relayer:${svc.address!.toLowerCase()}`), 'other-api', 600_000);
    const pending = svc.relay(args);
    const settled = pending.then(() => 'ok', (e: Error) => e.message);
    await clock.advance(10_500, 250);
    expect(await settled).toMatch(/relayer busy/);
    expect(rpc.transactionCount).not.toHaveBeenCalled();
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('leases on, lock freed within the wait: the relay proceeds', async () => {
    configureProcessRole({ processRole: 'api' });
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const { svc } = submitter(redis, clock);
    redis.steal(leaseKey('spec', `relayer:${svc.address!.toLowerCase()}`), 'other-api', 2_000);
    const pending = svc.relay(args);
    await clock.advance(3_000, 250);
    expect(await pending).toBe('0xhash');
  });

  it('leases on, Redis unavailable: fail-open (relays unlocked)', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new FakeLeaseRedis(Date.now);
    redis.failing = true;
    const { svc } = submitter(redis);
    expect(await svc.relay(args)).toBe('0xhash');
  });
});

describe('Eip3009DomainService boot verification × role', () => {
  it.each([['all', true], ['api', true], ['sync', true], ['fee', false], ['feeder', false]] as const)('%s verifies at boot: %s', async (role, verifies) => {
    configureProcessRole({ processRole: role });
    const svc = new Eip3009DomainService({ x402PaymentsConfigured: true, acceptedPaymentTokens: [{ symbol: 'USDC', chainId: 8453 }], acceptedTokensAreDerived: true } as never);
    const spy = vi.spyOn(svc, 'resolve').mockResolvedValue({} as never);
    await svc.onModuleInit();
    expect(spy.mock.calls.length > 0).toBe(verifies);
  });
});
