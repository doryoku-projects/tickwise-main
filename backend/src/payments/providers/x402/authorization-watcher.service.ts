import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppConfigService } from '../../../config/app-config.service.js';
import { baseUnitsToUsdMinor } from '../../../config/payment-tokens.config.js';
import { PaymentApplyService } from '../../payment-apply.service.js';
import { PaymentAuthorization } from '../../schemas/payment-authorization.schema.js';
import { AUTHORIZATION_USED_TOPIC } from './eip3009.js';
import {
  EvmRpcClient,
  TRANSFER_TOPIC,
  addressToTopic,
  hexToBigInt,
  topicToAddress,
  type RpcLog,
} from './evm-rpc.client.js';
import { X402_PROVIDER_KEY } from './x402.provider.js';

/** What one watch tick did, for the admin trigger and the logs. */
export interface WatchReport {
  chainId: number;
  scannedTo: number;
  found: number;
  applied: number;
  errors: number;
}

/**
 * THE SETTLEMENT WATCHER. A self-custody rail has no webhook, so this poll is the
 * ONLY thing that notices a payment.
 *
 * ── THE RULE THAT MAKES THIS SAFE ──────────────────────────────────────────
 *
 * `AuthorizationUsed(authorizer, nonce)` ALONE IS NOT PROOF OF PAYMENT, and
 * settling on it would be a free-money bug. On-chain a nonce is unique only PER
 * AUTHORIZER — the token stores `authorizationState[authorizer][nonce]` — so a
 * customer can legitimately spend the SAME nonce value from a second wallet they
 * control, and two different events can carry one nonce.
 *
 * So for every candidate event this watcher fetches the transaction receipt and
 * requires, IN THE SAME TRANSACTION, a `Transfer` log from the SAME token with:
 *
 *   to    == the treasury the authorization was signed for (the STORED value,
 *            never current config — an operator rotating the treasury must not
 *            invalidate a payment already in flight)
 *   from  == the authorizer named in the event
 *   value >= the expected amount
 *
 * Only then does it settle, and only for the amount that ACTUALLY MOVED. Anything
 * else is logged and skipped rather than applied.
 *
 * ── CONFIRMATIONS, AND WHY THE WATERMARK IS CONSERVATIVE ───────────────────
 *
 * Scanning stops at `head − minConfirmations`, so a transfer that a reorg could
 * still erase is never acted on: granting a plan is not reversible, and the
 * entitlement is spent the moment it lands. The watermark advances ONLY when every
 * log in the range was handled cleanly — a transient apply failure must not carry
 * it past the payment's block, or that payment is never seen again. Re-scanning is
 * free: `providerPaymentId = <nonce>:<tx>:<logIndex>` plus the apply path's unique
 * index makes a repeat a no-op.
 */
/**
 * Pending authorizations examined per chain per tick. Caps the eth_getLogs
 * topic2 list and the Mongo read. Rows beyond it are simply scanned on a later
 * tick — their watermark is NOT advanced (see runChain).
 */
const PENDING_SCAN_LIMIT = 500;

/**
 * How long after its quote dies an authorization is left in the scan before
 * being retired. Generous on purpose: an EIP-3009 signature's own window is
 * minutes, so days of grace means nothing spendable is ever stopped from being
 * watched, while still bounding the pending set.
 */
const RETIRE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Nonces per `eth_getLogs`. Keeps the request body small enough to stay well
 * under provider topic-count caps and inside the client's fixed timeout; the
 * chunks' results are unioned, which is exactly what one big call returns.
 */
const LOG_TOPIC_CHUNK = 100;

