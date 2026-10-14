/*
 * The snapshot encode cap (design §3.5, capacity plan "snapshot encode cap"):
 *  - the default is EXACTLY today's hard-coded 20 s (no row-count-derived default);
 *  - `maxEncodeMs` is the cap a holder actually encodes under (a larger configured
 *    cap lets an encode that would have aborted at 20 s commit), never past half
 *    the "being written" chunk TTL;
 *  - a committed encode over 75% of the cap raises `snapshot_encode_slow`, at or
 *    under it nothing;
 *  - an encode that runs past the cap names the env var in `snapshot_failed`.
 * The runtime cases drive a real holder; a clock the chunk writes advance makes
 * the encode time deterministic (`step` ms per chunk).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { ReadModelsService } from '../../src/read-models/read-models.service.js';
import { InThreadFeederHost } from '../../src/read-models/feeder/feeder-host.js';
import { ReadModelsRuntime } from '../../src/read-models/feeder/feeder.service.js';
import {
  DEFAULT_HOLDER_CONFIG,
  SNAPSHOT_ENCODE_TIMEOUT_DEFAULT_MS,
  SNAPSHOT_ENCODE_TIMEOUT_MAX_MS,
  SNAPSHOT_ENCODE_TIMEOUT_MIN_MS,
  SNAPSHOT_ENCODE_WARN_RATIO,
  snapshotEncodeCapMs,
  snapshotEncodeSlowDetail,
  snapshotEncodeTimeoutDetail,
  suggestedSnapshotEncodeCapMs,
  type HolderConfig,
} from '../../src/read-models/feeder/holder.js';
import { NoopSnapshotSink } from '../../src/read-models/feeder/snapshot-sink.js';
import type { Manifest } from '../../src/read-models/feeder/snapshot-store.js';
import { MemoryModelsTransport, MemoryStateTransport } from '../../src/read-models/transport.js';
import { FakeCluster, poolDoc, positionDoc } from './fake-cluster.js';
import { HOLDER_CONFIG, KEYS, MemoryRedis, POOLS_COLL, RANK_COLL, settled, SHARDS, SpecAlerts, waitUntil } from './support.js';

const ENV = 'READ_MODELS_SNAPSHOT_ENCODE_TIMEOUT_MS';

describe('snapshot encode cap: defaults and helpers', () => {
  it('defaults to exactly today’s 20 s', () => {
    expect(SNAPSHOT_ENCODE_TIMEOUT_DEFAULT_MS).toBe(20_000);
    expect(DEFAULT_HOLDER_CONFIG.maxEncodeMs).toBe(20_000);
    expect(snapshotEncodeCapMs(DEFAULT_HOLDER_CONFIG)).toBe(20_000);
    expect(SNAPSHOT_ENCODE_TIMEOUT_MIN_MS).toBe(5_000);
    // Half of the default 10-min "being written" TTL.
    expect(SNAPSHOT_ENCODE_TIMEOUT_MAX_MS).toBe(DEFAULT_HOLDER_CONFIG.writingTtlMs / 2);
    expect(SNAPSHOT_ENCODE_WARN_RATIO).toBe(0.75);
  });

  it('applies a configured cap as given, a broken one as the default', () => {
    const ttl = DEFAULT_HOLDER_CONFIG.writingTtlMs;
    expect(snapshotEncodeCapMs({ maxEncodeMs: 120_000, writingTtlMs: ttl })).toBe(120_000);
    expect(snapshotEncodeCapMs({ maxEncodeMs: 5_000, writingTtlMs: ttl })).toBe(5_000);
    expect(snapshotEncodeCapMs({ maxEncodeMs: 30_000.7, writingTtlMs: ttl })).toBe(30_000);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(snapshotEncodeCapMs({ maxEncodeMs: bad, writingTtlMs: ttl })).toBe(20_000);
    }
  });

  it('never runs past half the writing TTL (the first chunk must outlive the encode)', () => {
    expect(snapshotEncodeCapMs({ maxEncodeMs: 900_000, writingTtlMs: 600_000 })).toBe(300_000);
    expect(snapshotEncodeCapMs({ maxEncodeMs: 300_000, writingTtlMs: 600_000 })).toBe(300_000);
    expect(snapshotEncodeCapMs({ maxEncodeMs: 20_000, writingTtlMs: 30_000 })).toBe(15_000);
    // A broken TTL does not lower the cap.
    expect(snapshotEncodeCapMs({ maxEncodeMs: 20_000, writingTtlMs: Number.NaN })).toBe(20_000);
  });

  it('suggests 2 × the measured encode, rounded up to 5 s, within the bounds', () => {
    expect(suggestedSnapshotEncodeCapMs(17_300)).toBe(35_000);
    expect(suggestedSnapshotEncodeCapMs(23_000)).toBe(50_000);
    expect(suggestedSnapshotEncodeCapMs(1_000)).toBe(5_000);
    expect(suggestedSnapshotEncodeCapMs(-5)).toBe(5_000);
    expect(suggestedSnapshotEncodeCapMs(200_000)).toBe(300_000);
  });

  it('warns only past 75% of the cap', () => {
    expect(snapshotEncodeSlowDetail(15_000, 20_000, 6_500_000)).toBeNull();
    expect(snapshotEncodeSlowDetail(10_000, 20_000, 6_500_000)).toBeNull();
    expect(snapshotEncodeSlowDetail(17_300, 20_000, 0)).not.toBeNull();
    expect(snapshotEncodeSlowDetail(15_001, 20_000, 1)).not.toBeNull();
    expect(snapshotEncodeSlowDetail(99_999, 0, 1)).toBeNull();
    expect(snapshotEncodeSlowDetail(Number.NaN, 20_000, 1)).toBeNull();
  });

  it('says what to set it to, and when raising it cannot help', () => {
    const detail = snapshotEncodeSlowDetail(17_300, 20_000, 6_500_000)!;
    expect(detail).toContain('17300 ms');
    expect(detail).toContain('6500000 rows');
    expect(detail).toContain('87% of the 20000 ms cap');
    expect(detail).toContain(ENV);
    expect(detail).toContain('~2662 ms per 1M rows');
    expect(detail).toContain(`raise ${ENV} to ≥ 35000 ms`);
    expect(snapshotEncodeSlowDetail(17_300, 20_000, 0)).not.toContain('per 1M rows');
    const ceiling = snapshotEncodeSlowDetail(250_000, 300_000, 9_000_000)!;
    expect(ceiling).toContain(`${ENV} is already at 300000 ms`);
    expect(ceiling).not.toContain('raise');
  });

  it('a timeout names the env var and the rows', () => {
    const detail = snapshotEncodeTimeoutDetail('snapshot encode ran past 20000 ms', 23_000, 20_000, 8_800_000);
    expect(detail).toContain('snapshot encode ran past 20000 ms');
    expect(detail).toContain('8800000 rows');
    expect(detail).toContain('NOT READY');
    expect(detail).toContain(`raise ${ENV} to ≥ 50000 ms`);
  });
});

/** A transport whose chunk writes advance the holder's clock by `step` ms while armed. */
class SlowChunkTransport extends MemoryModelsTransport {
  skew = 0;
  step = 0;
  armed = false;
  override async putChunk(key: string, data: Uint8Array, ttlMs: number) {
    if (this.armed) this.skew += this.step;
    return super.putChunk(key, data, ttlMs);
  }
}

