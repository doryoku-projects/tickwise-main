#!/usr/bin/env node
/*
 * Does Mongo actually hold every position the indexer has?
 *
 * WHY THIS EXISTS. A backfill reports `status: success` and a row count, and
 * neither answers the only question that matters — whether anything was MISSED.
 * Two failures in one week were invisible for exactly that reason: a chain with
 * no configured source finished in 39ms with `fetched: 0` and called it success,
 * and an offset-paging bug walked past half the corpus (202,622 of 403,622
 * mainnet positions) while reporting a healthy-looking upsert count. Both were
 * found by eye, days later, from a leaderboard that looked subtly wrong.
 *
 * HOW IT CHECKS. v4 position ids are the NFT tokenId, minted sequentially, so
 * the id space is dense: for a complete shard, the rows present should be very
 * close to `1..maxTokenId`. The script therefore
 *
 *   1. reads every tokenId this shard holds (one indexed projection),
 *   2. asks the indexer for its highest tokenId on that chain,
 *   3. reports the gaps as ranges, and
 *   4. VERIFIES a sample of them against the indexer.
 *
 * Step 4 is what makes the answer trustworthy rather than a heuristic: a
 * tokenId can be legitimately absent (never minted, or minted after our cursor),
 * so a gap is only a DEFECT if the indexer actually has that position. The
 * script reports the two separately and only exits non-zero on confirmed misses.
 *
 * READ-ONLY. It writes nothing, to Mongo or anywhere else.
 *
 *   node scripts/check-position-coverage.mjs                # every enabled chain
 *   node scripts/check-position-coverage.mjs --chain 1      # one chain
 *   node scripts/check-position-coverage.mjs --sample 50    # verify more gaps
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const KNOWN_FLAGS = new Set(['--chain', '--sample', '--protocol']);
for (const a of args) {
  // A typo'd flag reading as "the operator declined" is how somebody concludes
  // a check ran that did not. Same rule as the migration scripts.
  if (a.startsWith('--') && !KNOWN_FLAGS.has(a)) {
    console.error(`Unknown flag ${a}. Known: ${[...KNOWN_FLAGS].join(', ')}`);
    process.exit(2);
  }
}

const PROTOCOL = argValue('--protocol') ?? 'uniswap-v4';
const SAMPLE_SIZE = Number(argValue('--sample') ?? 20);
const ONLY_CHAIN = argValue('--chain') ? Number(argValue('--chain')) : undefined;

/** Mirrors `normalizeProtocol` in collection-resolver.ts. */
const collectionFor = (chainId) => `${chainId}_${PROTOCOL.replace(/-/g, '_')}_positions`;

const CHAIN_ENV = {
  1: 'ETHEREUM',
  43114: 'AVALANCHE',
  42161: 'ARBITRUM',
  4663: 'ROBINHOOD',
};

function configuredChains() {
  const out = [];
  for (const [chainId, prefix] of Object.entries(CHAIN_ENV)) {
    const url = process.env[`${prefix}_UNISWAP_V4_SUBGRAPH_URL`];
    const fromSubgraph = process.env[`${prefix}_UNISWAP_V4_POSITIONS_FROM_SUBGRAPH`] === 'true';
    const ponder = process.env[`${prefix}_UNISWAP_V4_PONDER_URL`];
    if (ponder) continue; // Ponder pages by cursor; this check targets the Envio path.
    if (!url || !fromSubgraph) continue;
    out.push({ chainId: Number(chainId), url });
  }
  return ONLY_CHAIN ? out.filter((c) => c.chainId === ONLY_CHAIN) : out;
}

async function hasura(url, query, variables = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
  return body.data;
}

/** Highest tokenId the indexer holds for this chain. */
async function indexerMaxTokenId(url, chainId) {
  // order_by tokenId is a NUMERIC column in this schema, so desc gives the true
  // maximum rather than a lexicographic one ("99" > "403622" as strings).
  const d = await hasura(
    url,
    `query M($c: numeric!) {
       Position(where: {chainId: {_eq: $c}}, order_by: [{tokenId: desc}], limit: 1) { tokenId }
     }`,
    { c: String(chainId) },
  );
  return d.Position?.[0] ? Number(d.Position[0].tokenId) : 0;
}