@Injectable()
export class AuthorizationWatcherService {
  private readonly logger = new Logger(AuthorizationWatcherService.name);
  private readonly clients = new Map<number, EvmRpcClient>();
  /** Coalescing guard — a slow tick must not stack behind a repeatable cron. */
  private readonly inFlight = new Set<number>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PaymentApplyService) private readonly applyService: PaymentApplyService,
    @InjectModel(PaymentAuthorization.name)
    private readonly authorizations: Model<PaymentAuthorization>,
  ) {}

  /** Chains with an accepted token AND an endpoint — what the queue registers. */
  watchedChainIds(): number[] {
    if (!this.config.x402PaymentsConfigured) return [];
    const rpc = this.config.evmRpcUrls;
    return [...new Set(this.config.acceptedPaymentTokens.map((t) => t.chainId))].filter((id) =>
      rpc.has(id),
    );
  }

  /**
   * One poll of one chain.
   *
   * Returns rather than throws on a chain-level failure: the queue would retry
   * with backoff, but a node blip is not worth burning retries when the next tick
   * is 30 seconds away and the watermark has not moved.
   */
  async watchChain(chainId: number): Promise<WatchReport> {
    const report: WatchReport = { chainId, scannedTo: 0, found: 0, applied: 0, errors: 0 };
    if (this.inFlight.has(chainId)) {
      this.logger.log(`Chain ${chainId} watch already in flight — skipping this tick`);
      return report;
    }
    this.inFlight.add(chainId);
    try {
      await this.runChain(chainId, report);
    } catch (err) {
      report.errors += 1;
      this.logger.error(
        `[alert] x402.watch_failed chain=${chainId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight.delete(chainId);
    }
    return report;
  }

  private async runChain(chainId: number, report: WatchReport): Promise<void> {
    const client = this.clientFor(chainId);
    if (!client) return;

    // Anything that could still settle. `issued` is included on purpose: with no
    // relayer the customer submits from their own wallet, so a payment can land
    // for an authorization we never saw a signature for.
    // Ordered oldest-first and capped. The sort is load-bearing, not cosmetic:
    // without it the planner returns rows in whatever order the partial
    // {chainId,status} index yields — grouped by status ascending, which puts
    // `submitted` LAST. Those are the authorizations whose transaction is
    // already broadcast, i.e. the ones about to settle, so an unordered scan
    // drops exactly the rows that most need watching. Oldest-first also means a
    // backlog drains deterministically instead of starving the same tail.
    const pending = await this.authorizations
      .find({ chainId, status: { $in: ['issued', 'authorized', 'submitted'] } })
      .sort({ createdAt: 1, _id: 1 })
      .limit(PENDING_SCAN_LIMIT)
      .lean()
      .exec();
    if (pending.length === 0) return;
    if (pending.length === PENDING_SCAN_LIMIT) {
      // The cap is now safe (the watermark below only moves for scanned rows),
      // but a persistently full page means the backlog is not draining and some
      // authorizations are being watched late. That is worth a human.
      this.logger.warn(
        `[alert] x402.pending_scan_capped chain=${chainId} limit=${PENDING_SCAN_LIMIT} — ` +
          `backlog exceeds one tick; oldest are scanned first, newer wait`,
      );
    }

    const head = await client.blockNumber();
    const minConf = BigInt(this.config.minConfirmationsFor(chainId));
    // The reorg budget. A transfer shallower than this is deliberately invisible.
    const safeHead = head > minConf ? head - minConf : 0n;
    if (safeHead === 0n) return;

    const range = BigInt(Math.max(1, this.config.paymentWatchBlockRange));
    const fromBlock = this.scanFloor(pending, safeHead, range);
    if (fromBlock > safeHead) return;
    const toBlock = fromBlock + range - 1n > safeHead ? safeHead : fromBlock + range - 1n;

    const byNonce = new Map(pending.map((a) => [a.nonce.toLowerCase(), a]));
    const addresses = [...new Set(pending.map((a) => a.tokenAddress))];
    const nonces = [...byNonce.keys()];

    // Chunked. A full page of 500 nonces is a ~35 KB request body — large enough
    // that some providers reject it outright on a topic-count cap, and slow
    // enough to be a second way this wedges against the fixed request timeout.
    // Splitting is free: the union of per-chunk results is identical, because
    // topic2 is an OR-set and the block range is the same for every chunk.
    const logs: Awaited<ReturnType<typeof client.logsByTopic>> = [];
    for (let i = 0; i < nonces.length; i += LOG_TOPIC_CHUNK) {
      const chunk = nonces.slice(i, i + LOG_TOPIC_CHUNK);
      const part = await client.logsByTopic({
        address: addresses,
        topic0: AUTHORIZATION_USED_TOPIC,
        topic1: null, // authorizer: any — it is not known until the customer signs
        topic2: chunk.map((n) => n as string), // the nonce IS the reference
        fromBlock,
        toBlock,
      });
      logs.push(...part);
    }

    let allClean = true;
    for (const log of logs) {
      report.found += 1;
      try {
        const applied = await this.settle(client, log, byNonce);
        if (applied) report.applied += 1;
      } catch (err) {
        // HOLD THE WATERMARK. Carrying it past this block would lose the payment
        // permanently; a re-scan is idempotent and costs one `eth_getLogs`.
        allClean = false;
        report.errors += 1;
        this.logger.error(
          `[alert] x402.settle_failed chain=${chainId} tx=${log.transactionHash}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (allClean) {
      report.scannedTo = Number(toBlock);
      // ONLY the rows whose nonce was actually in the topic2 filter above. The
      // previous filter was {chainId, status}, which advanced the watermark for
      // every pending authorization including the ones past the scan cap — so
      // an authorization we never asked about was marked as scanned, and
      // `scanFloor` (a min over the marks) then moved past the block its payment
      // landed in. It was never looked at again: a silent, permanent loss of a
      // real payment. This is exactly what this file's header says the watermark
      // exists to prevent, and it is the same read-batch-then-write shape
      // `payment-reconcile.service.ts` already gets right.
      await this.authorizations
        .updateMany(
          { _id: { $in: pending.map((a) => a._id) } },
          { $set: { lastScannedBlock: Number(toBlock) } },
        )
        .exec();
    }
    if (report.found > 0 || report.errors > 0) {
      this.logger.log(`x402 watch chain=${chainId} ${JSON.stringify(report)}`);
    }

    await this.retireDeadAuthorizations(chainId);
  }

  /**
   * Retire authorizations that can no longer be paid.
   *
   * Without this the pending set only ever grows: nothing else in the codebase
   * writes `expired` or `failed`, and nothing deletes, so every abandoned quote
   * stays in the scan forever. That is what makes the per-tick cap bite — and
   * before the watermark fix, crossing that cap silently lost real payments.
   *
   * Deliberately conservative, because retiring a row stops watching it:
   *
   *  - `submitted` is NEVER retired. A transaction is in flight for that nonce.
   *  - `issued` is retired only long after its quote died. It is scanned in the
   *    first place because, with no relayer, a customer can sign and submit from
   *    their own wallet without us ever seeing the signature — so a payment can
   *    still arrive against a row we think is untouched. The grace period is
   *    what makes that safe: an EIP-3009 signature's own window is minutes, so
   *    once the quote has been dead for days no signature against that nonce can
   *    still be spent.
   *  - `authorized` additionally requires its signing window to have provably
   *    closed, the same test `rotate()` applies.
   *
   * A retired row keeps its document — it is the audit trail — and can still be
   * rotated back into use, since `rotatableStatus` admits `expired`.
   */
  private async retireDeadAuthorizations(chainId: number): Promise<void> {
    const graceMs = RETIRE_GRACE_MS;
    const deadBefore = new Date(Date.now() - graceMs);
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      const res = await this.authorizations
        .updateMany(
          {
            chainId,
            quoteExpiresAt: { $lt: deadBefore },
            $or: [
              { status: 'issued' },
              { status: 'authorized', validBefore: { $lt: nowSec } },
            ],
          },
          { $set: { status: 'expired' } },
        )
        .exec();
      const n = res?.modifiedCount ?? 0;
      if (n > 0) {
        this.logger.log(
          `x402 retired ${n} authorization(s) on chain ${chainId} — quote dead for over ` +
            `${Math.round(graceMs / 86_400_000)}d and unpayable`,
        );
      }
    } catch (err) {
      // Never let housekeeping fail a watch tick: the scan above already
      // committed its watermark, and a retry costs nothing.
      this.logger.warn(
        `x402 retire sweep failed chain=${chainId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * One `AuthorizationUsed` log → a settlement, if and only if the paired
   * `Transfer` proves the money actually reached the treasury.
   */
  private async settle(
    client: EvmRpcClient,
    log: RpcLog,
    byNonce: Map<string, PaymentAuthorization & { _id?: unknown }>,
  ): Promise<boolean> {
    // topics: [AuthorizationUsed, authorizer, nonce]
    const authorizer = topicToAddress(log.topics[1] ?? '');
    const nonce = (log.topics[2] ?? '').toLowerCase();
    const auth = byNonce.get(nonce);
    if (!auth) return false;

    const receipt = await client.getTransactionReceipt(log.transactionHash);
    if (!receipt) {
      // Not mined yet as far as this node is concerned. Not an error — the next
      // tick will find it — but the watermark must not advance past it either.
      throw new Error(`receipt not available yet for ${log.transactionHash}`);
    }
    if (receipt.status !== '0x1') {
      // The transaction reverted, so the event cannot really exist in canonical
      // state. Skip; nothing moved.
      this.logger.warn(`x402 skipping reverted tx ${log.transactionHash}`);
      return false;
    }

    const expected = BigInt(auth.expectedBaseUnits);
    const paired = findPairedTransfer(receipt.logs, {
      tokenAddress: auth.tokenAddress,
      from: authorizer,
      to: auth.treasuryAddress,
      minValue: expected,
    });
    if (!paired) {
      // THE GUARD DOING ITS JOB. An `AuthorizationUsed` for our nonce with no
      // matching transfer into OUR treasury means the nonce was spent somewhere
      // else — the per-authorizer uniqueness trap. Loud, and never applied.
      this.logger.error(
        `[alert] x402.unmatched_authorization nonce=${nonce} tx=${log.transactionHash} ` +
          `authorizer=${authorizer} — no Transfer of >= ${expected} ${auth.tokenSymbol} base units to ` +
          `${auth.treasuryAddress} in this transaction; NOT settling`,
      );
      return false;
    }

    const amountMinor = baseUnitsToUsdMinor(paired.value, auth.tokenDecimals);
    const outcome = await this.applyService.apply({
      provider: X402_PROVIDER_KEY,
      invoiceId: String(auth.invoiceId),
      payment: {
        // One id per settled log, so a top-up from a second authorization is a
        // distinct payment row and a re-scan is a no-op.
        providerPaymentId: `${nonce}:${log.transactionHash}:${log.logIndex}`,
        status: 'succeeded',
        amountMinor,
        currency: 'USD',
        reference: String(auth.invoiceId),
        asset: auth.tokenSymbol,
        assetAmount: paired.value.toString(),
        chainId: auth.chainId,
        txHash: log.transactionHash,
        receivedAt: new Date(),
      },
    });

    await this.authorizations
      .updateOne(
        { _id: auth._id },
        { $set: { status: 'settled', txHash: log.transactionHash.toLowerCase() } },
      )
      .exec();

    if (outcome.applied) {
      this.logger.log(
        `x402 settled invoice ${String(auth.invoiceId)}: ${amountMinor} minor from ${authorizer} ` +
          `(tx ${log.transactionHash})`,
      );
    }
    return outcome.applied;
  }

  /**
   * Where to start scanning: the oldest un-scanned watermark, clamped so an
   * authorization with no watermark cannot trigger a genesis-to-head rescan.
   */
  private scanFloor(
    group: Array<{ lastScannedBlock?: number }>,
    safeHead: bigint,
    range: bigint,
  ): bigint {
    const marks = group
      .map((a) => (typeof a.lastScannedBlock === 'number' ? BigInt(a.lastScannedBlock + 1) : undefined))
      .filter((b): b is bigint => b !== undefined);
    if (marks.length < group.length) {
      const fresh = safeHead > range ? safeHead - range + 1n : 0n;
      return marks.length === 0 ? fresh : bigIntMin(fresh, ...marks);
    }
    return bigIntMin(...marks);
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

/**
 * The paired `Transfer` in a receipt, or `undefined`.
 *
 * EXPORTED and pure so the settle gate — the one rule standing between this rail
 * and a free-money bug — is testable without a chain. Matches on all four of
 * token, `from`, `to` and amount; `value >= minValue` rather than `===` so an
 * overpayment still settles (the fold credits the excess), while an underpay does
 * not silently pass as exact.
 */
export function findPairedTransfer(
  logs: RpcLog[],
  want: { tokenAddress: string; from: string; to: string; minValue: bigint },
): { value: bigint } | undefined {
  const token = want.tokenAddress.toLowerCase();
  // A SELF-TRANSFER IS NOT A PAYMENT. `from === to` leaves the treasury's balance
  // exactly as it was, yet emits a `Transfer` that otherwise satisfies every check
  // below — so without this the invoice settles and nothing has been paid.
  // `AuthorizationService.issue` already refuses to issue such a payload; this is
  // the second lock, on the side that actually grants entitlement.
  if (want.from.toLowerCase() === want.to.toLowerCase()) return undefined;
  const fromTopic = addressToTopic(want.from);
  const toTopic = addressToTopic(want.to);
  for (const log of logs) {
    if (log.address.toLowerCase() !== token) continue;
    if ((log.topics[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) continue;
    if ((log.topics[1] ?? '').toLowerCase() !== fromTopic) continue;
    if ((log.topics[2] ?? '').toLowerCase() !== toTopic) continue;
    const value = hexToBigInt(log.data === '0x' || !log.data ? '0x0' : log.data);
    if (value >= want.minValue) return { value };
  }
  return undefined;
}

function bigIntMin(...values: bigint[]): bigint {
  return values.reduce((min, v) => (v < min ? v : min));
}
