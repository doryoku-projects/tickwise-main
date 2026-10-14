/*
 * An in-memory stand-in for the Envio indexer, answering the subgraph-dialect
 * documents `EnvioAdapter` sends (through a mocked `graphql-request`), with the
 * ORDERING the real translator guarantees: every root's ORDER BY gets `id asc`
 * appended, and `first`/`skip` slice after the sort. Enough of the dialect for
 * the backfill walks: the tokenId range walk, the createdAt offset walk (the
 * completeness tail), the tokenId edge reads, pools (plain, poolStats, and the
 * combined per-range request) and tokens.
 */

export const CHAIN = 1;
export const POOL_ID = '0x00000000000000000000000000000000000000000000000000000000000000aa';
/** On mainnet's whitelist (verified). */
export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

export interface FakePosition {
  tokenId: number;
  createdAt: number;
  isActive?: boolean;
  liquidity?: string;
  lastModifyBlock?: number;
  /** Duplicates the row under the same tokenId (an impossible v4 state, for the overflow guard). */
  duplicate?: number;
}

type Vars = Record<string, unknown>;

export class FakeIndexer {
  positions: FakePosition[] = [];
  poolTick = 10;
  /** Per-op request log. */
  calls: Array<{ op: string; variables: Vars }> = [];
  /** Delay (ms) for a tokenId range request, by its `tokenId_gte`. */
  rangeDelayMs = new Map<string, number>();
  /** Called after each tokenId range page is answered (to mutate the table mid-walk). */
  afterRangePage?: (from: string) => void;
  /** Increment `poolTick` by this on every combined range-pools request. */
  tickStepPerRangePools = 0;

  /** Fail a request (non-retriable error) when this returns true; `n` = earlier calls of that op. */
  failWhen?: (op: string, n: number) => boolean;

