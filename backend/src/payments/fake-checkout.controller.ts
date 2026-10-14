import { Controller, Get, Inject, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { PaymentApplyService } from './payment-apply.service.js';
import { FakePaymentProvider, FAKE_PROVIDER_KEY } from './providers/fake.provider.js';

/** Minimal Express response shape — avoids pulling in `@types/express`. */
interface RedirectingResponse {
  redirect(status: number, url: string): void;
}

/**
 * The dev rail's "checkout page": a GET that settles a fake payment and bounces
 * the browser to the return URL, exactly as Radom's hosted page would.
 *
 * WHY A ROUTE AND NOT A TEST HELPER: everything downstream of a settlement —
 * the apply path, the invoice writes, the period advance, the receipt, the five
 * return-page states — is what a first real payment will exercise, and none of
 * it can be walked through in a browser until something can settle. Radom needs
 * an account, sandbox credentials and a human; this needs neither and drives
 * the identical code.
 *
 * ── IT GRANTS PAID PLANS FOR NOTHING, SO: ─────────────────────────────────
 *
 * `FakePaymentProvider.isConfigured()` returns false in production
 * unconditionally, `PaymentProviderRegistry` therefore never registers it
 * there, and `resolve` below 404s when it is absent. `validateSecurity` refuses
 * to boot production with `PAYMENTS_FAKE_ENABLED` set at all. Three independent
 * gates, because one of them being edited by somebody who does not know about
 * the other two is exactly how this becomes a free-money endpoint.
 *
 * `?amount=` is the point of the dev rail, not a loose end: it makes the
 * underpay, tolerated-underpay and overpay branches of the fold reachable from
 * a browser instead of only from a spec.
 */
@Controller('billing/fake-checkout')
export class FakeCheckoutController {
  constructor(
    @Inject(FakePaymentProvider) private readonly fake: FakePaymentProvider,
    @Inject(PaymentApplyService) private readonly applyService: PaymentApplyService,
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  @Get(':ref')
  async settle(
    @Param('ref') ref: string,
    @Query('return') returnUrl: string,
    @Query('amount') amount: string | undefined,
    @Res() res: RedirectingResponse,
  ): Promise<void> {
    // The gate, re-checked at the route rather than assumed from registration.
    if (!this.fake.isConfigured()) throw new NotFoundException({ error: 'Not found' });

    const override = amount === undefined ? undefined : Number(amount);
    const settled = this.fake.settle(
      ref,
      Number.isFinite(override) && override !== undefined && override >= 0 ? Math.round(override) : undefined,
    );
    if (!settled) throw new NotFoundException({ error: 'No such checkout' });

    await this.applyService.apply({ provider: FAKE_PROVIDER_KEY, payment: settled });

    // Only ever back to OUR portal. `returnUrl` arrives in a query string, and
    // redirecting to whatever it says would be an open redirect on a route that
    // has just been through the money code — so the host is checked against
    // `PORTAL_BASE_URL` and anything else falls back to the billing page.
    res.redirect(302, this.safeReturn(returnUrl));
  }

  private safeReturn(candidate: string | undefined): string {
    const fallback = `${this.config.portalBaseUrl}/portal/billing`;
    if (!candidate) return fallback;
    try {
      const target = new URL(candidate);
      const portal = new URL(this.config.portalBaseUrl);
      return target.origin === portal.origin ? target.toString() : fallback;
    } catch {
      return fallback;
    }
  }
}
