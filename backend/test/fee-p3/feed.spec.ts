/*
 * P3.3 feeds (design §9.2): the background boot load (= the first pass's page
 * source), buffered newer-wins hints during the load, the reconcile and the
 * loss / gap / reset / XREAD-error triggers of the hint stream (leases on).
 */
import { describe, expect, it, vi } from 'vitest';
import type { FeeRowHint } from '../../src/database/positions.repository.js';
import {
  FeeCandidateFeed,
  STORE_NOT_READY_ALERT_MS,
  XREAD_ERROR_RECONCILE_MS,
  compareStreamIds,
  type FeeStoreDoc,
  type FeeStoreSource,
} from '../../src/sync/fee-candidate-feed.js';
import { resolveFeeP3Settings, type FeeP3Settings } from '../../src/sync/fee-measurer.js';
import { FeeRowHintPublisher, hintLossKey, hintStreamKey } from '../../src/sync/fee-row-hint-publisher.js';
import type { FeeCoordination } from '../../src/sync/fee-signals.js';
import { FakeFeeRedis } from './fake-redis.js';

const CHAIN = 4663;
const PROTO = 'uniswap-v4';
const POOL = `0x${'ab'.repeat(32)}`;

function doc(id: string, over: Partial<FeeStoreDoc> = {}): FeeStoreDoc {
  return {
    positionId: id,
    tokenId: id,
    poolId: POOL,
    tickLower: -60,
    tickUpper: 60,
    lastModifyBlock: 10,
    token0: { decimals: 6, priceUsd: 1 },
    token1: { decimals: 6, priceUsd: 1 },
    metrics: { feesSource: 'onchain', isPriceable: true, pendingFeesUsd: 1 },
    updatedAt: new Date(1_000),
    ...over,
  };
}

function hint(id: string, over: Partial<FeeRowHint> = {}): FeeRowHint {
  return {
    positionId: id,
    isActive: true,
    wAt: 5_000,
    tokenId: id,
    poolId: POOL,
    tickLower: -60,
    tickUpper: 60,
    lastModifyBlock: 10,
    decimals0: 6,
    decimals1: 6,
    price0: 7,
    price1: 1,
    isPriceable: true,
    feesSource: 'onchain',
    pendingFeesUsd: 2,
    ...over,
  };
}

/** A walkable "secondary": docs in positionId order, optionally paused between pages. */
function source(docs: FeeStoreDoc[]) {
  const sorted = () => [...docs].sort((a, b) => (String(a.positionId) < String(b.positionId) ? -1 : 1));
  const reads: string[] = [];
  let gate: Promise<void> | undefined;
  let fail: Error | undefined;
  const src: FeeStoreSource = {
    async walk(_c, _p, after, limit) {
      reads.push(after);
      if (gate) await gate;
      if (fail) throw fail;
      return sorted()
        .filter((d) => !after || String(d.positionId) > after)
        .slice(0, limit);
    },
  };
  return {
    src,
    docs,
    reads,
    pause() {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = undefined;
        release();
      };
    },
    failWith(e: Error | undefined) {
      fail = e;
    },
  };
}

async function settle(feed: FeeCandidateFeed): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  void feed;
}

