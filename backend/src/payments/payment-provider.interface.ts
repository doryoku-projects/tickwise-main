/**
 * The payment-rail abstraction.
 *
 * Written against Stripe's shape deliberately — the schemas already speak
 * Stripe's status vocabularies verbatim — but the FIRST real rail is Radom
 * (hosted USDC checkout), which differs from Stripe in three ways that the
 * `capabilities` object exists to make explicit rather than implicit:
 *
 *  1. Radom's pay-link rail does NOT auto-renew. Something on our side has to
 *     mint the next invoice, which is what `subscription-sweep` is for.
 *  2. Its webhook is a STATIC SHARED KEY in a header, not an HMAC over the
 *     body. A body nobody signed is a body anybody can write, so the payment is
 *     always RE-FETCHED before entitlement is granted — see `getPayment`.
 *  3. Crypto settles for whatever the sender actually sent. Under- and
 *     overpayment are ordinary outcomes, not errors.
 *
 * A caller must branch on `capabilities`, never on `provider.key`. Keying off
 * the name is how a second rail silently inherits the first one's assumptions.
 */

/** What a rail can and cannot do. Every field is load-bearing somewhere. */
export interface ProviderCapabilities {
  /** The rail hosts a checkout page we redirect the customer to. */
  hostedCheckout: boolean;
  /**
   * The rail settles by a DIRECT ON-CHAIN TRANSFER to an address we control,
   * with no third party in the middle. `createCheckout` then returns
   * `instructions` instead of a `hostedUrl`, and there is no webhook at all —
   * a chain watcher is what notices the money.
   *
   * This is the axis that separates the two rail SHAPES, and it is why it is a
   * capability rather than a subclass: `hostedCheckout: true` means "send the
   * browser somewhere", `onChainDirect: true` means "show the customer an
   * address". A rail may support neither (`manual`), and a future fiat rail
   * will be the first shape without ever touching the second.
   */
  onChainDirect: boolean;
  /**
   * The rail renews the subscription ITSELF. `false` means our sweep is the
   * only thing that will ever bill a second period — forgetting this is a
   * subscription that silently never renews.
   */
  recurring: boolean;
  /** The rail delivers webhooks at all. `manual` does not. */
  webhooks: boolean;
  /**
   * The webhook carries a cryptographic signature OVER THE BODY, so the body
   * can be trusted once verified.
   *
   * `false` — Radom, a static header key — means the header proves only that
   * the SENDER knew a shared secret, and says nothing about the payload. The
   * apply path must then treat the body as a HINT (which payment id to look
   * at) and re-fetch the truth. Nothing may branch on this to SKIP the
   * re-fetch: `PaymentApplyService` re-fetches unconditionally, and this flag
   * exists so a reader knows why.
   */
  bodySignature: boolean;
  /**
   * Settlement can differ from the amount asked for. True for every crypto
   * rail; the $1 underpay tolerance and the overpay-to-credit rule in
   * `entitlement-fold.ts` exist for exactly this.
   */
  variableSettlement: boolean;
}

export interface CreateCheckoutArgs {
  /**
   * OUR invoice id. The correlation key: the rail echoes it back on the
   * payment, which is how a webhook about `pay_abc` finds the invoice it
   * settles. Never a customer id — an invoice is the thing being paid.
   */
  reference: string;
  /** Money. Integer MINOR units. */
  amountMinor: number;
  currency: string;
  /** Shown on the rail's checkout page. Contains no secrets. */
  description: string;
  customerEmail?: string;
  /**
   * OUR customer id, when the rail wants to record who a payment belongs to on
   * its own row (the x402 rail stores it on the authorization). Distinct
   * from `reference`, which is the INVOICE — a hosted rail ignores this.
   */
  customerId?: string;
  /**
   * The chain the customer chose, for a rail that accepts several. Advisory: a
   * rail with no token on that chain falls back to its first accepted one, so a
   * bad value degrades to a default rather than failing. A hosted rail ignores
   * it.
   */
  preferredChainId?: number;
  /** Where the rail sends the browser afterwards. Both carry the invoice id. */
  successUrl: string;
  cancelUrl: string;
}

