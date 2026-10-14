#!/usr/bin/env node
// Quota counter reseed: run once after the MAIN Redis (REDIS_URL) has lost data.
//
// WHY: the monthly quota is enforced ONLY from Redis — rate-limiter-flexible
// keeps one counter per customer per month at `meter:quota:<customerId>:<YYYY-MM>`
// (`MeteringService.quotaLimiter`). When the main Redis comes back empty (2026-10-04
// 11:54 IST: a start-command change), every counter restarts at 0, so every
// customer silently gets back the units they had already used this month, and an
// exhausted customer is unblocked until the 1st. Nothing errors, so nothing alerts.
//
// The Mongo `usage` collection holds a per-customer, per-month snapshot of the
// same charges (`MeteringService.snapshotUsage`, compensated on every refund), so
// it survives exactly what Redis lost. This script raises each counter to
// max(Redis, Mongo):
//   - it never LOWERS a counter, so it is safe when Redis did NOT lose data
//     (every counter is already ≥ its snapshot → nothing changes) and safe to
//     run twice — a second `--apply` closes the gap left by requests charged
//     while the first one ran;
//   - each row is re-read from the PRIMARY immediately before its write, and the
//     write is ONE atomic Lua call (read + compare + set), so the stale window is
//     one round trip, not the length of the run;
//   - an existing key keeps its TTL; a missing key gets the limiter's own 35 days.
//
// SKIPPED, never written:
//   - `quotaResetAt` set this period: an involuntary downgrade zeroed that
//     customer's counter on purpose (`MeteringService.resetQuotaPeriod`) while
//     the snapshot kept counting, so reseeding would re-impose units the reset
//     forgave. A reset that lands WHILE this runs is re-checked per row, and any
//     key raised for a customer reset after the run started is deleted again.
//   - an unlimited plan (`monthlyUnits` 0), a missing customer or plan: no quota
//     is enforced, so there is nothing to restore.
//
// HELD FOR REVIEW (diagnose lists them; `--apply` writes them only when named in
// `--include=<id,id>`), because the snapshot can hold units the live counter
// never charged and the customer must not be blocked for them:
//   - the customer document changed this period (a plan move from an unlimited
//     plan — `snapshotUsage` counts units on unlimited plans, the quota does
//     not — or an admin `assignPlan`);
//   - the customer's plan document changed this period (e.g. `monthlyUnits`
//     edited from 0);
//   - the raise would take a counter from under the limit to at/over it, i.e.
//     start answering 429 until the 1st.
//
// Accuracy otherwise: the snapshot is best-effort (a failed write is lost) and
// never records a 429'd attempt, while the Redis counter does count a 429'd
// consume — both under-count, in the customer's favour. Fail-open requests (Redis
// unreachable) are in the snapshot but were never charged: grep the logs for
// `[alert] metering.fail_open` in the period first.
//
// Usage (from backend/). Keep the secrets out of shell history: put MONGODB_URI
// and REDIS_URL in a file outside the repo and pass it with --env-file.
//   node --env-file=/secure/prod-reseed.env scripts/quota-counter-reseed.mjs            (diagnose)
//   node --env-file=/secure/prod-reseed.env scripts/quota-counter-reseed.mjs --apply    (write)
//   …--period=2026-10            (default: the current UTC month)
//   …--customer=<24-hex id>      (one customer only)
//   …--include=<id,id>           (also write these held-for-review rows)
//   …--force-redis               (write even if REDIS_URL does not look like the main Redis)
// REDIS_URL must be the MAIN Redis (the one BullMQ uses), never read-model-redis.
// Railway: the main Redis service's REDIS_PUBLIC_URL, from your laptop.
import mongoose from 'mongoose';
import { Redis } from 'ioredis';

const QUOTA_PREFIX = 'meter:quota'; // MeteringService.quotaLimiter keyPrefix
const QUOTA_DURATION_SEC = 35 * 24 * 60 * 60; // MeteringService QUOTA_DURATION_SEC
// Keys BullMQ keeps on the main Redis for the life of a queue (queue.service.ts /
// payments-queue.service.ts, default `bull` prefix). read-model-redis never has them.
const MAIN_REDIS_MARKERS = ['bull:payments:meta', 'bull:positions-sync:meta', 'bull:background-sweeps:meta'];

