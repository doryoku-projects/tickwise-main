#!/usr/bin/env node
// Billing self-serve migration: prepares the global `customers` and `plans`
// collections for the subscriptions work (customer-owned logins, per-plan
// self-serve prices) BEFORE the schema that declares them is deployed.
//
// What it does, in order:
//   1. reports duplicate customer emails (grouped case-insensitively)
//   2. $unsets explicit `email: null` — a stored null is NOT a missing field,
//      and the partial index in step 4 treats the two very differently
//   3. REFUSES to go further while duplicates remain. Merging is deliberately
//      NOT automated: customers own API keys and usage history, so picking the
//      surviving row is a human decision.
//   4. creates the partial-unique index on `customers.email`
//   5. backfills `plans.prices[]` from the legacy float `plans.price`
//   6. backfills `customers.origin` / `planSource` / `creditBalanceMinor`
//   7. RECONCILES the seeded plan keys against `PLAN_SEEDS` — fills any of
//      maxApiKeys / allowBrowserKeys / description / features that is absent or
//      empty, and leaves every value an operator actually chose alone
//   8. INSERTS `endpoint_costs` rows for route keys present in
//      `ENDPOINT_COST_SEEDS` but missing from the collection
//   9. reports (and, only behind `--reprice-endpoints`, applies) the seeded unit
//      cost ladder onto rows that already exist at a different price
//
// WHY 7–9 EXIST: both seed lists are inserted ONLY when their collection is
// EMPTY (`SettingsCacheService.seedIfEmpty`). Every field and every route added
// after first boot is therefore invisible to an existing database, forever, with
// no error anywhere — the plan rows simply lack `maxApiKeys`/`allowBrowserKeys`,
// `SettingsCacheService.refresh` normalizes the absence FAIL-CLOSED (1 key, no
// browser keys), and a paying customer silently gets the Free entitlement while
// the pricing page advertises otherwise. Steps 7–9 are the reconciler that was
// missing, and they are re-runnable: a second run reports zero changes.
//
// Steps 7–9 are strictly ADDITIVE by default. Filling an absent field and
// inserting a missing route are safe (they replace a fail-closed default with
// the value the product documents); CHANGING an existing price is not, because
// it changes what customers are billed — hence the separate opt-in flag.
//
// CRITICAL ORDERING: run this with --apply BEFORE deploying the code that
// declares the index. Mongoose `autoIndex` is ON in this app (DatabaseModule
// passes only `uri`), so every declared index is built at boot — and a FAILED
// boot-time build surfaces as a rejected promise that main.ts's
// `unhandledRejection` handler logs and SWALLOWS. The app then boots perfectly
// happily with NO unique index on email, and you discover the problem when a
// duplicate signup succeeds. Deploying first converts a loud migration failure
// into a silent data-integrity hole.
//
// Billing collections are global (un-sharded) and need no domain logic. Steps
// 1–6 therefore run against the raw driver with no application code loaded;
// steps 7–9 are a RECONCILIATION against the seed lists, so they must read the
// real `PLAN_SEEDS` / `ENDPOINT_COST_SEEDS` rather than a copy pasted in here —
// a second copy of the values is exactly the drift this script exists to fix.
// `loadSeeds()` below reads the TypeScript sources directly (no build step) and
// only falls back to `../dist` when it cannot.
//
// Usage: node scripts/billing-subscriptions-migration.mjs          (diagnose)
//        node scripts/billing-subscriptions-migration.mjs --apply  (write)
//        …--apply --reprice-endpoints  (ALSO rewrite existing endpoint costs)
// Non-local: MONGODB_URI=… node scripts/billing-subscriptions-migration.mjs
import mongoose from 'mongoose';

const KNOWN_FLAGS = ['--apply', '--reprice-endpoints'];
const APPLY = process.argv.includes('--apply');
/**
 * Opt-in for step 9 ONLY. Inserting a MISSING endpoint cost row (step 8) is a
 * fix — the route was being charged its decorator fallback because no row
 * existed. Changing an EXISTING row's cost is a pricing decision about live
 * customers' bills, so it never rides along with a routine backfill: without
 * this flag step 9 reports the difference and writes nothing.
 */
