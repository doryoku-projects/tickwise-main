/*
 * An in-memory subgraph for the charts specs: it parses whatever document it is
 * handed — the legacy single-root queries, the adapter's paged transaction walk,
 * or the new multi-root batch — and answers every root from one data set, with
 * The Graph's semantics for the handful of arguments these reads use (`where`,
 * `orderBy`/`orderDirection`, `first`, `skip`, `id`). Both chart implementations
 * then read IDENTICAL data, which is what makes the fixture-equality spec a
 * comparison of the computations rather than of two fakes.
 */
import { Kind, parse, type FieldNode, type OperationDefinitionNode, type SelectionSetNode, type ValueNode } from 'graphql';
import type { GraphQLClient } from 'graphql-request';

export interface FakePoolDay {
  pool: string;
  date: number;
  tick: string | null;
  token0Price: string;
  token1Price: string;
  open: string;
  high: string;
  low: string;
  close: string;
  tvlUSD: string;
  volumeUSD: string;
  feesUSD: string;
}
export interface FakeTokenDay {
  token: string;
  date: number;
  priceUSD: string;
}
export interface FakeTick {
  pool: string;
  tickIdx: string;
  liquidityGross: string;
  liquidityNet: string;
  price0: string;
  price1: string;
}
export interface FakePool {
  tick: string | null;
  sqrtPrice: string;
  tickSpacing: string;
  token0: { decimals: string };
  token1: { decimals: string };
}
export interface FakeTx {
  chainId: string;
  txHash: string;
  logIndex: string;
  type: string;
  tokenId: string;
  amount0: string;
  amount1: string;
  gasCostETH: string;
  timestamp: string;
  blockNumber: string;
  sender: string;
}

export interface FakeData {
  poolDayDatas: FakePoolDay[];
  tokenDayDatas: FakeTokenDay[];
  ticks: FakeTick[];
  pools: Record<string, FakePool>;
  positionTransactions: FakeTx[];
}

export interface FakeCall {
  query: string;
  variables: Record<string, unknown>;
  /** Root field names, in document order. */
  roots: string[];
}

export interface FakeSubgraphOptions {
  /** Throw instead of answering (inspect `call.roots` to fail selectively). */
  fail?: (call: FakeCall) => unknown;
  /** Delay (or hold) the answer. */
  delay?: (call: FakeCall) => Promise<void> | undefined;
  /** Observes each call as it arrives (e.g. to read the caller's lane). */
  onCall?: (call: FakeCall) => void;
}

const DEFAULT_FIRST = 100;

export function fakeSubgraph(data: FakeData, options: FakeSubgraphOptions = {}) {
  const calls: FakeCall[] = [];
  const client = {
    async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      const op = parse(query).definitions[0] as OperationDefinitionNode;
      const fields = op.selectionSet.selections as FieldNode[];
      const call: FakeCall = { query, variables, roots: fields.map((field) => field.name.value) };
      calls.push(call);
      options.onCall?.(call);
      await options.delay?.(call);
      const failure = options.fail?.(call);
      if (failure) throw failure;
      const out: Record<string, unknown> = {};
      for (const field of fields) out[field.alias?.value ?? field.name.value] = resolveRoot(field, variables, data);
      return out as T;
    },
  };
  return { client: client as unknown as GraphQLClient, calls };
}

function resolveRoot(field: FieldNode, vars: Record<string, unknown>, data: FakeData): unknown {
  const args: Record<string, unknown> = {};
  for (const arg of field.arguments ?? []) args[arg.name.value] = valueOf(arg.value, vars);
  const where = (args.where ?? {}) as Record<string, unknown>;
  const first = (args.first as number | undefined) ?? DEFAULT_FIRST;
  const skip = (args.skip as number | undefined) ?? 0;
  const desc = args.orderDirection === 'desc';
  const page = <T>(rows: T[]) => rows.slice(skip, skip + first);

  switch (field.name.value) {
    case 'poolDayDatas': {
      const rows = data.poolDayDatas
        .filter((r) => r.pool === where.pool && (where.date_gte === undefined || r.date >= Number(where.date_gte)))
        .sort((a, b) => (desc ? b.date - a.date : a.date - b.date));
      return page(rows).map((r) => project(r, field.selectionSet));
    }
    case 'tokenDayDatas': {
      const rows = data.tokenDayDatas
        .filter((r) => r.token === where.token && (where.date_gte === undefined || r.date >= Number(where.date_gte)))
        .sort((a, b) => (desc ? b.date - a.date : a.date - b.date));
      return page(rows).map((r) => project(r, field.selectionSet));
    }
    case 'ticks': {
      const floor = BigInt(String(where.liquidityGross_gt ?? '-1'));
      const rows = data.ticks
        .filter((r) => r.pool === where.pool && BigInt(r.liquidityGross) > floor)
        .sort((a, b) => Number(a.tickIdx) - Number(b.tickIdx));
      return page(rows).map((r) => project(r, field.selectionSet));
    }
    case 'pool': {
      const row = data.pools[String(args.id)];
      return row ? project(row, field.selectionSet) : null;
    }
    case 'positionTransactions': {
      const ids = (where.tokenId_in as string[] | undefined)?.map(String);
      const rows = data.positionTransactions
        .filter(
          (r) =>
            (where.chainId === undefined || Number(r.chainId) === Number(where.chainId)) &&
            (ids === undefined || ids.includes(r.tokenId)) &&
            (where.timestamp_gt === undefined || Number(r.timestamp) > Number(where.timestamp_gt)),
        )
        // timestamp in the asked direction, then a stable id ASCENDING either
        // way: a TOTAL order, as the translator's appended `id asc` makes it on
        // the real indexer.
        .sort(
          (a, b) =>
            (desc ? Number(b.timestamp) - Number(a.timestamp) : Number(a.timestamp) - Number(b.timestamp)) ||
            txId(a).localeCompare(txId(b)),
        );
      return page(rows).map((r) => project(r, field.selectionSet));
    }
    default:
      throw new Error(`fake subgraph: unsupported root ${field.name.value}`);
  }
}

function txId(tx: FakeTx): string {
  return `${tx.txHash}-${tx.logIndex.padStart(6, '0')}`;
}

function project(row: object, selection: SelectionSetNode | undefined): Record<string, unknown> {
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const node of selection?.selections ?? []) {
    if (node.kind !== Kind.FIELD) throw new Error('fake subgraph: fragments are not supported');
    const value = source[node.name.value];
    out[node.alias?.value ?? node.name.value] =
      node.selectionSet && value && typeof value === 'object' ? project(value, node.selectionSet) : value;
  }
  return out;
}

function valueOf(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case Kind.VARIABLE:
      return vars[node.name.value];
    case Kind.INT:
      return Number(node.value);
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.BOOLEAN:
      return node.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map((value) => valueOf(value, vars));
    case Kind.OBJECT:
      return Object.fromEntries(node.fields.map((f) => [f.name.value, valueOf(f.value, vars)]));
    default:
      return undefined;
  }
}