const running: ReadModelsRuntime[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
});

async function holderWith(holder: Partial<HolderConfig> = {}) {
  const c = new FakeCluster();
  c.t = Math.floor(Date.now() / 1000);
  for (let n = 0; n < 200; n++) c.insert(RANK_COLL, positionDoc(n));
  for (let n = 0; n < 40; n++) c.insert(POOLS_COLL, poolDoc(n));
  const redis = new MemoryRedis();
  const transport = new SlowChunkTransport(redis, KEYS);
  const lines: string[] = [];
  const alerts = new SpecAlerts((line) => lines.push(line));
  const runtime = new ReadModelsRuntime(
    {
      transport,
      state: new MemoryStateTransport(redis, KEYS),
      keys: KEYS,
      sink: new NoopSnapshotSink(),
      createHost: () => new InThreadFeederHost(() => c, { liveFlushMs: 10, confirmEveryMs: 40, statsEveryMs: 60_000 }),
      alerts,
      owner: 'A',
    },
    {
      role: 'both',
      shards: SHARDS,
      holder: { ...HOLDER_CONFIG, ...holder },
      maxLagMs: 120_000,
      positionsCapacity: 0,
      leaseTtlMs: 1_000,
      leaseRetryMs: 100,
      oplogRetryMs: 60_000,
    },
    { rank: 'shadow', pools: 'shadow' },
  );
  running.push(runtime);
  await runtime.start();
  await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
  await settled(runtime, c);
  const session = runtime.holder!;
  const manifest = (session as unknown as { liveManifest: Manifest }).liveManifest;
  const chunks = manifest.columns.reduce((n, col) => n + col.chunks, 0);
  expect(chunks).toBeGreaterThan(4);
  /** Encode the next snapshot as if it took `totalMs` (spread over its chunks). */
  const snapshotTaking = async (totalMs: number) => {
    (session as unknown as { now: () => number }).now = () => Date.now() + transport.skew;
    transport.step = totalMs / chunks;
    transport.armed = true;
    try {
      return await session.writeSnapshot();
    } finally {
      transport.armed = false;
    }
  };
  return { runtime, alerts, lines, snapshotTaking };
}

