import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { SubscriptionsService } from '../src/payments/subscriptions.service.js';

/**
 * `SubscriptionsService.cancel` — the ONE method here worth pinning on its own,
 * because it is the only place a customer-driven action decides between "stop a
 * PAID plan at period end" and "abandon a never-paid checkout now", and the two
 * must not be confused: scheduling a cancel-at-period-end on an `incomplete`
 * subscription names an end date for a period nobody ever paid for, which the
 * portal renders verbatim beside a still-open PAY panel.
 *
 * `SubscriptionsService` has 8 injected dependencies but `cancel` touches only
 * the subscriptions / invoices / customers collections, so the rest are stubbed
 * away and a deliberately small in-memory Mongoose stand-in backs the three that
 * matter. It handles ObjectId equality and numeric `$lte` — both of which the
 * sweep spec's fake did not need and therefore does not do.
 */

const CUSTOMER = '507f1f77bcf86cd799439011';

const asId = (v: unknown): unknown =>
  v && typeof v === 'object' && typeof (v as { toHexString?: unknown }).toHexString === 'function'
    ? (v as { toHexString: () => string }).toHexString()
    : v;

function collection<T extends Record<string, unknown>>(rows: T[]) {
  const matches = (row: T, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, want]) => {
      const have = row[key];
      const isOp =
        want &&
        typeof want === 'object' &&
        !(want instanceof Date) &&
        typeof (want as { toHexString?: unknown }).toHexString !== 'function';
      if (isOp) {
        const op = want as Record<string, unknown>;
        if ('$in' in op) return (op.$in as unknown[]).map(asId).includes(asId(have));
        if ('$lte' in op) {
          const w = op.$lte as number | Date;
          return have instanceof Date && w instanceof Date
            ? have.getTime() <= w.getTime()
            : typeof have === 'number' && (have as number) <= (w as number);
        }
        if ('$ne' in op) return asId(have) !== asId(op.$ne);
        if ('$exists' in op) return (have !== undefined) === op.$exists;
        return false;
      }
      return asId(have) === asId(want);
    });

  const apply = (row: T, update: Record<string, unknown>) => {
    const set = update.$set as Record<string, unknown> | undefined;
    const unset = update.$unset as Record<string, unknown> | undefined;
    const inc = update.$inc as Record<string, number> | undefined;
    if (set) Object.assign(row, set);
    if (unset) for (const k of Object.keys(unset)) delete (row as Record<string, unknown>)[k];
    if (inc) for (const [k, v] of Object.entries(inc)) (row as Record<string, unknown>)[k] = (Number(row[k]) || 0) + v;
  };

  return {
    rows,
    find(filter: Record<string, unknown> = {}) {
      const found = rows.filter((r) => matches(r, filter));
      const chain = { limit: () => chain, sort: () => chain, lean: () => chain, exec: async () => found };
      return chain;
    },
    findOne(filter: Record<string, unknown> = {}) {
      const found = rows.find((r) => matches(r, filter)) ?? null;
      const chain = { sort: () => chain, lean: () => chain, exec: async () => found };
      return chain;
    },
    updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
      return {
        exec: async () => {
          const row = rows.find((r) => matches(r, filter));
          if (!row) return { matchedCount: 0, modifiedCount: 0 };
          apply(row, update);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
    },
  };
}

