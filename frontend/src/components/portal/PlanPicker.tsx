'use client';

import { useCallback, useEffect, useState } from 'react';
import { catalogApi, type ApiPlan, type PlanPrice } from '../../lib/catalog-api';
import { formatMoneyMinor, formatUtcDate } from '../../lib/format';
import { SkeletonRows } from '../StateViews';
import {
  checkoutConflict,
  portalApi,
  type OnChainInstructions,
} from '../../lib/portal-api';

type Cadence = 'month' | 'year';

/**
 * The plan catalogue AND the act of buying one, in a single component used by both
 * `/portal/billing` and `/portal/billing/plans`.
 *
 * WHY IT IS SHARED. The billing page used to offer a "See plans" card whose only
 * function was to navigate somewhere else — so a customer with no active plan, on
 * the page about their plan, was shown a button instead of the thing they came for.
 * Plans are now rendered inline there. That leaves two surfaces needing the same
 * table AND the same `choose` behaviour, and `choose` is not presentational: it
 * decides between a hosted redirect, an on-chain pay dialog, a scheduled downgrade,
 * a credit-covered upgrade, and the 409 that means a payment is already in flight.
 * Two copies of that would drift, and the branch that drifts is the one that takes
 * money.
 *
 * The parent still owns the PAY DIALOG (`onInstructions`) rather than this
 * component, because the dialog must survive the parent's background refresh —
 * see `PayModal`. Rendering it from here would put it inside a subtree the billing
 * page replaces on load.
 */