describe('snapshot encode cap: a real holder', () => {
  it('a committed encode over 75% of the default cap warns, with the measured time in status', async () => {
    const { runtime, alerts, lines, snapshotTaking } = await holderWith();
    expect(await snapshotTaking(0.85 * 20_000)).toBe(true);
    expect(alerts.names).toContain('read_models.snapshot_encode_slow');
    expect(alerts.names).not.toContain('read_models.snapshot_failed');
    const line = lines.find((l) => l.includes('snapshot_encode_slow'))!;
    expect(line).toContain('of the 20000 ms cap');
    expect(line).toContain(ENV);
    const status = runtime.meter.snapshot();
    expect(status.snapshots.lastEncodeMs).toBeGreaterThan(0.75 * 20_000);
    expect(status.snapshots.lastEncodeMs).toBeLessThanOrEqual(20_000);
  }, 30_000);

  it('an encode at half the cap commits silently', async () => {
    const { alerts, snapshotTaking } = await holderWith();
    expect(await snapshotTaking(0.5 * 20_000)).toBe(true);
    expect(alerts.names).not.toContain('read_models.snapshot_encode_slow');
    expect(alerts.names).not.toContain('read_models.snapshot_failed');
  }, 30_000);

  it('an encode past the default cap aborts and names the env var', async () => {
    const { runtime, alerts, lines, snapshotTaking } = await holderWith();
    const written = runtime.meter.snapshots.written;
    expect(await snapshotTaking(2 * 20_000)).toBe(false);
    expect(runtime.meter.snapshots.written).toBe(written);
    expect(alerts.names).toContain('read_models.snapshot_failed');
    const line = lines.find((l) => l.includes('snapshot_failed'))!;
    expect(line).toContain('ran past 20000 ms');
    // The rows the encode was asked to write (200 positions + 40 pools).
    expect(line).toContain('(240 rows;');
    expect(line).toContain(`raise ${ENV}`);
    expect(alerts.names).not.toContain('read_models.snapshot_encode_slow');
  }, 30_000);

  it('a raised cap lets the same encode commit (the configured value is the one applied)', async () => {
    const { runtime, alerts, snapshotTaking } = await holderWith({ maxEncodeMs: 60_000 });
    const written = runtime.meter.snapshots.written;
    expect(await snapshotTaking(1.5 * 20_000)).toBe(true);
    expect(runtime.meter.snapshots.written).toBe(written + 1);
    // 30 s of a 60 s cap: under the warning line.
    expect(alerts.names).not.toContain('read_models.snapshot_failed');
    expect(alerts.names).not.toContain('read_models.snapshot_encode_slow');
  }, 30_000);

  it('a cap configured past half the writing TTL is held to it', async () => {
    const { alerts, snapshotTaking } = await holderWith({ maxEncodeMs: 60_000, writingTtlMs: 40_000 });
    // 30 s < the configured 60 s, but past half the 40 s writing TTL.
    expect(await snapshotTaking(30_000)).toBe(false);
    expect(alerts.names).toContain('read_models.snapshot_failed');
  }, 30_000);
});

describe('snapshot encode cap: the env var reaches the holder (review finding: it was never wired)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('READ_MODELS_SNAPSHOT_ENCODE_TIMEOUT_MS: default 20 s, garbage = default, clamped 5 s – 5 min', () => {
    vi.stubEnv(ENV, '');
    delete process.env[ENV];
    expect(new AppConfigService().readModelsSnapshotEncodeTimeoutMs).toBe(20_000);
    for (const [raw, want] of [
      ['', 20_000],
      ['abc', 20_000],
      ['0', 20_000],
      ['-5', 20_000],
      ['1000', 5_000],
      ['900000', 300_000],
      ['60000', 60_000],
      ['60000.9', 60_000],
    ] as const) {
      vi.stubEnv(ENV, raw);
      expect(new AppConfigService().readModelsSnapshotEncodeTimeoutMs, raw).toBe(want);
    }
  });

  function service(over: Record<string, unknown>) {
    const config = {
      readModelsMode: 'off',
      enabledIntegrations: [],
      isProduction: false,
      readModelsSnapshotIntervalMs: 300_000,
      readModelsOplogWindowHintMs: 10_800_000,
      readModelsScanDocsPerSec: 5_000,
      ...over,
    };
    return new ReadModelsService(config as never) as unknown as { holderConfig(): HolderConfig };
  }

  it('ReadModelsService hands the configured cap to the holder', () => {
    const cfg = service({ readModelsSnapshotEncodeTimeoutMs: 60_000 }).holderConfig();
    expect(cfg.maxEncodeMs).toBe(60_000);
    expect(snapshotEncodeCapMs(cfg)).toBe(60_000);
  });

  it('a config without the getter (older specs) keeps exactly 20 s', () => {
    expect(snapshotEncodeCapMs(service({}).holderConfig())).toBe(20_000);
  });

  it('end to end: the env var → config → holderConfig → the cap the encode runs under', () => {
    vi.stubEnv(ENV, '45000');
    const config = new AppConfigService();
    const svc = new ReadModelsService(config) as unknown as { holderConfig(): HolderConfig };
    expect(snapshotEncodeCapMs(svc.holderConfig())).toBe(45_000);
  });
});
