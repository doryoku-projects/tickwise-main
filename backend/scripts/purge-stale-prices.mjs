#!/usr/bin/env node
// Clear SAVED token prices that only a stale or thin provider quote supports
// (fix 1 of docs/spam-and-pool-mismatch-2026-10-05.md: HPP was served at
// $31,374 from a 4.5-month-old DIA quotation with $0.098 of daily volume, and
// `{chainId}_tokens.priceUsd` kept it as last-known-good).
//
// DIAGNOSE BY DEFAULT — prints what it would clear and writes nothing.
// `--apply` sets `priceUsd: 0` (+ `pricePurgedAt`, `pricePurgedReason`) on the
// matched rows: last-known-good reads require `priceUsd > 0`, so the price stops
// being served at once, and the next token-price sweep prices the token again.
// With `PRICE_QUOTE_GUARD=on` that sweep can no longer pick the rejected quote;
// with the guard OFF it may well write the same stale price back — run this
// with the guard on (or just switch the guard on: its sweep clears these rows
// by itself, this script only does it immediately).
//
// Stored evidence counts only while it describes the CURRENT price:
// `priceEvidenceAt` (stamped by the write that carried it) must equal
// `pricedAt` — a later price write with every flag off leaves older evidence
// behind, and a row without the stamp has none to go on.
//
// What counts as "only a rejected quote supports it" (any one):
//   guard-differs    the row carries the SWEEP's evidence (`priceQuoteRejected`
//                    + `priceGuardUsd`, the consensus over accepted quotes
//                    only), quotes were rejected, and the guard's price is 0
//                    or more than 10% away from the saved price. A row with
//                    sweep evidence is judged on this comparison ALONE: a
//                    fresh consensus that a stale DIA quote sat within 10% of
//                    is kept, whatever date the evidence carries;
//   stored-stale     no sweep evidence, but hot-path provenance
//                    (`priceQuoteSource` + `priceQuotedAt`) dated older than
//                    --max-age-ms;
//   dia-match        --probe-dia only: no stored provenance, and DIA's current
//                    answer for the token is stale or thin AND within 1% of the
//                    saved price (the saved price is that DIA quote). This one
//                    makes one public, keyless DIA request per candidate.
//   --address=…      listed explicitly (reason `manual`).
//
// Usage:
//   MONGODB_URI=… node scripts/purge-stale-prices.mjs                 (diagnose)
//   MONGODB_URI=… node scripts/purge-stale-prices.mjs --probe-dia     (diagnose, + DIA probe)
//   MONGODB_URI=… node scripts/purge-stale-prices.mjs --apply [--chain=1] [--address=0x…,0x…]
// Flags: --apply --chain=<id> --max-age-ms=<ms> (default 86400000)
//        --dia-min-volume=<usd> (default 1000) --probe-dia --limit=<n> (probe cap, default 500)
//        --address=<0x…>[,<0x…>]
// Any other flag is an error. The URI comes from MONGODB_URI only and is never printed.
//
// Load: the scan reads `secondaryPreferred` (maxStaleness 120 s), in keyset
// pages on the `{chainId, address}` index with a server-side maxTimeMS and a
// pause between pages — never an unpaced scan of the primary. `--apply`
// writes each row with its OWN filter pinned to the price and `pricedAt` that
// were judged (one bulkWrite per page of matches), so a row the token-price
// sweep re-priced since — on the primary, after the (possibly lagging)
// secondary read or a slow --probe-dia — is skipped, and counted.
// The thresholds mirror `src/pricing/token-trust.ts` (`quoteRejection`); the
// spec `test/stale-quotes/purge-script.spec.ts` pins them together.
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DIA_MIN_VOLUME_USD = 1_000;
const GUARD_DIFF_RATIO = 1.1;
const DIA_MATCH_RATIO = 1.01;
const DIA_CHAIN = { 1: 'Ethereum', 43114: 'Avalanche', 42161: 'Arbitrum' };
export const PAGE_SIZE = 1000;
const PAGE_PAUSE_MS = 50;
const READ_MAX_TIME_MS = 30_000;
const READ_MAX_STALENESS_S = 120;

/**
 * Would the quote guard reject this quote? Mirrors `quoteRejection` in
 * `src/pricing/token-trust.ts` exactly (the spec runs both on the same cases).
 */
export function quoteRejection(quote, providerName, opts, now = Date.now()) {
  const at = quote.quotedAtMs;
  if (typeof at === 'number' && Number.isFinite(at) && now - at > opts.maxAgeMs) return 'stale';
  if (providerName === 'dia' && opts.diaMinVolumeUsd > 0) {
    const vol = typeof quote.volume24hUsd === 'number' && Number.isFinite(quote.volume24hUsd) ? quote.volume24hUsd : 0;
    if (vol < opts.diaMinVolumeUsd) return 'thin';
  }
  return null;
}

