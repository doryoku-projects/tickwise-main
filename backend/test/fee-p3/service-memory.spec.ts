/*
 * P3.3 pass over the RAM store (design §9.3): Mongo is touched only for rows
 * that changed — an unchanged re-read costs NO read and NO write, a stamp-only
 * write needs no read, and a row that needs its served fields rewritten (or is
 * marked `verify`) is read from the primary by id first. Own writes update RAM;
 * a chunk the guards partly refused marks its rows `verify`. A page the boot
 * load has not covered yet never ends the pass. A store that cannot load falls
 * back to today's Mongo pages. Drains refresh RAM from the docs they read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeeRefreshCandidate } from '../../src/database/positions.repository.js';
import type { FeeStoreSource } from '../../src/sync/fee-candidate-feed.js';
import { CHAIN, MIN, PROTO, docOf, flush, makeP3Harness, measured } from './service-harness.js';

const MEMORY = { positionFeeCandidates: 'memory' };

afterEach(() => {
  vi.useRealTimers();
});

async function loaded(h: ReturnType<typeof makeP3Harness>) {
  await h.service.feedLoop();
  await flush();
  expect(h.ramStore()?.complete).toBe(true);
}

describe('memory mode: a pass over the store', () => {
  it('unchanged rows: 0 Mongo page reads, 0 by-id reads, 0 writes — and the pass still finishes and saves its cursor', async () => {
    const h = makeP3Harness({ config: MEMORY });
    await loaded(h);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.all).toBe(5);
    expect(r.unchanged).toBe(5);
    expect(r.finished).toEqual(['all']);
    expect(h.positions.findFeeRefreshCandidates).not.toHaveBeenCalled();
    expect(h.positions.findFeeRefreshCandidatesByIds).not.toHaveBeenCalled();
    expect(h.positions.writeRpcFees).not.toHaveBeenCalled();
    expect(h.store.all.finishedAt).toBeInstanceOf(Date);
  });

  it('reads exactly the served + verify rows from the primary; stamp-only rows are written without a read', async () => {
    const rows: FeeRefreshCandidate[] = [
      measured('10'), // unchanged
      measured('11'), // verify (marked below)
      { ...measured('12'), stored: { ...measured('12').stored, metrics: { isPriceable: true, pendingFeesUsd: 5, feesSource: 'indexer' } } }, // served
      { ...measured('13'), rpc: { fees0: '1', fees1: '1', block: 900, at: new Date(Date.now() - MIN) } }, // stamp moved, served figure did not
    ];
    const h = makeP3Harness({ config: MEMORY, rows });
    await loaded(h);
    h.ramStore()!.markVerify('11');
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidatesByIds).toHaveBeenCalledTimes(1);
    expect(h.positions.findFeeRefreshCandidatesByIds.mock.calls[0]![2]).toEqual(['11', '12']);
    const written = h.written();
    expect(written.map((w) => w.positionId).sort()).toEqual(['12', '13']);
    expect(written.find((w) => w.positionId === '12')!.served).toBeDefined();
    expect(written.find((w) => w.positionId === '12')!.version).toEqual(new Date(1_000));
    expect(written.find((w) => w.positionId === '13')!.served).toBeUndefined();
    expect(r.unchanged).toBe(2);
    // RAM follows the writes: the new stamp, the served figure, verify cleared.
    const ram = h.ramStore()!;
    expect(ram.get('13')!.rpc!.block).toBe(1001); // its batch's own head (batch 2 of 2)
    expect(ram.get('12')!.feesSource).toBe('onchain');
    expect(ram.get('11')!.verify).toBeUndefined();
    expect((h.service.feeStatus().chains as Record<string, { servedHydrated: number }>)[`${CHAIN}:${PROTO}`]!.servedHydrated).toBe(2);
  });

  it('the served decision is re-made on the FRESH doc: RAM said served, the primary says already on-chain → no write', async () => {
    const fresh = measured('10');
    const h = makeP3Harness({ config: MEMORY, rows: [fresh] });
    await loaded(h);
    h.ramStore()!.upsert([{ ...h.ramStore()!.get('10')!, feesSource: 'indexer', updatedAtMs: 2_000 }]);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidatesByIds).toHaveBeenCalledTimes(1);
    expect(h.positions.writeRpcFees).not.toHaveBeenCalled();
    expect(r.unchanged).toBe(1);
  });

  it('a served row the primary no longer has (closed) is dropped from RAM, not written', async () => {
    const h = makeP3Harness({ config: MEMORY, rows: [measured('10')] });
    await loaded(h);
    h.ramStore()!.markVerify('10');
    h.rows.splice(0, 1);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.writeRpcFees).not.toHaveBeenCalled();
    expect(r.stale).toBe(1);
    expect(h.ramStore()!.get('10')).toBeUndefined();
  });

  it('a chunk the guards partly refused: its rows become verify (never a stamp RAM cannot vouch for)', async () => {
    const rows = ['10', '11'].map((id) => ({ ...measured(id), rpc: { fees0: '1', fees1: '1', block: 900, at: new Date(Date.now() - MIN) } }));
    const h = makeP3Harness({ config: MEMORY, rows });
    await loaded(h);
    h.setWriteAnswer((w) => ({ matched: w.length - 1, modified: w.length - 1 }));
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.ramStore()!.get('10')!.verify).toBe(true);
    expect(h.ramStore()!.get('11')!.verify).toBe(true);
    expect(h.ramStore()!.get('10')!.rpc!.block).toBe(900);
  });

  it('a page cut short by the boot load is NOT the end of the pass: the cursor advances, the next tick continues', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => measured(String(10 + i)));
    let release!: () => void;
    let pages = 0;
    const source: FeeStoreSource = {
      async walk(_c, _p, after, limit) {
        pages++;
        if (pages === 2) await new Promise<void>((r) => (release = r));
        return rows
          .filter((r) => !after || r.positionId > after)
          .slice(0, limit)
          .map(docOf);
      },
    };
    const h = makeP3Harness({ config: { ...MEMORY, positionFeeLoadDocsPerSec: 2 }, rows, source });
    await h.service.feedLoop();
    await flush();
    const first = await h.service.refreshChain(CHAIN, PROTO);
    expect(first.tiers.all).toBe(2);
    expect(first.finished).toEqual([]);
    expect(h.store.all.cursor).toBe('11');
    expect(h.store.all.finishedAt).toBeUndefined();
    await vi.waitFor(() => expect(pages).toBe(2), { timeout: 3_000 });
    release();
    await vi.waitFor(() => expect(h.ramStore()!.complete).toBe(true), { timeout: 5_000 });
    await flush();
    expect(h.ramStore()!.complete).toBe(true);
    (h.service as unknown as { lastStart: Map<string, number> }).lastStart.clear();
    const second = await h.service.refreshChain(CHAIN, PROTO);
    expect(second.tiers.all).toBe(4);
    expect(second.finished).toEqual(['all']);
    expect(h.positions.findFeeRefreshCandidates).not.toHaveBeenCalled();
  }, 10_000);

  it('a store whose load fails: the pass reads Mongo pages exactly as today', async () => {
    const source: FeeStoreSource = {
      walk: async () => {
        throw new Error('No suitable servers found');
      },
    };
    const h = makeP3Harness({ config: MEMORY, source });
    await h.service.feedLoop();
    await flush();
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidates).toHaveBeenCalled();
    expect(r.finished).toEqual(['all']);
    expect(h.warnings().some((w) => w.includes('[alert] fees.store_load_failed'))).toBe(true);
  });

  it('mongo mode (the default) never builds a store and reads Mongo pages', async () => {
    const h = makeP3Harness();
    await h.service.feedLoop();
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.ramStore()).toBeUndefined();
    expect(h.positions.findFeeRefreshCandidates).toHaveBeenCalled();
  });

  it('a drain refreshes RAM from the primary doc it read (a lost hint cannot keep RAM stale)', async () => {
    const rows = [measured('10'), measured('11')];
    const h = makeP3Harness({ config: { ...MEMORY, positionFeeFullIntervalMs: 360 * MIN }, rows, cursors: { all: { cursor: '', startedAt: new Date(Date.now() - MIN), finishedAt: new Date() } } });
    await loaded(h);
    rows[1] = { ...measured('11'), stored: { ...measured('11').stored, token0: { priceUsd: 9 } }, version: new Date(5_000) };
    h.service.markDirty(CHAIN, ['11'], PROTO, new Map([['11', 2000]]));
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.ramStore()!.get('11')!.price0).toBe(9);
  });

  it('writer hints (leases off) reach the store through the service', async () => {
    const h = makeP3Harness({ config: MEMORY });
    await loaded(h);
    h.service.applyHints(CHAIN, PROTO, [{ positionId: '10', isActive: false, wAt: Date.now() }]);
    expect(h.ramStore()!.get('10')).toBeUndefined();
  });
});