function makeFeed(docs: FeeStoreDoc[], opts: { settings?: Partial<FeeP3Settings>; coord?: FeeCoordination; now?: () => number } = {}) {
  const s = source(docs);
  const logger = { warn: vi.fn(), log: vi.fn(), debug: vi.fn() };
  const sleeps: number[] = [];
  const feed = new FeeCandidateFeed({
    source: s.src,
    settings: () => ({ ...resolveFeeP3Settings({}), candidates: 'memory', ...opts.settings }),
    logger,
    coord: opts.coord,
    now: opts.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const warnings = () => logger.warn.mock.calls.map((c) => String(c[0]));
  return { feed, s, logger, sleeps, warnings };
}

describe('boot load', () => {
  it('start() returns at once; the store is usable WHILE loading and pages cover only what was loaded', async () => {
    const docs = Array.from({ length: 2_500 }, (_, i) => doc(String(10_000 + i)));
    const { feed, s } = makeFeed(docs);
    const release = s.pause();
    feed.start(CHAIN, PROTO);
    expect(feed.usable(CHAIN, PROTO)).toBe(true);
    const store = feed.store(CHAIN, PROTO)!;
    expect(store.page('', 10)).toEqual({ rows: [], end: false });
    release();
    await settle(feed);
    expect(store.complete).toBe(true);
    expect(store.size).toBe(2_500);
    expect(s.reads).toEqual(['', '10999', '11999']);
    expect(feed.status()[`${CHAIN}:${PROTO}`]).toMatchObject({ rows: 2_500, ready: true, state: 'ready' });
  });

  it('paces the walk at POSITION_FEE_LOAD_DOCS_PER_SEC', async () => {
    const docs = Array.from({ length: 1_000 }, (_, i) => doc(String(10_000 + i)));
    const { feed, sleeps } = makeFeed(docs, { settings: { loadDocsPerSec: 250 } });
    feed.start(CHAIN, PROTO);
    await settle(feed);
    // Pages of 250 at 250/s: ~1 s after each full page.
    expect(sleeps).toHaveLength(4);
    for (const ms of sleeps) expect(ms).toBeGreaterThan(900);
  });

  it('hints during the load are buffered and applied newer-wins after each page', async () => {
    const docs = [doc('1'), doc('2', { updatedAt: new Date(9_000) }), doc('3')];
    const { feed, s } = makeFeed(docs);
    const release = s.pause();
    feed.start(CHAIN, PROTO);
    feed.applyHints(CHAIN, PROTO, [
      hint('1', { wAt: 5_000, price0: 7 }), // newer than the doc (1,000): wins
      hint('2', { wAt: 5_000, price0: 7 }), // older than the doc (9,000): loses
      hint('3', { isActive: false, wAt: 5_000 }), // closure after the doc: removes
      hint('4', { wAt: 5_000 }), // a new active row the walk does not have
    ]);
    expect(feed.status()[`${CHAIN}:${PROTO}`]!.buffered).toBe(4);
    release();
    await settle(feed);
    const store = feed.store(CHAIN, PROTO)!;
    expect(store.get('1')!.price0).toBe(7);
    expect(store.get('2')!.price0).toBe(1);
    expect(store.get('3')).toBeUndefined();
    expect(store.get('4')).toBeDefined();
    expect(feed.status()[`${CHAIN}:${PROTO}`]!.buffered).toBe(0);
  });

  it('a failing walk makes the chain unusable (the pass reads Mongo), alerts, and retries after the backoff', async () => {
    let now = 1_000_000;
    const { feed, s, warnings } = makeFeed([doc('1')], { now: () => now });
    s.failWith(new Error('No suitable servers found (secondary)'));
    feed.start(CHAIN, PROTO);
    await settle(feed);
    expect(feed.usable(CHAIN, PROTO)).toBe(false);
    expect(warnings().some((w) => w.includes('[alert] fees.store_load_failed'))).toBe(true);
    s.failWith(undefined);
    feed.maintain(CHAIN, PROTO);
    await settle(feed);
    expect(feed.usable(CHAIN, PROTO)).toBe(false);
    now += 31_000;
    feed.maintain(CHAIN, PROTO);
    await settle(feed);
    expect(feed.usable(CHAIN, PROTO)).toBe(true);
    expect(feed.store(CHAIN, PROTO)!.complete).toBe(true);
  });

  it('refuses a chain whose positionId is not its tokenId (the store order would not be the pass order)', async () => {
    const { feed, warnings } = makeFeed([doc('1', { tokenId: '0x1' })]);
    feed.start(CHAIN, PROTO);
    await settle(feed);
    expect(feed.usable(CHAIN, PROTO)).toBe(false);
    expect(warnings().join('\n')).toContain('positionId 1 != tokenId 0x1');
  });

  it('[alert] fees.store_not_ready once a load has run 15 min', async () => {
    let now = 0;
    const { feed, s, warnings } = makeFeed([doc('1')], { now: () => now });
    const release = s.pause();
    feed.start(CHAIN, PROTO);
    now = STORE_NOT_READY_ALERT_MS + 1;
    feed.maintain(CHAIN, PROTO);
    feed.maintain(CHAIN, PROTO);
    expect(warnings().filter((w) => w.includes('[alert] fees.store_not_ready'))).toHaveLength(1);
    release();
    await settle(feed);
  });
});

describe('reconcile', () => {
  it('runs every POSITION_FEE_RECONCILE_MS, diffs in place, and alerts above 1 % drift', async () => {
    let now = 1_000;
    const docs = Array.from({ length: 200 }, (_, i) => doc(String(100 + i)));
    const { feed, s, warnings, logger } = makeFeed(docs, { now: () => now, settings: { reconcileMs: 60_000 } });
    feed.start(CHAIN, PROTO);
    await settle(feed);
    now += 30_000;
    feed.maintain(CHAIN, PROTO);
    await settle(feed);
    expect(feed.status()[`${CHAIN}:${PROTO}`]!.reconciles).toBe(0);
    // One row closed with no hint (lost), one new: 2 of 200 = 1 %, not above.
    s.docs.splice(0, 1);
    s.docs.push(doc('999', { updatedAt: new Date(now) }));
    now += 31_000 + 600_000;
    feed.maintain(CHAIN, PROTO);
    await settle(feed);
    expect(feed.status()[`${CHAIN}:${PROTO}`]!.reconciles).toBe(1);
    expect(feed.store(CHAIN, PROTO)!.get('100')).toBeUndefined();
    expect(feed.store(CHAIN, PROTO)!.get('999')).toBeDefined();
    expect(warnings().some((w) => w.includes('reconcile_drift'))).toBe(false);
    expect(logger.log.mock.calls.some((c) => String(c[0]).includes('reconciled (interval)'))).toBe(true);
    // Five changed: 2.5 % → alert.
    s.docs.splice(0, 5);
    feed.requestReconcile(CHAIN, PROTO, 'test');
    feed.maintain(CHAIN, PROTO);
    await settle(feed);
    expect(warnings().some((w) => w.includes('[alert] fees.reconcile_drift') && w.includes('reason=test'))).toBe(true);
  });
});

describe('the hint stream (leases on)', () => {
  function coordWith(models: FakeFeeRedis, state: FakeFeeRedis): FeeCoordination {
    return { leasesEnabled: true, namespace: 'ns', modelsRedis: async () => models, stateRedis: async () => state };
  }

  async function publish(coord: FeeCoordination, rows: FeeRowHint[]) {
    const pub = new FeeRowHintPublisher({ positionFeeCandidates: 'memory' } as never, coord);
    await pub.publish(CHAIN, PROTO, rows);
    return pub;
  }

  it('records the stream tail BEFORE the load scan: hints written during the scan are read after it, buffered, then applied', async () => {
    let clock = 10_000;
    const models = new FakeFeeRedis(() => clock);
    const state = new FakeFeeRedis(() => clock);
    const coord = coordWith(models, state);
    await publish(coord, [hint('1', { wAt: 1, price0: 99 })]); // before the scan: never read
    const { feed, s } = makeFeed([doc('1'), doc('2')], { coord });
    const release = s.pause();
    feed.start(CHAIN, PROTO);
    await settle(feed);
    clock += 1;
    await publish(coord, [hint('2', { wAt: 5_000, price0: 42 })]);
    expect(await feed.consumeOnce()).toBe(1);
    expect(feed.status()[`${CHAIN}:${PROTO}`]!.buffered).toBe(1);
    release();
    await settle(feed);
    const store = feed.store(CHAIN, PROTO)!;
    expect(store.get('1')!.price0).toBe(1);
    expect(store.get('2')!.price0).toBe(42);
    clock += 1;
    await publish(coord, [hint('1', { wAt: 6_000, isActive: false })]);
    await feed.consumeOnce();
    expect(store.get('1')).toBeUndefined();
  });

  it('a moved loss counter → [alert] fees.hint_gap → reconcile', async () => {
    let clock = 10_000;
    const models = new FakeFeeRedis(() => clock);
    const state = new FakeFeeRedis(() => clock);
    const coord = coordWith(models, state);
    const { feed, warnings, s } = makeFeed([doc('1')], { coord, now: () => clock });
    feed.start(CHAIN, PROTO);
    await settle(feed);
    await feed.consumeOnce(); // baseline of the loss counter
    models.failing = true;
    await publish(coord, [hint('5')]);
    models.failing = false;
    expect(await state.get(hintLossKey('ns', CHAIN, PROTO))).toBe('1');
    s.docs.push(doc('5', { updatedAt: new Date(clock) }));
    clock += 20_000;
    await feed.consumeOnce();
    expect(warnings().some((w) => w.includes('[alert] fees.hint_gap') && w.includes('loss counter'))).toBe(true);
    feed.maintain(CHAIN, PROTO);
    await settle(feed);
    expect(feed.store(CHAIN, PROTO)!.get('5')).toBeDefined();
    expect(feed.status()[`${CHAIN}:${PROTO}`]!.lossEpochs).toBe(1);
  });

  it('a stream trimmed past the consumer → gap → reconcile', async () => {
    let clock = 10_000;
    const models = new FakeFeeRedis(() => clock);
    const state = new FakeFeeRedis(() => clock);
    const coord = coordWith(models, state);
    await publish(coord, [hint('1')]);
    const { feed, warnings } = makeFeed([doc('1')], { coord, now: () => clock });
    feed.start(CHAIN, PROTO);
    await settle(feed);
    // 801 entries land and trim everything up to and past our position before we read.
    for (let i = 0; i < 801; i++) {
      clock += 1;
      await models.xadd(hintStreamKey('ns', CHAIN, PROTO), 'MAXLEN', '~', 800, '*', 'h', '[]');
    }
    const stream = models.store.get(hintStreamKey('ns', CHAIN, PROTO)) as { v: Array<[string, string[]]> };
    stream.v.splice(0, 10); // the oldest unread entries are gone
    clock += 20_000;
    feed['chains'].get(`${CHAIN}:${PROTO}`)!.streamId = '10000-0';
    await feed.consumeOnce();
    expect(warnings().some((w) => w.includes('trimmed past the consumer'))).toBe(true);
  });

  it('a stream that disappears after we read from it (redis-models restart) → reset → reconcile', async () => {
    let clock = 10_000;
    const models = new FakeFeeRedis(() => clock);
    const state = new FakeFeeRedis(() => clock);
    const coord = coordWith(models, state);
    const { feed, warnings } = makeFeed([doc('1')], { coord, now: () => clock });
    feed.start(CHAIN, PROTO);
    await settle(feed);
    clock += 1;
    await publish(coord, [hint('1', { wAt: 9_999 })]);
    await feed.consumeOnce();
    models.del(hintStreamKey('ns', CHAIN, PROTO));
    clock += 20_000;
    await feed.consumeOnce();
    expect(warnings().some((w) => w.includes('hint stream reset'))).toBe(true);
  });

  it('60 s of XREAD errors → one reconcile request (not one per failure)', async () => {
    let clock = 10_000;
    const models = new FakeFeeRedis(() => clock);
    const state = new FakeFeeRedis(() => clock);
    const coord = coordWith(models, state);
    const { feed, warnings } = makeFeed([doc('1')], { coord, now: () => clock });
    feed.start(CHAIN, PROTO);
    await settle(feed);
    models.failOn.add('xread');
    for (let t = 0; t <= XREAD_ERROR_RECONCILE_MS; t += 1_000) {
      clock += 1_000;
      await feed.consumeOnce();
    }
    expect(warnings().filter((w) => w.includes('xread errors'))).toHaveLength(1);
  });

  it('compareStreamIds orders <ms>-<seq> numerically', () => {
    expect(compareStreamIds('10-1', '9-5')).toBe(1);
    expect(compareStreamIds('10-1', '10-2')).toBe(-1);
    expect(compareStreamIds('10-2', '10-2')).toBe(0);
    expect(compareStreamIds('1700000000000-0', '999999999999-9')).toBe(1);
  });
});
