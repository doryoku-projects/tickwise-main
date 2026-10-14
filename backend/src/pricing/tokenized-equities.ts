/*
 * Tokenized equities on Robinhood Chain.
 *
 * Robinhood Chain carries tokenized US equities alongside ordinary tokens. That
 * distinction exists nowhere on-chain — it is off-chain product metadata — so it
 * belongs here rather than in the indexer, where a list change would alter the
 * config fingerprint and force a full 53M-block resync.
 *
 * Keyed on contract address, never on symbol: a symbol is attacker-controlled on
 * this chain, and 193 canonical equity tickers are an obvious impersonation
 * target. See scripts/refresh-tokenized-equities.mjs.
 */

import { EQUITY_META, ROBINHOOD_EQUITIES } from './data/tokenized-equities.robinhood.js';
import { SYMBOL_META, ROBINHOOD_TOKEN_SYMBOLS } from './data/token-symbols.robinhood.js';

/** Per-chain equity maps. Only 4663 has one; every other chain resolves empty. */
const BY_CHAIN: ReadonlyMap<number, ReadonlyMap<string, string>> = new Map([
  [EQUITY_META.chainId, ROBINHOOD_EQUITIES],
]);

const EMPTY: ReadonlyMap<string, string> = new Map();

/**
 * The equity map for a chain. Empty for every chain without tokenized equities.
 *
 * `chainId` is coerced because query params reach the repositories as strings on
 * some paths — the same hazard `pools.repository.ts` guards against for
 * `minTvlUsd` ("a string bound vs a numeric field matches nothing in Mongo").
 * Here an unconverted string would silently resolve to the empty map, and since
 * this drives an INCLUSION filter that reads as "no equities on this chain"
 * rather than as an error.
 */
export function equitiesFor(chainId: number | string): ReadonlyMap<string, string> {
  const id = typeof chainId === 'number' ? chainId : Number(chainId);
  return Number.isFinite(id) ? (BY_CHAIN.get(id) ?? EMPTY) : EMPTY;
}

/**
 * Lowercased equity contract addresses for a chain, for use in a Mongo `$in`.
 *
 * Returns `[]` for a chain with no equities, which makes an inclusion filter fail
 * CLOSED — `{ $in: [] }` matches nothing. That is the correct direction here: a
 * request for equities on a chain that has none must return zero rows, never
 * every row.
 */
export function equityAddresses(chainId: number | string): string[] {
  return [...equitiesFor(chainId).keys()];
}

/** The ticker for a known equity contract, or undefined. */
export function equityTicker(chainId: number | string, address: string): string | undefined {
  return equitiesFor(chainId).get(address.toLowerCase());
}

export function isEquity(chainId: number | string, address: string): boolean {
  return equitiesFor(chainId).has(address.toLowerCase());
}

export { EQUITY_META };

/*
 * Address -> symbol recovery, wider than the equity set.
 *
 * The indexer stores the literal "UNKNOWN" whenever its ERC-20 metadata read
 * failed, and never retries — so a symbol lost during a rate-limited stretch of
 * the sync stays lost short of a resync. Measured on 4663: of the 248 tokens in
 * pools over $100k TVL, 95 are UNKNOWN and 77 of those are CoinGecko-listed, so
 * this recovers ~81% of what a user actually sees.
 *
 * SYMBOL ONLY. Decimals are deliberately not recovered here — every amount and
 * TVL already written used the stored decimals, so changing one at read time
 * would make fresh reads disagree with the aggregates. That has to be fixed in
 * the indexer and re-synced.
 */
const SYMBOLS_BY_CHAIN: ReadonlyMap<number, ReadonlyMap<string, string>> = new Map([
  [SYMBOL_META.chainId, ROBINHOOD_TOKEN_SYMBOLS],
]);

/** A known symbol for a contract the indexer failed to name, or undefined. */
export function knownSymbol(chainId: number | string, address: string): string | undefined {
  const id = typeof chainId === 'number' ? chainId : Number(chainId);
  if (!Number.isFinite(id)) return undefined;
  return SYMBOLS_BY_CHAIN.get(id)?.get(address.toLowerCase());
}

export { SYMBOL_META };