/**
 * What the customer needs in order to pay, in whichever form the rail deals in.
 *
 * EXACTLY ONE of `hostedUrl` / `instructions` is present, decided by the rail's
 * capabilities — never both, and a checkout with neither is a bug the caller
 * should refuse rather than render. Keeping them on one type (instead of
 * forking `createCheckout`'s return) is what lets `SubscriptionsService` mint a
 * checkout without knowing the rail's shape; only the portal branches.
 */
export interface ProviderCheckout {
  /** The rail's own id for the session / pay link / deposit. */
  ref: string;
  /** Hosted-redirect rails (Radom today, Stripe later). */
  hostedUrl?: string;
  /** Direct on-chain rails. See `OnChainInstructions`. */
  instructions?: OnChainInstructions;
  expiresAt?: Date;
}

/**
 * How a customer pays a no-middleman rail. TWO SHAPES, discriminated on `kind`.
 *
 * `authorization` IS THE ONLY ONE ANYTHING MINTS. The customer signs an EIP-3009
 * message and the token moves the money into one treasury; the NONCE is the
 * invoice reference.
 *
 * `deposit` IS LEGACY AND READ-ONLY. The deposit-address rail that produced it —
 * an xpub, one derived address per invoice, a `Transfer` watcher and an offline
 * sweep — was deleted on 2026-08-11. The SHAPE survives because rows carrying it
 * are already stored in the `invoices` collection, and a type that cannot
 * describe data you still have to read is not a simplification. Nothing writes it
 * any more; do not add a caller that does.
 *
 * `kind` IS OPTIONAL ON THE DEPOSIT VARIANT for the same reason: rows written
 * before the union existed have no `kind` field at all, so ABSENT MUST MEAN
 * `deposit` or every historical invoice becomes unreadable.
 */
export type OnChainInstructions = DepositInstructions | AuthorizationInstructions;

/**
 * LEGACY, READ-ONLY: pay-to-this-address, from the deleted deposit rail.
 *
 * Kept only so stored invoices remain readable — see `OnChainInstructions`.
 * Nothing mints this shape since 2026-08-11.
 */
export interface DepositInstructions {
  /** Absent on rows written before the union existed — see `OnChainInstructions`. */
  kind?: 'deposit';
  chainId: number;
  /** Human chain name for the UI — a wrong network is the commonest way to lose funds. */
  chainName: string;
  /** ERC-20 contract the customer must send. Never the native coin. */
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** The address to send to. Unique per invoice — that uniqueness IS the matching. */
  payToAddress: string;
  /**
   * The exact amount, in the TOKEN's own base units, as a DECIMAL STRING.
   *
   * A string and not a number: USDC has 6 decimals so small amounts fit, but an
   * 18-decimal token at any real price exceeds 2^53 and a float silently loses
   * the low digits — the same rule the position schemas follow for chain
   * amounts. The watcher parses it with `BigInt`.
   */
  amountBaseUnits: string;
  /** The same amount rendered for a human, e.g. `19.00 USDC`. Display only. */
  amountDisplay: string;
  /** Confirmations required before this is treated as settled. */
  minConfirmations: number;
}

/**
 * Sign-to-pay, for the EIP-3009 / x402 rail.
 *
 * NOTE WHAT IS ABSENT: the EIP-712 typed data itself. It cannot be composed
 * here, and the reason is structural rather than incidental — the signed struct
 * includes `from`, the payer's wallet, which is unknown at checkout time (an
 * invoice is raised long before anybody connects a wallet, and renewals are
 * raised by a background sweep with no browser present at all). So checkout
 * publishes the QUOTE — chain, token, exact amount, treasury, and the nonce that
 * will reference this invoice — and the payload to sign is minted per wallet by
 * a separate authenticated request once the customer has connected one.
 *
 * That split is also the safer arrangement: the typed data is composed
 * server-side at the moment of signing and stored, exactly as
 * `siwe.service.ts` composes its message, so we never verify against a payload
 * a client supplied.
 */
