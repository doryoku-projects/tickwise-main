import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PaymentApplyService } from './payment-apply.service.js';
import { PaymentProviderRegistry } from './provider-registry.js';
import { Invoice } from './schemas/invoice.schema.js';
import { Payment } from './schemas/payment.schema.js';
import { WebhookEvent } from './schemas/webhook-event.schema.js';

export interface ReconcileReport {
  /** Payments taken but never honoured, now applied. */
  applied: number;
  /** Still pending on the rail's side — checked again next tick. */
  stillPending: number;
  /** Webhook events that failed and were retried. */
  eventsRetried: number;
  errors: number;
}

/** Bounded so a tick always terminates, however big the backlog. */
const RECONCILE_BATCH = 100;

/**
 * How long a webhook event may sit unprocessed before it is called stuck.
 * Comfortably longer than any handler run, short enough that a human hears
 * about it the same day.
 */
const STUCK_EVENT_MS = 30 * 60_000;

/**
 * THE LOST-WEBHOOK BACKSTOP.
 *
 * A webhook is a network delivery, so it can simply not arrive: the rail times
 * out, a deploy drops the connection mid-handler, a proxy 502s, the process
 * dies between claiming a payment and applying it. Every one of those leaves
 * the same footprint — a customer who has paid and does not have their plan —
 * and NOTHING notices, because there is no error anywhere. The rail believes it
 * delivered; we believe nothing happened.
 *
 * So this job asks the question from our side instead of waiting to be told:
 *
 *  1. **Unhonoured payments.** A `payments` row that is `succeeded` with no
 *     `appliedAt` is money taken and not acted on. Re-run the apply — which is
 *     safe, because the invoice total is recomputed rather than incremented.
 *  2. **Pending payments.** A row still `pending` gets RE-FETCHED from the
 *     rail. This is the one that catches a crypto transfer that confirmed after
 *     the webhook we saw, and the rail's answer is authoritative.
 *  3. **Stuck events.** A `webhook_events` row left in `received` for half an
 *     hour means a handler started and never finished. Surfaced loudly; the
 *     underlying payment is picked up by (1) or (2) regardless, so this is an
 *     alert rather than a repair.
 *
 * All three are idempotent, so running this beside a webhook that is arriving
 * at the same moment is harmless: whichever claims the payment row first wins
 * and the other gets `duplicate`.
 */
@Injectable()
export class PaymentReconcileService {
  private readonly logger = new Logger(PaymentReconcileService.name);

  constructor(
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @InjectModel(Invoice.name) private readonly invoices: Model<Invoice>,
    @InjectModel(WebhookEvent.name) private readonly events: Model<WebhookEvent>,
    @Inject(PaymentApplyService) private readonly applyService: PaymentApplyService,
    @Inject(PaymentProviderRegistry) private readonly registry: PaymentProviderRegistry,
  ) {}

  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { applied: 0, stillPending: 0, eventsRetried: 0, errors: 0 };

    // The partial index on `{status, receivedAt}` filtered to `appliedAt`
    // absent is what makes this a key range scan rather than a walk of every
    // payment ever taken.
    const outstanding = await this.payments
      .find({ appliedAt: { $exists: false }, status: { $in: ['succeeded', 'pending'] } })
      .sort({ receivedAt: 1 })
      .limit(RECONCILE_BATCH)
      .lean()
      .exec();