  async respond(query: string, variables: Vars): Promise<unknown> {
    const op = opName(query);
    const n = this.count(op);
    this.calls.push({ op, variables });
    if (this.failWhen?.(op, n)) throw new Error(`fake indexer: ${op} exploded`);
    switch (op) {
      case 'PositionsByTokenId':
        return this.positionsByTokenId(variables);
      case 'TokenIdEdge':
        return this.tokenIdEdge(variables);
      case 'Positions':
        return this.positionsByCreatedAt(variables);
      case 'RangePools':
        this.poolTick += this.tickStepPerRangePools;
        return { pools: this.poolRows(variables, true) };
      case 'Pools':
        return { pools: this.poolRows(variables, false) };
      case 'PoolStats':
        return { pools: this.poolRows(variables, true) };
      case 'Tokens':
        return { tokens: this.tokenRows(variables) };
      default:
        return {};
    }
  }

  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  private rows(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const p of this.positions) {
      const copies = 1 + (p.duplicate ?? 0);
      for (let i = 0; i < copies; i++) out.push(row(p, i));
    }
    return out;
  }

  private async positionsByTokenId(v: Vars): Promise<unknown> {
    const where = (v.where ?? {}) as Record<string, string>;
    const gte = BigInt(where.tokenId_gte ?? '0');
    const lt = where.tokenId_lt !== undefined ? BigInt(where.tokenId_lt) : undefined;
    const delay = this.rangeDelayMs.get(String(where.tokenId_gte));
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const matched = this.rows()
      .filter((r) => {
        const t = BigInt(String(r.tokenId));
        return t >= gte && (lt === undefined || t < lt);
      })
      .sort((a, b) => cmpBig(String(a.tokenId), String(b.tokenId)) || cmpStr(String(a.id), String(b.id)));
    const skip = Number(v.skip ?? 0);
    const first = Number(v.first ?? 100);
    const page = matched.slice(skip, skip + first);
    this.afterRangePage?.(String(where.tokenId_gte));
    return { positions: page };
  }

  private tokenIdEdge(v: Vars): unknown {
    const where = (v.where ?? {}) as Record<string, string>;
    const since = where.createdAtTimestamp_gte !== undefined ? Number(where.createdAtTimestamp_gte) : undefined;
    const matched = this.rows()
      .filter((r) => since === undefined || Number(r.createdAtTimestamp) >= since)
      .sort((a, b) => cmpBig(String(a.tokenId), String(b.tokenId)));
    if (matched.length === 0) return { positions: [] };
    const pick = v.orderDirection === 'desc' ? matched[matched.length - 1]! : matched[0]!;
    return { positions: [{ tokenId: pick.tokenId }] };
  }

  private positionsByCreatedAt(v: Vars): unknown {
    const where = (v.where ?? {}) as Record<string, string>;
    const gte = where.createdAtTimestamp_gte !== undefined ? Number(where.createdAtTimestamp_gte) : -Infinity;
    const lt = where.createdAtTimestamp_lt !== undefined ? Number(where.createdAtTimestamp_lt) : Infinity;
    const matched = this.rows()
      .filter((r) => Number(r.createdAtTimestamp) >= gte && Number(r.createdAtTimestamp) < lt)
      .sort((a, b) => Number(a.createdAtTimestamp) - Number(b.createdAtTimestamp) || cmpStr(String(a.id), String(b.id)));
    if (v.orderDirection === 'desc') matched.reverse();
    const skip = Number(v.skip ?? 0);
    const first = Number(v.first ?? 100);
    return { positions: matched.slice(skip, skip + first) };
  }

  private poolRows(v: Vars, withStats: boolean): unknown[] {
    const where = (v.where ?? v) as Record<string, unknown>;
    const ids = ((where.id_in ?? v.ids ?? []) as string[]).map((s) => s.toLowerCase());
    if (!ids.includes(POOL_ID)) return [];
    const base: Record<string, unknown> = {
      id: POOL_ID,
      name: 'WETH/USDC',
      fee: 500,
      tickSpacing: 10,
      tick: this.poolTick,
      sqrtPriceX96: '79228162514264337593543950336',
      token0Id: WETH,
      token1Id: USDC,
    };
    if (withStats) {
      Object.assign(base, {
        totalValueLockedUSD: '1000000',
        totalValueLockedUSDUntracked: '0',
        totalValueLockedToken0: '100',
        totalValueLockedToken1: '1000000',
        volumeUSD: '5',
        feesUSD: '1',
      });
    }
    return [base];
  }

  private tokenRows(v: Vars): unknown[] {
    const where = (v.where ?? {}) as Record<string, unknown>;
    const ids = ((where.id_in ?? []) as string[]).map((s) => s.toLowerCase());
    const all = [
      { id: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
      { id: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    ];
    return all.filter((t) => ids.includes(t.id));
  }
}

function row(p: FakePosition, copy: number): Record<string, unknown> {
  const active = p.isActive !== false;
  return {
    id: `${CHAIN}_${p.tokenId}${copy > 0 ? `_dup${copy}` : ''}`,
    chainId: CHAIN,
    tokenId: String(p.tokenId),
    owner: '0x1111111111111111111111111111111111111111',
    poolId: POOL_ID,
    tickLower: -100,
    tickUpper: 100,
    liquidity: p.liquidity ?? (active ? '1000' : '0'),
    isActive: active,
    isPriceable: true,
    createdAtTimestamp: String(p.createdAt),
    createdAtBlockNumber: String(p.createdAt),
    closedAtTimestamp: active ? null : String(p.createdAt + 10),
    depositedToken0: 1,
    depositedToken1: 1,
    withdrawnToken0: 0,
    withdrawnToken1: 0,
    totalFeesCollected0: 0,
    totalFeesCollected1: 0,
    amount0: active ? 1 : 0,
    amount1: active ? 1 : 0,
    totalGasCostETH: 0,
    updatedAtBlock: String(p.createdAt),
    updatedAtTimestamp: String(p.createdAt),
    lastModifyBlock: String(p.lastModifyBlock ?? p.createdAt),
  };
}

function opName(query: string): string {
  const m = /query\s+(\w+)/.exec(query);
  return m?.[1] ?? 'unknown';
}

function cmpBig(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A `graphql-request` mock module factory bound to `getIndexer()`. */
export function graphqlRequestMock(getIndexer: () => FakeIndexer) {
  return {
    gql: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), ''),
    GraphQLClient: class {
      async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
        return (await getIndexer().respond(query, variables)) as T;
      }
    },
  };
}