export interface AuthorizationInstructions {
  kind: 'authorization';
  chainId: number;
  chainName: string;
  /** The ERC-20 being authorized — also the EIP-712 `verifyingContract`. */
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /**
   * Where the money goes. Display + confirmation only: the binding copy lives
   * inside the signed struct, so a tampered value here cannot redirect funds —
   * it would simply produce a signature the token rejects.
   */
  treasuryAddress: string;
  /** DECIMAL STRING. The exact `value` that will be signed for. */
  amountBaseUnits: string;
  amountDisplay: string;
  /**
   * The 32-byte authorization nonce. THE INVOICE REFERENCE on this rail — it is
   * what `AuthorizationUsed` carries back, and it is minted and stored against
   * the invoice before the customer ever sees it.
   */
  nonce: string;
  /**
   * NOTE what is absent: `validBefore`. The signing window belongs to the
   * SIGNATURE and starts when somebody signs, so it is stamped by the per-wallet
   * signing step and not carried on the quote. Putting it here originally made
   * every sweep-raised renewal unpayable — the quote is a stored snapshot minted
   * a week before its period, so a 30-minute window had long elapsed by the time
   * the customer saw the panel. The quote's own staleness bound is
   * `ProviderCheckout.expiresAt`.
   */
  /** Confirmations required before the relayed transfer is treated as settled. */
  minConfirmations: number;
}

/**
 * The rail's OWN account of one payment, as returned by `getPayment`.
 *
 * This — never a webhook body — is what entitlement is computed from. On a rail
 * with `bodySignature: false` that is the whole security argument; on one with
 * a real body HMAC it costs one request and removes an entire class of
 * "verified the signature, trusted a stale replay" bug, so it is unconditional.
 */
export interface ProviderPayment {
  providerPaymentId: string;
  status: 'pending' | 'succeeded' | 'failed';
  /**
   * Money. Integer MINOR units, in `currency`. What actually settled.
   *
   * OPTIONAL, and omitting it is meaningfully different from reporting `0`: it
   * means "this rail cannot tell you the amount", and the CALLER must then fall
   * back to its own record. A self-custody rail knows only what it EXPECTED —
   * the settled figure is computed by its chain watcher from a verified
   * `Transfer` and lives on the `Payment` row, not on the rail.
   *
   * Reporting `0` instead was a real money bug. `PaymentReconcileService`'s
   * drift repair releases the `appliedAt` claim, re-fetches, and re-applies —
   * and its `fresh ?? { …latest.amountMinor }` fallback only fires when the
   * re-fetch returns NULL. Both crypto rails returned a non-null object carrying
   * `amountMinor: 0`, so the fallback never fired: the repair re-applied the
   * payment as zero and the invoice total, being RECOMPUTED from the sum of
   * applied payments, dropped by the real amount — turning a paid invoice back
   * into an unpaid one and putting a paying customer on the path to a downgrade.
   */
  amountMinor?: number;
  currency: string;
  /** The `reference` we sent at checkout — our invoice id — echoed back. */
  reference?: string;
  /** On-chain detail, when the rail is crypto. */
  asset?: string;
  /** DECIMAL STRING, never a float — token amounts routinely exceed 2^53. */
  assetAmount?: string;
  chainId?: number;
  txHash?: string;
  receivedAt?: Date;
}

/**
 * What we take from a webhook body: an id to look up, and nothing that could
 * grant anything on its own.
 *
 * `kind: 'ignored'` is a first-class outcome, not a failure — a rail sends
 * plenty of events we do not act on, and answering 200 to those is what stops
 * it retrying them forever.
 */
export interface WebhookEnvelope {
  /** The rail's event id — the replay key. A retry repeats it verbatim. */
  providerEventId: string;
  kind: 'payment' | 'ignored';
  /** Present for `kind: 'payment'`. A HINT: everything else is re-fetched. */
  providerPaymentId?: string;
}

/**
 * A broadcast payment's progress toward settlement.
 *
 * `confirmations` counts the transaction's own block, so a freshly mined tx is
 * 1 rather than 0 — which is what every explorer shows and therefore what the
 * customer will compare against.
 */
export interface PaymentProgress {
  /** Confirmations so far, inclusive of the mining block. Never negative. */
  confirmations: number;
  /** What this chain requires before we settle. From `minConfirmationsFor`. */
  minConfirmations: number;
  /** Blocks still to go. Zero once the requirement is met. */
  remaining: number;
  txHash: string;
  /** Absent when the chain has no explorer configured — never a dead link. */
  explorerUrl?: string;
}

