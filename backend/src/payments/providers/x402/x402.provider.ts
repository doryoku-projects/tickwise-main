import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppConfigService } from '../../../config/app-config.service.js';
import { paymentTxUrl } from '../../../config/chains.config.js';
import {
  formatTokenAmount,
  paymentChainName,
  usdMinorToTokenBaseUnits,
  type PaymentToken,
} from '../../../config/payment-tokens.config.js';
import type {
  InFlightMode,
  PaymentProgress,
  CreateCheckoutArgs,
  PaymentProvider,
  ProviderCapabilities,
  ProviderCheckout,
  ProviderPayment,
  WebhookEnvelope,
  WebhookHeaders,
} from '../../payment-provider.interface.js';
import { PaymentAuthorization } from '../../schemas/payment-authorization.schema.js';
import { EvmRpcClient } from './evm-rpc.client.js';
import { Eip3009DomainService } from './eip3009-domain.service.js';
import { randomAuthorizationNonce } from './eip3009.js';

export const X402_PROVIDER_KEY = 'x402';

/**
 * THE crypto rail: one treasury, no xpub, no sweep, no middleman.
 *
 * The customer SIGNS an EIP-3009 authorization and the token itself moves the
 * money STRAIGHT INTO THE TREASURY. Attribution is the NONCE we minted, so it is
 * known before the customer sees anything; funds consolidate by construction, so
 * there is nothing to sweep and no seed anywhere in the system.
 *
 * ── WHAT THIS REPLACED, AND WHAT IT COSTS ──────────────────────────────────
 *
 * A deposit-address rail lived here until 2026-08-11: an xpub, one derived
 * address per invoice, a `Transfer` watcher, and a periodic OFFLINE SWEEP to
 * consolidate. It was deleted deliberately, and the trade is worth restating
 * because it is a PRODUCT constraint rather than a technical one:
 *
 *   gained — no seed, no xpub, no sweep; money lands in one address you control.
 *   LOST   — a customer can no longer pay from a BARE EXCHANGE WITHDRAWAL. A
 *            Coinbase/Binance "send USDC" carries no signature and no memo, so
 *            with one shared treasury there is nothing to attribute it to. Paying
 *            requires a connected self-custody wallet, full stop.
 *
 * If exchange payers ever have to be served, the answer is a second rail, not a
 * change here — that is what `PaymentProvider` is for.
 *
 * ── WHY `createCheckout` DOES NOT RETURN SOMETHING TO SIGN ──────────────────
 *
 * An EIP-3009 authorization hashes `from`, the payer's wallet. That is unknown
 * here: an invoice is raised when a plan is chosen — and for a RENEWAL, by a
 * background sweep with no browser in the picture at all. So checkout publishes
 * the QUOTE (chain, token, exact amount, treasury, and the nonce that will
 * reference this invoice) and the payload to sign is minted per wallet by a
 * separate authenticated request once a wallet is connected.
 *
 * Minting the nonce HERE rather than at signing time is deliberate: it makes the
 * invoice↔nonce mapping 1:1 and stable, so attribution is fixed before the
 * customer sees anything, and a reload cannot produce a second live
 * authorization for one invoice.
 *
 * ── NO KEY, AND NO WEBHOOK ─────────────────────────────────────────────────
 *
 * This provider holds no key of any kind. `verifyWebhook`/`parseWebhook` fail
 * closed: there is no third party to send one, and settlement comes from watching
 * the chain for `AuthorizationUsed` — with the paired `Transfer` verified, per the
 * nonce-is-per-authorizer trap documented on `PaymentAuthorization`
 * (`AuthorizationWatcherService`).
 */
