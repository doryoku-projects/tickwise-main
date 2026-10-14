import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AdminJwtGuard } from '../auth/admin-jwt.guard.js';
import { SettingsCacheService } from '../billing/settings-cache.service.js';
import { PaymentApplyService } from './payment-apply.service.js';
import { PaymentReconcileService } from './payment-reconcile.service.js';
import { PaymentsQueueService } from './payments-queue.service.js';
import { MarkPaidDto, MarkSubscriptionStatusDto } from './portal-billing.dto.js';
import { PaymentProviderRegistry } from './provider-registry.js';
import { manualPaymentId, MANUAL_PROVIDER_KEY } from './providers/manual.provider.js';
import { Invoice } from './schemas/invoice.schema.js';
import { Payment } from './schemas/payment.schema.js';
import { Subscription, LIVE_SUBSCRIPTION_STATUSES } from './schemas/subscription.schema.js';
import { SubscriptionSweepService } from './subscription-sweep.service.js';

/** The admin identity `AdminJwtGuard` writes onto the request. */
interface AdminRequest {
  adminUser?: { email?: string; sub?: string };
}

/** Page size for the admin lists. Bounded so a console cannot ask for everything. */
const MAX_PAGE = 200;

/**
 * `/admin/subscriptions`, `/admin/payments`, `/admin/revenue` and the manual
 * financial actions.
 *
 * ── EVERY FINANCIAL WRITE GOES THROUGH `PaymentApplyService` ───────────────
 *
 * `mark-paid` does not touch an invoice, a subscription or a plan. It builds a
 * `ProviderPayment` from what the operator typed and hands it to the same
 * service the Radom webhook uses. That is the whole point of the `manual` rail
 * existing: one entitlement fold, one set of writes, one idempotency guard. An
 * admin path that wrote its own `$set` would be a second way to grant a plan,
 * and it would be the one nobody tested.
 *
 * ── `confirm` AND `note` ON EVERY ONE ──────────────────────────────────────
 *
 * `confirm: true` because a financial action must not be reachable by a
 * mis-clicked button or a replayed curl. `note` because six months later the
 * only record of WHY an invoice was written off by hand is the sentence
 * somebody typed at the time. `reconciledBy` is stamped from the JWT, never
 * from the body — an operator naming themselves is not an audit trail.
 */
@Controller('admin')
@UseGuards(AdminJwtGuard)
export class AdminPaymentsController {
  private readonly logger = new Logger(AdminPaymentsController.name);

  constructor(
    @InjectModel(Subscription.name) private readonly subscriptions: Model<Subscription>,
    @InjectModel(Invoice.name) private readonly invoices: Model<Invoice>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @Inject(PaymentApplyService) private readonly applyService: PaymentApplyService,
    @Inject(PaymentReconcileService) private readonly reconcile: PaymentReconcileService,
    @Inject(SubscriptionSweepService) private readonly sweep: SubscriptionSweepService,
    @Inject(PaymentsQueueService) private readonly queue: PaymentsQueueService,
    @Inject(PaymentProviderRegistry) private readonly registry: PaymentProviderRegistry,
    @Inject(SettingsCacheService) private readonly settings: SettingsCacheService,
  ) {}

  // ─── Read ──────────────────────────────────────────────────────────────────

  @Get('subscriptions')
  async listSubscriptions(
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('limit') limit?: string,
  ) {
    const filter: Record<string, unknown> = {};
    if (status === 'live') filter.status = { $in: LIVE_SUBSCRIPTION_STATUSES };
    else if (status) filter.status = status;
    if (customerId && Types.ObjectId.isValid(customerId)) {
      filter.customerId = new Types.ObjectId(customerId);
    }
    return this.subscriptions
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(pageSize(limit))
      .lean()
      .exec();
  }

  @Get('subscriptions/:id')
  async getSubscription(@Param('id') id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException({ error: 'No such subscription' });
    const subscription = await this.subscriptions.findById(id).lean().exec();
    if (!subscription) throw new NotFoundException({ error: 'No such subscription' });
    const [invoices, payments] = await Promise.all([
      this.invoices.find({ subscriptionId: subscription._id }).sort({ periodStart: -1 }).lean().exec(),
      this.payments.find({ subscriptionId: subscription._id }).sort({ receivedAt: -1 }).lean().exec(),
    ]);
    return { subscription, invoices, payments };
  }

