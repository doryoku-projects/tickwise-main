/*
 * `EnvioAdapter.fetchPositionTransactions` honours `maxPages` and says when it
 * stopped short.
 *
 * It used to loop `page < 1000` whatever it was asked, so position detail —
 * which asked for ONE page — walked a busy position's whole history. The walk is
 * oldest-first, so a capped list is missing its NEWEST rows; `truncated` is how a
 * caller knows.
 */
import { describe, expect, it } from 'vitest';

import {
  EnvioAdapter,
  envioTxWhere,
  normalizeEnvioTransaction,
  type IndexedTx,
} from '../src/subgraph/adapters/envio.adapter.js';

const integration = { chainId: 1, protocol: 'uniswap-v4', dialect: 'hyperindex', enabled: true, subgraphUrl: 'http://x' };

function rows(n: number): IndexedTx[] {
  return Array.from({ length: n }, (_, i) => ({
    chainId: 1,
    txHash: `0x${i.toString(16).padStart(4, '0')}`,
    logIndex: i % 5,
    type: i % 3 === 0 ? 'DEPOSIT' : 'COLLECT',
    tokenId: '7',
    amount0: i,
    amount1: i * 2,
    gasCostETH: 0.001,
    timestamp: String(1_700_000_000 + i),
    blockNumber: String(100 + i),
    sender: '0xABC',
  }));
}

function adapterOver(all: IndexedTx[]) {
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    async request(_query: string, variables: { first: number; skip: number }) {
      requests.push(variables);
      return { positionTransactions: all.slice(variables.skip, variables.skip + variables.first) };
    },
  };
  const adapter = new EnvioAdapter({} as never, {} as never, {} as never);
  (adapter as unknown as { positionSource: () => unknown }).positionSource = () => client;
  const walk = (maxPages: number, cursorTimestamp = 0) =>
    adapter.fetchPositionTransactions({
      integration: integration as never,
      positionIds: ['7'],
      cursorTimestamp,
      pageSize: 1000,
      maxPages,
    });
  return { requests, walk };
}

