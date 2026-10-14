import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Model } from 'mongoose';
import { SubscriptionSweepService } from '../src/payments/subscription-sweep.service.js';
import { LIVE_SUBSCRIPTION_STATUSES as LIVE } from '../src/payments/schemas/subscription.schema.js';
import type { AppConfigService } from '../src/config/app-config.service.js';
import type { BillingMailService } from '../src/payments/billing-mail.service.js';
import type { MeteringService } from '../src/billing/metering.service.js';
import type { PaymentProviderRegistry } from '../src/payments/provider-registry.js';
import type { PlansService } from '../src/billing/plans.service.js';
import type { SettingsCacheService } from '../src/billing/settings-cache.service.js';
import type { SubscriptionsService } from '../src/payments/subscriptions.service.js';

/**
 * The lifecycle clock.
 *
 * Nothing on the rail side renews anything — Radom's pay-link rail has
 * `recurring: false` — so this sweep is the only thing that will ever bill a
 * second period, notice a lapse, or cut access. The properties pinned here are
 * the ones whose absence is silent: a deadline computed from the wrong clock, a
 * kill switch written where a plan change belonged, an operator's manual grant
 * quietly revoked.
 */

const NOW = new Date('2026-09-10T12:00:00.000Z');
const CUSTOMER = '507f1f77bcf86cd799439011';

interface Sub {
  _id: string;
  customerId: string;
  planKey: string;
  priceId: string;
  interval: 'month' | 'year';
  unitAmountMinor: number;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  graceDays: number;
  graceEndsAt?: Date;
  cancelAtPeriodEnd: boolean;
  lateByDays: number;
  provider: string;
  /**
   * Declared, and the factory always sets it. `expireAbandonedCheckoutsPass`
   * filters on `startedAt: { $lte: cutoff }`, and the in-memory `matches`
   * helper treats a non-Date as no match — so an undeclared field would make
   * the "leaves a RECENT incomplete alone" case pass for the wrong reason
   * (nothing matched at all) and pin nothing.
   */
  startedAt: Date;
  endedAt?: Date;
  pendingPlanKey?: string;
  pendingPriceId?: string;
  pendingEffectiveAt?: Date;
  cancellationReason?: string;
}

interface Cust {
  _id: string;
  email?: string;
  planKey: string;
  planSource?: string;
  status: string;
  currentSubscriptionId?: string;
}

/** A deliberately small stand-in for the Mongoose surface these passes use. */
function collection<T extends { _id: string }>(rows: T[]) {
  const matches = (row: T, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, want]) => {
      const have = (row as Record<string, unknown>)[key];
      if (want && typeof want === 'object' && !(want instanceof Date)) {
        const op = want as Record<string, unknown>;
        if ('$in' in op) return (op.$in as unknown[]).includes(have);
        if ('$nin' in op) return !(op.$nin as unknown[]).includes(have);
        if ('$ne' in op) return have !== op.$ne;
        if ('$lte' in op) return have instanceof Date && have.getTime() <= (op.$lte as Date).getTime();
        if ('$gte' in op) return have instanceof Date && have.getTime() >= (op.$gte as Date).getTime();
        if ('$type' in op) return typeof have === 'string';
        if ('$exists' in op) return (have !== undefined) === op.$exists;
      }
      return have === want;
    });

  const apply = (row: T, update: Record<string, unknown>) => {
    const set = update.$set as Record<string, unknown> | undefined;
    const unset = update.$unset as Record<string, unknown> | undefined;
    if (set) Object.assign(row, set);
    if (unset) for (const key of Object.keys(unset)) delete (row as Record<string, unknown>)[key];
  };

  return {
    rows,
    find(filter: Record<string, unknown> = {}) {
      const found = rows.filter((r) => matches(r, filter));
      const chain = {
        limit: () => chain,
        sort: () => chain,
        select: () => chain,
        lean: () => chain,
        exec: async () => found,
      };
      return chain;
    },
    findOne(filter: Record<string, unknown> = {}) {
      const found = rows.find((r) => matches(r, filter)) ?? null;
      const chain = { sort: () => chain, select: () => chain, lean: () => chain, exec: async () => found };
      return chain;
    },
    findById(id: unknown) {
      const found = rows.find((r) => r._id === String(id)) ?? null;
      const chain = { lean: () => chain, exec: async () => found };
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
    updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
      return {
        exec: async () => {
          const found = rows.filter((r) => matches(r, filter));
          found.forEach((r) => apply(r, update));
          return { matchedCount: found.length, modifiedCount: found.length };
        },
      };
    },
  };
}

