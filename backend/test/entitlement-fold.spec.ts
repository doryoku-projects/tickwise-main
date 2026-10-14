import { describe, expect, it } from 'vitest';
import {
  addDays,
  addInterval,
  daysBetween,
  foldPayment,
  prorationCreditMinor,
  UNDERPAY_TOLERANCE_MINOR,
  type FoldInput,
} from '../src/payments/entitlement-fold.js';

/**
 * The entitlement fold is the one piece of this subsystem where a mistake is
 * money, so it is pure and every branch below is reachable from a literal.
 *
 * Every assertion here was MUTATION-TESTED: the source was deliberately
 * regressed, the test was confirmed failing, and the source restored
 * byte-identically. The mutation is named in each block that carries a security
 * or money property, because "it passes" is not evidence that it tests
 * anything — this repo has already shipped a test that passed while testing
 * nothing.
 */

const PERIOD_START = new Date('2026-08-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-09-01T00:00:00.000Z');

function input(overrides: {
  invoice?: Partial<FoldInput['invoice']>;
  subscription?: Partial<FoldInput['subscription']>;
  payment?: Partial<FoldInput['payment']>;
} = {}): FoldInput {
  return {
    invoice: {
      subtotalMinor: 9900,
      amountDueMinor: 9900,
      amountPaidMinor: 0,
      currency: 'USD',
      status: 'open',
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      planKey: 'standard',
      priceId: 'standard_monthly',
      interval: 'month',
      ...overrides.invoice,
    },
    subscription: {
      status: 'incomplete',
      // Before the invoice's period end, so a settlement advances.
      currentPeriodEnd: PERIOD_START,
      cancelAtPeriodEnd: false,
      ...overrides.subscription,
    },
    payment: { amountMinor: 9900, currency: 'USD', ...overrides.payment },
  };
}

describe('foldPayment — settlement', () => {
  it('settles an exact payment and advances the period', () => {
    const decision = foldPayment(input());
    expect(decision.settled).toBe(true);
    expect(decision.invoiceStatus).toBe('paid');
    expect(decision.invoicePaidMinor).toBe(9900);
    expect(decision.shortfallMinor).toBe(0);
    expect(decision.creditMinor).toBe(0);
    expect(decision.subscriptionStatus).toBe('active');
    expect(decision.advanceTo).toEqual({ periodStart: PERIOD_START, periodEnd: PERIOD_END });
  });

  it('grants the plan the INVOICE names, not the one the subscription holds', () => {
    // MUTATION: return the subscription's plan instead of the invoice's → this
    // fails. This is the property that makes an upgrade land at the moment the
    // money does: the subscription is still on `standard` here.
    const decision = foldPayment(
      input({ invoice: { planKey: 'pro', priceId: 'pro_monthly', subtotalMinor: 79000, amountDueMinor: 79000 },
              payment: { amountMinor: 79000 } }),
    );
    expect(decision.grant?.planKey).toBe('pro');
    expect(decision.grant?.priceId).toBe('pro_monthly');
  });

  it('recurs at the LIST price, never at the prorated amount actually charged', () => {
    // MUTATION: use `amountDueMinor` for `grant.unitAmountMinor` → this fails.
    // An upgrade discounted to $4 by proration must not reprice the plan to $4
    // for every future renewal.
    const decision = foldPayment(
      input({ invoice: { subtotalMinor: 79000, amountDueMinor: 400 }, payment: { amountMinor: 400 } }),
    );
    expect(decision.settled).toBe(true);
    expect(decision.grant?.unitAmountMinor).toBe(79000);
  });

  it('activates a subscription that is set to cancel at period end', () => {
    // They paid for this period, so they get this period. The cancellation
    // applies at its end, which is what `cancelAtPeriodEnd` means.
    const decision = foldPayment(input({ subscription: { cancelAtPeriodEnd: true } }));
    expect(decision.subscriptionStatus).toBe('active');
    expect(decision.advanceTo).toBeDefined();
  });
});

