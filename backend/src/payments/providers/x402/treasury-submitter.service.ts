import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { encodeAbiParameters, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AppConfigService } from '../../../config/app-config.service.js';
import { CoordinationRedis } from '../../../common/coordination-redis.js';
import { LeaseRunner, defaultLeaseClock, type LeaseRunnerClock } from '../../../common/lease-runner.js';
import { leasesEnabled } from '../../../common/process-role.js';
import { RELEASE_SCRIPT } from '../../../common/redis-lease.js';
import { EvmRpcClient } from './evm-rpc.client.js';
import { TRANSFER_WITH_AUTHORIZATION_SELECTOR } from './eip3009.js';

/**
 * THE RELAYER. The only thing in this backend that signs and broadcasts a
 * transaction, and the only private key the payment system holds.
 *
 * ── WHAT IT CAN AND CANNOT DO ──────────────────────────────────────────────
 *
 * It submits a customer's already-signed EIP-3009 authorization to the token
 * contract and pays the gas. Every field that moves money — `from`, `to`,
 * `value`, `nonce` — is inside the CUSTOMER's signature, so this key cannot
 * redirect a cent: change any of them and the token's own signature check fails
 * and the call reverts.
 *
 * **BLAST RADIUS OF A FULL COMPROMISE: the gas float, and nothing else.** An
 * attacker holding this key can waste the ETH sitting in the relayer account and
 * can grief pending upgrades by refusing to submit. They cannot touch customer
 * funds and cannot touch the treasury, whose key never comes near this process.
 * Fund it with a few dollars, alert on the balance, and treat it as disposable.
 *
 * Contrast the HD hot-wallet sweeper this design deliberately rejected: deposit
 * addresses were non-hardened BIP-32 children, so an xpub plus ONE leaked child
 * key reconstructs the parent and drains every address past and future. That is
 * why `receiveWithAuthorization` is also forbidden — it enforces
 * `msg.sender == to`, which would force the TREASURY key onto this machine and
 * turn a gas-float leak into a treasury drain.
 *
 * ── IT IS OPTIONAL, AND THAT IS DELIBERATE ─────────────────────────────────
 *
 * With no key configured this service reports `isReady === false` and the
 * customer is asked to submit their own authorization from their wallet (paying
 * their own gas). That is a supported deployment: it removes the last key from
 * the server entirely at the cost of one extra wallet confirmation.
 */
