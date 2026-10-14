import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { request } from 'undici';
import { AppConfigService } from '../../config/app-config.service.js';
import type {
  CreateCheckoutArgs,
  PaymentProvider,
  ProviderCapabilities,
  ProviderCheckout,
  ProviderPayment,
  WebhookEnvelope,
  WebhookHeaders,
} from '../payment-provider.interface.js';

export const RADOM_PROVIDER_KEY = 'radom';

/** Outbound call budget. A rail that has stopped answering must not hold a request open. */
const RADOM_TIMEOUT_MS = 8000;

/**
 * ─── WIRE FORMAT — VERIFY AGAINST THE SANDBOX BEFORE GOING LIVE ─────────────
 *
 * Everything in this block is Radom's shape, not ours, and it was written
 * WITHOUT a live account (the credentials are the one external dependency this
 * milestone could not remove). It is collected here, at the top, rather than
 * scattered through the methods, so confirming it against the real API is a
 * single diff against a single block.
 *
 * What is NOT provisional, and must survive any correction below: the payment
 * is re-fetched before entitlement is granted, the header key is compared by
 * hashing both sides, and rotation is supported. Those are properties of this
 * file's logic, not of Radom's field names.
 */
const RADOM_PATHS = {
  /** POST — mint a hosted checkout session. */
  createCheckout: '/checkout_session',
  /** GET `${payment}/${id}` — the re-fetch. */
  payment: '/payments',
} as const;

/**
 * The webhook's shared-secret header. Radom sends a STATIC verification key,
 * NOT an HMAC over the body — hence `bodySignature: false` and the mandatory
 * re-fetch. Lowercased because Node lowercases inbound header names.
 */
const RADOM_VERIFICATION_HEADER = 'radom-verification-key';

/** Event types that carry a settlement. Anything else resolves to `ignored`. */
const RADOM_PAYMENT_EVENTS = new Set([
  'managedPayment',
  'newPayment',
  'paymentTransactionConfirmed',
]);

/**
 * Radom — hosted crypto checkout, USDC on Ethereum / Base / Arbitrum.
 *
 * THREE THINGS THIS FILE GETS RIGHT AND A REWRITE MUST KEEP:
 *
 *  1. **The webhook body is never trusted.** Radom authenticates with a static
 *     shared key in a header, so a verified request proves the SENDER knew a
 *     secret and proves nothing whatsoever about the JSON. Anyone who obtains
 *     that key — a log, a proxy, a support ticket, an old deployment — could
 *     otherwise post `{"amount": "9999", "status": "succeeded"}` and buy a Pro
 *     plan. `parseWebhook` therefore extracts an EVENT ID and a PAYMENT ID and
 *     nothing else; `getPayment` fetches the amount, the currency and the
 *     status from Radom over an authenticated channel.
 *
 *  2. **Both sides are hashed before comparing.** `timingSafeEqual` THROWS on
 *     unequal lengths, so feeding it a stored secret and an attacker-controlled
 *     header of a different length turns the security check into a 500 — and a
 *     500-vs-401 split is a length oracle for the secret. Hashing first makes
 *     both operands exactly 32 bytes, always.
 *
 *  3. **Rotation is supported.** `RADOM_WEBHOOK_SECRET_PREVIOUS` is accepted
 *     alongside the current one, so a key can be rolled without a window where
 *     in-flight deliveries are rejected. Both are compared in constant time and
 *     the previous one is compared even when the current one matches, so the
 *     answer's timing does not reveal which key was used.
 */