export function PlanPicker({
  id,
  currentPlanKey,
  onInstructions,
  onSettled,
  heading,
}: {
  /**
   * Set on the card itself rather than on a wrapper. `/portal/billing` nests this
   * inside its plan card, where the collapse rule that puts a rule and spacing
   * between sections is `.admin-card + .admin-card` — an ADJACENT-sibling
   * selector. A `<div id="plans">` around this broke that adjacency, and the
   * visible symptom was the "Plans" heading jammed against the paragraph above it
   * with no separator.
   */
  id?: string;
  /** Marks the plan the customer is already on. */
  currentPlanKey?: string | null;
  /** Checkout produced something payable — the parent opens the dialog. */
  onInstructions: (instructions: OnChainInstructions) => void;
  /** A plan change landed without payment (scheduled, or covered by credit). */
  onSettled: (notice: string) => void;
  /** Rendered above the catalogue; omitted on a page that has its own header. */
  heading?: React.ReactNode;
}) {
  const [plans, setPlans] = useState<ApiPlan[]>([]);
  const [cadence, setCadence] = useState<Cadence>('month');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyPlan, setBusyPlan] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const catalog = await catalogApi.listPlans();
      setPlans(catalog.plans);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the plans');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function choose(plan: ApiPlan, price: PlanPrice) {
    setBusyPlan(plan.key);
    setError('');
    try {
      const result = await portalApi.startCheckout(plan.key, price.id);
      if (result.outcome === 'checkout' && result.hostedUrl) {
        // Full navigation, not a router push: another origin.
        window.location.assign(result.hostedUrl);
        return;
      }
      if (result.outcome === 'checkout' && result.instructions) {
        onInstructions(result.instructions);
        return;
      }
      onSettled(
        result.outcome === 'scheduled'
          ? `Your plan will change to ${plan.name} on ${formatUtcDate(result.effectiveAt)}. ` +
              'You keep your current plan until then — you have already paid for it.'
          : `You are now on ${plan.name}. Your account credit covered it in full.`,
      );
    } catch (err) {
      // A 409 is not a plain failure: it carries the purchase already in flight,
      // and CONTINUING it is the whole point. Raising a second invoice for the same
      // month is the mistake this branch exists to prevent.
      const conflict = checkoutConflict(err);
      if (conflict?.hostedUrl) {
        window.location.assign(conflict.hostedUrl);
        return;
      }
      if (conflict?.instructions) {
        // The crypto-rail equivalent of that redirect: reopen the payment they
        // already started rather than showing "you already have a payment in
        // progress" beside a retry that can only 409 again.
        onInstructions(conflict.instructions);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not start the checkout');
    } finally {
      setBusyPlan('');
    }
  }

  const sellable = plans.filter((plan) => (plan.prices ?? []).some((p) => p.unitAmountMinor > 0));
  const hasAnnual = sellable.some((plan) => (plan.prices ?? []).some((p) => p.interval === 'year'));
  /**
   * Whether the customer is on a PAID plan, which is what decides the verb on the
   * buttons: "Switch to Pro" is wrong for somebody on Free, who is not switching
   * away from anything. Derived from the catalogue rather than from a flag,
   * because Free is exactly the plan that is not in `sellable`.
   */
  const onPaidPlan = sellable.some((plan) => plan.key === currentPlanKey);

  if (loading) {
    // `id` on the skeleton too: the `#plans` scroll chase on /portal/billing
    // starts as soon as the target exists, and giving it nothing to aim at until
    // the catalogue fetch resolves shortens the window it has to work in.
    return (
      <div className="admin-card" id={id}>
        <SkeletonRows rows={4} />
      </div>
    );
  }

  return (
    <div className="admin-card" id={id}>
      {heading}

      {/* A failed CHECKOUT belongs beside the table that started it, not on a
          full-page error view — the catalogue is still valid and still usable, and
          replacing it would lose the customer's place. */}
      {error ? <p className="payInstrWarn">{error}</p> : null}

      {hasAnnual ? (
        <div className="planCadence">
          <button
            className={cadence === 'month' ? 'admin-btn primary' : 'admin-btn'}
            type="button"
            onClick={() => setCadence('month')}
          >
            Monthly
          </button>
          <button
            className={cadence === 'year' ? 'admin-btn primary' : 'admin-btn'}
            type="button"
            onClick={() => setCadence('year')}
          >
            Annual
          </button>
        </div>
      ) : null}

      {/*
       * A GRID OF SMALL CARDS, not a table. The catalogue was an `admin-table`
       * with six columns, and below 720px `stackTable` turned every row into a
       * labelled block — six stacked label/value pairs per plan, ~640px of
       * scrolling for a two-plan catalogue, so "Pro" was off-screen while you read
       * "Standard". A table is also the layout that ages worst here: each new tier
       * is another full-height row on a phone and another squeezed column on a
       * desktop, and the tier count is a business decision, not a fixed one.
       *
       * The card is ~180px whatever the screen and the grid reflows instead of
       * growing: one column on a phone, two from `sm`, three from `xl`. Five plans
       * cost two rows, not five screens.
       */}
      {sellable.length === 0 ? (
        <p className="admin-note">No paid plans are on sale at the moment.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sellable.map((plan) => {
            const price = pickPrice(plan, cadence);
            const current = currentPlanKey === plan.key;
            return (
              <div
                key={plan.key}
                className={[
                  'flex flex-col gap-3 rounded-xl border p-4',
                  // The plan you are on is marked by the CARD, not by a line of
                  // text where the button would be — at a glance across a grid,
                  // colour reads and a caption does not.
                  current
                    ? 'border-primary/50 bg-primary/[0.06]'
                    : 'border-border/60 bg-surface/40',
                ].join(' ')}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-display text-base font-semibold">{plan.name}</span>
                  <span className="whitespace-nowrap font-mono text-sm">
                    {price ? (
                      <>
                        {formatMoneyMinor(price.unitAmountMinor, price.currency)}
                        <span className="text-muted-foreground">/{price.interval.slice(0, 2)}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </span>
                </div>

                {plan.description ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">{plan.description}</p>
                ) : null}
                {price?.displayNote ? (
                  <p className="text-xs text-muted-foreground">{price.displayNote}</p>
                ) : null}

                {/* The three numbers that actually decide the choice, on one line.
                    They were three rows of the stacked table each costing ~56px. */}
                <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-border/50 pt-3">
                  <Spec
                    label="Units / mo"
                    value={plan.monthlyUnits === 0 ? '∞' : compactUnits(plan.monthlyUnits)}
                    title={plan.monthlyUnits === 0 ? 'Unlimited' : plan.monthlyUnits.toLocaleString()}
                  />
                  <Spec label="Req / min" value={plan.rateLimitPerMin.toLocaleString()} />
                  <Spec
                    label="Keys"
                    value={plan.maxApiKeys === 0 ? '∞' : String(plan.maxApiKeys ?? 1)}
                  />
                </dl>

                {current ? (
                  <div className="rounded-lg bg-primary/10 py-2 text-center text-xs font-medium text-primary">
                    Your plan
                  </div>
                ) : price ? (
                  <button
                    className="admin-btn primary w-full justify-center"
                    type="button"
                    disabled={busyPlan !== ''}
                    onClick={() => void choose(plan, price)}
                  >
                    {busyPlan === plan.key
                      ? 'Starting…'
                      : onPaidPlan
                        ? `Switch to ${plan.name}`
                        : `Get ${plan.name}`}
                  </button>
                ) : (
                  <p className="admin-note">Not available {cadence}ly</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* The asymmetry surprises people, so it is stated before they click rather
          than explained afterwards. Downgrading immediately would mean refunding,
          and this rail cannot send money back. */}
      <p className="admin-note">
        Moving to a bigger plan takes effect as soon as you pay, and the unused part of your current period
        is credited against it. Moving to a smaller one takes effect at the end of the period you have
        already paid for.
      </p>
    </div>
  );
}

/** One number and its name, in the width of a third of a card. */
function Spec({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[0.625rem] uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate font-mono text-sm" title={title}>
        {value}
      </dd>
    </div>
  );
}

/**
 * `5000000` → `5M`.
 *
 * The full figure does not fit a third of a card at any usable size, and it is
 * the ORDER OF MAGNITUDE that separates the tiers — nobody picks a plan on the
 * last three digits of its allowance. The exact number stays reachable as the
 * cell's `title`, and every page that quotes the allowance to bill against it
 * (usage, invoices) still prints it in full.
 */
function compactUnits(units: number): string {
  if (units >= 1_000_000) return `${trimZero(units / 1_000_000)}M`;
  if (units >= 1_000) return `${trimZero(units / 1_000)}k`;
  return units.toLocaleString();
}

/** `5.0` → `5`, `1.5` → `1.5`. One decimal, only when it says something. */
function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/**
 * The price to offer for a cadence.
 *
 * Falls back to the plan's monthly price when it has no annual one, rather than
 * hiding the plan: a catalogue where one tier silently disappears when somebody
 * clicks "Annual" reads as a broken page, not as a missing option.
 */
function pickPrice(plan: ApiPlan, cadence: Cadence): PlanPrice | undefined {
  const prices = (plan.prices ?? []).filter((p) => p.unitAmountMinor > 0);
  return prices.find((p) => p.interval === cadence) ?? prices.find((p) => p.interval === 'month');
}
