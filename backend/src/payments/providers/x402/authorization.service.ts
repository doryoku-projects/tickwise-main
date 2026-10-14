import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { getAddress, isAddress, type Hex } from 'viem';
import { AppConfigService } from '../../../config/app-config.service.js';
import {
  PAYMENT_CHAIN_EXPLORERS,
  formatTokenAmount,
  paymentChainName,
} from '../../../config/payment-tokens.config.js';
import { Invoice } from '../../schemas/invoice.schema.js';
import { PaymentAuthorization } from '../../schemas/payment-authorization.schema.js';
import { Eip3009DomainService } from './eip3009-domain.service.js';
import {
  BALANCE_OF_SELECTOR,
  buildTransferAuthorizationTypedData,
  verifyAuthorizationSignature,
  type AuthorizationTypedData,
} from './eip3009.js';
import { EvmRpcClient } from './evm-rpc.client.js';
import { TreasurySubmitterService } from './treasury-submitter.service.js';
import { X402PaymentProvider } from './x402.provider.js';
import { toInvoiceCheckout } from '../../subscriptions.service.js';
import type { ProviderCheckout } from '../../payment-provider.interface.js';

/** What the wallet is asked to sign, plus what the panel shows beside it. */
export interface AuthorizationPayload {
  /** The EIP-712 payload, ready to hand to `signTypedData` verbatim. */
  typedData: AuthorizationTypedData;
  chainId: number;
  chainName: string;
  tokenSymbol: string;
  /** e.g. `19 USDC`. Display only. */
  amountDisplay: string;
  treasuryAddress: string;
  /** Unix SECONDS — when this signature stops being spendable. */
  validBefore: number;
  /**
   * Whether WE will submit it. `false` means the customer's wallet must send the
   * transaction itself and pay its own gas, and the panel must say so.
   */
  relayed: boolean;
  /** The wallet's CURRENT token balance, human-formatted (e.g. `7.99 USDC`). */
  balanceDisplay: string;
  /**
   * Explorer base for this chain, so the panel can link the transaction while it
   * confirms. Empty when the chain has no known explorer — the panel must cope
   * rather than render a dead link.
   */
  explorerUrl: string;
}

/** One network a customer may choose to pay on. */
export interface PaymentNetworkOption {
  chainId: number;
  chainName: string;
  tokenSymbol: string;
  /** Whether this is the network the invoice is quoted on right now. */
  current: boolean;
}

/** The re-quoted instructions after a network switch. */
export interface AuthorizationSwitchResult {
  instructions: NonNullable<ProviderCheckout['instructions']>;
}

/** What `confirm` reports back. */
export interface AuthorizationResult {
  status: 'settled' | 'submitted' | 'authorized';
  txHash?: string;
  /**
   * Present ONLY on the no-relayer path: the exact transaction the customer's
   * wallet must send to finish paying.
   *
   * It cannot be issued alongside the payload, because the calldata EMBEDS the
   * signature — so it exists for the first time here, after the signature has
   * been verified. Building it server-side rather than letting the frontend
   * re-encode keeps one encoder (whose selector is pinned by test) instead of two
   * that can disagree.
   */
  selfSubmit?: { to: string; data: string; chainId: number };
}

/**
 * The signing half of the x402 rail: issue a payload bound to one wallet, verify
 * the signature that comes back, and get it on chain.
 *
 * ── WHY THE SERVER COMPOSES THE PAYLOAD ────────────────────────────────────
 *
 * Same rule as `siwe.service.ts`, and it removes the same attack class. We build
 * the typed data, STORE what we issued, and the client returns only a signature.
 * Verification then rebuilds the payload from the STORED row — never from
 * anything the caller sent — so there is no way to have us verify one message and
 * relay another.
 *
 * ── NO INVOICE ID CROSSES THE WIRE ─────────────────────────------------------
 *
 * Both methods resolve the caller's own OPEN invoice from `req.customerUser`,
 * exactly as `PortalController` never takes a customer id. An `invoiceId`
 * parameter would need an ownership check on every call, and the check that is
 * never written is the one that leaks; resolving server-side removes the
 * question rather than answering it.
 */
