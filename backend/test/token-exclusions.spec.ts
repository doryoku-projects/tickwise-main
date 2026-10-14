import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXCLUSION_REFRESH_MS,
  EXCLUSION_SCAN_MAX_TIME_MS,
  TokensRepository,
} from '../src/database/token.repository.js';

/**
 * A tokens model whose two leaderboard scans are told apart by their filter
 * (`$or` with `isHoneypot` = spam; `dexActive` = no-real-market). Returns the
 * rows the test set, or throws when asked to.
 */
function makeRepo(opts: { spam?: string[]; noMarket?: string[]; fail?: boolean; chains?: number[] } = {}) {
  const finds: Array<Record<string, unknown>> = [];
  const reads: Array<{ read?: unknown; maxTimeMS?: unknown }> = [];
  const state = { spam: opts.spam ?? [], noMarket: opts.noMarket ?? [], fail: opts.fail ?? false };
  const model = {
    find: vi.fn((filter: Record<string, unknown>) => {
      finds.push(filter);
      const chain: Record<string, unknown> = {};
      const seen: { read?: unknown; maxTimeMS?: unknown } = {};
      reads.push(seen);
      chain.select = () => chain;
      chain.read = (pref: unknown) => ((seen.read = pref), chain);
      chain.maxTimeMS = (ms: unknown) => ((seen.maxTimeMS = ms), chain);
      chain.lean = async () => {
        if (state.fail) throw new Error('mongo down');
        const isSpam = JSON.stringify(filter).includes('isHoneypot');
        // Spam rows carry a hard flag (the scan decides in JS, `=== true`);
        // no-market rows must look "uncorroborated" to survive the in-memory filter.
        if (isSpam) return state.spam.map((address) => ({ address, isHoneypot: true }));
        return state.noMarket.map((address) => ({ address, priceSources: [], dexActive: false }));
      };
      return chain;
    }),
  };
  const config = opts.chains
    ? { enabledIntegrations: opts.chains.map((chainId) => ({ chainId, protocol: 'uniswap-v4' })) }
    : undefined;
  const repo = new TokensRepository({ tokenModel: () => model } as never, config as never);
  return { repo, finds, reads, state, model };
}

afterEach(() => vi.useRealTimers());

describe('leaderboard exclusion set (TokensRepository)', () => {
  it('both scans lead with chainId', async () => {
    const { repo, finds } = makeRepo();
    await repo.findSpamAddresses(43114);
    await repo.findNoRealMarketAddresses(43114);
    expect(finds).toHaveLength(2);
    for (const filter of finds) expect(filter.chainId).toBe(43114);
  });

  it('both scans read from a secondary with a server-side time limit', async () => {
    const { repo, reads } = makeRepo();
    await repo.findSpamAddresses(1);
    await repo.findNoRealMarketAddresses(1);
    expect(reads).toHaveLength(2);
    for (const r of reads) {
      expect((r.read as { mode?: string })?.mode).toBe('secondaryPreferred');
      expect(r.maxTimeMS).toBe(EXCLUSION_SCAN_MAX_TIME_MS);
    }
  });

  it('is ONE merged, de-duplicated set', async () => {
    const { repo } = makeRepo({ spam: ['0xa', '0xb'], noMarket: ['0xb', '0xc'] });
    const set = await repo.readyLeaderboardExclusions(1);
    expect(set.ok).toBe(true);
    expect([...set.addresses].sort()).toEqual(['0xa', '0xb', '0xc']);
  });

  it('reads synchronously once built — a request never re-scans', async () => {
    const { repo, model } = makeRepo({ spam: ['0xa'] });
    await repo.readyLeaderboardExclusions(1);
    const scans = model.find.mock.calls.length;
    expect(repo.leaderboardExclusions(1)?.addresses).toEqual(['0xa']);
    await repo.readyLeaderboardExclusions(1);
    expect(model.find.mock.calls.length).toBe(scans);
  });

  it('a first build that fails reads as an EMPTY, not-ok set (fail-open, uncacheable)', async () => {
    const { repo } = makeRepo({ fail: true });
    expect(await repo.readyLeaderboardExclusions(1)).toEqual({ addresses: [], ok: false });
  });

  it('is rebuilt on a background timer (EXCLUSION_REFRESH_MS), keeping the last good set on error', async () => {
    vi.useFakeTimers();
    const { repo, state } = makeRepo({ spam: ['0xa'], chains: [1] });
    repo.onModuleInit(); // warms without blocking boot…
    expect((await repo.readyLeaderboardExclusions(1)).addresses).toEqual(['0xa']); // …and a reader joins it

    state.spam = ['0xa', '0xz'];
    await vi.advanceTimersByTimeAsync(EXCLUSION_REFRESH_MS - 1_000);
    expect(repo.leaderboardExclusions(1)?.addresses).toEqual(['0xa']); // not rebuilt before the interval
    await vi.advanceTimersByTimeAsync(1_000);
    expect(repo.leaderboardExclusions(1)?.addresses.sort()).toEqual(['0xa', '0xz']);

    state.fail = true;
    await vi.advanceTimersByTimeAsync(EXCLUSION_REFRESH_MS);
    expect(repo.leaderboardExclusions(1)).toEqual({ addresses: ['0xa', '0xz'], ok: true });
    repo.onModuleDestroy();
  });
});