describe('foldPayment — the $1 underpay tolerance', () => {
  it('settles a payment short by exactly the tolerance', () => {
    const decision = foldPayment(
      input({ payment: { amountMinor: 9900 - UNDERPAY_TOLERANCE_MINOR } }),
    );
    expect(decision.settled).toBe(true);
    // Reported even though it was forgiven — the tolerance excused it, it did
    // not arrive, and the admin view has to be able to say so.
    expect(decision.shortfallMinor).toBe(UNDERPAY_TOLERANCE_MINOR);
  });

  it('does NOT settle a payment one cent beyond the tolerance', () => {
    // MUTATION: change `<=` to `<` in the tolerance comparison, or widen the
    // constant → one of these two cases fails. The boundary is the test.
    const decision = foldPayment(
      input({ payment: { amountMinor: 9900 - UNDERPAY_TOLERANCE_MINOR - 1 } }),
    );
    expect(decision.settled).toBe(false);
    expect(decision.refusal).toBe('short-paid');
    expect(decision.invoiceStatus).toBe('open');
    expect(decision.shortfallMinor).toBe(UNDERPAY_TOLERANCE_MINOR + 1);
  });

  it('accumulates part payments and settles on the top-up', () => {
    const first = foldPayment(input({ payment: { amountMinor: 5000 } }));
    expect(first.settled).toBe(false);
    expect(first.invoicePaidMinor).toBe(5000);

    const second = foldPayment(
      input({ invoice: { amountPaidMinor: first.invoicePaidMinor }, payment: { amountMinor: 4900 } }),
    );
    expect(second.settled).toBe(true);
    expect(second.invoicePaidMinor).toBe(9900);
  });

  it('is OVERRIDABLE, so a small-value live test can mean something', () => {
    // THE $1-PLAN TRAP. At the default 100, a $1.00 invoice is settled by a
    // payment of one cent — or of nothing — because the tolerance IS the price.
    // A live test at that amount goes green while proving nothing about
    // amounts, which is worse than no test.
    const dollarPlan = { invoice: { subtotalMinor: 100, amountDueMinor: 100 } };
    expect(foldPayment(input({ ...dollarPlan, payment: { amountMinor: 1 } })).settled).toBe(true);
    expect(foldPayment(input({ ...dollarPlan, payment: { amountMinor: 0 } })).settled).toBe(true);

    // Tightened for the test run, the same payments are correctly refused…
    const tight = (amountMinor: number) =>
      foldPayment({ ...input({ ...dollarPlan, payment: { amountMinor } }), toleranceMinor: 5 });
    expect(tight(1).settled).toBe(false);
    expect(tight(0).settled).toBe(false);
    // …and a genuine near-exact payment still settles.
    expect(tight(96).settled).toBe(true);
    expect(tight(95).settled).toBe(true);
    expect(tight(94).settled).toBe(false);
  });

  it('clamps a negative tolerance to exact-payment rather than inverting it', () => {
    // A malformed value must TIGHTEN the rule. The failure direction that
    // matters is "granted a plan for less money than it costs".
    const exact = (amountMinor: number) =>
      foldPayment({ ...input({ payment: { amountMinor } }), toleranceMinor: -500 });
    expect(exact(9900).settled).toBe(true);
    expect(exact(9899).settled).toBe(false);
  });

  it('applies the tolerance to the TOTAL, not to each payment', () => {
    // Two payments each 60c short would each be "within tolerance" if the rule
    // were per-payment; together they are 120c short, which is not.
    const decision = foldPayment(
      input({ invoice: { amountPaidMinor: 9840 }, payment: { amountMinor: 0 } }),
    );
    expect(decision.settled).toBe(true); // 60 short — inside
    const worse = foldPayment(
      input({ invoice: { amountPaidMinor: 9700 }, payment: { amountMinor: 79 } }),
    );
    expect(worse.settled).toBe(false); // 121 short — outside
  });
});