@Injectable()
export class RadomPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(RadomPaymentProvider.name);
  readonly key = RADOM_PROVIDER_KEY;

  readonly capabilities: ProviderCapabilities = {
    hostedCheckout: true,
    // A middleman rail. Retained as the reference HOSTED-REDIRECT adapter —
    // the shape a future FIAT provider will take — not because we route
    // crypto through it.
    onChainDirect: false,
    /**
     * FALSE, and load-bearing. Radom's pay-link rail does not auto-renew, so
     * nothing on Radom's side will ever bill a second period —
     * `SubscriptionSweepService` is the only thing that will. Flipping this to
     * true without also disabling the sweep's renewal pass double-bills.
     */
    recurring: false,
    webhooks: true,
    /** See rule 1 above. A static header key is not a body signature. */
    bodySignature: false,
    /** Crypto. Senders round, and network fees come out of the transfer. */
    variableSettlement: true,
  };

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  /**
   * Both halves required, same rule as every other credential pair in this
   * codebase (`mailConfigured`, `configuredOauthProviders`): an API key with no
   * webhook secret can take money and then cannot be told that it did, which is
   * strictly worse than being switched off.
   */
  isConfigured(): boolean {
    return Boolean(this.config.radomApiKey && this.config.radomWebhookSecret);
  }

  async createCheckout(args: CreateCheckoutArgs): Promise<ProviderCheckout> {
    const body = {
      // Minor units → the decimal string Radom prices in. `toFixed(2)` and not
      // a division left as a float: 1999 / 100 is 19.99 today and a
      // 19.990000000000002 the day the amount changes.
      total: (args.amountMinor / 100).toFixed(2),
      currency: args.currency,
      /**
       * OUR invoice id, echoed back on the payment. This is the correlation
       * key — without it a webhook says "someone paid" and cannot say what for.
       */
      metadata: [{ key: 'invoiceId', value: args.reference }],
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
      ...(args.customerEmail ? { customerEmail: args.customerEmail } : {}),
      gateway: {
        managed: {
          methods: this.config.radomAcceptedMethods.map((method) => ({
            network: method.network,
            token: method.token,
          })),
        },
      },
    };

    const json = await this.call<Record<string, unknown>>('POST', RADOM_PATHS.createCheckout, body);
    const ref = firstString(json, ['checkoutSessionId', 'id', 'sessionId']);
    const hostedUrl = firstString(json, ['checkoutSessionUrl', 'sessionUrl', 'url']);
    if (!ref || !hostedUrl) {
      // A checkout we cannot hand to the customer is an infrastructure failure,
      // not a business outcome — it is the one place in this subsystem a 5xx is
      // the honest answer, because retrying genuinely might work.
      throw new ServiceUnavailableException({
        error: 'The payment provider did not return a usable checkout link. Try again in a moment.',
      });
    }
    return {
      ref,
      hostedUrl,
      ...(this.config.radomCheckoutTtlMs > 0
        ? { expiresAt: new Date(Date.now() + this.config.radomCheckoutTtlMs) }
        : {}),
    };
  }

  /**
   * The re-fetch. THROWS on a transport failure and returns `null` only when
   * Radom answers 404 — the interface's contract, and the distinction matters:
   * "Radom has never heard of this id" is a forged or stale webhook to drop,
   * while "we could not reach Radom" is a retry. Collapsing them would make an
   * outage look like a flood of forgeries and silently drop real payments.
   */
  async getPayment(providerPaymentId: string): Promise<ProviderPayment | null> {
    const json = await this.call<Record<string, unknown> | null>(
      'GET',
      `${RADOM_PATHS.payment}/${encodeURIComponent(providerPaymentId)}`,
      undefined,
      { notFoundAsNull: true },
    );
    if (!json) return null;
    return this.toProviderPayment(providerPaymentId, json);
  }

  verifyWebhook(_raw: Buffer, headers: WebhookHeaders): boolean {
    const presented = headerValue(headers, RADOM_VERIFICATION_HEADER);
    if (!presented) return false;

    const current = this.config.radomWebhookSecret;
    // No secret configured = nothing can be verified. Fail CLOSED; an unset
    // secret must never read as "skip the check".
    if (!current) return false;

    const presentedDigest = sha256(presented);
    // Both compared unconditionally — no early return on a match. Short-
    // circuiting would make a request signed with the CURRENT key measurably
    // faster than one signed with the previous key, which leaks which key an
    // attacker's guess is closest to.
    const matchesCurrent = digestEquals(presentedDigest, sha256(current));
    const previous = this.config.radomWebhookSecretPrevious;
    const matchesPrevious = previous ? digestEquals(presentedDigest, sha256(previous)) : false;

    if (matchesPrevious && !matchesCurrent) {
      // Visible, because a rotation that is never finished is a secret that
      // never actually rotated. No values logged.
      this.logger.warn('[alert] payments.webhook.previous_secret radom — finish the rotation and unset RADOM_WEBHOOK_SECRET_PREVIOUS');
    }
    return matchesCurrent || matchesPrevious;
  }

  /**
   * Pull the two ids out of a verified body. Deliberately extracts NOTHING
   * that could grant entitlement — no amount, no status. See rule 1.
   */
  parseWebhook(raw: Buffer): WebhookEnvelope | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const body = parsed as Record<string, unknown>;

    const eventId = firstString(body, ['id', 'eventId', 'radomEventId']);
    if (!eventId) return null;

    const eventType = firstString(body, ['eventType', 'type']) ?? '';
    const data = asRecord(body.eventData) ?? asRecord(body.data) ?? body;
    // Radom nests the payment under the event-type name in some payloads.
    const nested = asRecord(data[eventType]) ?? data;
    const paymentId = firstString(nested, ['paymentId', 'id', 'radomPaymentId'])
      ?? firstString(data, ['paymentId', 'radomPaymentId']);

    if (!RADOM_PAYMENT_EVENTS.has(eventType) || !paymentId) {
      // `ignored` is a SUCCESS: the handler records it and answers 200, which
      // is what stops Radom retrying an event we will never act on forever.
      return { providerEventId: eventId, kind: 'ignored' };
    }
    return { providerEventId: eventId, kind: 'payment', providerPaymentId: paymentId };
  }

  // ─── transport ─────────────────────────────────────────────────────────────

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts?: { notFoundAsNull?: boolean },
  ): Promise<T> {
    const apiKey = this.config.radomApiKey;
    if (!apiKey) {
      throw new ServiceUnavailableException({ error: 'The payment provider is not configured.' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RADOM_TIMEOUT_MS);
    try {
      const response = await request(`${this.config.radomApiBaseUrl}${path}`, {
        method,
        headers: {
          // Radom takes the raw key, not a Bearer token.
          authorization: apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        bodyTimeout: RADOM_TIMEOUT_MS,
        headersTimeout: RADOM_TIMEOUT_MS,
      });

      if (response.statusCode === 404 && opts?.notFoundAsNull) {
        await response.body.dump().catch(() => undefined);
        return null as T;
      }
      const text = await response.body.text();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        // The STATUS and a truncated body only. Never the request — it carries
        // the API key in a header and customer detail in the payload. Same rule
        // as `MailService`.
        this.logger.error(
          `Radom ${method} ${path} failed (HTTP ${response.statusCode}): ${text.slice(0, 300)}`,
        );
        throw new ServiceUnavailableException({ error: 'The payment provider is unavailable. Try again shortly.' });
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Radom ${method} ${path} errored: ${reason}`);
      throw new ServiceUnavailableException({ error: 'The payment provider is unreachable. Try again shortly.' });
    } finally {
      clearTimeout(timer);
    }
  }

  private toProviderPayment(id: string, json: Record<string, unknown>): ProviderPayment {
    const data = asRecord(json.payment) ?? json;
    const currency = (firstString(data, ['currency', 'quoteCurrency']) ?? 'USD').toUpperCase();
    return {
      providerPaymentId: firstString(data, ['id', 'paymentId']) ?? id,
      status: radomStatus(firstString(data, ['status', 'paymentStatus'])),
      amountMinor: toMinor(firstString(data, ['amount', 'total', 'quoteAmount'])),
      currency,
      reference: readInvoiceReference(data),
      asset: firstString(data, ['token', 'asset', 'tokenSymbol']),
      assetAmount: firstString(data, ['tokenAmount', 'assetAmount']),
      chainId: toChainId(firstString(data, ['network', 'chainId'])),
      txHash: firstString(data, ['transactionHash', 'txHash']),
      receivedAt: toDate(firstString(data, ['createdAt', 'confirmedAt', 'receivedAt'])),
    };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Both operands are 32-byte digests by construction, so this cannot throw. */
function digestEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Read one header. A DUPLICATE header name yields `undefined` — fail closed,
 * the same rule as `readBinderCookie`: an array means something in front of us
 * saw two values, and picking one is guessing which is ours.
 */
function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (typeof raw === 'string') return raw.trim() || undefined;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** First of `keys` present as a non-empty string. Numbers are stringified. */
function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * Our invoice id out of Radom's metadata, which they model as a list of
 * `{key, value}` pairs rather than an object.
 */
function readInvoiceReference(data: Record<string, unknown>): string | undefined {
  const metadata = data.metadata;
  if (Array.isArray(metadata)) {
    for (const entry of metadata) {
      const row = asRecord(entry);
      if (row && row.key === 'invoiceId' && typeof row.value === 'string') return row.value;
    }
  }
  const asObject = asRecord(metadata);
  if (asObject && typeof asObject.invoiceId === 'string') return asObject.invoiceId;
  return firstString(data, ['reference', 'invoiceId']);
}

/**
 * Decimal string → integer minor units.
 *
 * Parsed as a STRING and scaled with a round, never `Number(x) * 100` left
 * unrounded: `19.99 * 100` is 1998.9999999999998 in IEEE-754, and `Math.trunc`
 * of that is a cent short on every single payment.
 */
export function toMinor(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

/**
 * Radom's own status vocabulary → the three states `Payment.status` allows.
 *
 * Exported for its spec. It is a pure map, and the one branch that matters —
 * an UNRECOGNISED status resolving to `pending` and never to `succeeded` — is
 * unreachable from `getPayment` without a network stub, so it would otherwise
 * be the untested half of the most consequential decision in the file.
 */
export function radomStatus(value: string | undefined): 'pending' | 'succeeded' | 'failed' {
  const normalized = (value ?? '').toLowerCase();
  if (['success', 'succeeded', 'complete', 'completed', 'confirmed', 'paid'].includes(normalized)) {
    return 'succeeded';
  }
  if (['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(normalized)) return 'failed';
  // UNKNOWN FALLS TO `pending`, never to `succeeded`. A status this build does
  // not recognise must not grant anything; pending is the state that waits for
  // a reconcile rather than the one that hands out a plan.
  return 'pending';
}

/** Radom network slug (or a numeric chain id) → our numeric chain id. */
function toChainId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  const slugs: Record<string, number> = {
    ethereum: 1,
    mainnet: 1,
    base: 8453,
    arbitrum: 42161,
    arbitrumone: 42161,
    polygon: 137,
  };
  return slugs[value.toLowerCase().replace(/[^a-z0-9]/g, '')];
}

function toDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
