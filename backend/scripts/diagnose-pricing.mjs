#!/usr/bin/env node
// Read-only pricing diagnostic. For each v4 NFT id, joins our Ponder index +
// live aggregators (DeFiLlama → GeckoTerminal, same order as the backend) and
// runs the REAL pool-consistency code (imported from dist) to show what each
// position SHOULD value at. Run `npm run build` first so dist is current.
//
// Usage: node scripts/diagnose-pricing.mjs [nftId ...]
//
// IMPORTANT: this imports the actual enforcePoolConsistency + poolRatio from the
// compiled build — NOT a reimplementation — so it faithfully reproduces the real
// behavior (including any ratio underflow). A reimplementation here previously
// hid a bug and produced wrong conclusions.
import { enforcePoolConsistency, poolRatio } from '../dist/pricing/pool-consistency.js';

// No built-in default: the indexer url is deployment config, not source.
const PONDER = process.env.ETHEREUM_UNISWAP_V4_PONDER_URL;
if (!PONDER) {
  console.error('Set ETHEREUM_UNISWAP_V4_PONDER_URL to the indexer GraphQL url first.');
  process.exit(2);
}
const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['304444', '283113', '154017', '71998'];

// Mainnet anchors (stable / native / wrapped-native / trusted), lowercased.
const ANCHORS = new Set([
  '0x0000000000000000000000000000000000000000', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7',
  '0x6b175474e89094c44da98b954eedeac495271d0f', '0x0000000000085d4780b73119b644ae5ecd22b376',
  '0x4fabb145d64652a948d72533023f6e7a623c7c53', '0x853d955acef822db058eb8505911ed77f175b99e',
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f', // GHO
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', '0xae78736cd615f374d3085123a210448e74fc6393',
]);
const isAnchor = (a) => ANCHORS.has(a.toLowerCase());
// Same trust mapping as the adapter's legTrust(): anchor > verified (listed) > unverified.
const trustOf = (addr, token) => (isAnchor(addr) ? 'anchor' : token?.verified === true ? 'verified' : 'unverified');

async function gql(query) {
  const r = await fetch(PONDER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  return (await r.json()).data;
}
async function externalPrice(addr) {
  // Same provider order as the backend: defillama → geckoterminal (first positive wins).
  try {
    const c = (await (await fetch(`https://coins.llama.fi/prices/current/ethereum:${addr}`)).json()).coins?.[`ethereum:${addr}`];
    if (c?.price > 0) return { price: c.price, src: `defillama(${c.confidence})` };
  } catch {}
  try {
    const a = (await (await fetch(`https://api.geckoterminal.com/api/v2/networks/eth/tokens/${addr}`, { headers: { accept: 'application/json' } })).json()).data?.attributes;
    if (a?.price_usd > 0) return { price: Number(a.price_usd), src: 'geckoterminal' };
  } catch {}
  return { price: 0, src: 'none' };
}

for (const id of IDS) {
  const pos = (await gql(`{ positions(where:{tokenId:"${id}"}){items{poolId amount0 amount1 isActive}} }`))?.positions?.items?.[0];
  if (!pos) { console.log(`\n#${id}: not in Ponder`); continue; }
  const pool = (await gql(`{ pools(where:{id:"${pos.poolId}"}){items{name fee sqrtPriceX96 token0Id token1Id}} }`)).pools.items[0];
  const toks = (await gql(`{ tokens(where:{id_in:["${pool.token0Id}","${pool.token1Id}"]}){items{id symbol decimals verified}} }`)).tokens.items;
  const t0 = toks.find((t) => t.id.toLowerCase() === pool.token0Id.toLowerCase());
  const t1 = toks.find((t) => t.id.toLowerCase() === pool.token1Id.toLowerCase());
  const p0 = await externalPrice(pool.token0Id), p1 = await externalPrice(pool.token1Id);
  const trust0 = trustOf(pool.token0Id, t0), trust1 = trustOf(pool.token1Id, t1);
  const ratio = poolRatio(String(pool.sqrtPriceX96), Number(t0.decimals), Number(t1.decimals));            // REAL function
  const { vp0, vp1, derived0, derived1 } = enforcePoolConsistency(p0.price, p1.price, trust0, trust1, ratio); // REAL function
  const value = pos.amount0 * vp0 + pos.amount1 * vp1;
  const legNote = (derived, vp, ext) =>
    derived ? `  (DERIVED → pool-implied $${vp})` : vp === 0 && ext > 0 ? '  (ZEROED)' : '';
  console.log(`\n#${id}  ${pool.name}  fee ${(pool.fee / 10000).toFixed(2)}%  active=${pos.isActive}  ratio=${ratio}`);
  console.log(`  ${t0.symbol}(${trust0}): ext $${p0.price} [${p0.src}]  amt ${pos.amount0}  → vp $${vp0}${legNote(derived0, vp0, p0.price)}`);
  console.log(`  ${t1.symbol}(${trust1}): ext $${p1.price} [${p1.src}]  amt ${pos.amount1}  → vp $${vp1}${legNote(derived1, vp1, p1.price)}`);
  console.log(`  => underlyingValueUsd $${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
}