@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(Eip3009DomainService) private readonly domains: Eip3009DomainService,
    @Inject(TreasurySubmitterService) private readonly submitter: TreasurySubmitterService,
    @Inject(X402PaymentProvider) private readonly provider: X402PaymentProvider,
    @InjectModel(PaymentAuthorization.name)
    private readonly authorizations: Model<PaymentAuthorization>,
    @InjectModel(Invoice.name) private readonly invoices: Model<Invoice>,
  ) {}

  /**
   * The networks this customer could pay on, for the panel's picker.
   *
   * ONLY VERIFIED ONES. An accepted token whose EIP-712 domain we cannot prove is
   * excluded rather than listed-and-then-refused: offering a network that fails at
   * the signing step is worse than not offering it, because the customer has
   * already chosen it by then.
   */
  async networks(customerId: string): Promise<PaymentNetworkOption[]> {
    const auth = await this.findOpenAuthorization(customerId);
    const options: PaymentNetworkOption[] = [];
    for (const token of this.config.acceptedPaymentTokens) {
      if (!(await this.domains.isSupported(token))) continue;
      options.push({
        chainId: token.chainId,
        chainName: paymentChainName(token.chainId),
        tokenSymbol: token.symbol,
        current: token.chainId === auth.chainId,
      });
    }
    return options;
  }

  /**
   * Re-quote the open invoice on a different network.
   *
   * WHY THIS EXISTS RATHER THAN A CHOICE AT CHECKOUT TIME: a customer picking a
   * plan does not yet know which wallet they will pay from, and with several
   * networks accepted the registry's order otherwise decides for them — so
   * somebody holding USDC only on Arbitrum was quoted Base and told they had no
   * funds. The choice belongs on the screen where they are about to pay.
   *
   * Implemented by asking the PROVIDER to quote again with a preferred chain, so
   * the rotation rules (`isQuoteUsable` rejects a chain mismatch; `rotate` mints a
   * fresh nonce and refuses to touch a row whose relay is in flight) are the same
   * ones that govern every other re-quote. Nothing here reimplements them.
   */
  async switchNetwork(customerId: string, chainId: number): Promise<AuthorizationSwitchResult> {
    const owner = new Types.ObjectId(customerId);
    const invoice = await this.invoices
      .findOne({ customerId: owner, status: 'open' })
      .sort({ periodStart: -1 })
      .lean()
      .exec();
    if (!invoice) throw new NotFoundException({ error: 'You have no payment due right now.' });

    const accepted = this.config.acceptedPaymentTokens.find((t) => t.chainId === chainId);
    if (!accepted || !(await this.domains.isSupported(accepted))) {
      throw new BadRequestException({ error: 'That network is not available for payment.' });
    }

    const existing = await this.authorizations.findOne({ invoiceId: invoice._id }).lean().exec();
    if (existing && (existing.status === 'submitted' || existing.status === 'settled')) {
      throw new BadRequestException({
        error: 'This payment is already on its way — it cannot be moved to another network.',
      });
    }

    const checkout = await this.provider.createCheckout({
      reference: String(invoice._id),
      customerId,
      amountMinor: invoice.amountDueMinor,
      currency: invoice.currency,
      description: `${invoice.planKey} on ${paymentChainName(chainId)}`,
      preferredChainId: chainId,
      // Unused by this rail (nothing redirects) but part of the shared contract.
      successUrl: '',
      cancelUrl: '',
    });
    if (!checkout.instructions) {
      throw new ServiceUnavailableException({ error: 'Crypto payments are temporarily unavailable.' });
    }

    // The invoice's stored snapshot is what the portal renders, so it has to move
    // with the quote or the page keeps showing the old network.
    await this.invoices
      .updateOne(
        { _id: invoice._id, status: 'open' },
        { $set: { checkout: toInvoiceCheckout(this.provider.key, checkout) } },
      )
      .exec();

    this.logger.log(`x402 invoice ${String(invoice._id)} re-quoted on chain ${chainId}`);
    return { instructions: checkout.instructions };
  }

  /**
   * Bind this customer's open authorization to `fromAddress` and return the
   * payload to sign.
   *
   * RE-BINDABLE while nothing is in flight: a customer who connects a different
   * wallet gets a payload for the new one. Not once a relay is in flight, because
   * the nonce is already committed to a transaction.
   *
   * The signing window (`validBefore`) is stamped HERE and nowhere earlier — it
   * exists so an abandoned signature expires, and it can only start when somebody
   * is actually about to sign. Stamping it at checkout is what once made every
   * renewal unpayable.
   */
  async issue(customerId: string, fromAddress: string): Promise<AuthorizationPayload> {
    if (typeof fromAddress !== 'string' || !isAddress(fromAddress.trim(), { strict: false })) {
      throw new BadRequestException({ error: 'That is not a valid wallet address.' });
    }
    const from = getAddress(fromAddress.trim());
    const auth = await this.findOpenAuthorization(customerId);

    // ── NEVER LET THE TREASURY PAY ITSELF. ──
    //
    // `from === to` is a transfer that moves NOTHING — the treasury's balance is
    // unchanged — but it emits a perfectly ordinary `Transfer(treasury, treasury,
    // value)`, which satisfies the watcher's settle gate (right token, `from` ==
    // authorizer, `to` == treasury, right amount) and settles the invoice for
    // free. Only the treasury's own key can produce it, so it is not
    // customer-exploitable, but an operator testing with their own wallets can
    // trip it by connecting the wrong account — and it looks exactly like a
    // successful payment while no money has moved.
    if (from.toLowerCase() === auth.treasuryAddress.toLowerCase()) {
      throw new BadRequestException({
        error:
          `${shortAddress(from)} is the account payments are sent TO, so it cannot also be the payer. ` +
          'Connect a different wallet and try again.',
      });
    }

    if (auth.status === 'submitted' || auth.status === 'settled') {
      throw new BadRequestException({
        error: 'This payment is already on its way — it will confirm shortly.',
      });
    }

    const token = {
      chainId: auth.chainId,
      symbol: auth.tokenSymbol,
      address: auth.tokenAddress,
      decimals: auth.tokenDecimals,
      stable: true,
    };
    // Re-verified at signing time, not trusted from checkout: this is the last
    // moment before a human commits, and a domain we cannot prove produces a
    // signature the token will refuse.
    const domain = await this.domains.resolve(token).catch((err: Error) => {
      this.logger.error(`[alert] x402.domain_unverified_at_signing ${auth.tokenSymbol} — ${err.message}`);
      throw new ServiceUnavailableException({
        error: 'Crypto payments are temporarily unavailable — please try again later.',
      });
    });

    // ── BALANCE FIRST, BEFORE WE ASK ANYONE TO SIGN. ──
    //
    // The relay preflight already catches an insufficient balance, but it runs
    // AFTER the signature has been produced and verified — so without this check a
    // customer with no funds is walked through connecting a wallet and approving a
    // signature before being told the one thing that was knowable at the start.
    // Worse, if anything else goes wrong first they get an unrelated error and
    // never learn the real reason. Read it up front and name the shortfall.
    const balance = await this.readBalance(auth, from);
    const required = BigInt(auth.expectedBaseUnits);
    if (balance !== undefined && balance < required) {
      const short = formatTokenAmount(required - balance, auth.tokenDecimals);
      // NAMES THE WALLET. "This wallet holds 0" is unactionable when the customer
      // has several accounts and cannot tell which one the browser handed us —
      // which is exactly the confusion this message caused.
      throw new BadRequestException({
        error:
          `${shortAddress(from)} holds ${formatTokenAmount(balance, auth.tokenDecimals)} ` +
          `${auth.tokenSymbol} on ${paymentChainName(auth.chainId)} — ${short} ${auth.tokenSymbol} ` +
          `short of the ${formatTokenAmount(required, auth.tokenDecimals)} needed. Either add ` +
          `${auth.tokenSymbol} on ${paymentChainName(auth.chainId)} (it must be on that network — funds ` +
          'on another chain cannot be used), switch to a different network above, or connect another ' +
          'wallet.',
      });
    }

    const validAfter = 0;
    const validBefore = Math.floor((Date.now() + this.config.x402AuthorizationTtlMs) / 1000);
    const typedData = buildTransferAuthorizationTypedData({
      tokenName: domain.name,
      tokenVersion: domain.version,
      chainId: auth.chainId,
      tokenAddress: auth.tokenAddress,
      from,
      to: auth.treasuryAddress,
      valueBaseUnits: BigInt(auth.expectedBaseUnits),
      validAfter,
      validBefore,
      nonce: auth.nonce,
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    // Stamped together, and the status is reset to `issued`: a previously held
    // signature belonged to the OLD window and must not be verifiable against
    // this one.
    // `expired` is INCLUDED. It is the retire sweep's terminal state for a quote
    // nobody paid, and it is explicitly recoverable — `rotatableStatus` admits it
    // for exactly this reason. Omitting it made the write match zero documents
    // while this method still returned a fully signable payload, so the customer
    // signed something that was never persisted and `confirm()` then failed
    // forever: an unrecoverable lockout on any invoice left un-quoted long
    // enough for the sweep to reach it.
    const res = await this.authorizations
      .updateOne(
        { _id: auth._id, status: { $in: ['issued', 'authorized', 'failed', 'expired'] } },
        {
          $set: {
            fromAddress: from.toLowerCase(),
            domainName: domain.name,
            domainVersion: domain.version,
            validAfter,
            validBefore,
            status: 'issued',
          },
          $unset: { signature: '' },
        },
      )
      .exec();

    // Never hand back a payload we did not persist. `confirm()` rebuilds the
    // typed data from the STORED row, so a silent no-op here produces a
    // signature over one payload verified against another — an error the
    // customer cannot act on and cannot escape by retrying. Any future status
    // this guard has not been taught about now fails loudly, here, instead.
    if ((res?.matchedCount ?? 0) === 0) {
      this.logger.error(
        `[alert] x402.issue_not_persisted invoice=${auth.invoiceId} status=${auth.status} — ` +
          `the authorization was not in a re-issuable state; refusing to return an unsaved payload`,
      );
      throw new ServiceUnavailableException({
        error: 'That payment could not be prepared. Please start the checkout again.',
      });
    }

    const relayed = this.submitter.isReady;
    return {
      typedData,
      chainId: auth.chainId,
      chainName: paymentChainName(auth.chainId),
      tokenSymbol: auth.tokenSymbol,
      amountDisplay: `${formatTokenAmount(BigInt(auth.expectedBaseUnits), auth.tokenDecimals)} ${auth.tokenSymbol}`,
      treasuryAddress: auth.treasuryAddress,
      validBefore,
      relayed,
      balanceDisplay:
        balance === undefined
          ? ''
          : `${formatTokenAmount(balance, auth.tokenDecimals)} ${auth.tokenSymbol}`,
      explorerUrl: PAYMENT_CHAIN_EXPLORERS[auth.chainId] ?? '',
    };
  }

  /**
   * The wallet's token balance, or `undefined` when it cannot be read.
   *
   * `undefined` means UNKNOWN and must not be treated as zero: an RPC blip would
   * otherwise refuse a customer who has the money. The relay preflight is the
   * backstop for that case — it simulates the real transfer, so a genuinely
   * insufficient balance is still caught before anything is broadcast.
   */
  private async readBalance(
    auth: { chainId: number; tokenAddress: string },
    holder: string,
  ): Promise<bigint | undefined> {
    const url = this.config.evmRpcUrls.get(auth.chainId);
    if (!url) return undefined;
    try {
      const raw = await new EvmRpcClient(auth.chainId, url).ethCall(
        auth.tokenAddress,
        `${BALANCE_OF_SELECTOR}${holder.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`,
      );
      return BigInt(raw);
    } catch (err) {
      this.logger.warn(
        `Could not read ${auth.tokenAddress} balance for ${holder}: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * Verify a signature against the STORED payload and get it on chain.
   *
   * ORDER MATTERS, and it is the opposite of the SIWE nonce's. There, the nonce
   * is consumed BEFORE the signature check, because a bad signature is a GUESS
   * against a secret and the challenge must not survive it. Here the "secret" is
   * the customer's own key and a bad signature is an ordinary mistake — a wallet
   * that returned something odd, a stale panel — so burning the authorization
   * would strand the one person entitled to pay. Verify first; the on-chain nonce
   * is what makes double-spending impossible either way.
   */
  async confirm(customerId: string, signature: string): Promise<AuthorizationResult> {
    const auth = await this.findOpenAuthorization(customerId);

    if (auth.status === 'settled') return { status: 'settled' };
    if (auth.status === 'submitted') return { status: 'submitted', txHash: auth.txHash };
    if (!auth.fromAddress || auth.validBefore === undefined || !auth.domainName || !auth.domainVersion) {
      // No payload was ever issued for a wallet, so there is nothing this
      // signature could be over.
      throw new BadRequestException({
        error: 'Connect your wallet and request a payment authorization first.',
      });
    }
    if (auth.validBefore * 1000 <= Date.now()) {
      throw new BadRequestException({
        error: 'That authorization has expired — please request a new one and sign again.',
      });
    }

    // REBUILT FROM THE STORED ROW. Nothing the caller sent contributes to the
    // payload; they supply only the signature.
    const typedData = buildTransferAuthorizationTypedData({
      tokenName: auth.domainName,
      tokenVersion: auth.domainVersion,
      chainId: auth.chainId,
      tokenAddress: auth.tokenAddress,
      from: auth.fromAddress,
      to: auth.treasuryAddress,
      valueBaseUnits: BigInt(auth.expectedBaseUnits),
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    });

    const verdict = await verifyAuthorizationSignature({ typedData, signature });
    if (!verdict.valid) {
      this.logger.warn(
        `x402 signature refused for invoice ${String(auth.invoiceId)}: ${verdict.reason ?? 'unknown'}`,
      );
      throw new BadRequestException({
        error: 'That signature could not be verified. Please try signing again.',
      });
    }

    const calldata = this.submitter.encodeRelayCalldata({
      from: auth.fromAddress,
      to: auth.treasuryAddress,
      valueBaseUnits: BigInt(auth.expectedBaseUnits),
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
      signature,
    });

    // PREFLIGHT BEFORE STORING. A simulation that reverts means the transfer
    // cannot succeed — an insufficient balance, a nonce already spent, a token
    // that paused — and telling the customer now is far better than accepting the
    // signature, showing "payment in progress", and having it fail silently.
    const preflight = await this.submitter.preflight({
      chainId: auth.chainId,
      tokenAddress: auth.tokenAddress,
      calldata,
      // With no relayer the CUSTOMER sends it, so estimate against their account.
      sender: auth.fromAddress,
    });
    if (!preflight.ok) {
      this.logger.warn(
        `x402 preflight failed for invoice ${String(auth.invoiceId)}: ${preflight.reason}`,
      );
      throw new BadRequestException({
        error: explainPreflight(preflight.reason, auth.tokenSymbol),
      });
    }

    await this.authorizations
      .updateOne({ _id: auth._id }, { $set: { signature, status: 'authorized' } })
      .exec();

    // No relayer: the wallet submits it. The signature is stored, so a watcher
    // still settles the invoice whenever the customer's transaction lands.
    if (!this.submitter.isReady) {
      return {
        status: 'authorized',
        selfSubmit: { to: auth.tokenAddress, data: calldata, chainId: auth.chainId },
      };
    }

    let txHash: string;
    try {
      txHash = await this.submitter.relay({
        chainId: auth.chainId,
        tokenAddress: auth.tokenAddress,
        calldata,
        gas: preflight.gas,
      });
    } catch (err) {
      // The authorization stays `authorized` — still valid, still spendable until
      // `validBefore` — so a retry is meaningful. A 503 is honest here: the
      // customer did their part and our broadcast failed.
      this.logger.error(
        `[alert] x402.relay_failed invoice=${String(auth.invoiceId)} — ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException({
        error: 'We could not submit your payment just now. Your signature is saved — please retry shortly.',
      });
    }

    await this.authorizations
      .updateOne(
        { _id: auth._id, status: 'authorized' },
        { $set: { status: 'submitted', txHash: txHash.toLowerCase() } },
      )
      .exec();

    this.logger.log(
      `x402 relay submitted for invoice ${String(auth.invoiceId)} on chain ${auth.chainId}: ${txHash}`,
    );
    return { status: 'submitted', txHash };
  }

  /**
   * Record the transaction hash for a payment the CUSTOMER submitted themselves.
   *
   * WHY IT MATTERS: on the no-relayer path the browser learns the hash from
   * `eth_sendTransaction` and, until now, never told us — so `txHash` stayed empty
   * until the watcher settled and wrote its own. That is fine when everything
   * works, and useless in exactly the case you need it: a transaction that reverts,
   * stalls, or is replaced never settles, so the row sat `issued` with no trace and
   * an operator had nothing to search a chain explorer with.
   *
   * ── THE HASH IS UNTRUSTED AND MUST NEVER DRIVE SETTLEMENT. ──
   *
   * It arrives from the browser, so a caller can send any hex they like. It is
   * stored as a BREADCRUMB for support and for the UI's explorer link, and nothing
   * else: entitlement still comes only from the watcher finding OUR nonce in an
   * `AuthorizationUsed` event with a verified paired `Transfer`. If you ever find
   * yourself reading this field to decide whether someone has paid, stop.
   */
  async recordSubmission(customerId: string, txHash: string): Promise<{ recorded: boolean }> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash?.trim() ?? '')) {
      throw new BadRequestException({ error: 'That is not a transaction hash.' });
    }
    const auth = await this.findOpenAuthorization(customerId);
    // Guarded on the pre-settlement statuses so a late call cannot overwrite the
    // hash the WATCHER wrote — that one is verified, this one is hearsay.
    const updated = await this.authorizations
      .updateOne(
        { _id: auth._id, status: { $in: ['issued', 'authorized'] } },
        { $set: { status: 'submitted', txHash: txHash.trim().toLowerCase() } },
      )
      .exec();
    return { recorded: updated.modifiedCount > 0 };
  }

  /**
   * The caller's own authorization for their one open invoice.
   *
   * Scoped by `customerId` IN THE FILTER, so the query itself is the
   * authorization — the same rule `ClientsService.*Owned` follows. There is no
   * fetch-then-compare, so there is no window and no way to reach somebody
   * else's invoice.
   */
  private async findOpenAuthorization(
    customerId: string,
  ): Promise<PaymentAuthorization & { _id: unknown }> {
    const owner = new Types.ObjectId(customerId);
    const openInvoice = await this.invoices
      .findOne({ customerId: owner, status: 'open' })
      .sort({ periodStart: -1 })
      .lean()
      .exec();
    if (!openInvoice) {
      throw new NotFoundException({ error: 'You have no payment due right now.' });
    }
    const auth = await this.authorizations
      .findOne({ invoiceId: openInvoice._id, customerId: owner })
      .select('+signature')
      .lean()
      .exec();
    if (!auth) {
      throw new NotFoundException({
        error: 'This invoice is not payable with crypto. Please start the checkout again.',
      });
    }
    return auth as PaymentAuthorization & { _id: unknown };
  }
}

/** `0xf85a…484D` — enough to identify an account without a wall of hex. */
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * A revert reason a customer can act on.
 *
 * Node error strings are not user-facing copy ("execution reverted: FiatTokenV2:
 * authorization is used or canceled" tells a customer nothing), but the two
 * COMMON causes are entirely actionable and worth naming precisely: not enough
 * USDC, or an authorization already spent. Anything else stays generic rather
 * than leaking node internals into the UI.
 */
function explainPreflight(reason: string, tokenSymbol: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes('balance') || lower.includes('insufficient')) {
    return `Your wallet does not have enough ${tokenSymbol} for this payment.`;
  }
  if (lower.includes('authorization is used') || lower.includes('used or canceled')) {
    return 'This payment has already been authorized. Give it a moment to confirm.';
  }
  if (lower.includes('expired')) {
    return 'That authorization has expired — please request a new one and sign again.';
  }
  return `This payment could not be prepared. Check your ${tokenSymbol} balance and network, then try again.`;
}