const REPRICE_ENDPOINTS = process.argv.includes('--reprice-endpoints');
// A typo'd flag must not read as "the operator declined the option" — that is
// how someone concludes the reprice ran when it silently did not.
const unknownFlags = process.argv.slice(2).filter((arg) => !KNOWN_FLAGS.includes(arg));
if (unknownFlags.length > 0) {
  console.log(`unrecognized argument(s): ${unknownFlags.join(' ')} — known flags are ${KNOWN_FLAGS.join(' ')}`);
  throw new Error(`unrecognized argument(s): ${unknownFlags.join(' ')}`);
}
const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/copypools_positions';
// Both are seeded `price: 0` for reasons that are NOT "free to buy" — `free` is
// the default tier and `enterprise` is sales-negotiated. Neither may become a
// $0 self-serve checkout row.
/**
 * Sales-led plans: never offered on the public pricing page, never checkout-able.
 *
 * `free` is deliberately NOT here. Self-serve and priced are different questions:
 * Free IS self-serve (signing up for it is the whole funnel) — it simply has no
 * price row. Lumping it in with `enterprise` because both are seeded `price: 0`
 * removes Free from `listPublicPlans()` (which filters on `enabled && selfServe`)
 * and ships a pricing page with no free tier. `plans.seed.ts` has always seeded
 * `free` as `selfServe: true`; this list must not contradict it.
 */
const NO_SELF_SERVE_PLANS = ['enterprise'];
/** Plans that are self-serve but carry NO price row — nothing to charge for. */
const FREE_PLANS = ['free'];
const SAMPLE_LIMIT = 20;

// Byte-identical to what the schema declares, so a boot-time autoIndex pass is
// a no-op against it (a differing name/options pair throws IndexOptionsConflict
// on whichever runs second).
const EMAIL_INDEX_KEY = { email: 1 };
const EMAIL_INDEX_OPTIONS = {
  unique: true,
  partialFilterExpression: { email: { $type: 'string' } },
};

/**
 * Plan fields step 7 reconciles. Every entry must also exist on `Plan` and in
 * the field-by-field copy in `SettingsCacheService.refresh` — a field missing
 * from any of the three is a field an existing install never receives.
 *
 * `key`/`name`/`monthlyUnits`/`rateLimitPerMin`/`price`/`prices`/`enabled`/
 * `selfServe` are deliberately ABSENT: those are the numbers an operator prices
 * and tunes (this database already runs Standard at $19, not the seeded $99),
 * and reconciling them would overwrite the business with the defaults.
 */
const RECONCILED_PLAN_FIELDS = ['maxApiKeys', 'allowBrowserKeys', 'description', 'features'];

/**
 * "Absent or empty" per the reconciliation contract: undefined, null, `''`, or
 * `[]`. Everything else is a value someone chose and MUST survive — in
 * particular `allowBrowserKeys: false` (a deliberate denial) and
 * `maxApiKeys: 0` (which means UNLIMITED here, the most generous setting there
 * is). A falsy test would clobber both, turning a reconciler into a reset.
 * A whitespace-only string counts as set, deliberately: the contract says `''`,
 * and guessing at intent is how a reconciler starts overwriting real values.
 */
