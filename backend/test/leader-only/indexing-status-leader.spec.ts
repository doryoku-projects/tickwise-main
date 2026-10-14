/*
 * IndexingStatusService:
 *  (1) the chain-head probe (DeFiLlama `coins.llama.fi/block/...`) — prod showed
 *      `chainHeadBlock: null` on every chain while pricing hit 429s on the same
 *      host. One retry on 429 / 5xx / transport errors inside the 10 s leash,
 *      and a failed probe is ESTIMATED from the last good head
 *      (lastGood + elapsed / blockTimeMs, `chainHeadEstimated: true`) for up to
 *      15 min — never an RPC call;
 *  (2) leases on: ONE process probes and publishes; the others read its result
 *      from Redis and probe locally only when it is missing / stale / unreachable.
 */
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../src/config/app-config.service.js';
import type { IntegrationConfig } from '../../src/config/integrations.config.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { resetLeaseRunnersForTests } from '../../src/common/lease-runner.js';
import { resetShutdownForTests } from '../../src/common/shutdown.js';
import { leaseKey } from '../../src/common/coordination-redis.js';
import { LeaderRedis, coordinationOf } from './fakes.js';

let gqlCalls = 0;
let indexedBlock: number | 'fail' = 100;

vi.mock('graphql-request', () => ({
  gql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), ''),
  GraphQLClient: class {
    async request<T>(): Promise<T> {
      gqlCalls++;
      if (indexedBlock === 'fail') throw new Error('indexer 504');
      return { _meta: { block: { number: indexedBlock } } } as T;
    }
  },
}));

const { IndexingStatusService, LLAMA_CHAIN_SLUG, indexingStatusSnapshotKey } = await import(
  '../../src/health/indexing-status.service.js'
);

function integrationFor(chainId: number): IntegrationConfig {
  return {
    chainId,
    protocol: 'uniswap-v4',
    enabled: true,
    dialect: 'hyperindex',
    subgraphUrl: 'https://indexer.example/v1/graphql',
  } as IntegrationConfig;
}
const eth = integrationFor(1);

function config(integrations: IntegrationConfig[] = [eth]): AppConfigService {
  return { indexerMaxLagBlocks: 250, enabledIntegrations: integrations } as unknown as AppConfigService;
}

type HeadAnswer = number | { status: number; retryAfter?: string } | 'throw';

/** DeFiLlama answers, in order; the last one repeats. */
function stubHead(answers: HeadAnswer[]) {
  let i = 0;
  const fn = vi.fn(async (url: string | URL) => {
    if (!String(url).includes('coins.llama.fi/block/')) throw new Error(`unexpected fetch ${url}`);
    const answer = answers[Math.min(i++, answers.length - 1)]!;
    if (answer === 'throw') throw new Error('socket hang up');
    if (typeof answer === 'number') {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ height: answer }) } as Response;
    }
    const headers = new Headers(answer.retryAfter !== undefined ? { 'retry-after': answer.retryAfter } : {});
    return { ok: false, status: answer.status, headers, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

let warn: ReturnType<typeof vi.spyOn>;
const services: Array<{ onModuleDestroy(): void }> = [];

beforeEach(() => {
  gqlCalls = 0;
  indexedBlock = 100;
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const svc of services.splice(0)) svc.onModuleDestroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetProcessRoleForTests();
  resetLeaseRunnersForTests();
  resetShutdownForTests();
});

function make(cfg = config(), redis?: LeaderRedis) {
  const svc = new IndexingStatusService(cfg, (redis ? coordinationOf(redis) : undefined) as never);
  services.push(svc);
  return svc;
}