interface Sub extends Record<string, unknown> {
  _id: string;
  customerId: string;
  status: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

const PERIOD_END = new Date('2026-09-07T00:00:00.000Z');

/**
 * `inFlight` drives the rail's `hasPaymentInFlight`, AND IT IS MODE-AWARE,
 * because the two modes now produce opposite outcomes for the same call.
 *
 *  - `false`    nothing outstanding — the ordinary abandon.
 *  - `'issued'` a payload was handed to a wallet but no signature has been
 *               seen. The customer may still abandon; the INVOICE is spared so
 *               a late signature is not stranded.
 *  - `'signed'` the transfer is broadcast. The abandon is REFUSED outright —
 *               it cannot be recalled, and expiring the subscription would turn
 *               their payment into credit instead of the plan.
 */
type InFlight = false | 'issued' | 'signed';

function build(
  sub: Partial<Sub> & Pick<Sub, 'status'>,
  invoices: Array<Record<string, unknown>> = [],
  inFlight: InFlight = false,
) {
  const subs = collection<Sub>([
    {
      _id: 'sub1',
      customerId: CUSTOMER,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd ?? PERIOD_END,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
      ...sub,
    },
  ]);
  const invoiceRows = collection([...invoices]);
  const customers = collection<{ _id: string; creditBalanceMinor: number } & Record<string, unknown>>([
    { _id: CUSTOMER, creditBalanceMinor: 0 },
  ]);
  const service = new SubscriptionsService(
    subs as never,
    invoiceRows as never,
    {} as never, // counters — unused by cancel
    customers as never,
    {} as never, // plans
    // A registry with ONE rail that answers the in-flight question. `all()` is
    // what `voidUnfundedInvoices` reaches for; a bare `{}` here threw, which is
    // the loud failure the positional-construction note asks for.
    {
      all: () => [
        {
          key: 'x402',
          hasPaymentInFlight: async (_id: string, mode: 'any' | 'signed' = 'any') =>
            inFlight === 'signed' ? true : inFlight === 'issued' ? mode === 'any' : false,
        },
      ],
    } as never,
    {} as never, // applyService
    {} as never, // config
  );
  return { service, subs, invoiceRows, customers };
}

function openInvoice(extra: Record<string, unknown> = {}) {
  return {
    _id: 'inv1',
    subscriptionId: 'sub1',
    customerId: CUSTOMER,
    status: 'open',
    amountPaidMinor: 0,
    amountDueMinor: 1900,
    creditAppliedMinor: 0,
    number: 5,
    ...extra,
  };
}

describe('SubscriptionsService.cancel', () => {
  it('ABANDONS a never-paid (incomplete) checkout immediately and voids its open invoice', async () => {
    const { service, subs, invoiceRows } = build({ status: 'incomplete' }, [openInvoice()]);

    const result = await service.cancel(CUSTOMER, 'changed my mind');

    expect(result.immediate).toBe(true);
    // Moved out of the live set — findLive returns null next, so the portal
    // shows Free with no pending banner and no pay panel.
    expect(subs.rows[0].status).toBe('incomplete_expired');
    expect(subs.rows[0].endedAt).toBeInstanceOf(Date);
    expect(subs.rows[0].canceledAt).toBeInstanceOf(Date);
    // The open invoice (and its deposit address / pay panel) is gone.
    expect(invoiceRows.rows[0].status).toBe('void');
    // NOT flagged cancel-at-period-end — that would keep it live and pending.
    expect(subs.rows[0].cancelAtPeriodEnd).toBe(false);
  });

  it('does NOT void an invoice a payment is in flight against — the money would be stranded', async () => {
    // The scenario this guard exists for: the customer holds a signed
    // authorization for this invoice. Voiding it means their transfer lands on
    // something that can no longer take it, and the rail cannot refund.
    const { service, subs, invoiceRows, customers } = build(
      { status: 'incomplete' },
      [openInvoice({ creditAppliedMinor: 500 })],
      'issued',
    );

    const result = await service.cancel(CUSTOMER);

    // The subscription is still abandoned — that part is the customer's choice
    // and costs nothing. Only the INVOICE is spared, so the money has a target.
    expect(result.immediate).toBe(true);
    expect(subs.rows[0].status).toBe('incomplete_expired');
    expect(invoiceRows.rows[0].status).toBe('open');
    // And the credit is NOT returned, because the invoice still holds it. A
    // refund here plus a later settlement would credit the same money twice.
    expect(customers.rows[0].creditBalanceMinor).toBe(0);
  });

  it('treats a rail that throws as in flight — fail closed, the abandon is refused', async () => {
    // Fail-closed now REFUSES the cancel rather than sparing the invoice, and
    // that follows the same "which failure is recoverable" test: a customer
    // told to try again in a few minutes loses nothing, whereas abandoning on a
    // rail that could not answer risks turning their broadcast payment into
    // credit. The authorization's own expiry unblocks it either way.
    const { service, invoiceRows, subs } = build({ status: 'incomplete' }, [openInvoice()]);
    // Swap the rail for one that cannot answer. A stale open invoice is
    // recoverable; money on a void invoice is not.
    (service as unknown as { registry: { all: () => unknown[] } }).registry = {
      all: () => [
        {
          key: 'x402',
          hasPaymentInFlight: async () => {
            throw new Error('mongo unreachable');
          },
        },
      ],
    };

    await expect(service.cancel(CUSTOMER)).rejects.toMatchObject({ status: 409 });

    expect(subs.rows[0].status).toBe('incomplete');
    expect(invoiceRows.rows[0].status).toBe('open');
  });

  it('returns ONLY balance-sourced credit — a proration must never become spendable balance', async () => {
    /*
     * THE MONEY-PRINTING BUG. An upgrade invoice's discount is a PRORATION (the
     * unused value of the plan being left, which was never in the balance) plus
     * any BALANCE SPEND. Voiding refunded `creditAppliedMinor` — the total — so
     * cancelling an upgrade minted the proration as real, spendable credit, and
     * it compounded: the next upgrade prorated again AND spent the phantom
     * balance. Observed live going $0.99 → $1.98 with nothing ever paid.
     */
    const { service, invoiceRows, customers } = build({ status: 'incomplete' }, [
      openInvoice({
        // $2 Pro, discounted by $1.98: $0.99 proration + $0.99 taken from the
        // balance. Only the second half is the customer's to get back.
        subtotalMinor: 200,
        creditAppliedMinor: 198,
        creditFromBalanceMinor: 99,
        amountDueMinor: 2,
      }),
    ]);

    await service.cancel(CUSTOMER);

    expect(invoiceRows.rows[0].status).toBe('void');
    // 99, NOT 198. The proration stays where it belongs: the customer keeps the
    // plan period it was crediting them for.
    expect(customers.rows[0].creditBalanceMinor).toBe(99);
  });

  it('returns nothing for an invoice whose discount was pure proration', async () => {
    // The first cycle of the same bug: no balance existed yet, so the whole
    // discount was proration and the refund must be zero.
    const { service, customers } = build({ status: 'incomplete' }, [
      openInvoice({ subtotalMinor: 200, creditAppliedMinor: 99, creditFromBalanceMinor: 0, amountDueMinor: 101 }),
    ]);

    await service.cancel(CUSTOMER);

    expect(customers.rows[0].creditBalanceMinor).toBe(0);
  });

  it('REFUSES to abandon an unpaid checkout once the transfer is signed', async () => {
    /*
     * Abandoning here is not a no-op, it is a downgrade of the customer's own
     * payment: the transfer cannot be recalled, so it lands on a subscription
     * that is by then `incomplete_expired`, the fold refuses
     * `subscription-not-live`, and they end up on Free holding the money as
     * credit instead of on the plan they just paid for.
     */
    const { service, subs, invoiceRows } = build({ status: 'incomplete' }, [openInvoice()], 'signed');

    await expect(service.cancel(CUSTOMER)).rejects.toMatchObject({ status: 409 });

    // Nothing moved — the subscription is still live and the invoice payable,
    // so the payment settles into the plan it was for.
    expect(subs.rows[0].status).toBe('incomplete');
    expect(invoiceRows.rows[0].status).toBe('open');
  });

  it('SCHEDULES a paid (active) subscription to end at period end, leaving its invoice alone', async () => {
    const { service, subs, invoiceRows } = build({ status: 'active' }, [openInvoice()]);

    const result = await service.cancel(CUSTOMER);

    expect(result.immediate).toBe(false);
    expect(result.endsAt.getTime()).toBe(PERIOD_END.getTime());
    expect(subs.rows[0].status).toBe('active');
    expect(subs.rows[0].cancelAtPeriodEnd).toBe(true);
    // A paid invoice is never touched by a cancellation.
    expect(invoiceRows.rows[0].status).toBe('open');
  });

  it('SCHEDULES a past_due subscription too — only `incomplete` is abandoned', async () => {
    const { service, subs } = build({ status: 'past_due' });

    const result = await service.cancel(CUSTOMER);

    expect(result.immediate).toBe(false);
    expect(subs.rows[0].status).toBe('past_due');
    expect(subs.rows[0].cancelAtPeriodEnd).toBe(true);
  });

  it('404s when there is no live subscription', async () => {
    const { service } = build({ status: 'canceled' }); // terminal → not live
    // `NotFoundException({error})` leaves `.message` generic, so assert on the
    // response body — see the repo's `getResponse()` note.
    await expect(service.cancel(CUSTOMER)).rejects.toMatchObject({
      response: { error: expect.stringMatching(/active subscription/i) },
    });
  });
});
