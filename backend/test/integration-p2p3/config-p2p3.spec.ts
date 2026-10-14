/*
 * I1 — every P2/P3 env var: Zod entry + typed getter, with the exact getter
 * NAME each package reads structurally, and a default that IS today (the
 * three write-skip entries excepted: on by default since 2026-10-07). Blank
 * (`KEY=` on Railway) must read as unset, never as 0 / '' / a boot failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { resetProcessRoleForTests } from '../../src/common/process-role.js';
import { resolveFeeP3Settings } from '../../src/sync/fee-measurer.js';
import { readBackfillSettings } from '../../src/sync/backfill-profile.js';
import { writeSkipSettings } from '../../src/database/position-write-hash.js';
import { WRITE_BUDGET_OFF } from '../../src/common/write-budget-model.js';
import { UsageFlushService } from '../../src/billing/usage-flush.service.js';

const P2P3_ENVS = [
  'PROCESS_ROLE',
  'PROCESS_LEASES',
  'PROCESS_STATUS_PUBLISH_MS',
  'POSITIONS_REFRESH_QUEUE_CONCURRENCY',
  'BACKFILL_HELD_MAX_WAIT_MS',
  'AUTH_LIMITER_STORE',
  'CACHE_INVALIDATION',
  'INDEXER_BUDGET_SCOPE',
  'INDEXER_BUDGET_LOCAL_SHARE',
  'INDEXER_MAX_IN_FLIGHT',
  'INDEXER_INTERACTIVE_RESERVED_IN_FLIGHT',
  'RPC_BUDGET_PER_SEC',
  'RPC_ACCOUNT_MAP',
  'RPC_MONTHLY_CAP',
  'POSITIONS_WRITE_SKIP',
  'POSITIONS_WRITE_SKIP_AGE',
  'POSITIONS_WRITE_SKIP_TOLERANCE',
  'POSITIONS_GAS_REVALUE',
  'POSITIONS_FORCED_REWRITE_MS',
  'POSITIONS_FORCED_REWRITE_ZERO_MS',
  'WRITE_BUDGET_MODE',
  'WRITE_BUDGET_UNITS_PER_SEC',
  'WRITE_BUDGET_MIN',
  'WRITE_BUDGET_MAX',
  'WRITE_BUDGET_HOURLY_UNITS_PER_SEC',
  'WRITE_BUDGET_SHARES',
  'WRITE_BUDGET_READ_UNIT',
  'WRITE_BUDGET_UNIT_LATENCY_RED_MS',
  'WRITE_BUDGET_LATENCY_RED_MS',
  'WRITE_BUDGET_LAG_RED_MS',
  'WRITE_BUDGET_BACKFILL_MAX_NO_MONITOR',
  'WRITE_BUDGET_LOCAL_DIVISOR',
  'MONGO_MONITOR_URI',
  'MONGO_BULK_WRITE_MAX_OPS',
  'BACKFILL_PAGING',
  'BACKFILL_PIPELINE',
  'BACKFILL_LOOKAHEAD_PAGES',
  'BACKFILL_PRICE_WAIT_MS',
  'BACKFILL_FEE_READ',
  'PRICE_MISS_LEDGER',
  'GECKOTERMINAL_BUDGET',
  'GECKOTERMINAL_LOCAL_SHARE',
  'POSITION_FEE_BATCH_SIZE_BY_CHAIN',
  'POSITION_FEE_CONCURRENCY_BY_CHAIN',
  'POSITION_FEE_MAX_IN_FLIGHT',
  'POSITION_FEE_HEAD_PER',
  'POSITION_FEE_BUDGET',
  'POSITION_FEE_PASS_TARGET_MS',
  'POSITION_FEE_CANDIDATES',
  'POSITION_FEE_LOAD_DOCS_PER_SEC',
  'POSITION_FEE_RECONCILE_MS',
  'POSITION_FEE_RECONCILE_DOCS_PER_SEC',
  'FEE_SIGNALS_TRANSPORT',
  'MONGO_MAX_POOL_SIZE',
  'MONGO_WAIT_QUEUE_TIMEOUT_MS',
  'MONGO_APP_NAME',
  'USAGE_WRITE_MODE',
  'USAGE_FLUSH_INTERVAL_MS',
] as const;

function clearAll() {
  for (const name of P2P3_ENVS) {
    vi.stubEnv(name, '');
    delete process.env[name];
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetProcessRoleForTests();
});

describe('P2/P3 config — every default is today', () => {
  it('unset: role all, leases auto (off), no status fan-in, refresh concurrency 1, every flag off except write skip', () => {
    clearAll();
    const c = new AppConfigService();
    expect(c.processRole).toBe('all');
    expect(c.processLeases).toBe('auto');
    expect(c.processLeasesEnabled).toBe(false);
    expect(c.processStatusPublishMs).toBeUndefined();
    expect(c.positionsRefreshQueueConcurrency).toBe(1);
    expect(c.backfillHeldMaxWaitMs).toBe(2_700_000);
    expect(c.authLimiterStore).toBe('memory');
    expect(c.cacheInvalidation).toBe('off');
    expect(c.indexerBudgetScope).toBe('process');
    expect(c.indexerBudgetLocalShare).toBe(1);
    expect(c.rpcBudgetPerSec).toBe(0);
    expect(c.rpcAccountMap).toBe('');
    expect(c.rpcMonthlyCap).toBe(150_000_000);
    expect(c.writeBudget).toEqual(WRITE_BUDGET_OFF);
    expect(c.mongoMonitorUri).toBeUndefined();
    expect(c.backfillPaging).toBe('offset');
    expect(c.backfillPipeline).toBe(false);
    expect(c.backfillLookaheadPages).toBe(0);
    expect(c.backfillPriceWaitMs).toBe(5_000);
    expect(c.backfillFeeRead).toBe(false);
    expect(c.priceMissLedger).toBe('off');
    expect(c.geckoterminalBudget).toBe('off');
    expect(c.geckoterminalLocalShare).toBeUndefined();
    // P2.3 is ON by default since 2026-10-07, with the two knobs it needs to
    // skip a valued row; the pure reader resolves the same three from the config.
    expect(c.positionsWriteSkip).toBe('on');
    expect(c.positionsWriteSkipAge).toBe('bucket');
    expect(c.positionsWriteSkipTolerance).toBe('exact');
    expect(c.positionsGasRevalue).toBe('full-write');
    // No config at all (a repository built without one) stays off: every row written.
    expect(writeSkipSettings(undefined)).toMatchObject({ mode: 'off', age: 'refresh', gas: 'always' });
    expect(c.feeSignalsTransport).toBe('auto');
    expect(c.usageWriteMode).toBe('direct');
    expect(c.usageFlushIntervalMs).toBe(10_000);
    // Mongo client + indexer: today's values in role `all`.
    expect(c.mongoMaxPoolSize).toBe(60);
    expect(c.mongoWaitQueueTimeoutMs).toBe(10_000);
    expect(c.mongoAppName).toBe('tickwise-backend');
    expect(c.indexerGatewayConfig).toMatchObject({ maxInFlight: 12, interactiveReservedInFlight: 4, scope: 'process', localShare: 1, servesInteractive: true });
  });

  it('the readers each package uses see today through these getters (the structural contract)', () => {
    clearAll();
    const c = new AppConfigService();
    expect(resolveFeeP3Settings(c)).toMatchObject({
      batchByChain: new Map(),
      concurrencyByChain: new Map(),
      maxInFlight: 64,
      headPer: 'batch',
      budget: 'round',
      passTargetMs: 480_000,
      candidates: 'mongo',
      loadDocsPerSec: 5_000,
      reconcileMs: 21_600_000,
      reconcileDocsPerSec: 3_000,
      signalsTransport: 'auto',
    });
    expect(readBackfillSettings(c)).toMatchObject({ paging: 'offset', pipeline: false, lookaheadPages: 0, priceWaitMs: 5_000, feeRead: false });
    // Write skip: on, with the age bucket and full-write gas (2026-10-07).
    expect(writeSkipSettings(c as never)).toMatchObject({ mode: 'on', age: 'bucket', tolerance: 'exact', gas: 'full-write', forcedRewriteMs: 21_600_000, forcedRewriteZeroMs: 86_400_000 });
  });

  it('write skip rolls back through the environment: the old values, set explicitly, are read through', () => {
    clearAll();
    vi.stubEnv('POSITIONS_WRITE_SKIP', 'OFF');
    vi.stubEnv('POSITIONS_WRITE_SKIP_AGE', 'refresh');
    vi.stubEnv('POSITIONS_GAS_REVALUE', 'always');
    const c = new AppConfigService();
    expect(writeSkipSettings(c as never)).toMatchObject({ mode: 'off', age: 'refresh', tolerance: 'exact', gas: 'always' });
    // One of the three alone is read through too (an old pin left in an environment).
    clearAll();
    vi.stubEnv('POSITIONS_GAS_REVALUE', 'always');
    expect(writeSkipSettings(new AppConfigService() as never)).toMatchObject({ mode: 'on', age: 'bucket', gas: 'always' });
  });

  it('BLANK values read as unset (Railway allows `KEY=`): no boot failure, no 0', () => {
    clearAll();
    for (const name of P2P3_ENVS) vi.stubEnv(name, '');
    const c = new AppConfigService();
    expect(c.processRole).toBe('all');
    expect(c.positionsWriteSkip).toBe('on');
    expect(c.positionsWriteSkipAge).toBe('bucket');
    expect(c.positionsGasRevalue).toBe('full-write');
    expect(c.rpcMonthlyCap).toBe(150_000_000);
    expect(c.backfillHeldMaxWaitMs).toBe(2_700_000);
    expect(c.positionsForcedRewriteMs).toBe(21_600_000);
    expect(c.writeBudget).toEqual(WRITE_BUDGET_OFF);
    expect(c.mongoMaxPoolSize).toBe(60);
    expect(c.indexerGatewayConfig.maxInFlight).toBe(12);
    expect(resolveFeeP3Settings(c).maxInFlight).toBe(64);
    expect(c.usageWriteMode).toBe('direct');
    expect(c.usageFlushIntervalMs).toBe(10_000);
  });

  it('values are read through (case-insensitive enums), and garbage numbers fall back to the default', () => {
    clearAll();
    vi.stubEnv('PROCESS_LEASES', 'ON');
    vi.stubEnv('AUTH_LIMITER_STORE', 'Redis');
    vi.stubEnv('CACHE_INVALIDATION', 'redis');
    vi.stubEnv('INDEXER_BUDGET_SCOPE', 'shared');
    vi.stubEnv('RPC_BUDGET_PER_SEC', '300');
    vi.stubEnv('RPC_ACCOUNT_MAP', ' api.dwellir.com=main ');
    vi.stubEnv('RPC_MONTHLY_CAP', 'lots');
    vi.stubEnv('POSITIONS_WRITE_SKIP', 'shadow');
    vi.stubEnv('POSITIONS_FORCED_REWRITE_MS', '1000');
    vi.stubEnv('WRITE_BUDGET_MODE', 'enforce');
    vi.stubEnv('MONGO_BULK_WRITE_MAX_OPS', '500');
    vi.stubEnv('BACKFILL_PAGING', 'tokenid');
    vi.stubEnv('BACKFILL_PIPELINE', 'on');
    vi.stubEnv('BACKFILL_LOOKAHEAD_PAGES', '40');
    vi.stubEnv('BACKFILL_FEE_READ', 'on');
    vi.stubEnv('PRICE_MISS_LEDGER', 'on');
    vi.stubEnv('GECKOTERMINAL_BUDGET', 'shared');
    vi.stubEnv('GECKOTERMINAL_LOCAL_SHARE', '2');
    vi.stubEnv('POSITION_FEE_BATCH_SIZE_BY_CHAIN', '1:400');
    vi.stubEnv('POSITION_FEE_CONCURRENCY_BY_CHAIN', '4663:32');
    vi.stubEnv('POSITION_FEE_CANDIDATES', 'memory');
    vi.stubEnv('POSITION_FEE_BUDGET', 'per-chain');
    vi.stubEnv('POSITION_FEE_HEAD_PER', 'page');
    vi.stubEnv('FEE_SIGNALS_TRANSPORT', 'redis');
    const c = new AppConfigService();
    expect(c.processLeasesEnabled).toBe(true); // `on` in role all
    expect(c.authLimiterStore).toBe('redis');
    expect(c.cacheInvalidation).toBe('redis');
    expect(c.indexerGatewayConfig.scope).toBe('shared');
    expect(c.rpcBudgetPerSec).toBe(300);
    expect(c.rpcAccountMap).toBe('api.dwellir.com=main');
    expect(c.rpcMonthlyCap).toBe(150_000_000);
    expect(c.positionsWriteSkip).toBe('shadow');
    // Below 60 s the reader keeps the 6 h default (never a boot failure).
    expect(writeSkipSettings(c as never).forcedRewriteMs).toBe(21_600_000);
    expect(c.writeBudget).toMatchObject({ mode: 'enforce', maxOps: 500 });
    expect(c.backfillPaging).toBe('tokenid');
    expect(c.backfillPipeline).toBe(true);
    expect(c.backfillLookaheadPages).toBe(8);
    expect(c.backfillFeeRead).toBe(true);
    expect(c.priceMissLedger).toBe('on');
    expect(c.geckoterminalBudget).toBe('shared');
    expect(c.geckoterminalLocalShare).toBeUndefined(); // 2 is out of (0, 1]
    const fee = resolveFeeP3Settings(c);
    expect(fee.batchByChain.get(1)).toBe(400);
    expect(fee.concurrencyByChain.get(4663)).toBe(32);
    expect(fee).toMatchObject({ candidates: 'memory', budget: 'per-chain', headPer: 'page', signalsTransport: 'redis' });
  });

  it('the write budget settings are memoised (one object for the process)', () => {
    clearAll();
    vi.stubEnv('WRITE_BUDGET_MODE', 'observe');
    const c = new AppConfigService();
    expect(c.writeBudget).toBe(c.writeBudget);
    expect(c.writeBudget.mode).toBe('observe');
  });

  it('PROCESS_STATUS_PUBLISH_MS: unset = undefined (the service applies statusPublishMsDefault), explicit wins, garbage = unset', () => {
    clearAll();
    vi.stubEnv('PROCESS_STATUS_PUBLISH_MS', '5000');
    expect(new AppConfigService().processStatusPublishMs).toBe(5_000);
    vi.stubEnv('PROCESS_STATUS_PUBLISH_MS', '0');
    expect(new AppConfigService().processStatusPublishMs).toBe(0);
    vi.stubEnv('PROCESS_STATUS_PUBLISH_MS', 'often');
    expect(new AppConfigService().processStatusPublishMs).toBeUndefined();
  });

  it('USAGE_WRITE_MODE / USAGE_FLUSH_INTERVAL_MS: case-insensitive enum (unknown refuses the boot); interval clamped 1 s – 5 min', () => {
    clearAll();
    vi.stubEnv('USAGE_WRITE_MODE', 'BATCHED');
    vi.stubEnv('USAGE_FLUSH_INTERVAL_MS', '500');
    let c = new AppConfigService();
    expect(c.usageWriteMode).toBe('batched');
    expect(c.usageFlushIntervalMs).toBe(1_000);
    vi.stubEnv('USAGE_WRITE_MODE', 'drain');
    vi.stubEnv('USAGE_FLUSH_INTERVAL_MS', '900000');
    c = new AppConfigService();
    expect(c.usageWriteMode).toBe('drain');
    expect(c.usageFlushIntervalMs).toBe(300_000);
    vi.stubEnv('USAGE_FLUSH_INTERVAL_MS', 'often');
    expect(new AppConfigService().usageFlushIntervalMs).toBe(10_000);
    vi.stubEnv('USAGE_FLUSH_INTERVAL_MS', '-1');
    expect(new AppConfigService().usageFlushIntervalMs).toBe(10_000);
    vi.stubEnv('USAGE_WRITE_MODE', 'buffered');
    expect(() => new AppConfigService()).toThrow(/Invalid positions-backend configuration/);
  });

  it('UsageFlushService reads these getters by NAME (the structural contract): unset = direct, inert', () => {
    clearAll();
    const direct = new UsageFlushService(new AppConfigService(), {} as never, {} as never);
    expect(direct.configuredMode).toBe('direct');
    expect(direct.batching).toBe(false);
    expect(direct.intervalMs).toBe(10_000);
    vi.stubEnv('USAGE_WRITE_MODE', 'batched');
    vi.stubEnv('USAGE_FLUSH_INTERVAL_MS', '15000');
    const batched = new UsageFlushService(new AppConfigService(), {} as never, {} as never);
    expect(batched.configuredMode).toBe('batched');
    expect(batched.batching).toBe(true);
    expect(batched.intervalMs).toBe(15_000);
    expect(batched.staleMs).toBe(90_000); // max(60 s, 6 × interval)
  });

  it('POSITIONS_REFRESH_QUEUE_CONCURRENCY is bounded 1–64 here; the enforce-only clamp is QueueService\'s alone', () => {
    clearAll();
    vi.stubEnv('POSITIONS_REFRESH_QUEUE_CONCURRENCY', '4');
    expect(new AppConfigService().positionsRefreshQueueConcurrency).toBe(4);
    vi.stubEnv('POSITIONS_REFRESH_QUEUE_CONCURRENCY', '500');
    expect(new AppConfigService().positionsRefreshQueueConcurrency).toBe(64);
    vi.stubEnv('POSITIONS_REFRESH_QUEUE_CONCURRENCY', '0');
    expect(new AppConfigService().positionsRefreshQueueConcurrency).toBe(1);
  });
});

describe('P2.1 roles — boot refusal and per-role defaults', () => {
  it('a split role with PROCESS_LEASES=off refuses to boot ([alert] process_role.no_leases)', () => {
    clearAll();
    vi.stubEnv('PROCESS_ROLE', 'sync');
    vi.stubEnv('PROCESS_LEASES', 'off');
    expect(() => new AppConfigService()).toThrow(/process_role\.no_leases/);
  });

  it('an unknown role fails the Zod parse (no silent `all`)', () => {
    clearAll();
    vi.stubEnv('PROCESS_ROLE', 'worker');
    expect(() => new AppConfigService()).toThrow(/Invalid positions-backend configuration/);
  });

  it.each([
    ['api', 12, 2_000, 3, 1, 0.25, true],
    ['sync', 30, 30_000, 6, 0, 0.5, false],
    ['fee', 15, 30_000, 2, 0, 0.25, false],
    ['feeder', 5, 30_000, 2, 0, 0.25, false],
  ] as const)('role %s (auto → leases on): pool %d / wait %d ms, in-flight %d reserve %d, local share %d, interactive %s', (role, pool, wait, inFlight, reserve, share, interactive) => {
    clearAll();
    vi.stubEnv('PROCESS_ROLE', role);
    const c = new AppConfigService();
    expect(c.processRole).toBe(role);
    expect(c.processLeasesEnabled).toBe(true);
    expect(c.mongoMaxPoolSize).toBe(pool);
    expect(c.mongoWaitQueueTimeoutMs).toBe(wait);
    expect(c.mongoAppName).toBe(`tickwise-${role}`);
    expect(c.indexerGatewayConfig).toMatchObject({ maxInFlight: inFlight, interactiveReservedInFlight: reserve, localShare: share, servesInteractive: interactive });
    expect(c.writeBudget.runController).toBe(role !== 'feeder');
  });

  it('an explicit env always beats the role default', () => {
    clearAll();
    vi.stubEnv('PROCESS_ROLE', 'api');
    vi.stubEnv('MONGO_MAX_POOL_SIZE', '10');
    vi.stubEnv('MONGO_WAIT_QUEUE_TIMEOUT_MS', '1500');
    vi.stubEnv('INDEXER_MAX_IN_FLIGHT', '2');
    vi.stubEnv('INDEXER_INTERACTIVE_RESERVED_IN_FLIGHT', '1');
    vi.stubEnv('INDEXER_BUDGET_LOCAL_SHARE', '0.2');
    vi.stubEnv('MONGO_APP_NAME', 'tickwise-api-2');
    const c = new AppConfigService();
    expect(c.mongoMaxPoolSize).toBe(10);
    expect(c.mongoWaitQueueTimeoutMs).toBe(1_500);
    expect(c.mongoAppName).toBe('tickwise-api-2');
    expect(c.indexerGatewayConfig).toMatchObject({ maxInFlight: 2, interactiveReservedInFlight: 1, localShare: 0.2 });
  });
});
