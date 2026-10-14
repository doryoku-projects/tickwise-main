/*
 * Read-model flags (design §2.2): env < kill switch, which can only LOWER a
 * mode; roles; serve percent; and the env entries themselves (Zod + getters).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../../src/config/app-config.service.js';
import {
  activeModels,
  configuredModes,
  effectiveModes,
  isFeederCandidate,
  keepsModels,
  lowerMode,
  parseKillSwitch,
  resolveRole,
  selectedForServe,
} from '../../src/read-models/flags.js';
import { KillSwitch, lowers } from '../../src/read-models/killswitch.js';
import { rmKeys } from '../../src/read-models/keys.js';
import { MemoryRedis, MemoryStateTransport } from '../../src/read-models/transport.js';

describe('modes', () => {
  it('per-model env overrides READ_MODELS_MODE', () => {
    expect(configuredModes({ readModelsMode: 'off' })).toEqual({ rank: 'off', pools: 'off' });
    expect(configuredModes({ readModelsMode: 'shadow', poolCatalogMode: 'serve' })).toEqual({ rank: 'shadow', pools: 'serve' });
    expect(configuredModes({ readModelsMode: 'serve', rankEngineMode: 'off' })).toEqual({ rank: 'off', pools: 'serve' });
  });

  it('the kill switch can only LOWER a mode', () => {
    const env = { rank: 'shadow', pools: 'serve' } as const;
    expect(effectiveModes(env, { rank: 'serve', pools: 'off' })).toEqual({ rank: 'shadow', pools: 'off' });
    expect(effectiveModes(env, { pools: 'shadow' })).toEqual({ rank: 'shadow', pools: 'shadow' });
    expect(effectiveModes(env, {})).toEqual(env);
    expect(lowerMode('serve', 'off')).toBe('off');
    expect(lowerMode('off', 'serve')).toBe('off');
    expect(lowers('serve', 'shadow')).toBe(true);
    expect(lowers('shadow', 'serve')).toBe(false);
    expect(lowers('shadow', 'shadow')).toBe(false);
  });

  it('active models are everything not off', () => {
    expect([...activeModels({ rank: 'off', pools: 'shadow' })]).toEqual(['pools']);
    expect(activeModels({ rank: 'off', pools: 'off' }).size).toBe(0);
  });

  it('a garbled kill switch reads as no override', () => {
    expect(parseKillSwitch('{nope')).toEqual({});
    expect(parseKillSwitch(JSON.stringify({ rank: 'bogus', pools: 'off', at: 5, by: 'admin', extra: 1 }))).toEqual({ pools: 'off', at: 5, by: 'admin' });
    expect(parseKillSwitch(null)).toEqual({});
  });

  it('roles: auto = both today; P2 process roles map to read-model roles', () => {
    expect(resolveRole('auto')).toBe('both');
    expect(resolveRole('auto', 'all')).toBe('both');
    expect(resolveRole('auto', 'api')).toBe('server');
    expect(resolveRole('auto', 'feeder')).toBe('feeder');
    expect(resolveRole('auto', 'sync')).toBe('none');
    expect(resolveRole('server', 'feeder')).toBe('server');
    expect(isFeederCandidate('both')).toBe(true);
    expect(isFeederCandidate('server')).toBe(false);
    expect(keepsModels('none')).toBe(false);
    expect(keepsModels('feeder')).toBe(true);
  });

  it('serve percent: 0 never, 100 always, otherwise a share', () => {
    expect(selectedForServe(0, () => 0)).toBe(false);
    expect(selectedForServe(100, () => 0.999)).toBe(true);
    expect(selectedForServe(10, () => 0.05)).toBe(true);
    expect(selectedForServe(10, () => 0.5)).toBe(false);
  });
});

describe('kill switch on redis-state', () => {
  it('writes an override, `serve` clears it, and a read failure keeps the last reading', async () => {
    const redis = new MemoryRedis();
    const switchA = new KillSwitch(new MemoryStateTransport(redis, rmKeys('ns')), rmKeys('ns'));
    const switchB = new KillSwitch(new MemoryStateTransport(redis, rmKeys('ns')), rmKeys('ns'));
    await switchA.write('rank', 'off', 'admin', 1);
    expect(await switchB.read()).toMatchObject({ rank: 'off', by: 'admin' });
    await switchA.write('rank', 'serve', 'admin', 2);
    expect((await switchB.read()).rank).toBeUndefined();
    await switchA.write('pools', 'shadow', 'admin', 3);
    expect((await switchB.read()).pools).toBe('shadow');
    redis.down = true;
    expect((await switchB.read()).pools).toBe('shadow'); // fail-static
  });
});

describe('env entries', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults: everything off, safe values', () => {
    const config = new AppConfigService();
    expect(config.readModelsMode).toBe('off');
    expect(config.poolCatalogMode).toBeUndefined();
    expect(config.rankEngineMode).toBeUndefined();
    expect(config.readModelsServePercent).toBe(100);
    expect(config.readModelsRole).toBe('auto');
    expect(config.redisModelsUrl).toBe(config.redisUrl);
    expect(config.redisModelsSeparate).toBe(false);
    expect(config.readModelsDegradedPolicy).toBe('p1');
    expect(config.readModelsShadowSample).toBe(0.05);
    expect(config.readModelsShadowMaxPerMin).toBe(60);
    expect(config.readModelsScanDocsPerSec).toBe(5000);
    expect(config.readModelsVerifyDocsPerSec).toBe(500);
    expect(config.readModelsGenerationMs).toBe(2000);
    expect(config.readModelsSnapshotIntervalMs).toBe(300_000);
    expect(config.readModelsSnapshotEncodeTimeoutMs).toBe(20_000);
    expect(config.readModelsMaxLagMs).toBe(120_000);
    expect(config.readModelsReadyTimeoutMs).toBe(300_000);
    expect(config.readModelsWorkers).toBe(2);
    expect(config.readModelsMaxMb).toBe(0);
    expect(config.readModelsPositionsCapacity).toBe(0);
    expect(config.readModelsOplogWindowHintMs).toBe(10_800_000);
    expect(config.readModelsDurableSnapshotUrl).toBeUndefined();
  });

  it('REDIS_MODELS_URL names its own instance; blank reads as unset', () => {
    vi.stubEnv('REDIS_MODELS_URL', 'redis://models.internal:6379?family=0');
    expect(new AppConfigService().redisModelsUrl).toBe('redis://models.internal:6379?family=0');
    expect(new AppConfigService().redisModelsSeparate).toBe(true);
    vi.stubEnv('REDIS_MODELS_URL', '  ');
    expect(new AppConfigService().redisModelsSeparate).toBe(false);
  });

  it('the scan pace is a HARD ceiling of 5000 docs/s: a larger value fails the boot', () => {
    vi.stubEnv('READ_MODELS_SCAN_DOCS_PER_SEC', '5001');
    expect(() => new AppConfigService()).toThrow(/Invalid positions-backend configuration/);
    vi.stubEnv('READ_MODELS_SCAN_DOCS_PER_SEC', '1200');
    expect(new AppConfigService().readModelsScanDocsPerSec).toBe(1200);
    vi.stubEnv('READ_MODELS_VERIFY_DOCS_PER_SEC', '9000');
    expect(() => new AppConfigService()).toThrow();
  });

  it('a BLANK numeric read-model var reads as its default (never 0), with every model off', () => {
    for (const name of [
      'READ_MODELS_SERVE_PERCENT',
      'READ_MODELS_SCAN_DOCS_PER_SEC',
      'READ_MODELS_VERIFY_DOCS_PER_SEC',
      'READ_MODELS_WORKERS',
      'READ_MODELS_SHADOW_SAMPLE',
      'READ_MODELS_SHADOW_MAX_PER_MIN',
      'READ_MODELS_GENERATION_MS',
      'READ_MODELS_SNAPSHOT_INTERVAL_MS',
      'READ_MODELS_SNAPSHOT_ENCODE_TIMEOUT_MS',
      'READ_MODELS_MAX_LAG_MS',
      'READ_MODELS_READY_TIMEOUT_MS',
      'READ_MODELS_MAX_MB',
      'READ_MODELS_POSITIONS_CAPACITY',
      'READ_MODELS_OPLOG_WINDOW_HINT_MS',
    ]) {
      vi.stubEnv(name, '');
    }
    const config = new AppConfigService();
    expect(config.readModelsMode).toBe('off');
    expect(config.readModelsServePercent).toBe(100);
    expect(config.readModelsServePercentValid).toBe(true);
    expect(config.readModelsScanDocsPerSec).toBe(5000);
    expect(config.readModelsVerifyDocsPerSec).toBe(500);
    expect(config.readModelsWorkers).toBe(2); // '' used to read as 0 = engines AND the feeder on the main thread
    expect(config.readModelsShadowSample).toBe(0.05);
    expect(config.readModelsShadowMaxPerMin).toBe(60);
    expect(config.readModelsReadyTimeoutMs).toBe(300_000);
    expect(config.readModelsOplogWindowHintMs).toBe(10_800_000);
    expect(config.readModelsSnapshotEncodeTimeoutMs).toBe(20_000);
  });

  it('a garbage READ_MODELS_SERVE_PERCENT fails CLOSED (0: Mongo answers), never open to 100', () => {
    vi.stubEnv('READ_MODELS_SERVE_PERCENT', '10%');
    const config = new AppConfigService();
    expect(config.readModelsServePercent).toBe(0);
    expect(config.readModelsServePercentValid).toBe(false);
    vi.stubEnv('READ_MODELS_SERVE_PERCENT', ' 10 ');
    expect(new AppConfigService().readModelsServePercent).toBe(10);
  });

  it('modes are validated; clamps keep the rest sane', () => {
    vi.stubEnv('READ_MODELS_MODE', 'bogus');
    expect(() => new AppConfigService()).toThrow();
    vi.stubEnv('READ_MODELS_MODE', 'shadow');
    vi.stubEnv('POOL_CATALOG_MODE', 'serve');
    vi.stubEnv('READ_MODELS_SERVE_PERCENT', '250');
    vi.stubEnv('READ_MODELS_SNAPSHOT_INTERVAL_MS', '10');
    vi.stubEnv('READ_MODELS_MAX_LAG_MS', '1000');
    vi.stubEnv('READ_MODELS_OPLOG_WINDOW_HINT_MS', '1200000');
    vi.stubEnv('READ_MODELS_WORKERS', '0');
    const config = new AppConfigService();
    expect(config.readModelsMode).toBe('shadow');
    expect(config.poolCatalogMode).toBe('serve');
    expect(config.readModelsServePercent).toBe(100);
    expect(config.readModelsSnapshotIntervalMs).toBe(30_000);
    expect(config.readModelsMaxLagMs).toBe(config.readStalenessBudgetMs); // never below the staleness budget
    expect(config.readModelsOplogWindowHintMs).toBe(1_200_000);
    expect(config.readModelsWorkers).toBe(0);
  });
});
