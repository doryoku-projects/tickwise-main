import { describe, expect, it, vi } from 'vitest';
import { TokenPriceSyncService } from '../src/sync/token-price-sync.service.js';

/** A sweep run as `PricingService.startConsensusSweep` returns it (no lookup possible unless a batch says so). */
const newRun = () => ({ pairLookups: { verdictLeft: 0, servedLeft: 0, sent: 0, denied: 0 }, lookupsPossible: false });

function makeService(addresses: string[]) {
  const prefetched: string[][] = [];
  const config = {
    enabledIntegrations: [{ chainId: 1, protocol: 'uniswap-v4' }],
  };
  const positions = { distinctActiveTokenAddresses: vi.fn(async () => addresses) };
  const pricing = {
    startConsensusSweep: vi.fn(newRun),
    prefetchConsensus: vi.fn(async (_chainId: number, batch: Array<string>) => { prefetched.push(batch as string[]); }),
  };
  const svc = new TokenPriceSyncService(config as never, positions as never, pricing as never);
  return { svc, positions, pricing, prefetched };
}

describe('TokenPriceSyncService', () => {
  it('feeds the active-token universe to prefetchPrices', async () => {
    const addrs = Array.from({ length: 1200 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    const { svc, positions, pricing, prefetched } = makeService(addrs);
    const r = await svc.syncChain(1, 'uniswap-v4');
    expect(positions.distinctActiveTokenAddresses).toHaveBeenCalledWith(1, 'uniswap-v4');
    expect(pricing.prefetchConsensus).toHaveBeenCalled();
    // All addresses fed across the batches (BATCH=500 → 3 batches for 1200).
    expect(prefetched.flat().length).toBe(1200);
    expect(r.priced).toBe(1200);
    // ONE run for the whole sweep, told its size (the budget is spread over
    // it), the same object handed to every batch.
    expect(pricing.startConsensusSweep).toHaveBeenCalledTimes(1);
    expect(pricing.startConsensusSweep).toHaveBeenCalledWith({ tokens: 1200 });
    const run = pricing.startConsensusSweep.mock.results[0]!.value;
    expect(pricing.prefetchConsensus.mock.calls.map((c) => (c as unknown[])[2])).toEqual([run, run, run]);
  });

  it('returns immediately when a sweep is already in flight (frees the worker slot)', async () => {
    const { svc, positions } = makeService(['0xabc']);
    // Second call must NOT await the in-flight sweep — stacked cron jobs each
    // awaiting the shared promise held BullMQ slots and starved the queue.
    const [a, b] = await Promise.all([svc.syncChain(1, 'uniswap-v4'), svc.syncChain(1, 'uniswap-v4')]);
    expect(positions.distinctActiveTokenAddresses).toHaveBeenCalledTimes(1);
    expect([a.priced, b.priced].sort()).toEqual([0, 1]); // one real run, one no-op
  });

  it('sweep line: trust=earned/verdicts unknown=N quoteGuard{…}, and no suffix when nothing was computed', async () => {
    const line = async (stats: Array<Record<string, number>>, lookups?: number[], denied?: number[]) => {
      const config = { enabledIntegrations: [{ chainId: 1, protocol: 'uniswap-v4' }] };
      const addrs = Array.from({ length: stats.length * 500 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
      const positions = { distinctActiveTokenAddresses: vi.fn(async () => addrs) };
      let n = 0;
      const pricing = {
        startConsensusSweep: vi.fn(newRun),
        // A batch that could look pairs up marks the run and adds what it sent.
        prefetchConsensus: vi.fn(async (_c: number, _b: string[], run: ReturnType<typeof newRun>) => {
          if (lookups) {
            run.lookupsPossible = true;
            run.pairLookups.sent += lookups[n] ?? 0;
            run.pairLookups.denied += denied?.[n] ?? 0;
          }
          return stats[n++];
        }),
      };
      const svc = new TokenPriceSyncService(config as never, positions as never, pricing as never);
      const log = vi.spyOn((svc as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => {});
      await svc.syncChain(1, 'uniswap-v4');
      return String(log.mock.calls.at(-1)?.[0]);
    };
    const s = (v: number, e: number, u: number, r = 0, c = 0) => ({ trustVerdicts: v, trustEarned: e, trustUnknown: u, guardRejected: r, guardCleared: c });
    expect(await line([s(2, 1, 3, 1, 0), s(1, 0, 4, 0, 1)])).toMatch(
      / fed=1000\/1000 durationMs=\d+ trust=1\/3 unknown=7 quoteGuard\{rejected=1 cleared=1\}$/,
    );
    // Every verdict withheld still prints (that is the signal).
    expect(await line([s(0, 0, 5)])).toMatch(/ trust=0\/0 unknown=5 quoteGuard\{rejected=0 cleared=0\}$/);
    expect(await line([s(0, 0, 0)])).toMatch(/ fed=500\/500 durationMs=\d+$/);
    // pairLookups=<sent this run> pairDenied=<refused by the shared rate / a
    // benched DexScreener>, appended after every field: each one before them
    // is byte-identical.
    expect(await line([s(2, 1, 3, 1, 0), s(1, 0, 4, 0, 1)], [7, 5], [3, 0])).toMatch(
      /^Token-price sweep 1:uniswap-v4 fed=1000\/1000 durationMs=\d+ trust=1\/3 unknown=7 quoteGuard\{rejected=1 cleared=1\} pairLookups=12 pairDenied=3$/,
    );
    // A run that could look up and sent nothing says so (the 0 is the signal);
    // the trust suffix keeps its own rule.
    expect(await line([s(0, 0, 0)], [0])).toMatch(/^Token-price sweep 1:uniswap-v4 fed=500\/500 durationMs=\d+ pairLookups=0 pairDenied=0$/);
    // …and pairDenied says WHY: every lookup refused (the rate drained by
    // other chains' sweeps, or DexScreener benched) is not a quiet run.
    expect(await line([s(0, 0, 0)], [0], [9])).toMatch(/ pairLookups=0 pairDenied=9$/);
  });

  it('degrades gracefully if reading active tokens fails', async () => {
    const config = { enabledIntegrations: [{ chainId: 1, protocol: 'uniswap-v4' }] };
    const positions = { distinctActiveTokenAddresses: vi.fn(async () => { throw new Error('mongo down'); }) };
    const pricing = { startConsensusSweep: vi.fn(newRun), prefetchConsensus: vi.fn() };
    const svc = new TokenPriceSyncService(config as never, positions as never, pricing as never);
    const r = await svc.syncChain(1, 'uniswap-v4');
    expect(r.priced).toBe(0);
    expect(pricing.prefetchConsensus).not.toHaveBeenCalled();
  });
});