  @Get('payments')
  async listPayments(
    @Query('customerId') customerId?: string,
    @Query('unapplied') unapplied?: string,
    @Query('limit') limit?: string,
  ) {
    const filter: Record<string, unknown> = {};
    if (customerId && Types.ObjectId.isValid(customerId)) {
      filter.customerId = new Types.ObjectId(customerId);
    }
    // The operational view that matters: money taken and not yet honoured.
    if (unapplied === 'true') filter.appliedAt = { $exists: false };
    return this.payments.find(filter).sort({ receivedAt: -1 }).limit(pageSize(limit)).lean().exec();
  }

  @Get('invoices')
  async listInvoices(
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('limit') limit?: string,
  ) {
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (customerId && Types.ObjectId.isValid(customerId)) {
      filter.customerId = new Types.ObjectId(customerId);
    }
    // `returnToken` is `select: false` and is deliberately NOT asked for: it is
    // a capability, and an admin list is not a place to hand one out.
    return this.invoices.find(filter).sort({ createdAt: -1 }).limit(pageSize(limit)).lean().exec();
  }

  /**
   * MRR / ARR, new vs churned, and the split by plan.
   *
   * MRR IS BUILT FROM LIVE SUBSCRIPTIONS' OWN `unitAmountMinor`, not from the
   * plans' current prices. A subscription's amount is LOCKED at subscribe time
   * precisely so an admin repricing a plan does not reprice existing
   * subscribers — so computing revenue from the price list would report what we
   * WOULD charge rather than what we DO, and would move every time somebody
   * edited the pricing page.
   *
   * Annual subscriptions are divided down to a monthly figure. That is what
   * makes MRR comparable across cadences and is the standard definition; ARR is
   * then 12× it and is not a separate measurement.
   *
   * `past_due` COUNTS toward MRR. The customer still has access and still owes
   * the money; excluding them would make a dunning problem look like churn and
   * then look like a recovery when they pay.
   */
  @Get('revenue')
  async revenue() {
    const live = await this.subscriptions
      .find({ status: { $in: ['active', 'past_due', 'trialing'] } })
      .select('planKey interval unitAmountMinor status createdAt')
      .lean()
      .exec();

    const byPlan = new Map<string, { subscriptions: number; mrrMinor: number }>();
    let mrrMinor = 0;
    for (const subscription of live) {
      const monthly = Math.round(
        subscription.interval === 'year' ? subscription.unitAmountMinor / 12 : subscription.unitAmountMinor,
      );
      mrrMinor += monthly;
      const row = byPlan.get(subscription.planKey) ?? { subscriptions: 0, mrrMinor: 0 };
      row.subscriptions += 1;
      row.mrrMinor += monthly;
      byPlan.set(subscription.planKey, row);
    }

    // A rolling 30-day window rather than a calendar month: the calendar
    // version reads as a collapse on the 1st of every month and nobody can tell
    // it apart from a real one.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [newCount, churnedCount, collected] = await Promise.all([
      this.subscriptions.countDocuments({ startedAt: { $gte: since } }).exec(),
      this.subscriptions
        .countDocuments({ status: { $in: ['canceled', 'unpaid'] }, endedAt: { $gte: since } })
        .exec(),
      this.payments
        .aggregate<{ total: number }>([
          { $match: { status: 'succeeded', appliedAt: { $exists: true }, receivedAt: { $gte: since } } },
          { $group: { _id: null, total: { $sum: '$amountMinor' } } },
        ])
        .exec(),
    ]);

    return {
      mrrMinor,
      arrMinor: mrrMinor * 12,
      liveSubscriptions: live.length,
      last30Days: {
        newSubscriptions: newCount,
        churnedSubscriptions: churnedCount,
        collectedMinor: Math.round(collected[0]?.total ?? 0),
      },
      byPlan: [...byPlan.entries()]
        .map(([planKey, row]) => ({
          planKey,
          planName: this.settings.getPlan(planKey)?.name ?? planKey,
          ...row,
        }))
        .sort((a, b) => b.mrrMinor - a.mrrMinor),
      // Diagnostics an operator needs beside the numbers: an unapplied payment
      // is revenue collected that nobody has been given anything for.
      unappliedPayments: await this.payments.countDocuments({ appliedAt: { $exists: false } }).exec(),
      rails: this.registry.list(),
    };
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  /**
   * Record money that arrived off-rail, or reconcile a sandbox payment by hand.
   *
   * Routed through `PaymentApplyService` on the `manual` rail, so it settles the
   * invoice, advances the period, grants the plan, credits an overpayment and
   * sends the receipt through exactly the code a webhook uses.
   */
  @Post('payments/mark-paid')
  async markPaid(@Req() req: AdminRequest, @Body() body: MarkPaidDto) {
    const amountMinor = Number(body.amountMinor);
    // Parsed from a STRING and validated here rather than typed as a number on
    // the DTO: `enableImplicitConversion` would turn "abc" into NaN and hand it
    // straight to the fold, and the global pipe is inert under `tsx` dev anyway.
    if (!Number.isInteger(amountMinor) || amountMinor < 0) {
      throw new BadRequestException({
        error: 'amountMinor must be a non-negative whole number of minor units (cents).',
      });
    }
    if (!Types.ObjectId.isValid(body.invoiceId)) {
      throw new NotFoundException({ error: 'No such invoice' });
    }
    const invoice = await this.invoices.findById(body.invoiceId).lean().exec();
    if (!invoice) throw new NotFoundException({ error: 'No such invoice' });

    const reconciledBy = adminIdentity(req);
    const outcome = await this.applyService.apply({
      provider: MANUAL_PROVIDER_KEY,
      invoiceId: String(invoice._id),
      reconciledBy,
      note: body.note,
      payment: {
        // DETERMINISTIC, so a double-submitted form collides on the unique
        // index instead of crediting the invoice twice — while a genuine second
        // part-payment under a different reference still records.
        providerPaymentId: manualPaymentId(String(invoice._id), body.reference),
        status: 'succeeded',
        amountMinor,
        currency: invoice.currency,
        reference: String(invoice._id),
        receivedAt: new Date(),
      },
    });
    this.logger.warn(
      `[audit] payments.mark_paid by=${reconciledBy} invoice=${String(invoice._id)} ` +
        `amount=${amountMinor} outcome=${outcome.reason} note=${JSON.stringify(body.note)}`,
    );
    return outcome;
  }

  /**
   * Force a subscription's status.
   *
   * THE ESCAPE HATCH, and it says so. It writes `Subscription.status` and
   * NOTHING else — no plan grant, no period advance, no invoice change. Moving
   * a subscription to `active` here does not give the customer the plan,
   * because entitlement comes from a paid invoice and this is not one. Use
   * `mark-paid` for that. Making this route grant a plan would be a second
   * entitlement path with no money behind it, which is the one thing the whole
   * design is arranged to prevent.
   *
   * `Customer.status` is untouchable from here for the same reason it is
   * untouchable from the sweep: it is a hard kill switch, not a billing state.
   */
  @Post('subscriptions/:id/mark-status')
  async markStatus(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: MarkSubscriptionStatusDto,
  ) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException({ error: 'No such subscription' });
    const updated = await this.subscriptions
      .findByIdAndUpdate(
        id,
        {
          $set: {
            status: body.status,
            ...(body.status === 'canceled' || body.status === 'unpaid' ? { endedAt: new Date() } : {}),
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!updated) throw new NotFoundException({ error: 'No such subscription' });

    this.logger.warn(
      `[audit] payments.mark_status by=${adminIdentity(req)} subscription=${id} ` +
        `status=${body.status} note=${JSON.stringify(body.note)}`,
    );
    return updated;
  }

  /**
   * Re-ask the rail about every payment we have not finished applying, right
   * now, instead of waiting for the cron.
   *
   * Safe to press repeatedly and needs no `confirm`: it grants nothing that a
   * scheduled run would not grant a quarter of an hour later, and the reason
   * somebody presses it is that a customer is on the phone.
   */
  @Post('payments/resync')
  async resync() {
    return this.reconcile.reconcile();
  }

  /** Run the lifecycle sweep now. Coalesces with an in-flight one. */
  @Post('subscriptions/sweep')
  async runSweep(@Query('async') async_?: string) {
    if (async_ === 'true') return { jobId: await this.queue.enqueueSweep() };
    return this.sweep.sweep();
  }

  @Get('payments/queue')
  async queueStatus() {
    return this.queue.status();
  }
}

/**
 * Who did it, from the TOKEN. Never from the body — a self-declared identity is
 * not an audit trail, it is a text field.
 */
function adminIdentity(req: AdminRequest): string {
  return req.adminUser?.email ?? req.adminUser?.sub ?? 'unknown-admin';
}

function pageSize(limit?: string): number {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(MAX_PAGE, Math.floor(parsed));
}
