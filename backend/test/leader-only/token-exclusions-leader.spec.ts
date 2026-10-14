/*
 * TokensRepository's exclusion set as a leader-only poller (capacity plan step
 * 1). Leases on: ONE process scans {chainId}_tokens and publishes; every other
 * replica adopts the published copy and scans only when it is missing, stale
 * beyond 3 intervals, or Redis is unreachable. Leases off: today, no Redis.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokensRepository, EXCLUSION_REFRESH_MS, EXCLUSION_SNAPSHOT_MAX_AGE_MS } from '../../src/database/token.repository.js';
import {
  decodeExclusionSnapshot,
  exclusionBlobKey,
  exclusionMetaKey,
  parseExclusionMeta,
  publishExclusionSnapshot,
} from '../../src/database/exclusion-snapshot.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { resetLeaseRunnersForTests } from '../../src/common/lease-runner.js';
import { resetShutdownForTests } from '../../src/common/shutdown.js';
import { leaseKey } from '../../src/common/coordination-redis.js';
import { LeaderRedis, coordinationOf, flush } from './fakes.js';

const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const C = '0x' + 'cc'.repeat(20);

const repos: TokensRepository[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) repo.onModuleDestroy();
  resetProcessRoleForTests();
  resetLeaseRunnersForTests();
  resetShutdownForTests();
  vi.restoreAllMocks();
});

function makeRepo(redis: LeaderRedis | undefined, spam: string[] = [A, B]) {
  const state = { spam, fail: false };
  const model = {
    find: vi.fn((filter: Record<string, unknown>) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.read = () => chain;
      chain.maxTimeMS = () => chain;
      chain.lean = async () => {
        if (state.fail) throw new Error('mongo down');
        return JSON.stringify(filter).includes('isHoneypot') ? state.spam.map((address) => ({ address, isHoneypot: true })) : [];
      };
      return chain;
    }),
  };
  const config = { enabledIntegrations: [{ chainId: 1, protocol: 'uniswap-v4' }] };
  const repo = new TokensRepository(
    { tokenModel: () => model } as never,
    config as never,
    (redis ? coordinationOf(redis) : undefined) as never,
  );
  repos.push(repo);
  return { repo, model, state };
}

const refresh = (repo: TokensRepository) =>
  (repo as unknown as { refreshAllExclusions(): Promise<void> }).refreshAllExclusions();

/** Another process holds the `exclusions` lease (this one can only follow). */
function heldElsewhere(redis: LeaderRedis) {
  redis.steal(leaseKey('spec', 'exclusions'), 'other-process', 10 * 60_000);
}

async function seed(redis: LeaderRedis, addresses: string[], builtAt = Date.now()) {
  return publishExclusionSnapshot(redis as never, 'spec', 1, addresses, builtAt, 210_000);
}

describe('exclusion set — leases OFF (PROCESS_ROLE=all default)', () => {
  it('scans locally on the 60 s timer and touches no Redis key', async () => {
    const redis = new LeaderRedis();
    const { repo, model } = makeRepo(redis);
    repo.onModuleInit();
    expect((await repo.readyLeaderboardExclusions(1)).addresses.sort()).toEqual([A, B]);
    expect(model.find).toHaveBeenCalled();
    expect(redis.calls).toEqual([]);
    expect(redis.kv.size).toBe(0);
  });
});