function timeOf(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' || typeof v === 'number') return new Date(v).getTime();
  return NaN;
}

/**
 * Does the row's stored evidence describe its CURRENT price? Mirrors
 * `priceEvidenceIsCurrent` in `src/database/token.repository.ts` (the spec
 * pins them together).
 */
export function evidenceIsCurrent(doc) {
  const at = timeOf(doc?.priceEvidenceAt);
  const priced = timeOf(doc?.pricedAt);
  return Number.isFinite(at) && Number.isFinite(priced) && Math.abs(at - priced) <= 1000;
}

/** Why a stored token row's price should be cleared, from stored evidence alone (null = keep). */
export function classifyStoredRow(doc, opts, now = Date.now()) {
  const price = Number(doc?.priceUsd);
  if (!(price > 0)) return null;
  if (!evidenceIsCurrent(doc)) return null;
  const guardPrice = Number(doc.priceGuardUsd);
  if (Array.isArray(doc.priceQuoteRejected) && Number.isFinite(guardPrice)) {
    // Sweep evidence: the guard comparison decides, alone.
    if (doc.priceQuoteRejected.length === 0) return null;
    if (!(guardPrice > 0)) return 'guard-differs';
    const hi = Math.max(guardPrice, price);
    const lo = Math.min(guardPrice, price);
    return hi / lo > GUARD_DIFF_RATIO ? 'guard-differs' : null;
  }
  // Hot-path provenance: the provider that supplied the price dated it too long ago.
  if (typeof doc.priceQuoteSource !== 'string' || doc.priceQuoteSource.length === 0) return null;
  const at = timeOf(doc.priceQuotedAt);
  if (Number.isFinite(at) && now - at > opts.maxAgeMs) return 'stored-stale';
  return null;
}

/**
 * The pinned write for one judged row: cleared only if its price and
 * `pricedAt` are still the ones that were judged (a sweep that re-priced it in
 * between wins).
 */
export function pinnedClearOp(chainId, doc, reason, at) {
  return {
    updateOne: {
      filter: { chainId, address: String(doc.address).toLowerCase(), priceUsd: doc.priceUsd, pricedAt: doc.pricedAt ?? null },
      update: { $set: { priceUsd: 0, pricePurgedAt: at, pricePurgedReason: `purge-script:${reason}` } },
    },
  };
}

/** DIA answer → is the saved price that stale/thin DIA quote? */
export function diaMatches(savedPrice, dia, opts, now = Date.now()) {
  const p = Number(dia?.Price);
  if (!(p > 0) || !(savedPrice > 0)) return false;
  const hi = Math.max(p, savedPrice);
  const lo = Math.min(p, savedPrice);
  if (hi / lo > DIA_MATCH_RATIO) return false;
  const at = typeof dia.Time === 'string' ? Date.parse(dia.Time) : NaN;
  const vol = Number(dia.VolumeYesterdayUSD);
  return quoteRejection({ quotedAtMs: Number.isFinite(at) ? at : undefined, volume24hUsd: Number.isFinite(vol) && vol > 0 ? vol : undefined }, 'dia', opts, now) !== null;
}

export function parseArgs(argv) {
  const out = { apply: false, chain: undefined, maxAgeMs: DEFAULT_MAX_AGE_MS, diaMinVolumeUsd: DEFAULT_DIA_MIN_VOLUME_USD, probeDia: false, limit: 500, addresses: [] };
  for (const arg of argv) {
    const [k, v] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (k === '--apply' && v === undefined) out.apply = true;
    else if (k === '--probe-dia' && v === undefined) out.probeDia = true;
    else if (k === '--chain' && /^\d+$/.test(v ?? '')) out.chain = Number(v);
    else if (k === '--max-age-ms' && /^\d+$/.test(v ?? '') && Number(v) > 0) out.maxAgeMs = Number(v);
    else if (k === '--dia-min-volume' && /^\d+(\.\d+)?$/.test(v ?? '')) out.diaMinVolumeUsd = Number(v);
    else if (k === '--limit' && /^\d+$/.test(v ?? '') && Number(v) > 0) out.limit = Number(v);
    else if (k === '--address' && v) {
      for (const a of v.split(',')) {
        const lower = a.trim().toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(lower)) throw new Error(`--address: not an address: ${a}`);
        out.addresses.push(lower);
      }
    } else throw new Error(`unknown or malformed flag: ${arg}`);
  }
  return out;
}