@Injectable()
export class TreasurySubmitterService implements OnModuleInit {
  private readonly logger = new Logger(TreasurySubmitterService.name);
  private account?: ReturnType<typeof privateKeyToAccount>;
  private readonly clients = new Map<number, EvmRpcClient>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    // P2.1, APPENDED and optional: the coordination client for the fleet-wide
    // relayer lock (leases on only). Absent → the relay is unlocked, as today.
    @Optional() @Inject(CoordinationRedis) private readonly coordination?: CoordinationRedis,
    // Specs only.
    @Optional() private readonly lockClock?: LeaseRunnerClock,
  ) {}

  onModuleInit(): void {
    const key = this.config.x402SubmitterPrivateKey;
    if (!key) {
      this.logger.log(
        'No X402_SUBMITTER_PRIVATE_KEY — customers will submit their own authorizations and pay their own gas',
      );
      return;
    }
    try {
      this.account = privateKeyToAccount(key as Hex);
    } catch (err) {
      // Loud but NOT fatal: a malformed relayer key must not stop the app, since
      // the customer-submits path still works. Fatal would turn a typo into an
      // outage of the whole API.
      this.logger.error(
        `[alert] x402.submitter_key_invalid — X402_SUBMITTER_PRIVATE_KEY could not be parsed ` +
          `(${(err as Error).message}); falling back to customer-submitted authorizations`,
      );
      return;
    }
    this.logger.log(`x402 relayer ready: ${this.account.address} (gas-only; cannot move customer funds)`);
  }

  get isReady(): boolean {
    return this.account !== undefined;
  }

  /** The relayer's own address — public, and useful for a gas-balance alert. */
  get address(): string | undefined {
    return this.account?.address;
  }

  /**
   * ABI-encode `transferWithAuthorization(...)` with the customer's signature.
   *
   * Public and pure so the PREFLIGHT can simulate exactly the calldata the relay
   * will send — a preflight that builds its own encoding proves nothing about the
   * transaction we are about to pay for. Uses the `bytes signature` overload
   * (`0xcf092995`), never the `(v,r,s)` one.
   */
  encodeRelayCalldata(args: {
    from: string;
    to: string;
    valueBaseUnits: bigint;
    validAfter: number;
    validBefore: number;
    nonce: string;
    signature: string;
  }): Hex {
    const encodedArgs = encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes' },
      ],
      [
        args.from as Hex,
        args.to as Hex,
        args.valueBaseUnits,
        BigInt(args.validAfter),
        BigInt(args.validBefore),
        args.nonce as Hex,
        args.signature as Hex,
      ],
    );
    return `${TRANSFER_WITH_AUTHORIZATION_SELECTOR}${encodedArgs.slice(2)}` as Hex;
  }

  /**
   * Simulate the relay without spending anything.
   *
   * Run BEFORE a signature is accepted, so a customer whose balance moved, or
   * whose nonce is already spent, is told immediately rather than after a
   * reverted transaction. `eth_estimateGas` is the simulation: it executes the
   * call against current state and throws on a revert.
   *
   * Returns a reason string on failure rather than throwing — this is ordinary
   * caller input on an authenticated route, and a throw would make a customer's
   * insufficient balance a 500.
   */
  async preflight(args: {
    chainId: number;
    tokenAddress: string;
    calldata: Hex;
    /**
     * Who will ACTUALLY send the transaction if this succeeds — the relayer when
     * there is one, otherwise the customer's own wallet.
     *
     * `transferWithAuthorization` does not check `msg.sender`, so the outcome is
     * the same either way; the reason to pass the real sender is that
     * `eth_estimateGas` returns THAT account's gas cost and, on the self-submit
     * path, the customer is the one who pays it. Simulating from an unrelated
     * address (this used to fall back to the token contract itself) estimates a
     * transaction nobody is going to send.
     */
    sender: string;
  }): Promise<{ ok: true; gas: bigint } | { ok: false; reason: string }> {
    const client = this.clientFor(args.chainId);
    if (!client) return { ok: false, reason: `no RPC endpoint for chain ${args.chainId}` };
    const from = this.account?.address ?? args.sender;
    try {
      const gas = await client.estimateGas({ from, to: args.tokenAddress, data: args.calldata });
      return { ok: true, gas };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  /**
   * Sign and broadcast the relay. Returns the transaction hash.
   *
   * THROWS on failure, and the caller must treat that as RETRYABLE rather than
   * as a refusal: the authorization is still valid and still spendable until
   * `validBefore`, so a broadcast that failed on a node error should be tried
   * again. Re-submitting is safe by construction — the token marks the nonce
   * spent, so a duplicate relay reverts instead of paying twice.
   */
  async relay(args: { chainId: number; tokenAddress: string; calldata: Hex; gas: bigint }): Promise<string> {
    const account = this.account;
    if (!account) throw new Error('no relayer configured');
    const client = this.clientFor(args.chainId);
    if (!client) throw new Error(`no RPC endpoint for chain ${args.chainId}`);

    // P2.1 (leases on): nonce read → sign → send is serialised FLEET-wide per
    // relayer address (lock `relayer:<address>`, 60 s), so two api replicas
    // never read the same pending nonce. Leases off: today (unlocked).
    const release = await this.acquireRelayLock(account.address);
    try {
      return await this.signAndSend(account, client, args);
    } finally {
      await release();
    }
  }

  /** Lock TTL and the longest a relay waits for it before answering retryable (design §2.3). */
  static readonly RELAY_LOCK_TTL_MS = 60_000;
  static readonly RELAY_LOCK_WAIT_MS = 10_000;
  static readonly RELAY_LOCK_POLL_MS = 250;

  /**
   * Take `relayer:<address>` (leases on only). Returns its release. Throws a
   * RETRYABLE error after `RELAY_LOCK_WAIT_MS` held elsewhere (the caller
   * already treats a relay throw as retryable — the authorization stays valid
   * until `validBefore`). Redis unavailable → proceeds unlocked (fail-open:
   * the worst case is a nonce collision, which is itself a retryable error).
   */
  private async acquireRelayLock(address: string): Promise<() => Promise<void>> {
    const none = async () => undefined;
    if (!leasesEnabled() || !this.coordination) return none;
    const coordination = this.coordination;
    const clock = this.lockClock ?? defaultLeaseClock;
    const lock = new LeaseRunner({
      name: `relayer:${address.toLowerCase()}`,
      redis: () => coordination.client(),
      namespace: coordination.namespace,
      ttlMs: TreasurySubmitterService.RELAY_LOCK_TTL_MS,
      work: () => undefined,
      stopOnShutdown: false,
      clock,
    });
    const deadline = clock.now() + TreasurySubmitterService.RELAY_LOCK_WAIT_MS;
    for (;;) {
      const got = await lock.tryAcquire();
      if (got.status === 'acquired') {
        return async () => {
          const client = await coordination.client().catch(() => undefined);
          await client?.eval(RELEASE_SCRIPT, 1, lock.key, lock.owner).catch(() => undefined);
        };
      }
      if (got.status === 'unavailable') {
        this.logger.warn(`[alert] process_role.lease_unavailable lock=${lock.name} — Redis unreachable; relaying unlocked`);
        return none;
      }
      if (clock.now() >= deadline) {
        throw new Error('relayer busy: another relay holds the relayer lock — retry shortly');
      }
      await clock.sleep(TreasurySubmitterService.RELAY_LOCK_POLL_MS);
    }
  }

  private async signAndSend(
    account: ReturnType<typeof privateKeyToAccount>,
    client: EvmRpcClient,
    args: { chainId: number; tokenAddress: string; calldata: Hex; gas: bigint },
  ): Promise<string> {
    const [nonce, gasPrice] = await Promise.all([
      client.transactionCount(account.address),
      client.gasPrice(),
    ]);

    const signed = await account.signTransaction({
      chainId: args.chainId,
      to: args.tokenAddress as Hex,
      data: args.calldata,
      // A 25% headroom over the estimate. An EIP-3009 relay is a fixed-shape
      // call, so the estimate is reliable — the margin covers the state drift
      // between estimating and mining (a first-ever transfer to the treasury
      // writes a fresh storage slot and costs more than a later one).
      gas: (args.gas * 125n) / 100n,
      gasPrice: (gasPrice * 120n) / 100n,
      nonce,
      type: 'legacy',
    });
    return client.sendRawTransaction(signed);
  }

  private clientFor(chainId: number): EvmRpcClient | undefined {
    const cached = this.clients.get(chainId);
    if (cached) return cached;
    const url = this.config.evmRpcUrls.get(chainId);
    if (!url) return undefined;
    const client = new EvmRpcClient(chainId, url);
    this.clients.set(chainId, client);
    return client;
  }
}
