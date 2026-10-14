import { Logger } from '@nestjs/common';
import { request } from 'undici';

/**
 * The ONE place this backend talks to a blockchain node.
 *
 * the internal design notes listed RPC integration as out of scope, and that was true until
 * we chose to take custody of payments: no aggregator can answer "did this exact
 * transfer land in this exact address with N confirmations", which is the only
 * question a self-custody rail asks. RPC is confined HERE — a plain JSON-RPC
 * client over `undici`, no viem transport, no wallet, no signing. It reads; it
 * cannot move anything.
 *
 * Deliberately minimal: three calls (`eth_blockNumber`, `eth_getLogs`,
 * `eth_call`) are the entire surface a Transfer watcher needs. A heavier client
 * (viem's `PublicClient`, ethers `Provider`) would pull a transport, a chain
 * registry and a reconnection model we do not want on a read path that already
 * fails soft.
 */

/** The one hex-log shape `eth_getLogs` returns that we care about. */
export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string; // hex
  transactionHash: string;
  logIndex: string; // hex
}

/** The receipt fields settlement needs: did it succeed, and what did it emit. */
export interface RpcReceipt {
  status: string; // hex: '0x1' success, '0x0' reverted
  blockNumber: string; // hex
  transactionHash: string;
  logs: RpcLog[];
}

const RPC_TIMEOUT_MS = 10_000;

export class EvmRpcClient {
  private readonly logger: Logger;
  private nextId = 1;

  constructor(
    readonly chainId: number,
    private readonly url: string,
  ) {
    // Built in the body, not a field initializer: a field initializer runs
    // before the constructor parameter properties are assigned, so
    // `this.chainId` would be undefined in the label.
    this.logger = new Logger(`EvmRpc:${chainId}`);
  }

  /** Current head block number. */
  async blockNumber(): Promise<bigint> {
    return hexToBigInt(await this.call<string>('eth_blockNumber', []));
  }

