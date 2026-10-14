'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { BillingOverview } from '../../lib/portal-api';
import { formatMoneyMinor, formatUtcDate } from '../../lib/format';

/**
 * The lifecycle banner. FIVE states, one of which is the whole reason it
 * exists.
 *
 * `ended` — the downgrade — is the state people write badly. The instinct is to
 * warn: "your subscription has expired, your access has been revoked". None of
 * that is true here. `Customer.status` is a hard kill switch that the billing
 * lifecycle NEVER writes, so the customer's API keys keep working; what changed
 * is the plan they are metered against. Copy that implies revocation generates a
 * support ticket from someone who thinks their integration is down when it is
 * running fine at Free limits.
 *
 * `past_due` is the other one to get right: they still have full access, and
 * saying so is what makes the deadline land as information rather than as a
 * threat that has already been carried out.
 *
 * `actions` is a slot for the buttons that act on an UNPAID invoice — pay it, or
 * abandon the checkout. It is a slot rather than logic here because opening the
 * pay dialog is page state, and this file stays presentational. It renders in the
 * two states that can have an open invoice (`pending` and `past_due`); nothing
 * else has anything to pay, so passing it is harmless there.
 */
export function BillingBanner({
  billing,
  actions,
  manage,
}: {
  billing: BillingOverview;
  actions?: ReactNode;
  /**
   * Ending or resuming the SUBSCRIPTION — a slot of its own, deliberately not
   * folded into `actions`.
   *
   * `actions` acts on an unpaid INVOICE (pay it, drop an unpaid change);
   * `manage` acts on the plan the customer is currently paying for. Rendering
   * them in one row put "Cancel the change to pro" beside "Cancel subscription"
   * — two adjacent buttons, both starting "Cancel", one of them ending the plan
   * they are happily paying for. Separate slot, separate rule, quieter styling.
   */
  manage?: ReactNode;
}) {
  const subscription = billing.subscription;

  if (billing.state === 'past_due') {
    return (
      <div className="admin-card" style={{ borderLeft: '3px solid var(--warn, #b45309)' }}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="admin-h !mb-0">Payment overdue</h2>
          {manage}
        </div>
        <p>
          We have not received payment for your {billing.planName} plan.
          {subscription?.graceEndsAt ? (
            <>
              {' '}
              Your plan stays active until <strong>{formatUtcDate(subscription.graceEndsAt)}</strong>.
            </>
          ) : null}
        </p>
        <p className="admin-note">
          If it goes unpaid your account moves to the Free plan. Your API keys keep working — at Free
          limits — and nothing is deleted.
        </p>
        {/* BOTH, not either. `hostedUrl` substitutes for the PAY action on a
            redirect rail — it says nothing about cancelling, and an `else` here
            hid the cancel button behind the presence of a pay link. The page only
            puts a Pay button in `actions` when there are on-chain instructions, so
            the two can never both offer to pay. */}
        {billing.openInvoice?.hostedUrl || actions ? (
          <div className="bannerActions">
            {billing.openInvoice?.hostedUrl ? (
              <a className="admin-btn primary" href={billing.openInvoice.hostedUrl}>
                Pay {formatMoneyMinor(billing.openInvoice.amountDueMinor, billing.openInvoice.currency)}
              </a>
            ) : null}
            {actions}
          </div>
        ) : null}

      </div>
    );
  }

  if (billing.state === 'pending') {
    return (
      <div className="admin-card">
        <h2 className="admin-h">
          {billing.paymentInFlight ? 'Confirming your payment' : 'Payment in progress'}
        </h2>
        <p>
          {/* The plan being BOUGHT, not the account's current plan — while a
              first payment is pending, current is still Free but the invoice is
              for the plan they chose. */}
          We are waiting for your payment for {billing.openInvoice?.planName ?? billing.planName} to confirm.
          Your plan starts as soon as it does — you do not need to pay again.
        </p>
        {/* THE STATE A REFRESH USED TO DESTROY. The transfer is signed and on
            its way; settlement happens server-side in the watcher, so closing
            the tab costs nothing. Said explicitly because the page otherwise
            looks identical to "you have not paid yet" — and that page has a Pay
            button on it, which is how somebody pays twice. */}
        {billing.paymentInFlight ? (
          <p className="admin-note">
            Your transfer has been sent and is waiting on the network. This page updates itself, and
            the payment applies whether you stay here or not — there is nothing left for you to do.
            {/* Said explicitly because the Cancel button VANISHES at this point,
                and an action disappearing without explanation reads as a bug. */}{' '}
            It can no longer be cancelled — the transfer is on its way and cannot be called back.
          </p>
        ) : null}
        {/* Same rule as `past_due` above: a pay link never stands in for cancel. */}
        {billing.openInvoice?.hostedUrl || actions ? (
          <div className="bannerActions">
            {billing.openInvoice?.hostedUrl ? (
              <a className="admin-btn" href={billing.openInvoice.hostedUrl}>
                Open the payment page
              </a>
            ) : null}
            {actions}
          </div>
        ) : null}
      </div>
    );
  }

  if (billing.state === 'ended') {
    return (
      <div className="admin-card">
        <h2 className="admin-h">You are on the Free plan</h2>
        {/* Deliberately unalarming. Nothing was revoked — the limits changed. */}
        <p>
          Your previous subscription has ended. Your API keys still work and nothing has been deleted; they
          are subject to Free plan limits from now on.
        </p>
      </div>
    );
  }

  if (billing.state === 'active' && subscription) {
    return (
      <div className="admin-card">
        {/*
         * THE MANAGE CONTROL RIDES THE HEADING ROW.
         *
         * Given its own block under a rule it still read as a section — same
         * band, same divider, only the label had changed from "Manage" to
         * "Not using it?". Up here it costs no vertical space, sits visually
         * with the plan it acts on, and is as far from the Pay button as the
         * card allows, which is the property that matters: it must never read
         * as the next step after paying. Quiet by placement rather than by a
         * warning colour.
         */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="admin-h !mb-0">{billing.planName}</h2>
          {manage}
        </div>
        <p>
          {formatMoneyMinor(subscription.unitAmountMinor, billing.openInvoice?.currency ?? 'USD')} per{' '}
          {subscription.interval}
          {subscription.cancelAtPeriodEnd ? (
            <>
              {' '}
              — ending on <strong>{formatUtcDate(subscription.currentPeriodEnd)}</strong>
            </>
          ) : (
            <>
              {' '}
              — renews on <strong>{formatUtcDate(subscription.currentPeriodEnd)}</strong>
            </>
          )}
          .
        </p>
        {subscription.pendingPlanKey && subscription.pendingEffectiveAt ? (
          <p className="admin-note">
            Scheduled change to <strong>{subscription.pendingPlanKey}</strong> on{' '}
            {formatUtcDate(subscription.pendingEffectiveAt)}.
          </p>
        ) : null}
        {/* Nothing charges automatically on this rail, so saying "renews on" and
            stopping there would set the wrong expectation. */}
        {!subscription.cancelAtPeriodEnd ? (
          <p className="admin-note">
            We will email you an invoice before that date. Payments are not taken automatically.
          </p>
        ) : null}

        {/*
         * AN ACTIVE SUBSCRIPTION CAN HAVE SOMETHING TO PAY, and this branch used
         * to render no actions at all — so the Pay button existed only in the
         * invoice row at the bottom of the page.
         *
         * Two ways to get here and the renewal is the serious one: the sweep
         * raises a renewal invoice seven days ahead while the subscription is
         * still `active` and emails about it, so a paying customer arrived at
         * their billing page with a live invoice and nothing to press. The other
         * is a started-but-unpaid upgrade, which is how this was found.
         *
         * Suppressed once the transfer is signed, same as everywhere else — see
         * `paymentInFlight`.
         */}
        {billing.openInvoice && !billing.paymentInFlight ? (
          <>
            <p className="admin-note">
              <strong>
                {formatMoneyMinor(
                  billing.openInvoice.amountDueMinor,
                  billing.openInvoice.currency,
                )}
              </strong>{' '}
              is due for {billing.openInvoice.planName} — invoice #{billing.openInvoice.number}.
              {/* The consequence of the OTHER button in this row. It belongs
                  beside the choice, not in a separate card. */}
              {subscription.pendingPlanKey ? (
                <>
                  {' '}
                  Cancelling the change leaves you on {billing.planName} and returns any credit it
                  used.
                </>
              ) : null}
            </p>
            {billing.openInvoice.hostedUrl || actions ? (
              <div className="bannerActions">
                {billing.openInvoice.hostedUrl ? (
                  <a className="admin-btn primary" href={billing.openInvoice.hostedUrl}>
                    Pay{' '}
                    {formatMoneyMinor(
                      billing.openInvoice.amountDueMinor,
                      billing.openInvoice.currency,
                    )}
                  </a>
                ) : null}
                {actions}
              </div>
            ) : null}
          </>
        ) : null}

      </div>
    );
  }

  return (
    <div className="admin-card">
      <h2 className="admin-h">Free plan</h2>
      <p>
        You are on the Free plan. Upgrade for a bigger monthly allowance and more API keys.
      </p>
    </div>
  );
}