@Injectable()
export class X402PaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(X402PaymentProvider.name);
  readonly key = X402_PROVIDER_KEY;
  /** One RPC client per chain. See `clientFor`. */
  private readonly clients = new Map<number, EvmRpcClient>();

  readonly capabilities: ProviderCapabilities = {
    hostedCheckout: false,
    // Settles by a direct on-chain movement into an address we control, with no
    // third party. The portal branches on `instructions` rather than on the
    // rail's name, which is what lets a future fiat rail slot in unchanged.
    onChainDirect: true,
    // A signed authorization is single-use and covers ONE period. Nothing here
    // can re-charge a wallet later — which is the honest position for a
    // self-custody rail, and why the sweep raises every renewal invoice.
    recurring: false,
    webhooks: false,
    bodySignature: false,
    // The signed `value` is exact, so in principle settlement cannot vary — but
    // the flag stays TRUE because the fold's tolerance and overpay-credit rules
    // must still apply: a customer may pay one invoice twice from two wallets,
    // and the amount is quoted in USD minor units converted to token base units,
    // which is not a lossless round trip for every token.
    variableSettlement: true,
  };

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(Eip3009DomainService) private readonly domains: Eip3009DomainService,
    @InjectModel(PaymentAuthorization.name)
    private readonly authorizations: Model<PaymentAuthorization>,
  ) {}

  isConfigured(): boolean {
    return this.config.x402PaymentsConfigured;
  }

  /**
   * Mint, reuse, or ROTATE this invoice's authorization, and return the quote.
   *
   * IDEMPOTENT per invoice via the unique `{invoiceId}` index and the
   * create-then-catch-E11000 shape the rest of this subsystem uses. A customer
   * reloading the billing page must get the SAME nonce: two live authorizations
   * for one invoice are two payments they could each complete, and the
   * overpayment would be ours to explain.
   *
   * BUT REUSE IS CONDITIONAL, and the first version of this method got that
   * wrong in a way that made every renewal unpayable. It returned the existing
   * row unconditionally — whatever its status, whatever its window, whatever
   * amount it was quoted at. Three consequences, all silent:
   *
   *  - a stale quote was handed back forever, and the unique index blocked
   *    minting a replacement;
   *  - a change of accepted CHAIN left the invoice quoted on the old network with
   *    no path to re-quote it (and, while uniqueness was scoped by chain, allowed
   *    a SECOND authorization beside it);
   *  - an amount that moved after minting (an upgrade proration, credit applied)
   *    was never re-quoted, so `expectedBaseUnits` no longer matched the invoice;
   *  - nothing anywhere wrote `expired`, so no sweep could rescue it either.
   *
   * So a row is reused ONLY while it is genuinely still good, and otherwise
   * ROTATED IN PLACE — new nonce, fresh window, current amount — which keeps the
   * one-row-per-invoice guarantee without needing the index to change. Rotation
   * is refused for a row whose payment may already be in flight; see
   * `rotatableStatus`.
   */
  async createCheckout(args: CreateCheckoutArgs): Promise<ProviderCheckout> {
    if (!Types.ObjectId.isValid(args.reference)) {
      throw new ServiceUnavailableException({ error: 'A crypto checkout needs a valid invoice id.' });
    }
    if (!args.customerId || !Types.ObjectId.isValid(args.customerId)) {
      // Required on the document, so this would fail on insert anyway — but as a
      // named refusal rather than an opaque Mongoose validation error. The
      // now-deleted deposit rail shipped 100% BROKEN on exactly this: the field
      // was required on its schema and no caller passed it.
      throw new ServiceUnavailableException({
        error: 'A crypto checkout needs a customer id.',
      });
    }
    // The amount is quoted 1:1 into a USD-pegged token, so a non-USD invoice
    // would be quoted at the wrong number and could never settle. Refused rather
    // than silently mis-quoted — the amount ends up inside a SIGNED struct,
    // where it cannot be corrected afterwards.
    const currency = (args.currency ?? 'USD').trim().toUpperCase();
    if (currency !== 'USD') {
      throw new ServiceUnavailableException({
        error: `Crypto payments are only available for USD invoices (this one is ${currency}).`,
      });
    }

    const invoiceId = new Types.ObjectId(args.reference);
    const token = await this.selectToken(args.preferredChainId);
    const treasury = this.config.x402TreasuryAddress;
    if (!treasury) {
      throw new ServiceUnavailableException({ error: 'Crypto payments are not configured.' });
    }
    if (!token.stable) {
      // A non-stable token needs a rate locked at quote time with an expiry, and
      // that machinery does not exist. It bites harder here than on any transfer
      // rail — the amount goes inside a SIGNED struct, so a stale rate cannot be
      // corrected after the fact.
      throw new ServiceUnavailableException({
        error: `${token.symbol} is not a stablecoin; only USD-pegged tokens are accepted right now.`,
      });
    }

    const now = new Date();
    const amountBaseUnits = usdMinorToTokenBaseUnits(args.amountMinor, token.decimals).toString();

    // Looked up by INVOICE ALONE, deliberately. Scoping this by chain meant that
    // switching the accepted network silently minted a SECOND authorization beside
    // the first instead of re-quoting it.
    const existing = await this.authorizations.findOne({ invoiceId }).lean().exec();
    if (existing) {
      if (this.isQuoteUsable(existing, amountBaseUnits, treasury, token, now)) {
        return this.toCheckout(existing);
      }
      const rotated = await this.rotate(existing, { amountBaseUnits, treasury, token, now });
      // Rotation refused (a relay may be in flight, or the row is already
      // settled) — hand back what is there rather than inventing a second
      // payable authorization for one invoice.
      return this.toCheckout(rotated ?? existing);
    }

    const startBlock = await this.currentHead(token.chainId);
    // A NEW authorization with no start block is not safe to accept money
    // against. `scanFloor` falls back to `safeHead - paymentWatchBlockRange` for
    // a row with no mark, and that floor is recomputed from the CURRENT head on
    // every tick — so if the RPC stays unhealthy for longer than that window
    // (2000 blocks: ~1h on Base, ~7h on Ethereum), the floor marches past the
    // block the customer's payment landed in and it is never scanned. That is a
    // silently lost payment, and it is exactly the shape of the outage this
    // service just had. Refusing the checkout converts it into a visible
    // "cannot start a payment", which is strictly better than taking money we
    // cannot promise to see. Rotation is unaffected: those rows already carry a
    // mark, so their floor is anchored.
    if (startBlock === undefined) {
      throw new ServiceUnavailableException({
        error: 'Crypto payments are temporarily unavailable for this network. Please try again shortly.',
      });
    }

    let created: PaymentAuthorization;
    try {
      created = (await this.authorizations.create({
        invoiceId,
        customerId: new Types.ObjectId(args.customerId),
        chainId: token.chainId,
        nonce: randomAuthorizationNonce(),
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        treasuryAddress: treasury,
        expectedBaseUnits: amountBaseUnits,
        validAfter: 0,
        // NO `validBefore` at mint. It is the SIGNATURE's window and is stamped
        // when the payload is composed for a specific wallet — see the field's
        // note on the schema for why stamping it here made renewals unpayable.
        quoteExpiresAt: new Date(now.getTime() + this.config.x402QuoteTtlMs),
        status: 'issued',
        minConfirmations: this.config.minConfirmationsFor(token.chainId),
        ...(startBlock !== undefined ? { lastScannedBlock: startBlock } : {}),
      })) as PaymentAuthorization;
    } catch (err) {
      if (isDuplicateKey(err)) {
        const race = await this.authorizations.findOne({ invoiceId }).lean().exec();
        if (race) return this.toCheckout(race);
      }
      throw err;
    }

    this.logger.log(
      `x402 authorization minted for invoice ${args.reference} on chain ${token.chainId} ` +
        `(${token.symbol}, nonce ${created.nonce.slice(0, 10)}…)`,
    );
    return this.toCheckout(created);
  }

  /**
   * Re-read one authorization's settlement state, for the reconcile backstop.
   *
   * The watcher records a settled authorization as `<nonce>:<tx>:<logIndex>`, so
   * the nonce is recovered from the first `:`-segment — a 0x hex nonce contains
   * no colon. A bare nonce is accepted too, so an admin passing one resolves.
   * (The deleted deposit rail had this exact bug the other way round: it looked
   * up the whole composite as an address, and its reconcile backstop was silently
   * dead as a result.)
   *
   * THROWS on a Mongo failure rather than returning null: "we have never heard
   * of this" and "we could not check" have opposite correct responses.
   */
  async getPayment(providerPaymentId: string): Promise<ProviderPayment | null> {
    const nonce = providerPaymentId.split(':')[0].toLowerCase();
    const auth = await this.authorizations.findOne({ nonce }).lean().exec();
    if (!auth) return null;
    return {
      providerPaymentId: auth.nonce,
      status: auth.status === 'settled' ? 'succeeded' : auth.status === 'failed' ? 'failed' : 'pending',
      // `amountMinor` DELIBERATELY OMITTED, not zero. This rail knows only what
      // it EXPECTED; the settled figure is computed by the watcher from a
      // verified Transfer and lives on the `Payment` row. Reporting 0 here made
      // the reconcile's drift repair re-apply the payment as zero and wipe the
      // real amount off the invoice — see `ProviderPayment.amountMinor`.
      currency: 'USD',
      reference: String(auth.invoiceId),
      asset: auth.tokenSymbol,
      chainId: auth.chainId,
      ...(auth.txHash ? { txHash: auth.txHash } : {}),
    };
  }

  /** No webhook: no middleman to send one. Fail closed, like the deposit rail. */
  verifyWebhook(_raw: Buffer, _headers: WebhookHeaders): boolean {
    return false;
  }

  parseWebhook(_raw: Buffer): WebhookEnvelope | null {
    return null;
  }

  /**
   * Can the customer still pay this invoice without us doing anything?
   *
   * **`validBefore` IS THE DISCRIMINATOR, NOT THE STATUS**, and getting that
   * backwards is a total outage rather than a subtle bug. `createCheckout`
   * writes a fresh QUOTE as `status: 'issued'` with no `validBefore`, so a
   * status-only test reports "in flight" for every open invoice in the system —
   * which would block every plan change AND (via `BillingOverview`) hide the
   * Pay button from everyone, permanently.
   *
   * The window is stamped in `AuthorizationService.issue`, the moment a payload
   * is handed to a SPECIFIC wallet, and nowhere earlier — see the note there
   * about stamping it at checkout once making every renewal unpayable. So its
   * presence is exactly the fact this method needs: a signable payload exists
   * out in the world.
   *
   * Why that matters more than "have they signed": the SIGNATURE is made
   * client-side and the server does not hear about it until `confirm`, and on
   * the self-submit path the customer's own wallet broadcasts. From here,
   * "payload issued" and "signed, about to broadcast" are indistinguishable,
   * and nothing we do can stop the transfer.
   *
   *  - quote only (no `validBefore`)      → nothing signable exists      → false
   *  - `validBefore` in the future        → a wallet can spend it now    → TRUE
   *  - `validBefore` passed               → the token itself refuses it  → false
   *  - `authorized` / `submitted`         → signature seen / relay sent  → TRUE
   *
   * The last line is belt-and-braces: both of those states always carry a
   * window, but a signature we have actually seen must never be judged spent
   * merely because a clock drifted past its deadline.
   *
   * The expiry half is what keeps this a SHORT block — minutes, bounded by
   * `X402_AUTHORIZATION_TTL_MS` — rather than an invoice nobody can ever retire.
   */
  async hasPaymentInFlight(invoiceId: string, mode: InFlightMode = 'any'): Promise<boolean> {
    if (!Types.ObjectId.isValid(invoiceId)) return false;
    const live = await this.authorizations
      .findOne({
        invoiceId: new Types.ObjectId(invoiceId),
        status: { $in: ['issued', 'authorized', 'submitted'] },
      })
      .lean()
      .exec();
    if (!live) return false;

    // A signature we have SEEN. True in either mode — this one really cannot be
    // called back, and no clock changes that.
    if (live.status === 'authorized' || live.status === 'submitted') return true;

    // Everything below is an `issued` payload: a wallet has it, we have no idea
    // whether it was signed. `'signed'` callers are acting on an explicit "I am
    // not paying this", so they are not held up by the possibility.
    if (mode === 'signed') return false;

    // Seconds, matching EIP-3009's own `validBefore`.
    if (live.validBefore === undefined || live.validBefore === null) return false;
    return live.validBefore > Math.floor(Date.now() / 1000);
  }

  /**
   * How many confirmations a broadcast payment has, and how many are left.
   *
   * TWO RPC CALLS, and only for an authorization that has actually been
   * relayed. Everything short of that returns `null` rather than a zero: "no
   * transaction yet" and "mined, zero confirmations" are different facts, and a
   * customer told "0 of 30" for a transaction that was never broadcast would
   * wait forever for a number that cannot move.
   *
   * `confirmations` INCLUDES the mining block, so a freshly mined transaction
   * reads 1. That is what every block explorer shows, and this number exists to
   * be compared against one.
   */
  async paymentProgress(invoiceId: string): Promise<PaymentProgress | null> {
    if (!Types.ObjectId.isValid(invoiceId)) return null;
    const auth = await this.authorizations
      .findOne({ invoiceId: new Types.ObjectId(invoiceId) })
      .lean()
      .exec();
    if (!auth?.txHash) return null;

    const client = this.clientFor(auth.chainId);
    if (!client) return null;

    try {
      const receipt = await client.getTransactionReceipt(auth.txHash);
      // Broadcast but not yet mined — genuinely nothing to count.
      if (!receipt?.blockNumber) return null;

      const head = await client.blockNumber();
      const mined = BigInt(receipt.blockNumber);
      // `head - mined + 1`, floored: a reorg can briefly put the head behind
      // the block we read, and a negative confirmation count is nonsense.
      const confirmations = head >= mined ? Number(head - mined) + 1 : 0;
      const minConfirmations = this.config.minConfirmationsFor(auth.chainId);
      const explorerUrl = paymentTxUrl(auth.chainId, auth.txHash);

      return {
        confirmations,
        minConfirmations,
        remaining: Math.max(0, minConfirmations - confirmations),
        txHash: auth.txHash,
        ...(explorerUrl ? { explorerUrl } : {}),
      };
    } catch {
      // An RPC blip must not break the billing page. The caller renders the
      // in-flight state without a count, which is what it did before this
      // existed.
      return null;
    }
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /**
   * Whether an existing row may be handed back as-is.
   *
   * Four conditions, each of which was a distinct silent failure when reuse was
   * unconditional:
   *  - the quote window has not passed (else the customer is shown a dead quote);
   *  - the amount still matches the invoice (else they authorize the wrong sum,
   *    inside a signature that cannot be corrected);
   *  - the treasury still matches config (an operator rotating the treasury must
   *    not leave quotes paying the old address — though note a row that has
   *    already been SIGNED keeps its own stored treasury, which is why the
   *    watcher verifies against the row and never against current config);
   *  - a signed row's own `validBefore` has not passed (a dead signature is not
   *    a usable quote, even inside a live quote window).
   */
  private isQuoteUsable(
    auth: PaymentAuthorization,
    amountBaseUnits: string,
    treasury: string,
    token: PaymentToken,
    now: Date,
  ): boolean {
    if (auth.status === 'settled' || auth.status === 'submitted') return true; // paid, or in flight
    if (auth.status === 'expired' || auth.status === 'failed') return false;
    if (!auth.quoteExpiresAt || auth.quoteExpiresAt.getTime() <= now.getTime()) return false;
    if (auth.expectedBaseUnits !== amountBaseUnits) return false;
    if (auth.treasuryAddress?.toLowerCase() !== treasury.toLowerCase()) return false;
    // THE TOKEN AND CHAIN MUST STILL BE ONES WE ACCEPT. Without this, changing
    // `PAYMENT_ACCEPTED_TOKENS` to another network left every open invoice quoted
    // on the OLD chain forever — the customer is shown a payment they cannot make
    // and no path re-quotes it, which is the same dead-end as an expired quote.
    if (auth.chainId !== token.chainId) return false;
    if (auth.tokenAddress?.toLowerCase() !== token.address.toLowerCase()) return false;
    // A held signature whose window has closed cannot be relayed; the row needs
    // a fresh nonce and the customer needs to sign again.
    if (auth.validBefore !== undefined && auth.validBefore * 1000 <= now.getTime()) return false;
    return true;
  }

  /**
   * Re-quote an invoice in place: a new nonce, a fresh quote window, and the
   * current amount and treasury.
   *
   * IN PLACE rather than as a second document, so the unique
   * `{invoiceId, chainId}` index — the guarantee that one invoice has at most
   * one payable authorization — needs no relaxing.
   *
   * The update is GUARDED on the status we read, so a payment that starts
   * settling between the read and the write cannot have its nonce pulled out
   * from under it: the filter matches nothing, `modifiedCount` is 0, and the
   * caller falls back to the row as it stands. `null` therefore means "somebody
   * else moved this row" and never "the write failed silently".
   *
   * `submitted` and `settled` are NOT rotatable: a relay may already be in
   * flight for that nonce, and replacing it would leave a real payment arriving
   * against a nonce we no longer expect. Those are returned untouched.
   */
  private async rotate(
    auth: PaymentAuthorization & { _id?: unknown },
    args: { amountBaseUnits: string; treasury: string; token: PaymentToken; now: Date },
  ): Promise<PaymentAuthorization | null> {
    if (!rotatableStatus(auth.status)) return null;
    // `authorized` means a signature EXISTS. `rotatableStatus` admits it on the
    // reasoning that such a signature is already unusable — but that reasoning
    // covers only whether it can be spent GOING FORWARD, not whether it has
    // ALREADY been spent and is merely unobserved. With no relayer the customer
    // submits from their own wallet, so between their transaction landing and
    // the watcher seeing it the row sits at `authorized` with a real payment
    // on-chain. Replacing the nonce there points the watcher at a nonce that
    // will never appear, loses the payment permanently, and re-quotes the
    // customer for money they already sent.
    //
    // So enforce the justification instead of assuming it: rotate an
    // `authorized` row only once its signing window has demonstrably closed, at
    // which point no transaction carrying that nonce can still succeed. An
    // unknown window is treated as still-open — fail closed. Refusing is cheap:
    // the caller hands back the existing authorization rather than minting a
    // second payable one for the same invoice.
    if (auth.status === 'authorized') {
      const nowSec = Math.floor(args.now.getTime() / 1000);
      const windowClosed = typeof auth.validBefore === 'number' && auth.validBefore <= nowSec;
      if (!windowClosed) {
        this.logger.warn(
          `[alert] x402.rotate_refused invoice=${auth.invoiceId} status=authorized — ` +
            `signing window still open (validBefore=${auth.validBefore ?? 'unset'}, now=${nowSec}); ` +
            `a payment may already be in flight against this nonce`,
        );
        return null;
      }
    }

    const nonce = randomAuthorizationNonce();
    const startBlock = await this.currentHead(args.token.chainId);
    const updated = await this.authorizations
      .findOneAndUpdate(
        { _id: auth._id, status: auth.status },
        {
          $set: {
            nonce,
            // `chainId` INCLUDED: a rotation can now move an invoice between
            // networks, and leaving it behind would pair a chain with a token
            // address from a different one — an authorization for a contract that
            // does not exist there.
            chainId: args.token.chainId,
            expectedBaseUnits: args.amountBaseUnits,
            treasuryAddress: args.treasury,
            tokenAddress: args.token.address,
            tokenSymbol: args.token.symbol,
            tokenDecimals: args.token.decimals,
            quoteExpiresAt: new Date(args.now.getTime() + this.config.x402QuoteTtlMs),
            status: 'issued',
            minConfirmations: this.config.minConfirmationsFor(args.token.chainId),
            ...(startBlock !== undefined ? { lastScannedBlock: startBlock } : {}),
          },
          // The previous wallet binding and signature belong to the OLD nonce.
          // Left in place they would be verified against a payload nobody signed.
          $unset: { validBefore: '', fromAddress: '', domainName: '', domainVersion: '', signature: '', txHash: '' },
        },
        { new: true },
      )
      .lean()
      .exec();

    if (!updated) return null;
    this.logger.log(
      `x402 authorization re-quoted for invoice ${String(auth.invoiceId)} ` +
        `(nonce ${nonce.slice(0, 10)}…, ${args.amountBaseUnits} ${args.token.symbol} base units)`,
    );
    return updated as PaymentAuthorization;
  }

  /**
   * The token to quote in — the customer's preferred chain when we accept one
   * there, else the first accepted token.
   *
   * UNLIKE THE DEPOSIT RAIL, this also requires the token to have a VERIFIED
   * EIP-3009 domain. A token that does not implement the standard (USDT), or
   * whose `name`/`version` we compute differently from the contract, is skipped —
   * offering it would hand the customer a message their wallet signs happily and
   * the token then refuses, which is indistinguishable from "the payment broke"
   * and impossible for them to diagnose.
   */
  private async selectToken(preferredChainId?: number): Promise<PaymentToken> {
    const accepted = this.config.acceptedPaymentTokens;
    if (accepted.length === 0) {
      throw new ServiceUnavailableException({ error: 'No crypto payment tokens are configured.' });
    }

    const preferred = preferredChainId
      ? accepted.filter((t) => t.chainId === preferredChainId)
      : [];
    for (const token of [...preferred, ...accepted]) {
      if (await this.domains.isSupported(token)) return token;
    }

    // Every accepted token failed verification. A 503 with the operator detail
    // logged, never a silent fallback to an unverified token.
    this.logger.error(
      '[alert] x402.no_supported_token — none of the accepted tokens has a verified EIP-3009 domain ' +
        `(accepted: ${accepted.map((t) => `${t.symbol}:${t.chainId}`).join(', ')}). ` +
        'USDT does not implement EIP-3009; a bridged token may have a different EIP-712 domain.',
    );
    throw new ServiceUnavailableException({
      error: 'Crypto payments are temporarily unavailable — please try again later.',
    });
  }

  /**
   * The chain head at mint time, minus one, so the watcher's first scan has an
   * exact floor. Best-effort — a node failure leaves it unset and the watcher's
   * bounded fallback takes over. Never throws into checkout.
   */
  private async currentHead(chainId: number): Promise<number | undefined> {
    const client = this.clientFor(chainId);
    if (!client) return undefined;
    try {
      const head = await client.blockNumber();
      return Math.max(0, Number(head) - 1);
    } catch (err) {
      this.logger.warn(
        `Could not read chain ${chainId} head at checkout (${(err as Error).message}); ` +
          'authorization will use the watcher fallback floor',
      );
      return undefined;
    }
  }

  /**
   * The RPC client for a chain, or `undefined` when none is configured.
   *
   * A method rather than an inline `new EvmRpcClient(...)` for the same reason
   * `Eip3009DomainService.clientFor` is
   * ones: it is the seam a spec overrides. Without it the provider's unit tests
   * made real DNS lookups for a fake RPC host on every checkout, which is slow,
   * flaky offline, and tests the network rather than the code.
   */
  private clientFor(chainId: number): EvmRpcClient | undefined {
    const cached = this.clients.get(chainId);
    if (cached) return cached;
    const url = this.config.evmRpcUrls.get(chainId);
    if (!url) return undefined;
    const client = new EvmRpcClient(chainId, url);
    this.clients.set(chainId, client);
    return client;
  }

  private toCheckout(auth: PaymentAuthorization): ProviderCheckout {
    return {
      // The rail's own reference for this payment IS the nonce.
      ref: auth.nonce,
      instructions: {
        kind: 'authorization',
        chainId: auth.chainId,
        chainName: paymentChainName(auth.chainId),
        tokenAddress: auth.tokenAddress,
        tokenSymbol: auth.tokenSymbol,
        tokenDecimals: auth.tokenDecimals,
        treasuryAddress: auth.treasuryAddress,
        amountBaseUnits: auth.expectedBaseUnits,
        amountDisplay: `${formatTokenAmount(BigInt(auth.expectedBaseUnits), auth.tokenDecimals)} ${auth.tokenSymbol}`,
        nonce: auth.nonce,
        minConfirmations: auth.minConfirmations,
      },
      // The QUOTE's expiry, not the signature's. Past it, the next checkout
      // re-quotes rather than handing back a stale amount — see `isQuoteUsable`.
      expiresAt: auth.quoteExpiresAt,
    };
  }
}

/** Local copy of the duplicate-key check — the apply service's is not exported here. */
function isDuplicateKey(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: number }).code === 11000);
}

/**
 * Which statuses may have their nonce replaced.
 *
 * `issued` — nothing signed, nothing at risk. `authorized` — a signature exists,
 * so it is admitted here ONLY as a first filter: `rotate()` additionally refuses
 * unless that signature's window has provably closed. The older reasoning
 * ("rotation only reaches here when the signature is already unusable") was
 * about spendability going forward and did not cover a signature already spent
 * but not yet observed by the watcher — which is a real state, because with no
 * relayer the customer submits from their own wallet. `expired` / `failed` —
 * dead by definition.
 *
 * `submitted` and `settled` are absent DELIBERATELY: a transaction may be in
 * flight for that nonce, and rotating would leave a real payment arriving
 * against a nonce nothing is watching for.
 */
function rotatableStatus(status: PaymentAuthorization['status']): boolean {
  return status === 'issued' || status === 'authorized' || status === 'expired' || status === 'failed';
}