const isUnsetValue = (value) => {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

const describeValue = (value) => (Array.isArray(value) ? `[${value.length} item(s)]` : JSON.stringify(value));

const BACKEND_ROOT = new URL('../', import.meta.url);
const SEED_SOURCES = ['src/billing/plans.seed.ts', 'src/billing/endpoint-costs.seed.ts'];
const SEED_BUILT = ['dist/billing/plans.seed.js', 'dist/billing/endpoint-costs.seed.js'];

const importSeedPair = (relativePaths) =>
  Promise.all(relativePaths.map((rel) => import(new URL(rel, BACKEND_ROOT).href)));

/**
 * Load the REAL seed lists rather than a copy. Both seed modules are pure data
 * with type-only imports, so nothing else in the app is pulled in.
 *
 * Source first, `dist` last, and that order is the whole point: `dist` is stale
 * whenever someone edited a seed without rebuilding, and reconciling a database
 * against a stale build is the same drift bug one level up. Falling back to it
 * is loud.
 */
async function loadSeeds() {
  const attempts = [];
  // 1. tsx (a devDependency of this backend) over the TypeScript source.
  try {
    const { register } = await import('tsx/esm/api');
    const unregister = register();
    try {
      const [plansMod, costsMod] = await importSeedPair(SEED_SOURCES);
      return { plans: plansMod.PLAN_SEEDS, costs: costsMod.ENDPOINT_COST_SEEDS, from: 'src/ via tsx' };
    } finally {
      unregister();
    }
  } catch (err) {
    attempts.push(`tsx over src/: ${err.message}`);
  }
  // 2. Node's own type stripping (unflagged from v22.18 / v23.6).
  try {
    const [plansMod, costsMod] = await importSeedPair(SEED_SOURCES);
    return { plans: plansMod.PLAN_SEEDS, costs: costsMod.ENDPOINT_COST_SEEDS, from: 'src/ via node type-stripping' };
  } catch (err) {
    attempts.push(`node type-stripping over src/: ${err.message}`);
  }
  // 3. A previous `pnpm build`. Correct only if dist is current — hence the warning.
  try {
    const [plansMod, costsMod] = await importSeedPair(SEED_BUILT);
    console.log('seeds: WARNING — read from dist/, which is only as fresh as the last `pnpm build`');
    return { plans: plansMod.PLAN_SEEDS, costs: costsMod.ENDPOINT_COST_SEEDS, from: 'dist/ (possibly stale)' };
  } catch (err) {
    attempts.push(`dist/: ${err.message}`);
  }
  throw new Error(`cannot load the seed lists — tried:\n  - ${attempts.join('\n  - ')}`);
}

const seeds = await loadSeeds();
const PLAN_SEEDS = seeds.plans;
const ENDPOINT_COST_SEEDS = seeds.costs;
if (!Array.isArray(PLAN_SEEDS) || PLAN_SEEDS.length === 0) throw new Error('PLAN_SEEDS loaded empty — refusing to reconcile against nothing');
if (!Array.isArray(ENDPOINT_COST_SEEDS) || ENDPOINT_COST_SEEDS.length === 0) throw new Error('ENDPOINT_COST_SEEDS loaded empty — refusing to reconcile against nothing');
console.log(`seeds: loaded ${PLAN_SEEDS.length} plan seeds + ${ENDPOINT_COST_SEEDS.length} endpoint-cost seeds from ${seeds.from}`);

const formatDate = (value) => (value instanceof Date ? value.toISOString() : String(value ?? 'unknown'));

await mongoose.connect(URI);
const db = mongoose.connection.db;
const customers = db.collection('customers');
const plans = db.collection('plans');
const endpointCosts = db.collection('endpoint_costs');

// Reads/writes against a missing namespace are no-ops, but `indexes()` throws
// NamespaceNotFound — so a fresh database needs the existence check below.
const collectionNames = (await db.listCollections().toArray()).map((c) => c.name);
const customersExists = collectionNames.includes('customers');
if (!customersExists) console.log('customers: collection does not exist yet on this database');

const customersInspected = await customers.countDocuments({});

// ── 1. duplicate customer emails ─────────────────────────────────────────────
// Grouped on the LOWERCASED email: the schema writes emails through
// `lowercase: true`, but rows created before that (or by hand) can differ only
// in case, and two such rows are the same account to a human.
const duplicates = await customers
  .aggregate([
    { $match: { email: { $type: 'string' } } },
    {
      $group: {
        _id: { $toLower: '$email' },
        count: { $sum: 1 },
        docs: { $push: { id: '$_id', createdAt: '$createdAt', planKey: '$planKey' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1, _id: 1 } },
  ])
  .toArray();

if (duplicates.length === 0) {
  console.log('customers: no duplicate emails');
} else {
  const duplicateDocs = duplicates.reduce((total, group) => total + group.count, 0);
  console.log(`customers: ${duplicates.length} duplicated emails across ${duplicateDocs} documents`);
  for (const group of duplicates.slice(0, SAMPLE_LIMIT)) {
    console.log(`  - ${group._id} (${group.count} documents)`);
    for (const doc of group.docs) {
      console.log(`      ${doc.id} createdAt=${formatDate(doc.createdAt)} planKey=${doc.planKey ?? '(none)'}`);
    }
  }
  if (duplicates.length > SAMPLE_LIMIT) console.log(`  … and ${duplicates.length - SAMPLE_LIMIT} more`);
}

// ── 2. explicit null emails ──────────────────────────────────────────────────
// A bare `{ email: null }` filter would ALSO match documents with no email
// field at all, so match the BSON null TYPE — only the stored nulls get unset,
// and step 4's partial filter then genuinely skips them.
const nullEmailFilter = { email: { $type: 'null' } };
const nullEmails = await customers.countDocuments(nullEmailFilter);
let nullEmailsUnset = 0;
if (nullEmails === 0) {
  console.log('customers: no explicit null emails');
} else if (APPLY) {
  const res = await customers.updateMany(nullEmailFilter, { $unset: { email: '' } });
  nullEmailsUnset = res.modifiedCount;
  console.log(`customers: unset ${res.modifiedCount} null email fields`);
} else {
  console.log(`customers: WOULD unset ${nullEmails} null email fields (dry run)`);
}

// ── 3. refuse the index while duplicates remain ──────────────────────────────
if (duplicates.length > 0) {
  console.log('customers: REFUSING to build the unique email index — merge or delete the duplicates listed above first');
  console.log('aborted — index NOT created; plans and customers NOT backfilled; plan/endpoint reconciliation NOT run');
  await mongoose.disconnect();
  throw new Error(`${duplicates.length} duplicate customer emails — refusing to migrate`);
}

// ── 4. partial-unique email index ────────────────────────────────────────────
// `$type: 'string'`, NOT `$exists: true`. `$exists` also matches `email: null`,
// and Mongo treats multiple nulls as DUPLICATE keys — so an `$exists` filter
// would fail to build on exactly the data this index exists to protect (rows
// with no email are the common case here; email is optional today). Note the
// index is case-SENSITIVE: the schema's `lowercase: true` on email is what
// turns it into a real one-account-per-address guarantee.
const existingIndexes = customersExists ? await customers.indexes() : [];
const existingEmailIndex = existingIndexes.find(
  (ix) => ix.key?.email === 1 && Object.keys(ix.key).length === 1,
);
const emailIndexMatches =
  existingEmailIndex?.unique === true
  && existingEmailIndex?.partialFilterExpression?.email?.$type === 'string';

let indexOutcome;
if (existingEmailIndex && !emailIndexMatches) {
  // Same trap from the other side: a differing spec makes whichever build runs
  // second throw IndexOptionsConflict, and at boot that throw is swallowed.
  console.log(`customers: existing index '${existingEmailIndex.name}' on {email:1} has different options — drop it first: db.customers.dropIndex('${existingEmailIndex.name}')`);
  console.log('aborted — index NOT created; plans and customers NOT backfilled; plan/endpoint reconciliation NOT run');
  await mongoose.disconnect();
  throw new Error(`conflicting index '${existingEmailIndex.name}' on customers.{email:1} — refusing to migrate`);
} else if (existingEmailIndex) {
  indexOutcome = 'already present';
  console.log('customers: unique partial email index already present');
} else if (APPLY) {
  await customers.createIndex(EMAIL_INDEX_KEY, EMAIL_INDEX_OPTIONS);
  indexOutcome = 'created';
  console.log('customers: created unique partial index {email:1} over string emails');
} else {
  indexOutcome = 'not created (dry run)';
  console.log('customers: WOULD create unique partial index {email:1} over string emails (dry run)');
}

// ── 5. plans.prices[] backfill ───────────────────────────────────────────────
const planDocs = await plans.find({}).toArray();
let planPriceWrites = 0;
let planSelfServeWrites = 0;
for (const plan of planDocs) {
  const price = Number(plan.price) || 0;
  const excluded = NO_SELF_SERVE_PLANS.includes(plan.key);
  const isFree = FREE_PLANS.includes(plan.key);
  // Free is self-serve WITHOUT a price row. Every other non-sales-led plan needs
  // a real price before it can be sold — a $0 self-serve checkout row is the
  // hazard being avoided here, not self-serve itself.
  const selfServe = !excluded && (isFree || price > 0);
  if (!excluded && !isFree && price <= 0) {
    console.log(`plans: ${plan.key}: price is 0 — left OFF self-serve, needs a real price before it can be sold`);
  }

  const update = {};
  // ADDITIVE, like steps 6 and 7 and for the same reason: `selfServe` is written
  // only when the document has NO value for it.
  //
  // This used to write on a VALUE COMPARISON (`plan.selfServe !== selfServe`),
  // which made it a reconciler that overwrites. An operator who deliberately
  // turned a plan OFF self-serve — because it is sales-led, mid-migration, or
  // priced wrong — had that decision silently reverted by the next routine run of
  // a script whose own step 9 prints the re-run command. The derivation here is a
  // FIRST-BOOT guess from `price`, and a guess must not outrank a choice.
  //
  // `undefined` only, deliberately NOT `isUnsetValue`: `selfServe: false` is a
  // deliberate denial (the same trap that rule documents for `allowBrowserKeys`),
  // and a falsy test would clobber exactly the operator decision this protects.
  if (plan.selfServe === undefined) {
    update.selfServe = selfServe;
  } else if (plan.selfServe !== selfServe) {
    // Named, not silent: an operator reading this log is the only way the
    // divergence between the derivation and the stored value gets noticed.
    console.log(
      `plans: ${plan.key}: kept operator value selfServe=${plan.selfServe} (derivation would have set ${selfServe})`,
    );
  }
  // The price row follows the EFFECTIVE self-serve state — what the document
  // will actually carry after this step — not the derivation. An operator who
  // turned a plan off self-serve must not have a checkout price quietly created
  // for it on the next run; that would be the same overwrite by a side door.
  const effectiveSelfServe = plan.selfServe === undefined ? selfServe : plan.selfServe;
  // `!isFree` is load-bearing: Free is self-serve but must never gain a price
  // row. A $0 row would publish a checkout for nothing to pay, and
  // `settings-cache` filters prices on `unitAmountMinor > 0` anyway, so the row
  // would be invisible on the pricing page while still sitting in the document.
  if (effectiveSelfServe && !isFree && !(Array.isArray(plan.prices) && plan.prices.length > 0)) {
    update.prices = [
      {
        // MUST equal `monthlyPriceId(plan.key)` from `src/billing/plan.schema.ts`
        // — UNDERSCORE, not a hyphen. `PlansService.update` merges an incoming
        // prices[] payload BY id, so a row named `standard-monthly` is invisible
        // to an admin editing `standard_monthly` and the edit appends a SECOND
        // price instead of repricing this one.
        id: `${plan.key}_monthly`,
        interval: 'month',
        // Every field the schema declares is written EXPLICITLY. This is a raw
        // driver write, so Mongoose applies none of its `default:`s — an omitted
        // `intervalCount` / `currency` / `active` stays absent in the stored
        // document and `.lean()` reads (SettingsCacheService, PlansService) get
        // no defaults either.
        intervalCount: 1,
        // Math.round keeps this an integral JS number, which the driver
        // serializes as a BSON int32 — cents must never be stored as a float.
        unitAmountMinor: Math.round(price * 100),
        currency: 'USD',
        active: true,
      },
    ];
  }

  if (Object.keys(update).length === 0) {
    console.log(`plans: ${plan.key}: nothing to backfill`);
    continue;
  }
  const described = [
    update.prices ? `prices[1 monthly, $${price} → unitAmountMinor ${update.prices[0].unitAmountMinor}]` : null,
    'selfServe' in update ? `selfServe=${update.selfServe}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  if (update.prices) planPriceWrites += 1;
  if ('selfServe' in update) planSelfServeWrites += 1;
  if (APPLY) {
    await plans.updateOne({ _id: plan._id }, { $set: update });
    console.log(`plans: ${plan.key}: set ${described}`);
  } else {
    console.log(`plans: ${plan.key}: WOULD set ${described} (dry run)`);
  }
}

// ── 6. customers backfill ────────────────────────────────────────────────────
// Every existing row was created by an admin through /admin/clients — there is
// no self-serve signup yet — so origin/planSource are 'admin' by definition.
// Each field is filtered on `$exists: false` so a re-run never clobbers a value
// a later signup or admin action has already set.
const CUSTOMER_BACKFILL = [
  ['origin', 'admin'],
  ['planSource', 'admin'],
  ['creditBalanceMinor', 0],
];
let customerFieldWrites = 0;
for (const [field, value] of CUSTOMER_BACKFILL) {
  const filter = { [field]: { $exists: false } };
  const count = await customers.countDocuments(filter);
  if (count === 0) {
    console.log(`customers: ${field} already set on every document`);
    continue;
  }
  if (APPLY) {
    const res = await customers.updateMany(filter, { $set: { [field]: value } });
    customerFieldWrites += res.modifiedCount;
    console.log(`customers: set ${field}=${JSON.stringify(value)} on ${res.modifiedCount} documents`);
  } else {
    customerFieldWrites += count;
    console.log(`customers: WOULD set ${field}=${JSON.stringify(value)} on ${count} documents (dry run)`);
  }
}

// ── 7. plan field reconciliation against PLAN_SEEDS ──────────────────────────
// Re-read rather than reusing `planDocs`: step 5 may just have written to these
// documents, and reconciling against a pre-write snapshot is how a reconciler
// reports a change it already made.
const planDocsToReconcile = await plans.find({}).toArray();
const planDocsByKey = new Map(planDocsToReconcile.map((doc) => [doc.key, doc]));
let planFieldWrites = 0;
let planKeysMissing = 0;

for (const seed of PLAN_SEEDS) {
  const doc = planDocsByKey.get(seed.key);
  if (!doc) {
    // NOT created here. `plans` is non-empty, so this key was either deleted on
    // purpose or renamed, and re-inserting it would resurrect a tier an operator
    // retired — a louder mistake than leaving it absent.
    planKeysMissing += 1;
    console.log(`plans: ${seed.key}: seeded key has NO row — not created (only an EMPTY plans collection is seeded); create it in the admin panel if it belongs here`);
    continue;
  }
  const update = {};
  const described = [];
  const kept = [];
  for (const field of RECONCILED_PLAN_FIELDS) {
    if (isUnsetValue(doc[field])) {
      update[field] = seed[field];
      described.push(`${field}=${describeValue(seed[field])}`);
    } else {
      kept.push(`${field}=${describeValue(doc[field])}`);
    }
  }
  if (described.length === 0) {
    console.log(`plans: ${seed.key}: all reconciled fields already set (${kept.join(', ')})`);
    continue;
  }
  planFieldWrites += described.length;
  const keptNote = kept.length > 0 ? `; kept operator values ${kept.join(', ')}` : '';
  if (APPLY) {
    // `updatedAt` by hand: `timestamps: true` is a Mongoose-model behaviour and
    // this is a raw-driver write, so without it the document changes while
    // claiming it did not.
    await plans.updateOne({ _id: doc._id }, { $set: { ...update, updatedAt: new Date() } });
    console.log(`plans: ${seed.key}: filled ${described.join(', ')}${keptNote}`);
  } else {
    console.log(`plans: ${seed.key}: WOULD fill ${described.join(', ')}${keptNote} (dry run)`);
  }
}

const seededPlanKeys = new Set(PLAN_SEEDS.map((seed) => seed.key));
const unseededPlanKeys = planDocsToReconcile.map((doc) => doc.key).filter((key) => !seededPlanKeys.has(key));
if (unseededPlanKeys.length > 0) {
  console.log(`plans: ${unseededPlanKeys.length} non-seeded plan key(s) left untouched: ${unseededPlanKeys.join(', ')}`);
}

// ── 8. endpoint_costs: insert route keys that have no row ────────────────────
// A metered route with no row is charged its `@UnitCost(routeKey, fallback)`
// decorator default and is invisible to the admin panel, so nobody can see or
// change what it costs. Inserting the seeded row is what makes the price real.
const costDocs = await endpointCosts.find({}).toArray();
const costDocsByKey = new Map(costDocs.map((doc) => [doc.routeKey, doc]));
const missingCostSeeds = ENDPOINT_COST_SEEDS.filter((seed) => !costDocsByKey.has(seed.routeKey));
let costRowsInserted = 0;

if (missingCostSeeds.length === 0) {
  console.log(`endpoint_costs: every seeded route key already has a row (${costDocs.length} row(s) present)`);
} else {
  for (const seed of missingCostSeeds) {
    console.log(
      APPLY
        ? `endpoint_costs: + ${seed.routeKey} = ${seed.unitCost} unit(s) ("${seed.label}")`
        : `endpoint_costs: WOULD ADD ${seed.routeKey} = ${seed.unitCost} unit(s) ("${seed.label}") (dry run)`,
    );
  }
  if (APPLY) {
    const now = new Date();
    // Every schema-declared field written EXPLICITLY, timestamps included: the
    // raw driver applies no Mongoose defaults, and a `.lean()` read (which is
    // what `SettingsCacheService.refresh` does) applies none either.
    const res = await endpointCosts.insertMany(
      missingCostSeeds.map((seed) => ({
        routeKey: seed.routeKey,
        label: seed.label,
        unitCost: seed.unitCost,
        enabled: seed.enabled,
        createdAt: now,
        updatedAt: now,
      })),
    );
    costRowsInserted = res.insertedCount;
    console.log(`endpoint_costs: inserted ${res.insertedCount} missing row(s)`);
  } else {
    costRowsInserted = missingCostSeeds.length;
  }
}

// ── 9. endpoint_costs: the seeded ladder vs what exists (opt-in) ─────────────
// Deliberately separate from step 8. An absent row is a gap; a row at a
// different price may be a decision, and this script cannot tell the two apart
// — so it never guesses, it reports and waits for --reprice-endpoints.
const costDrift = ENDPOINT_COST_SEEDS.map((seed) => ({ seed, doc: costDocsByKey.get(seed.routeKey) }))
  .filter((row) => row.doc !== undefined && row.doc.unitCost !== row.seed.unitCost);
let costRowsRepriced = 0;

if (costDrift.length === 0) {
  console.log('endpoint_costs: every existing row already matches the seeded unit-cost ladder');
} else {
  for (const { seed, doc } of costDrift) {
    console.log(`endpoint_costs: ${seed.routeKey}: stored ${doc.unitCost} unit(s), seeded ladder says ${seed.unitCost}`);
  }
  if (!REPRICE_ENDPOINTS) {
    console.log(`endpoint_costs: ${costDrift.length} existing row(s) differ from the ladder and were NOT changed.`);
    console.log('endpoint_costs: --reprice-endpoints WILL OVERWRITE the stored unitCost of the row(s) listed above with the seeded value,');
    console.log('endpoint_costs:   which changes what every customer is billed per request from the next metering-cache refresh (~30s).');
    console.log('endpoint_costs:   It touches `unitCost` only — never `enabled`, never `label` — and never a route key absent from the seeds.');
    console.log('endpoint_costs:   Run: node scripts/billing-subscriptions-migration.mjs --apply --reprice-endpoints');
  } else if (APPLY) {
    const now = new Date();
    for (const { seed, doc } of costDrift) {
      await endpointCosts.updateOne({ _id: doc._id }, { $set: { unitCost: seed.unitCost, updatedAt: now } });
      costRowsRepriced += 1;
      console.log(`endpoint_costs: repriced ${seed.routeKey}: ${doc.unitCost} → ${seed.unitCost} unit(s)`);
    }
  } else {
    costRowsRepriced = costDrift.length;
    console.log(`endpoint_costs: WOULD reprice ${costDrift.length} row(s) to the seeded ladder (dry run — add --apply to write)`);
  }
}

console.log(`summary: inspected ${customersInspected} customers, ${planDocs.length} plans, ${costDocs.length} endpoint costs`);
console.log(`summary: email index ${indexOutcome}`);
console.log(
  APPLY
    ? `summary: unset ${nullEmailsUnset} null emails, wrote ${planPriceWrites} plan price lists + ${planSelfServeWrites} selfServe flags + ${customerFieldWrites} customer field values`
    : `summary: would unset ${nullEmails} null emails, write ${planPriceWrites} plan price lists + ${planSelfServeWrites} selfServe flags + ${customerFieldWrites} customer field values`,
);
console.log(
  APPLY
    ? `summary: reconciliation — filled ${planFieldWrites} plan field(s), inserted ${costRowsInserted} endpoint cost row(s)`
    : `summary: reconciliation — would fill ${planFieldWrites} plan field(s), insert ${costRowsInserted} endpoint cost row(s)`,
);
if (planKeysMissing > 0) console.log(`summary: ${planKeysMissing} seeded plan key(s) have no row and were NOT created`);
console.log(
  costDrift.length === 0
    ? 'summary: endpoint repricing — nothing pending, stored costs match the ladder'
    : REPRICE_ENDPOINTS
      ? `summary: endpoint repricing — ${costRowsRepriced} row(s) ${APPLY ? 'repriced' : 'would be repriced'} (--reprice-endpoints given)`
      : `summary: endpoint repricing — ${costDrift.length} row(s) PENDING, withheld until --reprice-endpoints is passed`,
);
// The idempotence claim, stated by the script so it does not have to be
// re-derived by eye. It covers the ADDITIVE reconciliation only; a pending
// reprice stays pending by design and is reported separately above.
const reconciliationPending = planFieldWrites + costRowsInserted;
if (APPLY && reconciliationPending === 0 && costDrift.length === 0) {
  console.log('summary: nothing left to reconcile — this database matches the seeds');
} else if (reconciliationPending === 0) {
  console.log('summary: reconciliation is idempotent — re-running it now would change nothing');
}
console.log(APPLY ? 'done — migration applied' : 'dry run complete (re-run with --apply to write)');
await mongoose.disconnect();