describe('chain head — retry', () => {
  it('retries a 429 once (honouring Retry-After) and reports the live head', async () => {
    const fn = stubHead([{ status: 429, retryAfter: '0' }, 150]);
    const s = await make().getStatus(eth);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(s.chainHeadBlock).toBe(150);
    expect(s.chainHeadEstimated).toBe(false);
    expect(s.lagBlocks).toBe(50);
  });

  it('retries a 5xx and a transport error, but not a 4xx answer', async () => {
    let fn = stubHead([{ status: 503, retryAfter: '0' }, 150]);
    expect((await make().getStatus(eth)).chainHeadBlock).toBe(150);
    expect(fn).toHaveBeenCalledTimes(2);

    fn = stubHead([{ status: 400 }, 150]);
    expect((await make().getStatus(eth)).chainHeadBlock).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a thrown fetch (jittered delay) and reports the second answer', async () => {
    const fn = stubHead(['throw', 160]);
    const s = await make().getStatus(eth);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(s.chainHeadBlock).toBe(160);
  });

  it('two failures with nothing to estimate from → null, not estimated (as before)', async () => {
    stubHead([{ status: 429, retryAfter: '0' }]);
    const s = await make().getStatus(eth);
    expect(s.chainHeadBlock).toBeNull();
    expect(s.chainHeadEstimated).toBe(false);
    expect(s.lagBlocks).toBeNull();
    expect(s.status).toBe('healthy'); // indexed block shown alone, unchanged rule
  });

  it('never retries past the 10 s leash: a 503 at 9 s is not retried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 9_000));
      return { ok: false, status: 503, headers: new Headers(), json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fn);
    let done = false;
    void make().getStatus(eth).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(10_100);
    expect(done).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('chain head — estimate from the last good head', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
  });

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  async function refreshed(svc: InstanceType<typeof IndexingStatusService>, advanceMs: number) {
    await vi.advanceTimersByTimeAsync(advanceMs);
    await svc.getStatus(eth); // stale → background refresh
    await vi.advanceTimersByTimeAsync(5_000); // any retry delay
    await flush();
    return svc.getStatus(eth);
  }

  it('a failed probe reports lastGood + elapsed / blockTime, flagged estimated', async () => {
    stubHead([1_000]);
    const svc = make();
    expect((await svc.getStatus(eth)).chainHeadBlock).toBe(1_000);

    stubHead([{ status: 429, retryAfter: '0' }]);
    const s = await refreshed(svc, 120_000); // the probe runs at +120 s → 10 mainnet blocks
    expect(s.chainHeadEstimated).toBe(true);
    expect(s.chainHeadBlock).toBe(1_010);
    expect(s.lagBlocks).toBe(910);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('chain-head probe failed'))).toHaveLength(1);
  });

  it('an estimated head leaves indexedUpToTimestamp null (the /v1/stats indexedTo source carries no flag)', async () => {
    stubHead([1_000]);
    const svc = make();
    const live = await svc.getStatus(eth);
    expect(live.indexedUpToTimestamp).not.toBeNull();

    stubHead([{ status: 429, retryAfter: '0' }]);
    const est = await refreshed(svc, 120_000);
    expect(est.chainHeadEstimated).toBe(true);
    expect(est.lagSeconds).not.toBeNull(); // /health still shows the flagged lag
    expect(est.indexedUpToTimestamp).toBeNull(); // as before the estimate existed

    stubHead([1_200]);
    const back = await refreshed(svc, 61_000);
    expect(back.chainHeadEstimated).toBe(false);
    expect(back.indexedUpToTimestamp).not.toBeNull();
  });

  it('stops estimating 15 min after the last good head', async () => {
    stubHead([1_000]);
    const svc = make();
    await svc.getStatus(eth);
    stubHead([{ status: 400 }]);
    expect((await refreshed(svc, 14 * 60_000)).chainHeadEstimated).toBe(true);
    const past = await refreshed(svc, 2 * 60_000);
    expect(past.chainHeadBlock).toBeNull();
    expect(past.chainHeadEstimated).toBe(false);
  });

  it('a live reading replaces the estimate', async () => {
    stubHead([1_000]);
    const svc = make();
    await svc.getStatus(eth);
    stubHead([{ status: 400 }]);
    expect((await refreshed(svc, 61_000)).chainHeadEstimated).toBe(true);
    stubHead([1_200]);
    const s = await refreshed(svc, 61_000);
    expect(s).toMatchObject({ chainHeadBlock: 1_200, chainHeadEstimated: false });
  });

  it('a chain with no block time is never estimated', async () => {
    LLAMA_CHAIN_SLUG[137] = 'polygon';
    try {
      const poly = integrationFor(137);
      stubHead([1_000]);
      const svc = make(config([poly]));
      await svc.getStatus(poly);
      stubHead([{ status: 400 }]);
      await vi.advanceTimersByTimeAsync(61_000);
      await svc.getStatus(poly);
      await flush();
      const s = await svc.getStatus(poly);
      expect(s.chainHeadBlock).toBeNull();
      expect(s.chainHeadEstimated).toBe(false);
    } finally {
      delete LLAMA_CHAIN_SLUG[137];
    }
  });
});