describe('exclusion set — leases ON', () => {
  it('the holder scans and publishes a decodable set', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    const { repo, model } = makeRepo(redis);
    repo.onModuleInit();
    await vi.waitFor(async () => {
      expect(parseExclusionMeta(await redis.get(exclusionMetaKey('spec', 1)), 1)).toBeDefined();
    });
    expect(model.find).toHaveBeenCalled();
    const blob = decodeExclusionSnapshot(await redis.getBuffer(exclusionBlobKey('spec', 1)), 1);
    expect(blob?.addresses.sort()).toEqual([A, B]);
    expect(redis.kv.get(exclusionMetaKey('spec', 1))?.exp).toBeGreaterThan(Date.now() + 2 * EXCLUSION_REFRESH_MS); // TTL > 2 intervals
  });

  it('a follower adopts the published set without scanning Mongo, and keeps the object while it is unchanged', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    heldElsewhere(redis);
    await seed(redis, [A, C]);
    const { repo, model } = makeRepo(redis);
    repo.onModuleInit();
    const first = await repo.readyLeaderboardExclusions(1); // first-build-waits, served from Redis
    expect(first).toEqual({ addresses: expect.arrayContaining([A, C]), ok: true });
    expect(model.find).not.toHaveBeenCalled();

    redis.calls.length = 0;
    await seed(redis, [C, A]); // same content, new builtAt
    redis.calls.length = 0;
    await refresh(repo);
    expect(redis.calls).toEqual(['get']); // the small meta only — no blob fetch
    expect(repo.leaderboardExclusions(1)).toBe(first); // identity = content version (read models)
    expect(model.find).not.toHaveBeenCalled();
  });

  it('a follower picks up a changed set', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    heldElsewhere(redis);
    await seed(redis, [A]);
    const { repo, model } = makeRepo(redis);
    repo.onModuleInit();
    expect((await repo.readyLeaderboardExclusions(1)).addresses).toEqual([A]);
    await seed(redis, [A, B, C]);
    await refresh(repo);
    expect(repo.leaderboardExclusions(1)?.addresses.sort()).toEqual([A, B, C]);
    expect(model.find).not.toHaveBeenCalled();
  });

  it('a follower rebuilds locally when the published copy is missing — and does not publish it', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    heldElsewhere(redis);
    const { repo, model } = makeRepo(redis);
    repo.onModuleInit();
    expect((await repo.readyLeaderboardExclusions(1)).addresses.sort()).toEqual([A, B]);
    expect(model.find).toHaveBeenCalled();
    await flush();
    expect(await redis.get(exclusionMetaKey('spec', 1))).toBeNull();
  });

  it('a follower rebuilds locally once the published copy is older than 3 intervals', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    heldElsewhere(redis);
    await seed(redis, [C], Date.now() - EXCLUSION_SNAPSHOT_MAX_AGE_MS - 1_000);
    const { repo, model } = makeRepo(redis);
    repo.onModuleInit();
    expect((await repo.readyLeaderboardExclusions(1)).addresses.sort()).toEqual([A, B]);
    expect(model.find).toHaveBeenCalled();
  });

  it('a copy just inside the 3-interval bound is still adopted', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    heldElsewhere(redis);
    await seed(redis, [C], Date.now() - EXCLUSION_SNAPSHOT_MAX_AGE_MS + 5_000);
    const { repo, model } = makeRepo(redis);
    repo.onModuleInit();
    expect((await repo.readyLeaderboardExclusions(1)).addresses).toEqual([C]);
    expect(model.find).not.toHaveBeenCalled();
  });

  it('a follower rebuilds locally while Redis is unreachable, keeping the last good set on a failed scan', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    heldElsewhere(redis);
    await seed(redis, [C]);
    const { repo, model, state } = makeRepo(redis);
    repo.onModuleInit();
    const first = await repo.readyLeaderboardExclusions(1);
    expect(first.addresses).toEqual([C]);

    redis.failing = true;
    await refresh(repo);
    expect(model.find).toHaveBeenCalled();
    expect(repo.leaderboardExclusions(1)?.addresses.sort()).toEqual([A, B]);

    state.fail = true;
    await refresh(repo);
    expect(repo.leaderboardExclusions(1)).toEqual({ addresses: expect.arrayContaining([A, B]), ok: true });
  });

  it('refuses a blob whose content does not match its meta', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    heldElsewhere(redis);
    await seed(redis, [C]);
    const meta = JSON.parse(String(await redis.get(exclusionMetaKey('spec', 1))));
    await redis.set(exclusionMetaKey('spec', 1), JSON.stringify({ ...meta, hash: 'deadbeefdeadbeef' }), 'PX', 60_000);
    const { repo, model } = makeRepo(redis);
    const warn = vi.spyOn((repo as unknown as { logger: { warn(msg: string): void } }).logger, 'warn').mockImplementation(() => undefined);
    repo.onModuleInit();
    expect((await repo.readyLeaderboardExclusions(1)).addresses.sort()).toEqual([A, B]);
    expect(model.find).toHaveBeenCalled();
    // Said once a minute, not silently — and not on every follower tick.
    await refresh(repo);
    await refresh(repo);
    const alerts = warn.mock.calls.filter(([msg]) => String(msg).includes('[alert] exclusions.snapshot_mismatch'));
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0]![0])).toContain('meta=deadbeefdeadbeef');
  });

  it('a holder whose stale belief matches its content still rewrites a pair another publisher replaced', async () => {
    // The review case at the repository level: this process (the holder) last
    // published [A, B]; another publisher replaced the pair with [C]; the
    // holder's next cycle (same content [A, B]) must REWRITE, not extend [C].
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    const { repo } = makeRepo(redis);
    repo.onModuleInit();
    await vi.waitFor(async () => {
      expect(parseExclusionMeta(await redis.get(exclusionMetaKey('spec', 1)), 1)).toBeDefined();
    });
    await seed(redis, [C]);
    await refresh(repo);
    const meta = parseExclusionMeta(await redis.get(exclusionMetaKey('spec', 1)), 1);
    const blob = decodeExclusionSnapshot(await redis.getBuffer(exclusionBlobKey('spec', 1)), 1);
    expect(blob?.addresses.sort()).toEqual([A, B]);
    expect(blob?.hash).toBe(meta?.hash);
  });
});