describe('foldPayment — overpayment', () => {
  it('credits the excess once, computed against the total', () => {
    const decision = foldPayment(input({ payment: { amountMinor: 12000 } }));
    expect(decision.settled).toBe(true);
    expect(decision.creditMinor).toBe(2100);
  });

  it('does not credit the same excess twice across two payments', () => {
    // MUTATION: compute the credit from `payment.amountMinor` rather than the
    // total → this fails. Two payments of 6000 against a 9900 invoice credit
    // 2100 once, not 2100 twice.
    const first = foldPayment(input({ payment: { amountMinor: 6000 } }));
    expect(first.creditMinor).toBe(0);
    const second = foldPayment(
      input({ invoice: { amountPaidMinor: 6000 }, payment: { amountMinor: 6000 } }),
    );
    expect(second.creditMinor).toBe(2100);
  });
});

describe('foldPayment — refusals (all of which are 200s, never 500s)', () => {
  it('refuses a currency mismatch and leaves the invoice untouched', () => {
    // MUTATION: drop the currency comparison → this fails, and 50 EUR would be
    // added to a USD invoice at 1:1.
    const decision = foldPayment(
      input({ invoice: { amountPaidMinor: 1000 }, payment: { currency: 'EUR' } }),
    );
    expect(decision.settled).toBe(false);
    expect(decision.refusal).toBe('currency-mismatch');
    expect(decision.invoicePaidMinor).toBe(1000); // unchanged
    expect(decision.invoiceStatus).toBe('open'); // unchanged
  });

  it('compares currency case-insensitively', () => {
    expect(foldPayment(input({ payment: { currency: 'usd' } })).settled).toBe(true);
  });

  it('refuses a payment against an already-paid invoice', () => {
    const decision = foldPayment(input({ invoice: { status: 'paid', amountPaidMinor: 9900 } }));
    expect(decision.settled).toBe(false);
    expect(decision.refusal).toBe('invoice-not-payable');
  });

  it('refuses a payment against a voided invoice', () => {
    expect(foldPayment(input({ invoice: { status: 'void' } })).refusal).toBe('invoice-not-payable');
  });

  it('refuses a payment against a DRAFT invoice — nothing has asked for it', () => {
    expect(foldPayment(input({ invoice: { status: 'draft' } })).refusal).toBe('invoice-not-payable');
  });

  it('ACCEPTS a payment against an uncollectible invoice', () => {
    // MUTATION: drop `uncollectible` from `isPayable` → this fails. It is the
    // post-grace write-off, and somebody paying it is a customer coming back.
    const decision = foldPayment(input({ invoice: { status: 'uncollectible' } }));
    expect(decision.settled).toBe(true);
    expect(decision.invoiceStatus).toBe('paid');
  });
});

