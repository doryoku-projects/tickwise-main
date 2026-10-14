import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';

export class StartCheckoutDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  planKey!: string;

  /**
   * Which `Plan.prices[]` entry to buy. Omitted means the active monthly one.
   *
   * The AMOUNT is never accepted from the client — only this id. The price is
   * then read from the plan document in Mongo, so a caller cannot name their
   * own figure, and cannot buy a deactivated or $0 price by asking for it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  priceId?: string;
}

/**
 * The wallet the customer will pay FROM.
 *
 * It is one of the six fields inside the EIP-3009 signature, so the server needs
 * it to compose the payload — but note what is ABSENT: no invoice id, no amount,
 * no treasury. The invoice is resolved from the JWT and the amount from the stored
 * authorization, so a caller cannot name their own figure or point at somebody
 * else's invoice.
 */
export class AuthorizeDto {
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: 'from must be a 0x-prefixed EVM address' })
  from!: string;
}

/** The signature over the payload we issued. Nothing else — see `AuthorizeDto`. */
export class ConfirmAuthorizationDto {
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{130}$/, { message: 'signature must be 65 bytes of hex' })
  signature!: string;
}

/**
 * Which network to re-quote the open invoice on.
 *
 * A chain ID and nothing else — no amount, no token address, no invoice. The
 * server checks it against its OWN accept-list, so a caller cannot name a chain
 * we do not take payment on, and cannot influence what is charged.
 */
export class SwitchNetworkDto {
  @IsInt()
  @Min(1)
  chainId!: number;
}

/**
 * The hash of a transaction the customer's own wallet sent.
 *
 * A BREADCRUMB, not evidence: it comes from the browser, so it is stored for
 * support and the explorer link and never used to decide that anyone has paid.
 */
export class SubmittedTxDto {
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{64}$/, { message: 'txHash must be a 32-byte hex hash' })
  txHash!: string;
}

export class CancelSubscriptionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * The admin financial actions. `confirm` and `note` are REQUIRED on every one
 * of them — see `AdminPaymentsController`.
 */
export class MarkPaidDto {
  @IsString()
  @MinLength(1)
  invoiceId!: string;

  /** Money. Integer MINOR units. What actually arrived. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  amountMinor!: string;

  /**
   * A short, stable name for this payment — a bank reference, a tx hash, a
   * ticket number. It is half of the deterministic idempotency id (see
   * `manualPaymentId`), so a double-clicked form collides instead of crediting
   * the invoice twice, while a genuine second part-payment can be recorded by
   * giving it a different one.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  reference!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note!: string;

  /** Must be the literal `true`. A financial write is never a bare POST. */
  @IsIn([true])
  confirm!: boolean;
}

export class MarkSubscriptionStatusDto {
  @IsIn(['active', 'past_due', 'unpaid', 'canceled'])
  status!: 'active' | 'past_due' | 'unpaid' | 'canceled';

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note!: string;

  @IsIn([true])
  confirm!: boolean;
}