describe('fetchPositionTransactions — maxPages', () => {
  it('stops at maxPages and flags a full last page as truncated', async () => {
    const { requests, walk } = adapterOver(rows(2500));
    const result = await walk(1);
    expect(requests).toHaveLength(1);
    expect(result.transactions).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it('a walk that ends on a short page inside the limit is complete — no flag at all', async () => {
    const { requests, walk } = adapterOver(rows(2500));
    const result = await walk(3);
    expect(requests.map((r) => r.skip)).toEqual([0, 1000, 2000]);
    expect(result.transactions).toHaveLength(2500);
    expect(result).not.toHaveProperty('truncated');
  });

  it('exactly a multiple of the page size at the limit reads as truncated (one more row cannot be asked for)', async () => {
    const { walk } = adapterOver(rows(2000));
    expect((await walk(2)).truncated).toBe(true);
  });

  it('maxPages <= 0 still means no limit', async () => {
    const { requests, walk } = adapterOver(rows(2500));
    const result = await walk(0);
    expect(requests).toHaveLength(3);
    expect(result.transactions).toHaveLength(2500);
    expect(result.truncated).toBeUndefined();
  });

  it('a cursor timestamp narrows the walk', async () => {
    const { requests, walk } = adapterOver(rows(10));
    await walk(5, 1_700_000_004);
    expect(requests[0]!.where).toEqual({ chainId: 1, tokenId_in: ['7'], timestamp_gt: '1700000004' });
  });
});

/**
 * An indexer that honours the direction the way the translator orders it:
 * `timestamp <dir>, id asc` — ties stay id-ascending whichever way the read goes.
 */
function directedAdapterOver(all: IndexedTx[]) {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const id = (r: IndexedTx) => `${r.txHash}-${String(r.logIndex).padStart(4, '0')}`;
  const client = {
    async request(query: string, variables: { first: number; skip: number }) {
      requests.push({ query, variables });
      const desc = query.includes('orderDirection: desc');
      const rows = [...all].sort(
        (a, b) =>
          (desc ? Number(b.timestamp) - Number(a.timestamp) : Number(a.timestamp) - Number(b.timestamp)) ||
          id(a).localeCompare(id(b)),
      );
      return { positionTransactions: rows.slice(variables.skip, variables.skip + variables.first) };
    },
  };
  const adapter = new EnvioAdapter({} as never, {} as never, {} as never);
  (adapter as unknown as { positionSource: () => unknown }).positionSource = () => client;
  const read = (maxPages: number, newestFirst?: boolean) =>
    adapter.fetchPositionTransactions({
      integration: integration as never,
      positionIds: ['7'],
      cursorTimestamp: 0,
      pageSize: 1000,
      maxPages,
      newestFirst,
    });
  return { requests, read };
}

/** 2,500 rows in runs of four equal timestamps, so a 1000-row page boundary falls inside a run. */
function tiedRows(n: number): IndexedTx[] {
  return rows(n).map((row, i) => ({ ...row, timestamp: String(1_700_000_000 + Math.floor(i / 4) * 10) }));
}

describe('fetchPositionTransactions — newestFirst', () => {
  it('one page is the NEWEST thousand, returned oldest first, and truncated means the OLDEST are missing', async () => {
    const all = tiedRows(2500);
    const { requests, read } = directedAdapterOver(all);
    const head = await read(1, true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.query).toContain('orderDirection: desc');
    expect(head.truncated).toBe(true);
    expect(head.transactions).toHaveLength(1000);
    const stamps = head.transactions.map((t) => t.timestamp);
    expect(Math.max(...stamps)).toBe(Math.max(...all.map((r) => Number(r.timestamp))));
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });

  it('a short history read newest first is EXACTLY what the ascending walk returns, ties included', async () => {
    const { read } = directedAdapterOver(tiedRows(998));
    const head = await read(1, true);
    const walk = await read(1);
    expect(head).not.toHaveProperty('truncated');
    expect(head.transactions.map((t) => t.transactionId)).toEqual(walk.transactions.map((t) => t.transactionId));
  });

  it('the ascending walk keeps its own document', async () => {
    const { requests, read } = directedAdapterOver(tiedRows(10));
    await read(1);
    expect(requests[0]!.query).toContain('orderDirection: asc');
    expect(requests[0]!.query).not.toContain('orderDirection: desc');
  });

  it('a newest-first walk drops a row a mid-walk insert pushed onto the next page', async () => {
    const all = tiedRows(2000);
    const requests: number[] = [];
    // Page 2 is read after a new transaction landed at the top: every row moved
    // down one, so page 2 starts with the last row of page 1.
    const client = {
      async request(_q: string, variables: { first: number; skip: number }) {
        requests.push(variables.skip);
        const desc = [...all].reverse();
        const shifted = variables.skip === 0 ? desc : [{ ...all[0]!, txHash: '0xnew' }, ...desc];
        return { positionTransactions: shifted.slice(variables.skip, variables.skip + variables.first) };
      },
    };
    const adapter = new EnvioAdapter({} as never, {} as never, {} as never);
    (adapter as unknown as { positionSource: () => unknown }).positionSource = () => client;
    const result = await adapter.fetchPositionTransactions({
      integration: integration as never,
      positionIds: ['7'],
      cursorTimestamp: 0,
      pageSize: 1000,
      maxPages: 3,
      newestFirst: true,
    });
    const ids = result.transactions.map((t) => t.transactionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the exported row helpers are the adapter’s own', () => {
  it('normalizeEnvioTransaction is exactly what the walk returns', async () => {
    const all = rows(3);
    const { walk } = adapterOver(all);
    const result = await walk(1);
    expect(result.transactions).toEqual(all.map((raw) => normalizeEnvioTransaction(raw, integration as never)));
  });

  it('envioTxWhere only adds a timestamp bound when there is one', () => {
    expect(envioTxWhere({ chainId: 4663 }, ['1', '2'])).toEqual({ chainId: 4663, tokenId_in: ['1', '2'] });
    expect(envioTxWhere({ chainId: 1 }, ['1'], 9)).toEqual({ chainId: 1, tokenId_in: ['1'], timestamp_gt: '9' });
  });
});