// Raise KEYS[1] to ARGV[1] if lower. Returns {before, after, code}:
// code 1 = raised, 0 = already ≥ target, -1 = value is not an integer (left alone).
const RAISE_LUA = `
local raw = redis.call('GET', KEYS[1])
local cur = 0
if raw then
  cur = tonumber(raw)
  if cur == nil or cur ~= math.floor(cur) then return {0, 0, -1} end
end
local target = tonumber(ARGV[1])
if target <= cur then return {cur, cur, 0} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then
  redis.call('SET', KEYS[1], target, 'PX', ttl)
else
  redis.call('SET', KEYS[1], target, 'EX', tonumber(ARGV[2]))
end
return {cur, target, 1}
`;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

const HEX24 = /^[0-9a-f]{24}$/i;

function parseArgs(argv) {
  const out = { apply: false, period: undefined, customer: undefined, include: new Set(), forceRedis: false };
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true;
    else if (arg === '--force-redis') out.forceRedis = true;
    else if (arg.startsWith('--period=')) out.period = arg.slice('--period='.length);
    else if (arg.startsWith('--customer=')) out.customer = arg.slice('--customer='.length);
    else if (arg.startsWith('--include=')) {
      for (const id of arg.slice('--include='.length).split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!HEX24.test(id)) fail(`--include ids must be 24-character hex, got '${id}'`);
        out.include.add(id.toLowerCase());
      }
    } else fail(`unknown argument '${arg}' (expected --apply, --period=YYYY-MM, --customer=<id>, --include=<id,id>, --force-redis)`);
  }
  return out;
}

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** scheme://host[:port][/db] for the known URL schemes only — never credentials. */
function describeUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['redis:', 'rediss:', 'mongodb:', 'mongodb+srv:'].includes(u.protocol)) return '(redacted: unexpected URL scheme)';
    return `${u.protocol}//${u.host}${u.pathname && u.pathname !== '/' ? u.pathname : ''}`;
  } catch {
    return '(redacted: unparseable URL)';
  }
}

