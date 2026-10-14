import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { MailService } from '../mail/mail.service.js';

/**
 * The four lifecycle emails: renewal notice, grace warning, downgraded, payment
 * received.
 *
 * SEPARATE FROM the auth mails in `CustomerAuthService` on purpose, and the
 * difference is not organisational — it is a security property. Those carry a
 * LIVE SECRET (a verification code, a reset token), so they have a
 * production-never-logs fork and an undeliverable path that shouts. Nothing
 * here carries a secret: every link is a plain portal URL any signed-in
 * customer can reach on their own, so an undeliverable billing mail is a warn
 * and no more. Keeping the two apart means the secret-handling rules cannot be
 * relaxed by someone reasoning about a mail that has no secret in it.
 *
 * TOTAL, like `MailService.send` itself. A subscription must never fail to
 * renew, and access must never fail to be cut, because an email did not go out.
 * Every method here resolves; failures are logged.
 */
@Injectable()
export class BillingMailService {
  private readonly logger = new Logger(BillingMailService.name);

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    // `@Optional()` mirrors `CustomerAuthService`: specs construct this class
    // directly and must not have to stand up a transport to assert on the
    // lifecycle. The HTTP path always has one — `PaymentsModule` imports
    // `MailModule`.
    @Optional() @Inject(MailService) private readonly mail?: MailService,
  ) {}

  /** A renewal invoice has been raised and is waiting to be paid. */
  async renewalDue(args: {
    to: string;
    planName: string;
    amountMinor: number;
    currency: string;
    dueBy: Date;
    payUrl: string;
  }): Promise<void> {
    await this.deliver(args.to, `Your ${args.planName} plan renews on ${formatDate(args.dueBy)}`, [
      `Your ${args.planName} subscription renews on ${formatDate(args.dueBy)}.`,
      '',
      `Amount due: ${formatMoney(args.amountMinor, args.currency)}`,
      '',
      'This rail does not charge you automatically — pay the invoice to keep your',
      'plan running:',
      args.payUrl,
      '',
      this.signOff(),
    ]);
  }

  /**
   * The period ended unpaid and the grace window has started.
   *
   * Says what happens at the end of it, in plain terms, because the single
   * commonest support question at this point is "will my keys stop working" —
   * and the answer is no, they drop to Free limits.
   */
  async graceWarning(args: {
    to: string;
    planName: string;
    amountMinor: number;
    currency: string;
    graceEndsAt: Date;
    payUrl: string;
  }): Promise<void> {
    await this.deliver(args.to, `Payment overdue — your ${args.planName} plan ends ${formatDate(args.graceEndsAt)}`, [
      `We have not received payment for your ${args.planName} subscription.`,
      '',
      `Amount due: ${formatMoney(args.amountMinor, args.currency)}`,
      `Your plan stays active until ${formatDate(args.graceEndsAt)}.`,
      '',
      'Pay now to keep it:',
      args.payUrl,
      '',
      'If it goes unpaid, your account moves to the Free plan. Your API keys keep',
      'working — at Free limits — and nothing is deleted.',
      '',
      this.signOff(),
    ]);
  }

  /**
   * Grace expired: the account is now on Free.
   *
   * The copy is deliberately unalarming and factual. Nothing was revoked; the
   * limits changed. `Customer.status` is never written by the billing
   * lifecycle, so the keys really do still work — see the note on that field.
   */
  async downgraded(args: { to: string; previousPlanName: string; billingUrl: string }): Promise<void> {
    await this.deliver(args.to, `Your account has moved to the Free plan`, [
      `Your ${args.previousPlanName} subscription has ended and your account is now on`,
      'the Free plan.',
      '',
      'Your API keys still work. They are subject to Free plan limits from now on,',
      'and nothing has been deleted.',
      '',
      'You can resubscribe at any time:',
      args.billingUrl,
      '',
      this.signOff(),
    ]);
  }

  /** A payment settled. Includes the shortfall when the tolerance forgave one. */
  async paymentReceived(args: {
    to: string;
    planName: string;
    amountMinor: number;
    currency: string;
    periodEnd: Date;
    invoiceNumber: number;
    creditMinor: number;
    billingUrl: string;
  }): Promise<void> {
    const lines = [
      `We have received ${formatMoney(args.amountMinor, args.currency)} for invoice #${args.invoiceNumber}.`,
      '',
      `Your ${args.planName} plan is active until ${formatDate(args.periodEnd)}.`,
    ];
    if (args.creditMinor > 0) {
      lines.push(
        '',
        `You sent ${formatMoney(args.creditMinor, args.currency)} more than the amount due.`,
        'It has been added to your account credit and will reduce your next invoice.',
      );
    }
    lines.push('', 'Billing history:', args.billingUrl, '', this.signOff());
    await this.deliver(args.to, `Payment received — ${args.planName}`, lines);
  }

  private signOff(): string {
    return `— ${new URL(this.config.portalBaseUrl).host}`;
  }

  /**
   * The single send. Nothing here throws, and nothing here logs the body — the
   * body is unremarkable, but the rule is worth keeping uniform across every
   * mail path in the codebase so nobody has to check which one is which.
   */
  private async deliver(to: string, subject: string, lines: string[]): Promise<void> {
    if (!this.mail?.isConfigured()) {
      this.logger.warn(`No mail transport configured — billing notice not sent to ${to} (${subject})`);
      return;
    }
    try {
      const sent = await this.mail.send({ to, subject, text: lines.join('\n') });
      if (!sent) {
        this.logger.warn(`Billing notice not accepted by the provider for ${to} (${subject})`);
      }
    } catch (err) {
      // Documented never to throw; if that changes, a renewal must still renew.
      const reason = err instanceof Error ? err.name : 'unknown error';
      this.logger.warn(`Mail transport threw sending a billing notice to ${to} (${reason})`);
    }
  }
}

/** Minor units → a human amount. The only place billing copy formats money. */
function formatMoney(minor: number, currency: string): string {
  const major = (Math.round(minor) / 100).toFixed(2);
  return `${major} ${currency.toUpperCase()}`;
}

/** UTC, spelled out. A bare `2026-09-01` reads as ambiguous to half the world. */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