/** The open renewal invoice a lapsed subscription always has in production. */
function openInvoice(subscriptionId = 'sub1') {
  return {
    _id: 'inv-open',
    subscriptionId,
    status: 'open',
    amountDueMinor: 9900,
    amountPaidMinor: 0,
    currency: 'USD',
    periodStart: new Date('2026-09-01T00:00:00.000Z'),
    number: 1,
  };
}

function buildSweep(
  opts: {
    subs?: Sub[];
    customers?: Cust[];
    invoices?: Array<{ _id: string }>;
    /** Make the raised renewal invoice come back fully covered by credit. */
    creditCoversRenewal?: boolean;
  } = {},
) {
  const subs = collection<Sub>(opts.subs ?? []);
  const customers = collection<Cust>(opts.customers ?? []);
  const invoices = collection<{ _id: string } & Record<string, unknown>>(
    (opts.invoices as Array<{ _id: string } & Record<string, unknown>>) ?? [],
  );
  const quotaResets: string[] = [];
  const mails: Array<{ kind: string; to: string }> = [];
  const raised: Array<{ planKey: string; periodStart: Date; unitAmountMinor: number }> = [];
  const settledFromCredit: string[] = [];
  const voided: string[] = [];

  const service = new SubscriptionSweepService(
    subs as unknown as Model<never>,
    invoices as unknown as Model<never>,
    customers as unknown as Model<never>,
    {
      async raiseInvoice(args: { planKey: string; periodStart: Date; price: { unitAmountMinor: number } }) {
        raised.push({
          planKey: args.planKey,
          periodStart: args.periodStart,
          // The AMOUNT the sweep decided to bill — the thing the locked-price
          // regression is about.
          unitAmountMinor: args.price.unitAmountMinor,
        });
        return {
          _id: `inv-${raised.length}`,
          amountDueMinor: opts.creditCoversRenewal ? 0 : args.price.unitAmountMinor,
          currency: 'USD',
          number: raised.length,
        };
      },
      async settleFromCredit(invoice: { _id: unknown }) {
        settledFromCredit.push(String(invoice._id));
      },
      async voidUnfundedInvoices(id: unknown) {
        voided.push(String(id));
      },
      checkoutReturnUrl: () => 'https://portal.test/portal/checkout/return',
    } as unknown as SubscriptionsService,
    {
      async getByKey(key: string) {
        if (key === 'gone') return null;
        return {
          key,
          name: key === 'pro' ? 'Pro' : 'Standard',
          prices: [
            { id: `${key}_monthly`, interval: 'month', intervalCount: 1, unitAmountMinor: key === 'pro' ? 79000 : 9900, currency: 'USD', active: true },
          ],
        };
      },
    } as unknown as PlansService,
    { getPlan: (key: string) => ({ name: key === 'pro' ? 'Pro' : 'Standard' }) } as unknown as SettingsCacheService,
    {
      async resetQuotaPeriod(id: string) {
        quotaResets.push(id);
        return true;
      },
    } as unknown as MeteringService,
    {
      async renewalDue(a: { to: string }) { mails.push({ kind: 'renewal', to: a.to }); },
      async graceWarning(a: { to: string }) { mails.push({ kind: 'grace', to: a.to }); },
      async downgraded(a: { to: string }) { mails.push({ kind: 'downgraded', to: a.to }); },
      async paymentReceived(a: { to: string }) { mails.push({ kind: 'receipt', to: a.to }); },
    } as unknown as BillingMailService,
    // No hosted checkout, so the renewal pass raises the invoice and skips the
    // pay-link/mail half — which keeps these tests about the CLOCK.
    { find: () => undefined } as unknown as PaymentProviderRegistry,
    {
      subscriptionGraceDays: 7,
      subscriptionRenewalLeadDays: 7,
      portalBaseUrl: 'https://portal.test',
    } as unknown as AppConfigService,
  );

  return { service, subs, customers, quotaResets, mails, raised, settledFromCredit, voided };
}