describe('foldPayment — the period never moves backwards', () => {
  it('does not shorten a subscription when a superseded invoice is paid late', () => {
    // MUTATION: emit `advanceTo` unconditionally → this fails. A late payment
    // on an old invoice settles the invoice; it must not drag a subscription
    // that has already rolled forward back to an earlier period end.
    const decision = foldPayment(
      input({ subscription: { status: 'active', currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z') } }),
    );
    expect(decision.settled).toBe(true);
    expect(decision.advanceTo).toBeUndefined();
  });

  it('still grants the plan on such a payment', () => {
    const decision = foldPayment(
      input({ subscription: { status: 'active', currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z') } }),
    );
    expect(decision.grant?.planKey).toBe('standard');
  });
});

describe('foldPayment — hostile inputs from a rail', () => {
  it('treats a NaN amount as zero rather than propagating it', () => {
    const decision = foldPayment(input({ payment: { amountMinor: Number.NaN } }));
    expect(decision.settled).toBe(false);
    expect(Number.isFinite(decision.invoicePaidMinor)).toBe(true);
    expect(decision.invoicePaidMinor).toBe(0);
  });

  it('floors a negative amount — this subsystem has no refund path', () => {
    // MUTATION: drop the `Math.max(0, …)` on `received` → this fails, and a
    // rail reporting -5000 would REDUCE what a customer has paid.
    const decision = foldPayment(
      input({ invoice: { amountPaidMinor: 9900 }, payment: { amountMinor: -5000 } }),
    );
    expect(decision.invoicePaidMinor).toBe(9900);
  });

  it('rounds a fractional amount rather than storing a float', () => {
    const decision = foldPayment(input({ payment: { amountMinor: 9899.7 } }));
    expect(Number.isInteger(decision.invoicePaidMinor)).toBe(true);
    expect(decision.invoicePaidMinor).toBe(9900);
  });
});

describe('addInterval — the day-of-month clamp', () => {
  it('clamps 31 January to the end of February instead of overflowing into March', () => {
    // MUTATION: use a bare `setUTCMonth(+1)` → this fails with 2 or 3 March.
    // JavaScript OVERFLOWS rather than clamping, so a subscription started on
    // the 31st would skip February entirely and bill a period nobody had.
    expect(addInterval(new Date('2026-01-31T12:00:00.000Z'), 'month')).toEqual(
      new Date('2026-02-28T12:00:00.000Z'),
    );
  });

  it('clamps into a leap February', () => {
    expect(addInterval(new Date('2028-01-31T00:00:00.000Z'), 'month')).toEqual(
      new Date('2028-02-29T00:00:00.000Z'),
    );
  });

  it('rolls December into January of the next year', () => {
    expect(addInterval(new Date('2026-12-15T00:00:00.000Z'), 'month')).toEqual(
      new Date('2027-01-15T00:00:00.000Z'),
    );
  });

  it('handles a year interval, including 29 February', () => {
    expect(addInterval(new Date('2028-02-29T00:00:00.000Z'), 'year')).toEqual(
      new Date('2029-02-28T00:00:00.000Z'),
    );
  });

  it('preserves the time of day', () => {
    expect(addInterval(new Date('2026-03-10T07:45:31.250Z'), 'month')).toEqual(
      new Date('2026-04-10T07:45:31.250Z'),
    );
  });
});

describe('prorationCreditMinor', () => {
  const start = new Date('2026-08-01T00:00:00.000Z');
  const end = new Date('2026-08-31T00:00:00.000Z'); // 30 days

  it('credits the unused fraction, floored', () => {
    // 20 of 30 days remaining on 9900 → 6600.
    expect(
      prorationCreditMinor({
        paidAmountMinor: 9900,
        periodStart: start,
        periodEnd: end,
        now: new Date('2026-08-11T00:00:00.000Z'),
      }),
    ).toBe(6600);
  });

  it('floors rather than rounding up — the credit reduces what we bill', () => {
    const credit = prorationCreditMinor({
      paidAmountMinor: 9900,
      periodStart: start,
      periodEnd: end,
      now: new Date('2026-08-08T13:00:00.000Z'),
    });
    expect(Number.isInteger(credit)).toBe(true);
    // 22d11h remaining of 30d → 9900 × 22.4583/30 = 7411.25, floored to 7411.
    expect(credit).toBe(7411);
  });

  it('credits nothing once the period has ended', () => {
    expect(
      prorationCreditMinor({
        paidAmountMinor: 9900,
        periodStart: start,
        periodEnd: end,
        now: new Date('2026-09-05T00:00:00.000Z'),
      }),
    ).toBe(0);
  });

  it('never credits MORE than was paid, even with a clock before the period', () => {
    // MUTATION: drop the `remaining >= total` clamp → this returns more than
    // `paidAmountMinor`, i.e. a credit for money nobody spent.
    expect(
      prorationCreditMinor({
        paidAmountMinor: 9900,
        periodStart: start,
        periodEnd: end,
        now: new Date('2026-07-01T00:00:00.000Z'),
      }),
    ).toBe(9900);
  });

  it('returns 0 for a zero-length period instead of dividing by zero', () => {
    expect(
      prorationCreditMinor({ paidAmountMinor: 9900, periodStart: end, periodEnd: end, now: start }),
    ).toBe(0);
  });
});

describe('date helpers', () => {
  it('addDays moves by whole days in UTC', () => {
    expect(addDays(new Date('2026-08-28T10:00:00.000Z'), 7)).toEqual(
      new Date('2026-09-04T10:00:00.000Z'),
    );
  });

  it('daysBetween floors and never goes negative', () => {
    expect(daysBetween(new Date('2026-08-01T00:00:00Z'), new Date('2026-08-04T23:00:00Z'))).toBe(3);
    expect(daysBetween(new Date('2026-08-04T00:00:00Z'), new Date('2026-08-01T00:00:00Z'))).toBe(0);
  });
});