/** Which of these tokenIds does the indexer actually have? */
async function indexerHas(url, chainId, tokenIds) {
  if (tokenIds.length === 0) return new Set();
  const d = await hasura(
    url,
    `query H($c: numeric!, $ids: [numeric!]) {
       Position(where: {chainId: {_eq: $c}, tokenId: {_in: $ids}}, limit: 1000) { tokenId }
     }`,
    { c: String(chainId), ids: tokenIds.map(String) },
  );
  return new Set((d.Position ?? []).map((p) => String(p.tokenId)));
}

/** Collapse a sorted list of missing ids into printable ranges. */
function toRanges(sorted) {
  const ranges = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

const chains = configuredChains();
if (chains.length === 0) {
  console.error(
    'No chain is reading positions from an Envio subgraph URL ' +
      '(needs <CHAIN>_UNISWAP_V4_SUBGRAPH_URL + _POSITIONS_FROM_SUBGRAPH=true, and no _PONDER_URL).',
  );
  process.exit(2);
}

await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
const db = mongoose.connection.db;
console.log(`mongo: ${mongoose.connection.name}\n`);

let confirmedMisses = 0;

for (const { chainId, url } of chains) {
  const name = collectionFor(chainId);
  const rows = await db
    .collection(name)
    .find({}, { projection: { positionId: 1, _id: 0 } })
    .toArray();
  const have = new Set(rows.map((r) => Number(r.positionId)).filter(Number.isFinite));

  const maxId = await indexerMaxTokenId(url, chainId);
  if (maxId === 0) {
    console.log(`chain ${chainId}: indexer reports no positions — skipping\n`);
    continue;
  }

  const missing = [];
  for (let i = 1; i <= maxId; i++) if (!have.has(i)) missing.push(i);

  const coverage = ((have.size / maxId) * 100).toFixed(1);
  console.log(`chain ${chainId}  (${name})`);
  console.log(`  mongo rows          ${have.size.toLocaleString()}`);
  console.log(`  indexer max tokenId ${maxId.toLocaleString()}`);
  console.log(`  coverage            ${coverage}%`);

  if (missing.length === 0) {
    console.log('  gaps                none\n');
    continue;
  }

  const ranges = toRanges(missing);
  console.log(`  absent ids          ${missing.length.toLocaleString()} in ${ranges.length.toLocaleString()} range(s)`);
  console.log(
    '  first few           ' +
      ranges
        .slice(0, 5)
        .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
        .join(', '),
  );

  // Verify a spread-out sample rather than the first N — a contiguous head is
  // usually just the tail of an unfinished walk, which says nothing about
  // whether the middle is intact.
  const step = Math.max(1, Math.floor(missing.length / SAMPLE_SIZE));
  const sample = [];
  for (let i = 0; i < missing.length && sample.length < SAMPLE_SIZE; i += step) sample.push(missing[i]);
  const present = await indexerHas(url, chainId, sample);
  const real = sample.filter((id) => present.has(String(id)));

  console.log(`  sampled             ${sample.length} absent ids against the indexer`);
  if (real.length === 0) {
    console.log('  verdict             OK — none of the sampled ids exist upstream either\n');
  } else {
    confirmedMisses += real.length;
    const pct = ((real.length / sample.length) * 100).toFixed(0);
    console.log(`  verdict             MISSING DATA — ${real.length}/${sample.length} (${pct}%) of sampled gaps DO exist upstream`);
    console.log(`                      e.g. ${real.slice(0, 8).join(', ')}`);
    console.log(`                      estimated real misses ~${Math.round(missing.length * (real.length / sample.length)).toLocaleString()}\n`);
  }
}

await mongoose.disconnect();

if (confirmedMisses > 0) {
  console.log('Re-run the backfill for the affected chain(s) with {"fromStart": true}.');
  process.exit(1);
}