function subscription(overrides: Partial<Sub> = {}): Sub {
  return {
    _id: 'sub1',
    customerId: CUSTOMER,
    planKey: 'standard',
    priceId: 'standard_monthly',
    interval: 'month',
    unitAmountMinor: 9900,
    status: 'active',
    currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
    graceDays: 7,
    cancelAtPeriodEnd: false,
    lateByDays: 0,
    provider: 'radom',
    startedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function customer(overrides: Partial<Cust> = {}): Cust {
  return {
    _id: CUSTOMER,
    email: 'customer@example.test',
    planKey: 'standard',
    planSource: 'subscription',
    status: 'active',
    currentSubscriptionId: 'sub1',
    ...overrides,
  };
}

describe('sweep — lapse', () => {
  /** A tick two days after the period ended — inside the 7-day grace window. */
  const INSIDE_GRACE = new Date('2026-09-03T00:00:00.000Z');

  it('computes graceEndsAt from the DOCUMENT’S OWN currentPeriodEnd, not from now', async () => {
    // THE PROPERTY. Deriving the deadline from `now` would hand out two extra
    // days of free access here, and a week of sweep downtime would hand out a
    // week — the deadline is a property of the subscription, not of when we got
    // round to noticing.
    // MUTATION: `addDays(now, graceDays)` → this fails.
    const stack = buildSweep({
      subs: [subscription()],
      customers: [customer()],
      invoices: [openInvoice()],
    });
    await stack.service.sweep(INSIDE_GRACE);
    const sub = stack.subs.rows[0];
    expect(sub.status).toBe('past_due');
    // 2026-09-01 + 7 days, NOT 2026-09-03 + 7 days.
    expect(sub.graceEndsAt).toEqual(new Date('2026-09-08T00:00:00.000Z'));
  });

  it('uses the SUBSCRIPTION’S snapshotted graceDays, not the current config', async () => {
    // The config says 7; this subscription signed up under 30. Changing the
    // global default must never retroactively move an existing customer's
    // deadline in either direction.
    const stack = buildSweep({
      subs: [subscription({ graceDays: 30 })],
      customers: [customer()],
      invoices: [openInvoice()],
    });
    await stack.service.sweep(INSIDE_GRACE);
    expect(stack.subs.rows[0].graceEndsAt).toEqual(new Date('2026-10-01T00:00:00.000Z'));
  });

  it('records how late the payment is, for dunning copy', async () => {
    const stack = buildSweep({
      subs: [subscription()],
      customers: [customer()],
      invoices: [openInvoice()],
    });
    await stack.service.sweep(INSIDE_GRACE);
    expect(stack.subs.rows[0].lateByDays).toBe(2);
  });

  it('sends the grace warning exactly once across two ticks', async () => {
    // Filtered on `status: 'active'` — the state the pass is LEAVING — so a
    // doubled tick matches nothing the second time.
    // MUTATION: drop `status: 'active'` from the update filter → this fails.
    const stack = buildSweep({
      subs: [subscription()],
      customers: [customer()],
      invoices: [openInvoice()],
    });
    await stack.service.sweep(INSIDE_GRACE);
    await stack.service.sweep(INSIDE_GRACE);
    expect(stack.mails.filter((m) => m.kind === 'grace')).toHaveLength(1);
  });

  it('ENDS a cancelled subscription instead of dunning it', async () => {
    const stack = buildSweep({
      subs: [subscription({ cancelAtPeriodEnd: true })],
      customers: [customer()],
      invoices: [openInvoice()],
    });
    await stack.service.sweep(INSIDE_GRACE);
    expect(stack.subs.rows[0].status).toBe('canceled');
    expect(stack.subs.rows[0].endedAt).toBeDefined();
    expect(stack.mails.filter((m) => m.kind === 'grace')).toHaveLength(0);
  });
});

describe('sweep — a LATE tick', () => {
  it('lapses and expires in the same pass when the grace window has already gone', async () => {
    // The sweep has been down for nine days and the window was seven. The seven
    // days really did pass, so access really should be cut — deriving the
    // deadline from the document rather than from `now` is what makes that come
    // out right, and this is the case that proves it does something.
    const stack = buildSweep({
      subs: [subscription()],
      customers: [customer()],
      invoices: [openInvoice()],
    });
    await stack.service.sweep(NOW); // 9 days past the period end
    expect(stack.subs.rows[0].status).toBe('unpaid');
    expect(stack.customers.rows[0].planKey).toBe('free');
  });

  it('does NOT send a grace warning whose deadline has already passed', async () => {
    // Otherwise the customer receives "pay by the 8th to keep your plan" and
    // "your account has moved to the Free plan" in the same second, the first
    // of them untrue at the moment it was written. The downgrade notice is the
    // honest one; it goes alone.
    // MUTATION: remove the `graceEndsAt > now` guard → this fails.
    const stack = buildSweep({
      subs: [subscription()],
      customers: [customer()],
      invoices: [openInvoice()],
    });
    await stack.service.sweep(NOW);
    expect(stack.mails.filter((m) => m.kind === 'grace')).toHaveLength(0);
    expect(stack.mails.filter((m) => m.kind === 'downgraded')).toHaveLength(1);
  });
});

describe('sweep — grace expiry', () => {
  const lapsed = () =>
    subscription({
      status: 'past_due',
      graceEndsAt: new Date('2026-09-08T00:00:00.000Z'),
    });

  it('drops the customer to free and resets their quota', async () => {
    // `resetQuotaPeriod` is not optional politeness: the quota key is SHARED
    // across plan-specific limiter instances (which is what makes a mid-period
    // upgrade correct), so a customer downgraded after burning 3M units would
    // 429 on every request for the rest of the calendar month.
    // MUTATION: remove the `resetQuotaPeriod` call → this fails.
    const stack = buildSweep({ subs: [lapsed()], customers: [customer()] });
    await stack.service.sweep(NOW);
    expect(stack.subs.rows[0].status).toBe('unpaid');
    expect(stack.customers.rows[0].planKey).toBe('free');
    expect(stack.quotaResets).toContain(CUSTOMER);
  });

  it('NEVER writes Customer.status — that is a kill switch, not a billing state', async () => {
    // `ClientsService.resolveByRawKey` returns null for a suspended customer,
    // so every `/v1` request 401s. Writing 'suspended' on expiry would hard-
    // suspend the API instead of downgrading it: the customer's keys would stop
    // working entirely rather than dropping to Free limits.
    // MUTATION: add `status: 'suspended'` to the `dropToFree` $set → this fails.
    const stack = buildSweep({ subs: [lapsed()], customers: [customer()] });
    await stack.service.sweep(NOW);
    expect(stack.customers.rows[0].status).toBe('active');
  });

  it('leaves an ADMIN-set plan alone', async () => {
    // `planSource: 'admin'` means an operator put this customer here
    // deliberately. A lapsing subscription must not silently revoke it.
    // MUTATION: drop `planSource: {$ne: 'admin'}` from the filter → this fails.
    const stack = buildSweep({
      subs: [lapsed()],
      customers: [customer({ planSource: 'admin', planKey: 'pro' })],
    });
    await stack.service.sweep(NOW);
    expect(stack.customers.rows[0].planKey).toBe('pro');
    expect(stack.quotaResets).not.toContain(CUSTOMER);
  });

  it('is a no-op on a second tick', async () => {
    const stack = buildSweep({ subs: [lapsed()], customers: [customer()] });
    await stack.service.sweep(NOW);
    await stack.service.sweep(NOW);
    expect(stack.mails.filter((m) => m.kind === 'downgraded')).toHaveLength(1);
  });

  it('does not expire grace that has not run out yet', async () => {
    const stack = buildSweep({
      subs: [subscription({ status: 'past_due', graceEndsAt: new Date('2026-09-30T00:00:00.000Z') })],
      customers: [customer()],
    });
    await stack.service.sweep(NOW);
    expect(stack.subs.rows[0].status).toBe('past_due');
    expect(stack.customers.rows[0].planKey).toBe('standard');
  });
});

describe('sweep — renewal', () => {
  it('raises the next period’s invoice inside the lead window', async () => {
    const endingSoon = subscription({
      currentPeriodStart: new Date('2026-08-15T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-09-14T00:00:00.000Z'), // 4 days out
    });
    const stack = buildSweep({ subs: [endingSoon], customers: [customer()] });
    await stack.service.sweep(NOW);
    expect(stack.raised).toHaveLength(1);
    // The new period starts where the old one ends — no gap, no overlap.
    expect(stack.raised[0].periodStart).toEqual(new Date('2026-09-14T00:00:00.000Z'));
  });

  it('does NOT bill a subscription the customer has cancelled', async () => {
    // Raising an invoice for a period somebody has said they do not want is a
    // bill for something nobody agreed to buy.
    // MUTATION: drop `cancelAtPeriodEnd: false` from the renewal filter → fails.
    const stack = buildSweep({
      subs: [
        subscription({
          currentPeriodStart: new Date('2026-08-15T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-09-14T00:00:00.000Z'),
          cancelAtPeriodEnd: true,
        }),
      ],
      customers: [customer()],
    });
    await stack.service.sweep(NOW);
    expect(stack.raised).toHaveLength(0);
  });

  it('bills the PENDING plan when a scheduled change lands at this boundary', async () => {
    const stack = buildSweep({
      subs: [
        subscription({
          currentPeriodStart: new Date('2026-08-15T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-09-14T00:00:00.000Z'),
          pendingPlanKey: 'pro',
          pendingPriceId: 'pro_monthly',
          pendingEffectiveAt: new Date('2026-09-14T00:00:00.000Z'),
        }),
      ],
      customers: [customer()],
    });
    await stack.service.sweep(NOW);
    expect(stack.raised[0].planKey).toBe('pro');
  });

  it('does not lapse a subscription whose plan has been deleted — it shouts instead', async () => {
    // The customer did nothing wrong. Letting the period lapse into grace and
    // then to Free would punish them for an admin's edit.
    const stack = buildSweep({
      subs: [
        subscription({
          planKey: 'gone',
          currentPeriodStart: new Date('2026-08-15T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-09-14T00:00:00.000Z'),
        }),
      ],
      customers: [customer()],
    });
    const report = await stack.service.sweep(NOW);
    expect(report.errors).toBe(1);
    expect(stack.subs.rows[0].status).toBe('active');
  });
});

describe('sweep — scheduled plan change', () => {
  it('applies a downgrade that has come due, and resets the quota', async () => {
    const stack = buildSweep({
      subs: [
        subscription({
          planKey: 'pro',
          priceId: 'pro_monthly',
          unitAmountMinor: 79000,
          currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
          pendingPlanKey: 'standard',
          pendingPriceId: 'standard_monthly',
          pendingEffectiveAt: new Date('2026-09-09T00:00:00.000Z'),
        }),
      ],
      customers: [customer({ planKey: 'pro' })],
    });
    await stack.service.sweep(NOW);
    const sub = stack.subs.rows[0];
    expect(sub.planKey).toBe('standard');
    expect(sub.unitAmountMinor).toBe(9900);
    expect(sub.pendingPlanKey).toBeUndefined();
    expect(stack.customers.rows[0].planKey).toBe('standard');
    // A downgrade is INVOLUNTARY from the quota's point of view even though the
    // customer asked for it — they may already have spent more than the smaller
    // plan allows.
    expect(stack.quotaResets).toContain(CUSTOMER);
  });

  it('does not move a customer’s plan for a change on a past_due subscription', async () => {
    // A `past_due` subscription is inside grace on the OLD plan and keeps it
    // until grace decides otherwise.
    const stack = buildSweep({
      subs: [
        subscription({
          status: 'past_due',
          planKey: 'pro',
          graceEndsAt: new Date('2026-09-30T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
          pendingPlanKey: 'standard',
          pendingPriceId: 'standard_monthly',
          pendingEffectiveAt: new Date('2026-09-09T00:00:00.000Z'),
        }),
      ],
      customers: [customer({ planKey: 'pro' })],
    });
    await stack.service.sweep(NOW);
    expect(stack.subs.rows[0].planKey).toBe('standard'); // the subscription moves
    expect(stack.customers.rows[0].planKey).toBe('pro'); // the entitlement does not
  });
});

describe('sweep — regressions found by the 2026-08-06 adversarial review', () => {
  it('NEVER applies a pending change that is MORE expensive — that is an unpaid upgrade', async () => {
    // THE CRITICAL ONE. `changePlan`'s upgrade branch used to stamp
    // `pendingEffectiveAt: now` alongside an UNPAID invoice, so the very next
    // sweep tick promoted the pending plan onto the subscription AND onto
    // Customer.planKey — a second entitlement path, on a timer, with no money
    // behind it. Two independent guards now stop it: the upgrade branch leaves
    // `pendingEffectiveAt` unset, and this pass refuses a dearer pending price
    // even if something else sets it.
    // MUTATION: delete the `pendingMonthly > currentMonthly` check → this fails.
    const stack = buildSweep({
      subs: [
        subscription({
          planKey: 'standard',
          unitAmountMinor: 9900,
          currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
          pendingPlanKey: 'pro', // 79000/mo — dearer
          pendingPriceId: 'pro_monthly',
          pendingEffectiveAt: new Date('2026-09-09T00:00:00.000Z'),
        }),
      ],
      customers: [customer({ planKey: 'standard' })],
    });
    const report = await stack.service.sweep(NOW);
    expect(stack.subs.rows[0].planKey).toBe('standard');
    expect(stack.customers.rows[0].planKey).toBe('standard');
    expect(report.planChangesApplied).toBe(0);
    expect(report.errors).toBe(1); // refused loudly, not silently
  });

  it('bills an unchanged renewal at the subscription’s LOCKED amount, not the plan’s current price', async () => {
    // `Subscription.unitAmountMinor` is documented as locked at subscribe time
    // so an admin repricing a plan cannot reprice existing subscribers — but
    // `lookupPrice` reads the plan live, so the renewal was drawn at whatever
    // the plan says today. This subscriber is on 4900; the plan seed is 9900.
    // MUTATION: drop the unitAmountMinor override in resolveNextPrice → fails.
    const stack = buildSweep({
      subs: [
        subscription({
          unitAmountMinor: 4900,
          currentPeriodStart: new Date('2026-08-15T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-09-14T00:00:00.000Z'),
        }),
      ],
      customers: [customer()],
    });
    await stack.service.sweep(NOW);
    expect(stack.raised).toHaveLength(1);
    expect(stack.raised[0].unitAmountMinor).toBe(4900);
  });

  it('SETTLES a renewal that account credit covered in full', async () => {
    // `raiseInvoice` DEDUCTS the customer's credit, and the renewal pass then
    // only minted a pay link when `amountDueMinor > 0` — so a fully-credited
    // renewal had the credit spent, no invoice settled, and the subscription
    // lapsed to Free at period end. The customer had paid and got nothing.
    // MUTATION: remove the `amountDueMinor <= 0` branch in renewPass → fails.
    const stack = buildSweep({
      subs: [
        subscription({
          currentPeriodStart: new Date('2026-08-15T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-09-14T00:00:00.000Z'),
        }),
      ],
      customers: [customer()],
      creditCoversRenewal: true,
    });
    await stack.service.sweep(NOW);
    expect(stack.settledFromCredit).toHaveLength(1);
  });

  it('ages an ABANDONED checkout out of the live set so the customer can buy again', async () => {
    // `incomplete` is a LIVE status backing the partial-unique {customerId}
    // index, so a checkout somebody opened and closed blocked every future
    // purchase — permanently, repairable only by hand.
    // MUTATION: remove expireAbandonedCheckoutsPass → this fails.
    const stack = buildSweep({
      subs: [
        subscription({
          status: 'incomplete',
          startedAt: new Date('2026-09-01T00:00:00.000Z'), // >24h before NOW
          currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
        }),
      ],
      customers: [customer({ planKey: 'free' })],
    });
    await stack.service.sweep(NOW);
    expect(stack.subs.rows[0].status).toBe('incomplete_expired');
    expect(LIVE.includes(stack.subs.rows[0].status)).toBe(false);
  });

  it('leaves a RECENT incomplete checkout alone — the pay link may still be live', async () => {
    const stack = buildSweep({
      subs: [
        subscription({
          status: 'incomplete',
          startedAt: new Date('2026-09-10T09:00:00.000Z'), // 3h before NOW
          currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
        }),
      ],
      customers: [customer({ planKey: 'free' })],
    });
    await stack.service.sweep(NOW);
    expect(stack.subs.rows[0].status).toBe('incomplete');
  });
});

describe('LIVE_SUBSCRIPTION_STATUSES', () => {
  it('excludes `unpaid` — a post-grace row must not block a re-subscribe', async () => {
    // While `unpaid` counted as live, the partial-unique {customerId} index
    // made one lapse a PERMANENT bar on ever subscribing again: access had
    // already been cut and the customer moved to Free, and the row that
    // entitled nothing stood in the doorway forever.
    expect(LIVE).not.toContain('unpaid');
    // …and the statuses that must stay are still there.
    expect(LIVE).toContain('incomplete');
    expect(LIVE).toContain('active');
    expect(LIVE).toContain('past_due');
  });
});

describe('sweep — the self-heal', () => {
  it('drops a customer holding a paid plan with no live subscription', async () => {
    // The drift is invisible: nothing errors, and it is expensive in exactly
    // one direction.
    const stack = buildSweep({ subs: [], customers: [customer({ planKey: 'pro' })] });
    const report = await stack.service.sweep(NOW);
    expect(stack.customers.rows[0].planKey).toBe('free');
    expect(report.healed).toBe(1);
  });

  it('never heals UPWARD — a subscription document alone grants nothing', async () => {
    // MUTATION: add an "if a live subscription's plan differs, grant it" branch
    // → this fails. Granting a plan because a document says so, with no invoice
    // to point at, would make the sweep a second entitlement path with no money
    // behind it.
    const stack = buildSweep({
      subs: [subscription({ planKey: 'pro', currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z') })],
      customers: [customer({ planKey: 'standard' })],
    });
    await stack.service.sweep(NOW);
    expect(stack.customers.rows[0].planKey).toBe('standard');
  });

  it('leaves an admin-set plan alone', async () => {
    const stack = buildSweep({ subs: [], customers: [customer({ planKey: 'pro', planSource: 'admin' })] });
    await stack.service.sweep(NOW);
    expect(stack.customers.rows[0].planKey).toBe('pro');
  });

  it('leaves a free customer alone', async () => {
    const stack = buildSweep({ subs: [], customers: [customer({ planKey: 'free' })] });
    const report = await stack.service.sweep(NOW);
    expect(report.healed).toBe(0);
  });
});

describe('sweep — coalescing', () => {
  it('does not double-lapse when TWO PODS sweep the same data at once', async () => {
    // The coalescing guard is per-PROCESS, so it does nothing across pods. What
    // protects a second pod is the update filter naming the state the pass is
    // leaving — `{_id, status: 'active'}` — so whichever write lands second
    // matches nothing and its `modifiedCount === 0` short-circuits before the
    // email.
    //
    // Two services over THE SAME row arrays is what models that; two sequential
    // ticks on one service does not, because the pass's own `find` has already
    // stopped matching by then. Removing the filter passes every sequential
    // test and fails this one, which is the whole reason it is here.
    // MUTATION: drop `status: 'active'` from the lapse update filter → fails.
    const subs = [subscription()];
    const customers = [customer()];
    const invoices = [openInvoice()];
    const podA = buildSweep({ subs, customers, invoices });
    const podB = buildSweep({ subs, customers, invoices });
    const at = new Date('2026-09-03T00:00:00.000Z');

    await Promise.all([podA.service.sweep(at), podB.service.sweep(at)]);

    const graceEmails = [...podA.mails, ...podB.mails].filter((m) => m.kind === 'grace');
    expect(graceEmails).toHaveLength(1);
  });

  it('joins an in-flight sweep rather than running a second one', async () => {
    // Cron and an admin can press this at the same moment; two concurrent
    // passes would both see the same lapsed subscription and both email.
    const stack = buildSweep({
      subs: [subscription()],
      customers: [customer()],
      invoices: [openInvoice()],
    });
    const [a, b] = await Promise.all([
      stack.service.sweep(new Date('2026-09-03T00:00:00.000Z')),
      stack.service.sweep(new Date('2026-09-03T00:00:00.000Z')),
    ]);
    expect(a).toBe(b);
    expect(stack.mails.filter((m) => m.kind === 'grace')).toHaveLength(1);
  });
});