describe('indexing status — leases', () => {
  const avax = integrationFor(43114);

  it('leases off: probes locally and writes no Redis key', async () => {
    const redis = new LeaderRedis();
    stubHead([150]);
    const svc = make(config(), redis);
    svc.onModuleInit();
    await vi.waitFor(() => expect(gqlCalls).toBe(1));
    expect(redis.calls).toEqual([]);
  });

  it('the holder probes and publishes every integration', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    stubHead([150]);
    const svc = make(config([eth, avax]), redis);
    svc.onModuleInit();
    await vi.waitFor(async () => {
      const raw = await redis.get(indexingStatusSnapshotKey('spec'));
      expect(raw).not.toBeNull();
      const body = JSON.parse(String(raw));
      expect(Object.keys(body.entries)).toHaveLength(2);
    });
    const body = JSON.parse(String(await redis.get(indexingStatusSnapshotKey('spec'))));
    const entry = body.entries[`1:${eth.subgraphUrl}`];
    expect(entry.value).toMatchObject({ indexedBlock: 100, chainHeadBlock: 150, chainHeadEstimated: false });
    expect(entry.lastHead.value).toBe(150);
  });

  function publish(redis: LeaderRedis, entries: Record<string, unknown>) {
    return redis.set(indexingStatusSnapshotKey('spec'), JSON.stringify({ v: 1, at: Date.now(), entries }), 'PX', 210_000);
  }
  const value = (over: Record<string, unknown> = {}) => ({
    indexedBlock: 900,
    indexedUpToTimestamp: 1,
    chainHeadBlock: 950,
    chainHeadEstimated: false,
    lagBlocks: 50,
    lagSeconds: 600,
    synced: true,
    status: 'healthy',
    ...over,
  });

  it('a follower serves the published result with no indexer or DeFiLlama call — one GET for every integration', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    redis.steal(leaseKey('spec', 'indexing-status'), 'other', 10 * 60_000);
    await publish(redis, {
      [`1:${eth.subgraphUrl}`]: { value: value(), fetchedAt: Date.now() - 5_000 },
      [`43114:${avax.subgraphUrl}`]: { value: value({ indexedBlock: 7 }), fetchedAt: Date.now() - 5_000 },
    });
    const fn = stubHead([150]);
    const svc = make(config([eth, avax]), redis);
    svc.onModuleInit();
    const [a, b] = await Promise.all([svc.getStatus(eth), svc.getStatus(avax)]);
    expect(a.indexedBlock).toBe(900);
    expect(b.indexedBlock).toBe(7);
    expect(gqlCalls).toBe(0);
    expect(fn).not.toHaveBeenCalled();
    expect(redis.calls.filter((c) => c === 'get')).toHaveLength(1);
  });

  it('a follower probes locally when the published result is older than 3 TTLs', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    redis.steal(leaseKey('spec', 'indexing-status'), 'other', 10 * 60_000);
    await publish(redis, { [`1:${eth.subgraphUrl}`]: { value: value(), fetchedAt: Date.now() - 181_000 } });
    stubHead([150]);
    const svc = make(config(), redis);
    const s = await (svc.onModuleInit(), svc.getStatus(eth));
    expect(s.indexedBlock).toBe(100);
    expect(gqlCalls).toBeGreaterThan(0);
  });

  it('a follower probes locally when Redis is unreachable, estimating from the leader\'s adopted last head', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    redis.steal(leaseKey('spec', 'indexing-status'), 'other', 10 * 60_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    const now = Date.now();
    await publish(redis, {
      [`1:${eth.subgraphUrl}`]: { value: value(), fetchedAt: now - 5_000, lastHead: { value: 2_000, at: now - 5_000 } },
    });
    stubHead([{ status: 400 }]);
    const svc = make(config(), redis);
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect((await svc.getStatus(eth)).indexedBlock).toBe(900); // adopted

    redis.failing = true;
    await vi.advanceTimersByTimeAsync(120_000);
    await svc.getStatus(eth); // stale → local probe (Redis down)
    await vi.advanceTimersByTimeAsync(5_000);
    await new Promise<void>((r) => setImmediate(r));
    const s = await svc.getStatus(eth);
    expect(s.indexedBlock).toBe(100); // probed locally
    expect(s.chainHeadEstimated).toBe(true);
    expect(s.chainHeadBlock).toBe(2_000 + Math.floor(130_000 / 12_000));
  });
});