/**
 * How strict "in flight" should be, which depends on whose intent is driving
 * the question.
 *
 * **`'any'`** — a payload has been issued to a wallet, so a signature MAY exist
 * that we have not seen. Correct for an IMPLICIT void: a plan change does not
 * mean "I am not paying that", so an outstanding payload must be protected.
 *
 * **`'signed'`** — we have actually SEEN a signature (`authorized`) or sent a
 * relay (`submitted`). Correct for an EXPLICIT cancel, where the customer is
 * telling us in as many words that they are not paying. Treating a merely
 * issued payload as uncancellable there locked people out of their own cancel
 * button for the full 30-minute `X402_AUTHORIZATION_TTL_MS` because they opened
 * a wallet and closed it — which is the commonest way a payment does NOT
 * happen, and from the server indistinguishable from one about to.
 *
 * `'signed'` is safe precisely because of the credit invariant: if a signature
 * we never saw does land after the cancel, `PaymentApplyService` refuses and
 * puts the money on the customer's balance. The strictness only decides who
 * waits, never whether money can be lost.
 */
export type InFlightMode = 'any' | 'signed';

/** Header bag as the raw Node request exposes it. */
export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface PaymentProvider {
  /** Stable key. Stored on `Subscription.provider` / `Payment.provider`. */
  readonly key: string;
  readonly capabilities: ProviderCapabilities;

  /**
   * Whether this rail has the credentials it needs. A rail that is not
   * configured is not offered and is not accepted — the same both-halves rule
   * as `AppConfigService.configuredOauthProviders`, so a rail can never be
   * advertised by checkout and then rejected at its own webhook.
   */
  isConfigured(): boolean;

  createCheckout(args: CreateCheckoutArgs): Promise<ProviderCheckout>;

  /**
   * Re-fetch one payment from the rail. `null` = the rail does not know it.
   *
   * MUST throw on a transport failure rather than returning `null`: "the rail
   * has never heard of this payment" and "we could not reach the rail" have
   * opposite correct responses — the first is a forged or stale id to be
   * dropped, the second is a retry.
   */
  getPayment(providerPaymentId: string): Promise<ProviderPayment | null>;

  /**
   * Authenticate an inbound webhook against the RAW bytes.
   *
   * Takes the raw Buffer, not a parsed object: a signature is over bytes, and
   * `JSON.parse` → `JSON.stringify` is not the identity function (key order,
   * unicode escapes, number formatting). Implementations MUST hash both sides
   * before any `timingSafeEqual` — it THROWS on unequal lengths, which turns a
   * security check into a 500 and a length oracle.
   */
  verifyWebhook(raw: Buffer, headers: WebhookHeaders): boolean;

  /** Read the envelope out of a verified body. `null` = unparseable. */
  parseWebhook(raw: Buffer): WebhookEnvelope | null;

  /**
   * Is there a payment for this invoice that the customer can still complete,
   * with or without our involvement?
   *
   * OPTIONAL, and `undefined` means "no" — a redirect rail cannot have this
   * problem, because the customer pays THROUGH the rail and the rail knows
   * what it has accepted.
   *
   * A SELF-CUSTODY rail can. Once a payload has been issued to a wallet the
   * customer holds a signable instrument, and on the self-submit path their own
   * wallet broadcasts it: no server-side state can prevent that transfer.
   * "No money has arrived" is therefore NOT "no money is coming", and anything
   * that retires an invoice — voiding it on a plan change, expiring it in the
   * sweep — has to ask this before treating the invoice as inert.
   *
   * This is not hypothetical. A customer picked a plan, switched 270ms later
   * (which voids unfunded invoices), then paid the signature they were already
   * holding for the first invoice; the money landed on a void invoice and the
   * fold could do nothing with it.
   *
   * `mode` is how strict to be, and the right answer depends on WHOSE intent is
   * driving the call — see `InFlightMode`.
   */
  hasPaymentInFlight?(invoiceId: string, mode?: InFlightMode): Promise<boolean>;

  /**
   * How far along a broadcast payment is, in CONFIRMATIONS.
   *
   * Blocks, not seconds. A customer watching a crypto payment is waiting on a
   * count that only goes one way, and "waiting… 47s" tells them nothing about
   * how much longer — the chain does not care how long they have waited. "12 of
   * 30 confirmations" is the actual quantity being waited on, and it is the one
   * a block explorer will agree with.
   *
   * `null` when there is nothing broadcast to measure: no live authorization,
   * no transaction hash yet (signed but not relayed), or the receipt has not
   * appeared. Every one of those is "we cannot say", and the UI falls back to
   * saying so rather than inventing a number.
   */
  paymentProgress?(invoiceId: string): Promise<PaymentProgress | null>;
}