  /**
   * ERC-20 `Transfer` logs for a set of token contracts, over a block range.
   *
   * Filtered to `Transfer(address,address,uint256)` by topic0 AND to our
   * watched addresses by topic2 (the indexed `to`), so the node does the
   * matching and we never page the whole chain's transfer traffic. `toBlock`
   * is a concrete number, never `latest`: two calls a few ms apart must cover a
   * deterministic, non-overlapping range or a log is double-counted or missed.
   */
  async transferLogs(args: {
    tokenAddresses: string[];
    toAddresses: string[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RpcLog[]> {
    if (args.tokenAddresses.length === 0 || args.toAddresses.length === 0) return [];
    const params = [
      {
        address: args.tokenAddresses.map((a) => a.toLowerCase()),
        topics: [
          TRANSFER_TOPIC,
          null, // from: any
          args.toAddresses.map(addressToTopic), // to: the addresses we watch
        ],
        fromBlock: bigIntToHex(args.fromBlock),
        toBlock: bigIntToHex(args.toBlock),
      },
    ];
    return this.call<RpcLog[]>('eth_getLogs', params);
  }

  /**
   * A single `eth_call`. Used for boot-time token verification (`symbol()`,
   * `decimals()`, `name()`, `version()`, `DOMAIN_SEPARATOR()`) and for the
   * relay's preflight (`balanceOf`, `authorizationState`), never on the hot
   * watch path.
   *
   * `from` is optional and only matters for a preflight `eth_call` that
   * simulates a state-changing function — the node needs a sender to charge.
   */
  async ethCall(to: string, data: string, from?: string): Promise<string> {
    const tx: Record<string, string> = { to: to.toLowerCase(), data };
    if (from) tx.from = from.toLowerCase();
    return this.call<string>('eth_call', [tx, 'latest']);
  }

  /**
   * Logs for ONE topic0 over a block range, optionally narrowed by a third
   * topic.
   *
   * Separate from `transferLogs` rather than a generalisation of it: that method
   * hard-codes the `Transfer` topic layout (`[topic0, from, to]`) and exists to
   * be read at a glance on the money path. This one takes the topic array as
   * given, which is what `AuthorizationUsed(authorizer, nonce)` needs — we
   * filter on the NONCE (topic2), because the nonce is the invoice reference and
   * the authorizer is not known until the customer signs.
   *
   * `toBlock` is a concrete number, never `latest`, for the same reason as
   * `transferLogs`: two calls a few ms apart must cover a deterministic,
   * non-overlapping range or a log is double-counted or missed.
   */
  async logsByTopic(args: {
    address?: string[];
    topic0: string;
    topic1?: string[] | null;
    topic2?: string[] | null;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RpcLog[]> {
    const topics: Array<string | string[] | null> = [args.topic0];
    if (args.topic1 !== undefined || args.topic2 !== undefined) {
      topics.push(args.topic1 ?? null);
    }
    if (args.topic2 !== undefined) topics.push(args.topic2 ?? null);

    const filter: Record<string, unknown> = {
      topics,
      fromBlock: bigIntToHex(args.fromBlock),
      toBlock: bigIntToHex(args.toBlock),
    };
    if (args.address && args.address.length > 0) {
      filter.address = args.address.map((a) => a.toLowerCase());
    }
    return this.call<RpcLog[]>('eth_getLogs', [filter]);
  }

  /**
   * A transaction receipt, or `null` when the node has not seen it.
   *
   * `null` IS A VALID ANSWER here and is the one exception to this client's
   * "a missing result is a failure" rule: a transaction that has been broadcast
   * but not yet mined legitimately has no receipt, and treating that as an error
   * would make every in-flight relay look like an outage. Callers must therefore
   * distinguish `null` (not mined yet — wait) from a throw (could not ask).
   */
  async getTransactionReceipt(txHash: string): Promise<RpcReceipt | null> {
    return this.callAllowNull<RpcReceipt>('eth_getTransactionReceipt', [txHash]);
  }

  /** The relayer's next nonce, counting pending transactions. */
  async transactionCount(address: string): Promise<number> {
    return Number(hexToBigInt(await this.call<string>('eth_getTransactionCount', [address.toLowerCase(), 'pending'])));
  }

  /** Broadcast a signed transaction. Returns its hash. */
  async sendRawTransaction(signed: string): Promise<string> {
    return this.call<string>('eth_sendRawTransaction', [signed]);
  }

  /** Current gas price, for a legacy-priced relay on a chain without EIP-1559 data. */
  async gasPrice(): Promise<bigint> {
    return hexToBigInt(await this.call<string>('eth_gasPrice', []));
  }

  /** `eth_estimateGas` for the relay. Throws when the call would revert. */
  async estimateGas(args: { from: string; to: string; data: string }): Promise<bigint> {
    return hexToBigInt(
      await this.call<string>('eth_estimateGas', [
        { from: args.from.toLowerCase(), to: args.to.toLowerCase(), data: args.data },
      ]),
    );
  }

  /**
   * `call` for the one method whose `null` result is meaningful.
   *
   * Kept as a separate entry point rather than a flag on `call`, so the strict
   * "a missing result is a transient failure" rule stays the DEFAULT and a future
   * method cannot opt out of it by accident.
   */
  private async callAllowNull<T>(method: string, params: unknown[]): Promise<T | null> {
    const body = await this.rpc(method, params);
    if (body.error) {
      throw new Error(`${method} rpc error: ${body.error.message ?? 'unknown'}`);
    }
    return (body.result as T | null | undefined) ?? null;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const body = await this.rpc(method, params);
    if (body.error) {
      // The RPC's own error. Surfaced with the method so a provider that caps
      // `eth_getLogs` range is diagnosable — a silent empty result there would
      // read as "no payments arriving".
      throw new Error(`${method} rpc error: ${body.error.message ?? 'unknown'}`);
    }
    // A response with neither `error` NOR `result` is malformed. Returning it as
    // `T` was a lying cast: `eth_getLogs` → null then crashes on `.length`, and
    // `eth_call` → null then reads as 0 decimals. Throw so the caller treats it
    // as a transient failure — the watcher then does NOT advance its watermark,
    // and boot verification logs a tolerated warning rather than trusting a
    // phantom decimals of 0. (An empty log set is `[]`, not null, so this never
    // fires on a legitimately-empty getLogs.)
    if (body.result === null || body.result === undefined) {
      throw new Error(`${method} returned no result`);
    }
    return body.result as T;
  }

  /**
   * Host for error messages. HOST ONLY, deliberately: the path and query carry
   * the API key, and an error string ends up in logs, alerts and screenshots.
   */
  private host(): string {
    try {
      return new URL(this.url).host;
    } catch {
      return 'unparseable-rpc-url';
    }
  }

  /** The transport. One place that speaks JSON-RPC; the two entry points above
   *  differ only in how they treat a null `result`. */
  private async rpc(
    method: string,
    params: unknown[],
  ): Promise<{ result?: unknown; error?: { message?: string } }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await request(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: controller.signal,
        bodyTimeout: RPC_TIMEOUT_MS,
        headersTimeout: RPC_TIMEOUT_MS,
      });
      // Status FIRST. Parsing before checking it is what turned a perfectly
      // clear provider message — a 403 whose text/plain body read "API key is
      // disabled. Please contact Dwellir…" — into `Unexpected token 'A',
      // "API key is"...`, a JSON parse error that named neither the status, nor
      // the host, nor the actual problem, and cost real time to trace.
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const text = await res.body.text().catch(() => '');
        throw new Error(
          `${method} HTTP ${res.statusCode} from ${this.host()}: ${text.trim().slice(0, 200)}`,
        );
      }
      try {
        return (await res.body.json()) as { result?: unknown; error?: { message?: string } };
      } catch (err) {
        // A 2xx that is not JSON — a proxy notice, an HTML error page, a
        // truncated body. Say so with the status and host rather than emitting a
        // bare SyntaxError about a character.
        throw new Error(
          `${method} returned a non-JSON body (HTTP ${res.statusCode}) from ${this.host()}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      // Network- and TLS-level failures arrive with the useful part in `code`
      // and `cause`, which a bare `err.message` drops — that is why a disabled
      // API key surfaced as an opaque OpenSSL string with no host attached.
      const e = err as NodeJS.ErrnoException & { cause?: unknown };
      if (e && typeof e === 'object' && !String(e.message ?? '').includes(this.host())) {
        const code = e.code ? ` code=${e.code}` : '';
        const cause = e.cause ? ` cause=${String((e.cause as Error)?.message ?? e.cause)}` : '';
        throw new Error(`${method} to ${this.host()} failed: ${e.message}${code}${cause}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** `keccak256("Transfer(address,address,uint256)")`. A constant; no hashing at runtime. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** `decimals()` and `symbol()` selectors — the two calls boot verification makes. */
export const DECIMALS_SELECTOR = '0x313ce567';
export const SYMBOL_SELECTOR = '0x95d89b41';

/** A 20-byte address → the 32-byte topic form `eth_getLogs` matches on. */
export function addressToTopic(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '');
  return `0x${clean.padStart(64, '0')}`;
}

/** The indexed `to` topic of a Transfer log → the 20-byte address, lowercased. */
export function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

export function hexToBigInt(hex: string): bigint {
  return BigInt(hex);
}

export function bigIntToHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}