async function fetchDia(chainId, address) {
  const chainName = DIA_CHAIN[chainId];
  if (!chainName) return null;
  const res = await fetch(`https://api.diadata.org/v1/assetQuotation/${chainName}/${address}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  return res.json();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const { default: mongoose } = await import('mongoose');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const readPreference = new mongoose.mongo.ReadPreference('secondaryPreferred', undefined, { maxStalenessSeconds: READ_MAX_STALENESS_S });
  const now = Date.now();
  const names = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => /^\d+_tokens$/.test(n))
    .filter((n) => opts.chain === undefined || Number(n.split('_')[0]) === opts.chain)
    .sort();
  let total = 0;
  let skipped = 0;
  for (const name of names) {
    const chainId = Number(name.split('_')[0]);
    const col = db.collection(name);
    const found = new Map(); // address → { reason, doc }
    const probe = [];
    const projection = {
      _id: 0, address: 1, symbol: 1, priceUsd: 1, pricedAt: 1, priceEvidenceAt: 1, priceQuotedAt: 1, priceQuoteSource: 1,
      priceQuoteRejected: 1, priceGuardUsd: 1, priceSources: 1,
    };
    // Keyset pages on the {chainId, address} index, from a secondary.
    let after = '';
    for (;;) {
      const page = await col
        .find(
          { chainId, address: { $gt: after }, priceUsd: { $gt: 0 } },
          { projection, readPreference, maxTimeMS: READ_MAX_TIME_MS },
        )
        .hint({ chainId: 1, address: 1 })
        .sort({ chainId: 1, address: 1 })
        .limit(PAGE_SIZE)
        .toArray();
      for (const doc of page) {
        const address = String(doc.address).toLowerCase();
        if (opts.addresses.includes(address)) {
          found.set(address, { reason: 'manual', doc });
          continue;
        }
        const reason = classifyStoredRow(doc, opts, now);
        if (reason) found.set(address, { reason, doc });
        else if (opts.probeDia && DIA_CHAIN[chainId] && doc.priceQuotedAt === undefined) probe.push(doc);
      }
      if (page.length < PAGE_SIZE) break;
      after = String(page[page.length - 1].address);
      await new Promise((r) => setTimeout(r, PAGE_PAUSE_MS));
    }
    if (opts.probeDia && probe.length > 0) {
      const slice = probe.slice(0, opts.limit);
      console.log(`${name}: probing DIA for ${slice.length} of ${probe.length} rows without provenance`);
      for (const doc of slice) {
        try {
          const dia = await fetchDia(chainId, String(doc.address).toLowerCase());
          if (dia && diaMatches(Number(doc.priceUsd), dia, opts, now)) found.set(String(doc.address).toLowerCase(), { reason: 'dia-match', doc, dia });
        } catch {
          /* one failed probe is just "not proven" */
        }
      }
    }
    if (found.size === 0) {
      console.log(`${name}: nothing to clear`);
      continue;
    }
    console.log(`${name}: ${opts.apply ? 'clearing' : 'WOULD clear'} ${found.size} saved prices`);
    for (const [address, { reason, doc, dia }] of [...found].slice(0, 50)) {
      const at = doc.priceQuotedAt ? new Date(doc.priceQuotedAt).toISOString() : dia?.Time ?? '-';
      console.log(`  ${reason.padEnd(14)} ${String(doc.symbol ?? '?').padEnd(12)} ${address} $${Number(doc.priceUsd).toPrecision(6)} quotedAt=${at}${doc.priceGuardUsd !== undefined ? ` guard=$${Number(doc.priceGuardUsd).toPrecision(6)}` : ''}`);
    }
    if (found.size > 50) console.log(`  … and ${found.size - 50} more`);
    if (opts.apply) {
      const at = new Date();
      const ops = [...found.values()].map(({ reason, doc }) => pinnedClearOp(chainId, doc, reason, at));
      let cleared = 0;
      for (let i = 0; i < ops.length; i += PAGE_SIZE) {
        const res = await col.bulkWrite(ops.slice(i, i + PAGE_SIZE), { ordered: false });
        cleared += res.modifiedCount;
      }
      total += cleared;
      skipped += ops.length - cleared;
      if (ops.length > cleared) console.log(`  ${ops.length - cleared} skipped: re-priced (or already cleared) since they were read`);
    }
  }
  console.log(opts.apply ? `done — ${total} saved prices cleared, ${skipped} skipped (changed since read)` : 'diagnose complete (re-run with --apply to clear)');
  await mongoose.disconnect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
