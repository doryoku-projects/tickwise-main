/*
 * The write budget against a REAL MongoDB replica set (opt-in):
 *  - `budgetedBulkWrite` through Mongoose 9 reaches the server in ≤ 500-op
 *    chunks and the driver applies the per-chunk `timeoutMS` (CSOT → the
 *    command carries `maxTimeMS`); with the budget off it carries none;
 *  - `MongoMonitor` reads dirty % and the oplog window as a real user can;
 *  - the driver's heartbeat `hello` replies carry `lastWrite.majorityWriteDate`
 *    on the primary, so the majority-lag input is real and free.
 *
 *   WRITE_BUDGET_TEST_MONGO_URI='mongodb://127.0.0.1:27091/?replicaSet=wbtest' npx vitest run test/write-budget/mongo-contract.spec.ts
 *
 * Use a THROWAWAY replica set: the spec drops its own database.
 */
import mongoose, { Schema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WriteBudgetService } from '../../src/common/write-budget.js';
import { resolveWriteBudgetSettings } from '../../src/common/write-budget-model.js';
import { budgetedBulkWrite, BUDGETED_CHUNK_TIMEOUT_MS } from '../../src/database/budgeted-write.js';
import { MongoMonitor } from '../../src/database/mongo-monitor.js';
import { observeHeartbeat, resetReplicationLag, writeLagMs, type HeartbeatReply } from '../../src/database/replication-lag.js';
import { fakeClock, FakeRedis } from './fake-redis.js';

const URI = process.env.WRITE_BUDGET_TEST_MONGO_URI;

describe.skipIf(!URI)('write budget against a real replica set', () => {
  let conn: mongoose.Connection;
  const commands: Array<{ name: string; n: number; maxTimeMS?: number }> = [];
  const heartbeats: HeartbeatReply[] = [];

  beforeAll(async () => {
    conn = mongoose.createConnection(URI!, { dbName: 'wb_contract', monitorCommands: true, heartbeatFrequencyMS: 500 });
    await conn.asPromise();
    const client = conn.getClient();
    client.on('commandStarted', (e: { commandName: string; command: Record<string, unknown> }) => {
      if (e.commandName === 'update') {
        commands.push({ name: 'update', n: (e.command.updates as unknown[]).length, maxTimeMS: e.command.maxTimeMS as number | undefined });
      }
    });
    client.on('serverHeartbeatSucceeded', (e: { connectionId: string; reply?: HeartbeatReply }) => {
      heartbeats.push(e.reply ?? {});
      observeHeartbeat(e.connectionId, e.reply, Date.now(), 1e9);
    });
    await conn.dropDatabase();
  });

  afterAll(async () => {
    await conn?.dropDatabase().catch(() => undefined);
    await conn?.close();
    resetReplicationLag();
  });

  const model = () => conn.models.Row ?? conn.model('Row', new Schema({ k: Number, v: Number }, { collection: 'rows' }));
  const ops = (n: number, v: number) => Array.from({ length: n }, (_, k) => ({ updateOne: { filter: { k }, update: { $set: { k, v } }, upsert: true } }));

  it('budget off: one update command for the whole batch, no maxTimeMS (today)', async () => {
    commands.length = 0;
    const out = await budgetedBulkWrite(model(), ops(1200, 1), { bulkOptions: { ordered: false } });
    expect(out.upsertedCount).toBe(1200);
    expect(commands).toEqual([{ name: 'update', n: 1200, maxTimeMS: undefined }]);
  });

  it('budget on: ≤ 500 ops per command, each carrying the CSOT maxTimeMS', async () => {
    const clock = fakeClock();
    const svc = new WriteBudgetService(
      { writeBudget: resolveWriteBudgetSettings({ WRITE_BUDGET_MODE: 'enforce' }) } as never,
      { client: async () => new FakeRedis(clock.now) as never, namespace: 'mc' },
      { now: clock.now, sleep: clock.sleep },
    );
    (svc as unknown as { logger: unknown }).logger = { warn: () => {}, log: () => {} };
    commands.length = 0;
    const out = await budgetedBulkWrite(model(), ops(1200, 2), { budget: svc, unitsPerOp: 1, bulkOptions: { ordered: false } });
    expect(out.modifiedCount).toBe(1200);
    expect(commands.map((c) => c.n)).toEqual([500, 500, 200]);
    for (const c of commands) {
      expect(c.maxTimeMS).toBeGreaterThan(0);
      expect(c.maxTimeMS).toBeLessThanOrEqual(BUDGETED_CHUNK_TIMEOUT_MS);
    }
    expect(await model().countDocuments({ v: 2 })).toBe(1200);
  });

  it('the monitor reads dirty % and the oplog window', async () => {
    const monitor = new MongoMonitor({ mongoMonitorUri: URI } as never);
    const reading = await monitor.sample();
    await monitor.onModuleDestroy();
    expect(reading.error).toBeUndefined();
    expect(reading.dirtyPct).toBeGreaterThanOrEqual(0);
    expect(reading.dirtyPct).toBeLessThanOrEqual(100);
    expect(reading.oplogWindowSec).toBeGreaterThanOrEqual(0);
  });

  it('primary heartbeats carry majorityWriteDate, so the majority-lag input has a value', async () => {
    const deadline = Date.now() + 10_000;
    while (writeLagMs().majorityLagMs === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(heartbeats.some((h) => h.lastWrite?.majorityWriteDate !== undefined)).toBe(true);
    const lag = writeLagMs();
    expect(lag.majorityLagMs).toBeGreaterThanOrEqual(0);
    expect(lag.majorityLagMs).toBeLessThan(60_000);
  });
});
