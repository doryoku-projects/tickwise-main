import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import type { PaymentProvider } from './payment-provider.interface.js';
import { FakePaymentProvider } from './providers/fake.provider.js';
import { ManualPaymentProvider } from './providers/manual.provider.js';
import { RadomPaymentProvider } from './providers/radom.provider.js';
import { X402PaymentProvider } from './providers/x402/x402.provider.js';

/**
 * The one place that answers "which payment rails are live".
 *
 * Modelled on `OauthProviderRegistry` and for the same reason: a rail that
 * checkout will use and a rail whose webhook is accepted must be THE SAME LIST.
 * Two lists drift, and the drift is either a checkout link nobody can pay or a
 * webhook endpoint accepting deliveries for a rail we never sell — the second
 * being an unauthenticated write path to the money code.
 *
 * An UNCONFIGURED rail is not registered at all. On the WEBHOOK path `resolve`
 * 400s it exactly as it does a name that never existed — deliberately generic,
 * so a probe cannot enumerate which credentials an operator installed. On the
 * authenticated CHECKOUT path `resolveCheckoutProvider` instead 503s with a
 * clean customer message and logs the SPECIFIC reason, because an unconfigured
 * checkout rail is a server misconfiguration, not a client error.
 */
@Injectable()
export class PaymentProviderRegistry implements OnModuleInit {
  private readonly logger = new Logger(PaymentProviderRegistry.name);
  /** Only the CONFIGURED rails — what `find`/`resolve` serve. */
  private readonly providers = new Map<string, PaymentProvider>();
  /** EVERY rail this build has, configured or not — for "known but off" diagnosis. */
  private readonly known = new Map<string, PaymentProvider>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(X402PaymentProvider) private readonly x402: X402PaymentProvider,
    @Inject(RadomPaymentProvider) private readonly radom: RadomPaymentProvider,
    @Inject(ManualPaymentProvider) private readonly manual: ManualPaymentProvider,
    @Inject(FakePaymentProvider) private readonly fake: FakePaymentProvider,
  ) {}

  onModuleInit(): void {
    // `manual` and `fake` last so a real rail always wins the checkout default;
    // `x402` first because it is the intended production rail. Order here only
    // decides the diagnostic listing — the checkout default is
    // `PAYMENTS_PROVIDER`, never position in this array.
    for (const provider of [this.x402, this.radom, this.manual, this.fake]) {
      this.known.set(provider.key, provider);
      if (!provider.isConfigured()) continue;
      this.providers.set(provider.key, provider);
    }
    this.logger.log(`Payment rails live: ${[...this.providers.keys()].join(', ') || 'none'}`);

    // A tolerance left at test settings is money given away on every payment,
    // and it is invisible in normal operation — nothing errors, invoices just
    // settle a little light. Announced at boot whenever it is not the default.
    const tolerance = this.config.underpayToleranceMinor;
    if (tolerance !== 100) {
      this.logger.warn(
        `[alert] payments.underpay_tolerance_non_default value=${tolerance} minor units ` +
          '(default 100) — intended for small-value live testing; restore it before real pricing',
      );
    }

    // A checkout rail that is not live means every upgrade attempt is refused.
    // That is the correct behaviour — better than a dead pay link — but it is a
    // configuration mistake, so it must be visible at boot with the SPECIFIC
    // reason, not discovered by the first customer as an opaque error.
    if (!this.providers.has(this.checkoutProviderKey)) {
      this.logger.warn(
        `[alert] payments.checkout_rail_unavailable '${this.checkoutProviderKey}' — ` +
          `self-serve upgrades will be refused until it is configured. ${this.checkoutRailReason()}`,
      );
    }
  }

  /**
   * Why the configured checkout rail is not live, as an operator sentence.
   * Distinguishes a KNOWN rail that is merely unconfigured (and names what is
   * missing) from a `PAYMENTS_PROVIDER` value that is not a rail at all.
   */
  private checkoutRailReason(): string {
    const key = this.checkoutProviderKey;
    if (!this.known.has(key)) {
      return `PAYMENTS_PROVIDER='${key}' is not a known rail (known: ${[...this.known.keys()].join(', ')}).`;
    }
    if (key === this.x402.key) {
      const problem = this.config.x402ConfigProblem();
      return problem ? `The x402 rail is not fully configured: ${problem}.` : '';
    }
    if (key === this.radom.key) {
      return 'The radom rail needs RADOM_API_KEY and RADOM_WEBHOOK_SECRET.';
    }
    if (key === this.fake.key) {
      return 'The fake rail is disabled here (production, or PAYMENTS_FAKE_ENABLED unset).';
    }
    return `The '${key}' rail reported itself not configured.`;
  }

  /** The rail new checkouts are minted on. */
  get checkoutProviderKey(): string {
    return this.config.paymentsProvider;
  }

  /** Live rails, for diagnostics and the admin panel. Never a secret. */
  list(): Array<{ key: string; capabilities: PaymentProvider['capabilities'] }> {
    return [...this.providers.values()].map((p) => ({ key: p.key, capabilities: p.capabilities }));
  }

  /** `undefined` rather than a throw — for callers that must not fail closed loudly. */
  find(key: string): PaymentProvider | undefined {
    return this.providers.get(key);
  }

  /**
   * Every registered rail, as the real object.
   *
   * Separate from `list()`, which projects to `{key, capabilities}` because it
   * feeds the admin panel and must never hand a caller something with methods
   * on it. This one is for asking a question OF the rails — "does any of you
   * still have a payment in flight for this invoice" — where the answer has to
   * come from each implementation.
   */
  all(): PaymentProvider[] {
    return [...this.providers.values()];
  }

  /**
   * The strict lookup. 400s on unknown AND on unconfigured, with one identical
   * message for both — the difference is exactly the thing a prober wants.
   */
  resolve(key: string): PaymentProvider {
    const provider = this.providers.get(key);
    if (!provider) {
      throw new BadRequestException({ error: `Unknown payment provider '${key}'.` });
    }
    return provider;
  }

  /**
   * The rail a new checkout is minted on.
   *
   * NOT `resolve()`. `resolve()` is the WEBHOOK path's lookup, where an unknown
   * key is deliberately answered with a generic 400 to stop a prober
   * enumerating configured rails. This is the AUTHENTICATED CHECKOUT path: an
   * unconfigured checkout rail is a SERVER MISCONFIGURATION, not a client error,
   * so it is a 503 with a clean customer message — and the specific reason is
   * logged for the operator rather than surfaced as "Unknown payment provider",
   * which is what a customer used to see when a crypto rail was selected with
   * half its configuration missing.
   */
  resolveCheckoutProvider(): PaymentProvider {
    const live = this.providers.get(this.checkoutProviderKey);
    if (live) return live;
    this.logger.error(
      `[alert] payments.checkout_rail_unavailable '${this.checkoutProviderKey}' — ${this.checkoutRailReason()}`,
    );
    throw new ServiceUnavailableException({
      error: 'Card and crypto payments are temporarily unavailable — please try again later.',
    });
  }
}