/** Remove both URLs' passwords (raw and decoded) from an error message. */
function scrub(text, urls) {
  let out = String(text);
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      for (const secret of [u.password, decodeURIComponent(u.password), u.username && u.password ? `${u.username}:${u.password}` : '']) {
        if (secret && secret.length >= 4) out = out.split(secret).join('***');
      }
    } catch {
      out = out.split(raw).join('(redacted url)');
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const period = args.period ?? currentPeriod();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail(`--period must be YYYY-MM, got '${period}'`);
  if (args.customer !== undefined && !HEX24.test(args.customer)) {
    fail(`--customer must be a 24-character hex id, got '${args.customer}'`);
  }
  const mongoUri = process.env.MONGODB_URI;
  const redisUrl = process.env.REDIS_URL;
  if (!mongoUri) fail('MONGODB_URI is not set');
  if (!redisUrl) fail('REDIS_URL is not set (the MAIN Redis, not read-model-redis)');
  const periodStart = new Date(`${period}-01T00:00:00.000Z`);
  const runStartedAt = new Date();

  console.log(`mode     : ${args.apply ? 'APPLY (writes Redis)' : 'diagnose (read-only)'}`);
  console.log(`period   : ${period}${period === currentPeriod() ? '' : '  (NOT the current month — its counter no longer gates anything)'}`);
  console.log(`mongo    : ${describeUrl(mongoUri)}`);
  console.log(`redis    : ${describeUrl(redisUrl)}`);

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15_000 });
  const db = mongoose.connection.db;
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 10_000, lazyConnect: true });
  // ioredis reports a refused AUTH / DNS failure as an 'error' event and then
  // rejects connect() with a bare "Connection is closed" — keep the real reason.
  let lastRedisError = '';
  redis.on('error', (err) => {
    lastRedisError = err?.message ?? String(err);
  });
  let failures = 0;
  try {
    try {
      await redis.connect();
    } catch (err) {
      throw new Error(`cannot connect to REDIS_URL: ${lastRedisError || err?.message || err}`);
    }

    // Is this the MAIN Redis? BullMQ keeps a `meta` hash per queue there for good.
    const markers = (await Promise.all(MAIN_REDIS_MARKERS.map((k) => redis.exists(k)))).reduce((a, b) => a + b, 0);
    let quotaKeysSeen = 0;
    {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${QUOTA_PREFIX}:*:${period}`, 'COUNT', 1000);
        cursor = next;
        quotaKeysSeen += keys.length;
      } while (cursor !== '0' && quotaKeysSeen < 10_000);
    }
    console.log(`redis id : ${markers}/${MAIN_REDIS_MARKERS.length} BullMQ queue markers, ${quotaKeysSeen} ${period} quota keys present`);
    if (markers === 0) {
      const msg = 'REDIS_URL has none of the BullMQ queue markers — this does not look like the MAIN Redis';
      if (args.apply && !args.forceRedis) fail(`${msg}. Refusing to write (pass --force-redis to override).`);
      console.log(`WARN     : ${msg}.`);
    }

    const plans = new Map();
    for (const p of await db.collection('plans').find({}, { projection: { key: 1, monthlyUnits: 1, updatedAt: 1 } }).toArray()) {
      plans.set(p.key, { limit: Number(p.monthlyUnits) || 0, updatedAt: p.updatedAt ? new Date(p.updatedAt) : undefined });
    }

    const usageFilter = { period };
    if (args.customer) usageFilter.customerId = new mongoose.Types.ObjectId(args.customer);
    const rows = await db.collection('usage').find(usageFilter, { projection: { _id: 1, customerId: 1 } }).toArray();

    const customerIds = rows.map((r) => r.customerId).filter(Boolean);
    const customers = new Map();
    for (const c of await db
      .collection('customers')
      .find({ _id: { $in: customerIds } }, { projection: { planKey: 1, planSource: 1, updatedAt: 1 } })
      .toArray()) {
      customers.set(String(c._id), c);
    }

    const tally = { rows: rows.length, raise: 0, keep: 0, skipped: 0, held: 0, corrupt: 0, failed: 0, unitsRestored: 0 };
    const raisedKeys = new Map(); // customerId → key, for the post-run reset re-check
    const heldRows = [];
    const print = (r) =>
      console.log(
        `${r.action.padEnd(34)} ${r.id}  plan=${String(r.plan).padEnd(10)} limit=${String(r.limit).padEnd(9)} mongo=${String(r.mongo).padEnd(9)} redis ${r.before} -> ${r.after}`,
      );
    console.log('');

    for (const row of rows) {
      const id = String(row.customerId);
      // Re-read from the PRIMARY right before deciding: a charge or a quota reset
      // made since the run started must be seen (stale window = one round trip).
      const fresh = await db
        .collection('usage')
        .findOne({ _id: row._id }, { projection: { unitsConsumed: 1, quotaResetAt: 1 }, readPreference: 'primary' });
      const customer = customers.get(id);
      const units = Math.floor(Number(fresh?.unitsConsumed) || 0);
      const plan = customer ? plans.get(customer.planKey) : undefined;
      let skip;
      if (!fresh) skip = 'row-gone';
      else if (!customer) skip = 'no-customer';
      else if (fresh.quotaResetAt) skip = 'quota-reset-this-period';
      else if (!plan) skip = `unknown-plan:${customer.planKey}`;
      else if (plan.limit <= 0) skip = 'unlimited-plan';
      else if (units <= 0) skip = 'no-units';
      if (skip) {
        tally.skipped += 1;
        print({ id, plan: customer?.planKey ?? '-', limit: plan?.limit ?? '-', mongo: units, before: '-', after: '-', action: `skip (${skip})` });
        continue;
      }

      const key = `${QUOTA_PREFIX}:${id}:${period}`;
      try {
        const raw = await redis.get(key);
        const cur = raw === null ? 0 : Number(raw);
        if (!Number.isInteger(cur)) {
          tally.corrupt += 1;
          print({ id, plan: customer.planKey, limit: plan.limit, mongo: units, before: raw, after: '?', action: 'LEFT ALONE (non-integer in Redis)' });
          continue;
        }
        if (units <= cur) {
          tally.keep += 1;
          print({ id, plan: customer.planKey, limit: plan.limit, mongo: units, before: cur, after: cur, action: args.apply ? 'kept' : 'would keep' });
          continue;
        }
        const reasons = [];
        if (customer.updatedAt && new Date(customer.updatedAt) >= periodStart) reasons.push('customer-changed-this-month');
        if (plan.updatedAt && plan.updatedAt >= periodStart) reasons.push('plan-changed-this-month');
        if (cur < plan.limit && units >= plan.limit) reasons.push('would-hit-limit');
        if (reasons.length > 0 && !args.include.has(id.toLowerCase())) {
          tally.held += 1;
          heldRows.push({ id, reasons });
          print({ id, plan: customer.planKey, limit: plan.limit, mongo: units, before: cur, after: cur, action: `HELD (${reasons.join(',')})` });
          continue;
        }
        if (!args.apply) {
          tally.raise += 1;
          tally.unitsRestored += units - cur;
          print({ id, plan: customer.planKey, limit: plan.limit, mongo: units, before: cur, after: units, action: reasons.length ? 'would raise (--include)' : 'would raise' });
          continue;
        }
        const [b, a, code] = await redis.eval(RAISE_LUA, 1, key, String(units), String(QUOTA_DURATION_SEC));
        if (code === -1) {
          tally.corrupt += 1;
          print({ id, plan: customer.planKey, limit: plan.limit, mongo: units, before: '?', after: '?', action: 'LEFT ALONE (non-integer in Redis)' });
        } else if (code === 1) {
          tally.raise += 1;
          tally.unitsRestored += a - b;
          raisedKeys.set(id, key);
          print({ id, plan: customer.planKey, limit: plan.limit, mongo: units, before: b, after: a, action: reasons.length ? 'raised (--include)' : 'raised' });
        } else {
          tally.keep += 1;
          print({ id, plan: customer.planKey, limit: plan.limit, mongo: units, before: b, after: a, action: 'kept' });
        }
      } catch (err) {
        failures += 1;
        tally.failed += 1;
        print({ id, plan: customer.planKey, limit: plan.limit, mongo: units, before: '?', after: '?', action: `FAILED (${scrub(err?.message ?? err, [mongoUri, redisUrl])})` });
      }
    }

    // A quota reset (involuntary downgrade) that landed after its row was read
    // must still win: delete any key this run raised for such a customer.
    if (args.apply && raisedKeys.size > 0) {
      const resetSince = await db
        .collection('usage')
        .find({ period, quotaResetAt: { $gte: runStartedAt } }, { projection: { customerId: 1 }, readPreference: 'primary' })
        .toArray();
      for (const r of resetSince) {
        const key = raisedKeys.get(String(r.customerId));
        if (!key) continue;
        await redis.del(key);
        console.log(`reset during run → deleted ${key} again (the downgrade's reset stands)`);
      }
    }

    console.log('');
    console.log(
      `usage rows ${tally.rows} | ${args.apply ? 'raised' : 'would raise'} ${tally.raise} | already ≥ snapshot ${tally.keep} | held ${tally.held} | skipped ${tally.skipped} | non-integer ${tally.corrupt} | failed ${tally.failed}`,
    );
    console.log(`units ${args.apply ? 'restored' : 'to restore'}: ${tally.unitsRestored}`);
    if (heldRows.length > 0) {
      console.log(`\nHELD for review (${heldRows.length}). Check each customer's plan history this month and the`);
      console.log(`logs for '[alert] metering.fail_open'; write the ones that are right with --include=<id,id>:`);
      for (const h of heldRows) console.log(`  ${h.id}  ${h.reasons.join(', ')}`);
    }
    if (!args.apply) console.log('\nDiagnose only. Re-run with --apply to write.');
    else console.log('\nRun --apply once more: it is idempotent and closes the gap left by requests charged during this run.');
  } finally {
    await redis.quit().catch(() => undefined);
    await mongoose.disconnect().catch(() => undefined);
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`FAILED: ${scrub(err?.stack ?? err, [process.env.MONGODB_URI, process.env.REDIS_URL])}`);
  process.exit(1);
});
