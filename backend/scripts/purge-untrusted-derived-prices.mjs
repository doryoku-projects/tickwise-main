#!/usr/bin/env node
// One-off cleanup: delete `{chainId}_token_price_historical` rows whose source
// is a POOL-DERIVED subgraph quote (`subgraph-current` / `subgraph-historical`)
// for tokens WITHOUT a trusted market (not a config anchor, not in the
// committed CoinGecko allowlist). These rows were persisted by builds that
// predate the trusted-market gates — a seeded spam pool mints its own
// derivedETH "price" (RPC at ~$0.0107 from its own USDC/RPC pool), and the
// stored row would otherwise keep serving from the historical cache.
//
// Imports the REAL allowlist + anchor config from the compiled build — run
// `pnpm build` first so dist is current.
//
// Usage: node scripts/purge-untrusted-derived-prices.mjs          (dry run)
//        node scripts/purge-untrusted-derived-prices.mjs --apply  (delete)
import mongoose from 'mongoose';
import { isAllowlisted } from '../dist/pricing/token-allowlist.js';
import { isAnchorTokenStandalone } from '../dist/pricing/pricing-policy.js';

const APPLY = process.argv.includes('--apply');
const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/copypools_positions';
const POOL_DERIVED_SOURCES = ['subgraph-current', 'subgraph-historical'];

await mongoose.connect(URI);
const db = mongoose.connection.db;

const collections = (await db.listCollections().toArray())
  .map((c) => c.name)
  .filter((name) => /^\d+_token_price_historical$/.test(name));

let totalDeleted = 0;
for (const name of collections) {
  const chainId = Number(name.split('_')[0]);
  const col = db.collection(name);
  const addresses = await col.distinct('address', { source: { $in: POOL_DERIVED_SOURCES } });
  const untrusted = addresses.filter(
    (addr) => typeof addr === 'string'
      && !isAnchorTokenStandalone(chainId, addr)
      && !isAllowlisted(chainId, addr),
  );
  if (untrusted.length === 0) {
    console.log(`${name}: nothing to purge`);
    continue;
  }
  const filter = { source: { $in: POOL_DERIVED_SOURCES }, address: { $in: untrusted } };
  const count = await col.countDocuments(filter);
  if (APPLY) {
    const res = await col.deleteMany(filter);
    totalDeleted += res.deletedCount;
    console.log(`${name}: deleted ${res.deletedCount} pool-derived rows across ${untrusted.length} untrusted tokens`);
  } else {
    console.log(`${name}: WOULD delete ${count} pool-derived rows across ${untrusted.length} untrusted tokens (dry run)`);
    for (const addr of untrusted.slice(0, 20)) console.log(`  - ${addr}`);
    if (untrusted.length > 20) console.log(`  … and ${untrusted.length - 20} more`);
  }
}
console.log(APPLY ? `done — ${totalDeleted} rows deleted` : 'dry run complete (re-run with --apply to delete)');
await mongoose.disconnect();