    for (const row of outstanding) {
      try {
        const provider = this.registry.find(row.provider);
        if (!provider) {
          // A rail that has been switched off since the payment arrived. Not an
          // error we can fix here, and not one to retry silently forever.
          this.logger.warn(
            `[alert] payments.reconcile_no_rail provider=${row.provider} payment=${row.providerPaymentId}`,
          );
          report.errors += 1;
          continue;
        }

        // RE-FETCH. Even for a row we already believe succeeded: the stored row
        // came from a previous re-fetch, and the rail is the authority. This is
        // also what upgrades a `pending` row that has since confirmed.
        const fresh = await provider.getPayment(row.providerPaymentId);
        if (!fresh) {
          // `getPayment` returns null only for "the rail does not know this id"
          // — a transport failure THROWS. So this is a forged or synthetic id
          // that never existed on the rail.
          if (row.provider !== 'manual') {
            this.logger.warn(
              `[alert] payments.reconcile_unknown_to_rail provider=${row.provider} payment=${row.providerPaymentId}`,
            );
          }
          continue;
        }

        if (fresh.status !== 'succeeded') {
          report.stillPending += 1;
          // Keep the local row's status honest so the admin view is not
          // reporting a pending payment the rail has already failed.
          if (fresh.status !== row.status) {
            await this.payments.updateOne({ _id: row._id }, { $set: { status: fresh.status } }).exec();
          }
          continue;
        }

        const outcome = await this.applyService.apply({
          provider: row.provider,
          invoiceId: String(row.invoiceId),
          payment: fresh,
        });
        if (outcome.applied) {
          report.applied += 1;
          this.logger.warn(
            `[alert] payments.recovered_by_reconcile provider=${row.provider} payment=${row.providerPaymentId} ` +
              `invoice=${String(row.invoiceId)} — the webhook for this never landed`,
          );
        }
      } catch (err) {
        report.errors += 1;
        this.logger.error(
          `Reconcile failed for payment ${row.providerPaymentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    report.eventsRetried = await this.flagStuckEvents();
    await this.repairInvoiceTotals(report);

    if (report.applied > 0 || report.errors > 0) {
      this.logger.log(`Payment reconcile: ${JSON.stringify(report)}`);
    }
    return report;
  }

  /**
   * Surface webhook events that were received and never finished.
   *
   * Deliberately does NOT re-run the handler. The payment behind a stuck event
   * is already covered by the payment passes above, which go to the rail for
   * the truth; re-running a handler over a half-written body would be guessing
   * with the one input we have decided not to trust. This marks them `failed`
   * so they stop looking live, and shouts.
   */
  private async flagStuckEvents(): Promise<number> {
    const cutoff = new Date(Date.now() - STUCK_EVENT_MS);
    const stuck = await this.events
      .find({ status: 'received', receivedAt: { $lte: cutoff } })
      .limit(RECONCILE_BATCH)
      .lean()
      .exec();
    if (stuck.length === 0) return 0;

    await this.events
      .updateMany(
        { _id: { $in: stuck.map((e) => e._id) }, status: 'received' },
        { $set: { status: 'failed', lastError: 'Handler never completed — flagged by payment-reconcile' } },
      )
      .exec();
    this.logger.error(
      `[alert] payments.stuck_webhook_events count=${stuck.length} ` +
        `ids=${stuck.slice(0, 5).map((e) => e.providerEventId).join(',')}`,
    );
    return stuck.length;
  }

  /**
   * Repair an invoice whose stored `amountPaidMinor` disagrees with the sum of
   * its applied payments.
   *
   * This is the other half of "the total is recomputed, not incremented": the
   * apply path can die AFTER stamping `appliedAt` and BEFORE writing the
   * invoice, which leaves a payment that looks handled and an invoice that has
   * not moved. Nothing else would ever find it — the payment is out of the
   * reconcile queue by then.
   *
   * Only invoices that are still OPEN are checked. A settled one is finished
   * business, and recomputing history is not this job's remit.
   */
  private async repairInvoiceTotals(report: ReconcileReport): Promise<void> {
    const open = await this.invoices
      .find({ status: 'open' })
      .sort({ periodStart: 1 })
      .limit(RECONCILE_BATCH)
      .lean()
      .exec();

    for (const invoice of open) {
      try {
        const rows = await this.payments
          .aggregate<{ total: number }>([
            {
              $match: {
                invoiceId: invoice._id as Types.ObjectId,
                status: 'succeeded',
                appliedAt: { $exists: true },
              },
            },
            { $group: { _id: null, total: { $sum: '$amountMinor' } } },
          ])
          .exec();
        const actual = Math.max(0, Math.round(rows[0]?.total ?? 0));
        if (actual === invoice.amountPaidMinor) continue;

        this.logger.warn(
          `[alert] payments.invoice_total_drift invoice=${String(invoice._id)} ` +
            `stored=${invoice.amountPaidMinor} actual=${actual} — re-applying`,
        );
        // Re-run the newest applied payment through the apply path rather than
        // patching the number: the total is only half of what a settlement
        // does, and an invoice silently corrected to "paid" without the
        // subscription advancing is a worse state than the drift.
        const latest = await this.payments
          .findOne({ invoiceId: invoice._id, status: 'succeeded', appliedAt: { $exists: true } })
          .sort({ receivedAt: -1 })
          .lean()
          .exec();
        if (!latest) continue;

        await this.payments.updateOne({ _id: latest._id }, { $unset: { appliedAt: '' } }).exec();
        const provider = this.registry.find(latest.provider);
        const fresh = provider ? await provider.getPayment(latest.providerPaymentId) : null;
        const outcome = await this.applyService.apply({
          provider: latest.provider,
          invoiceId: String(invoice._id),
          // MERGED, not "fresh or stored". A rail that cannot report the settled
          // amount omits `amountMinor` (see `ProviderPayment`), and an
          // `undefined` there must fall back to OUR record — the payment row we
          // already applied. A plain `fresh ?? {…}` only covers a NULL re-fetch,
          // so a rail returning an object with no amount (both self-custody
          // rails) re-applied the payment as zero and the recomputed invoice
          // total lost the real money.
          payment: {
            providerPaymentId: fresh?.providerPaymentId ?? latest.providerPaymentId,
            status: fresh?.status ?? 'succeeded',
            amountMinor: fresh?.amountMinor ?? latest.amountMinor,
            currency: fresh?.currency ?? latest.currency,
            reference: String(invoice._id),
            ...(fresh?.txHash ? { txHash: fresh.txHash } : {}),
            ...(fresh?.chainId !== undefined ? { chainId: fresh.chainId } : {}),
            ...(fresh?.asset ? { asset: fresh.asset } : {}),
          },
        });
        if (outcome.applied) report.applied += 1;
      } catch (err) {
        report.errors += 1;
        this.logger.error(
          `Invoice repair failed for ${String(invoice._id)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
