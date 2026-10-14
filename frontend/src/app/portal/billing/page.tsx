'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { BillingBanner } from '../../../components/portal/BillingBanner';
import { ConfirmDialog } from '../../../components/portal/ConfirmDialog';
import { PayModal } from '../../../components/portal/PayModal';
import { InvoiceList } from '../../../components/portal/InvoiceList';
import { PlanPicker } from '../../../components/portal/PlanPicker';
import { ErrorNotice, SkeletonRows } from '../../../components/StateViews';
import { formatMoneyMinor, formatUtcDate } from '../../../lib/format';
import {
  portalApi,
  type BillingInvoice,
  type BillingOverview,
  type OnChainInstructions,
} from '../../../lib/portal-api';

/**
 * How long an acknowledgement stays on screen. Long enough to read a sentence
 * twice, short enough that it never reads as part of the page.
 */
const NOTICE_MS = 6000;

export default function PortalBillingPage() {
  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  /**
   * The open pay dialog, holding its OWN COPY of the instructions.
   *
   * Not read straight out of `billing` on every render, and that is deliberate:
   * the background poll replaces `billing` every 8 seconds, and when the payment
   * lands `openInvoice` disappears from it entirely. Driving the dialog from that
   * would tear it down — along with `SignToPay`'s connected wallet and issued
   * payload — at the exact moment it is showing the customer their confirmation.
   * A snapshot taken when they pressed "Pay" cannot be pulled out from under them.
   */
  const [payWith, setPayWith] = useState<OnChainInstructions | null>(null);
  /** Open when the customer has asked to cancel and not yet confirmed. */
  const [confirmCancel, setConfirmCancel] = useState(false);

  /**
   * Load the billing state.
   *
   * `silent` SKIPS THE LOADING SKELETON, and that is not a cosmetic option — it is
   * required for any BACKGROUND refresh. `loading` swaps the entire tree for
   * `<SkeletonRows>`, which UNMOUNTS `SignToPay` and destroys the wallet it had
   * connected and the payload it had issued; the panel then remounts at "Prepare
   * payment". A poll that did this every 8 seconds made the pay panel reset itself
   * over and over while the customer was trying to use it.
   *
   * A silent refresh still replaces `billing`, so the panel receives new props —
   * but it stays MOUNTED, so its own state survives. That is the whole difference.
   */
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError('');
    try {
      const [overview, history] = await Promise.all([portalApi.billing(), portalApi.billingInvoices()]);
      setBilling(overview);
      setInvoices(history);
    } catch (err) {
      // A failed BACKGROUND poll must not blank the page the customer is using;
      // the visible state is still valid and the next tick will try again.
      if (!opts?.silent) {
        setError(err instanceof Error ? err.message : 'Failed to load your billing');
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * REFRESH WHILE A PAYMENT IS IN FLIGHT.
   *
   * `SignToPay` polls for the payment IT started, but a customer can arrive here
   * with one already pending — they closed the tab, paid on their phone, or a
   * renewal invoice is sitting there. Without this the "payment in progress"
   * banner is a static claim that never resolves until somebody reloads, which is
   * exactly the "cannot tell it is alive" problem.
   *
   * Slower than the signing panel's poll (nobody is watching a spinner here) and
   * BOUNDED, because a tab left open overnight on a stalled payment should not
   * keep asking forever.
   */
  useEffect(() => {
    /*
     * KEYED ON THE INVOICE, NOT ON THE SUBSCRIPTION'S STATE.
     *
     * This tested `state === 'pending' || past_due`, which misses the case an
     * UPGRADE creates: the subscription stays `active` on the old plan while an
     * invoice for the new one is outstanding. So a customer who paid for Pro
     * watched the page keep saying Standard — `GET /account/billing` was already
     * answering `planKey: "pro"`, but only the portal-wide strip was asking, and
     * it keeps its answer to itself. The page had no reason to poll and no reason
     * to know.
     *
     * `openInvoice || paymentInFlight` covers every shape of "money is moving
     * against something this page is showing" — first checkout, renewal, grace
     * period, upgrade — and stops on its own when the invoice clears. The
     * ten-minute cap still bounds a tab left open on a stalled payment.
     */
    const watching = Boolean(billing?.openInvoice) || Boolean(billing?.paymentInFlight);
    if (!watching) return;
    const startedAt = Date.now();
    const tick = window.setInterval(() => {
      if (Date.now() - startedAt > 10 * 60 * 1000) {
        window.clearInterval(tick);
        return;
      }
      // SILENT — see `load`. A skeleton here would unmount the pay panel.
      void load({ silent: true });
    }, 8000);
    return () => window.clearInterval(tick);
    // Keyed on the two things that decide whether to watch, NOT on `billing` — the
    // object identity changes on every poll, which would restart the interval
    // before it ever fired.
  }, [Boolean(billing?.openInvoice), Boolean(billing?.paymentInFlight), load]);

  /**
   * A notice is an ACKNOWLEDGEMENT, so it clears itself.
   *
   * "Your checkout was cancelled — you are on the Free plan" is true for the
   * moment it takes to read; left on screen it becomes a permanent-looking card
   * competing with the plan table right underneath it, and the customer's next
   * action is to wonder whether it still applies. The state it describes is
   * already visible in the banner, so the sentence is transient by nature.
   *
   * Keyed on the TEXT, so a second notice restarts the clock instead of inheriting
   * the first one's remaining time, and the timer is cleared on unmount.
   */
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /**
   * `#plans` has to be honoured HERE, because the browser cannot — and it takes
   * more than one `scrollIntoView` to do it.
   *
   * The fragment resolves on load, when this page is still `PortalShell`'s
   * session skeleton or its own `<SkeletonRows>`: `#plans` does not exist, so the
   * native scroll silently does nothing and somebody arriving from the old
   * `/portal/billing/plans` URL (now a redirect carrying this fragment) lands at
   * the top of a page whose plan table is three screens down.
   *
   * **A single jump when the section mounts is not enough, and the reason is not
   * obvious: the scroll gets CLAMPED.** `PlanPicker` fetches its own catalogue,
   * so at the moment `#plans` first exists it holds a four-row skeleton and the
   * document is ~600px tall — `scrollTo` cannot go past `scrollHeight -
   * clientHeight`, so the browser silently lands at that maximum (measured: 145
   * of an eventual 805) and the position sticks while the real table grows the
   * page underneath it. Verified as an actual failure, not a hypothetical: the
   * first version of this effect left the section 708px below the fold. So the
   * target is re-asserted each frame until it reaches the top, for a bounded
   * window.
   *
   * Two things stop it becoming a page that fights its reader: any deliberate
   * input (wheel, touch, key) abandons the chase immediately, and it runs once
   * per arrival — `billing` is replaced by the 8-second poll while a payment is
   * pending, and a repeating effect would drag the page back down every tick,
   * under somebody reading the invoice table, possibly with a `PayModal` open
   * over it.
   *
   * **The once-only guard is the CONSUMED FRAGMENT, not a `useRef` latch, and
   * that is not a style choice.** A ref set at the top of the effect is defeated
   * by StrictMode's double invocation in dev: pass one starts the loop, its
   * cleanup cancels it, and pass two finds the latch already set and does
   * nothing at all — so the chase silently never happens (observed exactly that
   * way; the section stayed 708px below the fold). Clearing `#plans` from the URL
   * only once the chase has actually FINISHED makes the effect restartable and
   * idempotent: cleanup cancels but leaves the fragment, so a second pass redoes
   * the work, while every later re-render sees no fragment and stands down.
   */
  useEffect(() => {
    if (!billing) return;
    if (window.location.hash !== '#plans') return;

    let cancelled = false;
    let frame = 0;
    /** Stop chasing AND give up the fragment — the arrival is over. */
    const settle = () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      const { pathname, search } = window.location;
      window.history.replaceState(null, '', pathname + search);
    };
    window.addEventListener('wheel', settle, { passive: true });
    window.addEventListener('touchstart', settle, { passive: true });
    window.addEventListener('keydown', settle);

    // Long enough to outlast the catalogue fetch on a cold cache, short enough
    // that a page which can never satisfy the request stops trying.
    const deadline = Date.now() + 1500;
    const step = () => {
      if (cancelled) return;
      const section = document.getElementById('plans');
      if (section) {
        // A few px of slack: sub-pixel layout means `top` rarely settles at 0.
        if (section.getBoundingClientRect().top <= 4) {
          settle();
          return;
        }
        section.scrollIntoView({ block: 'start' });
      }
      if (Date.now() < deadline) frame = window.requestAnimationFrame(step);
      else settle();
    };
    frame = window.requestAnimationFrame(step);

    return () => {
      // Cancels, but deliberately does NOT consume the fragment — see above.
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener('wheel', settle);
      window.removeEventListener('touchstart', settle);
      window.removeEventListener('keydown', settle);
    };
  }, [billing]);

  /**
   * The cancellation copy, by state — THREE cases, not two.
   *
   * A `pending` (never-paid) checkout has no period to keep, so telling that
   * customer they "keep full access until the end of the period you paid for" is
   * nonsense; and on a crypto rail the warning NOT to cancel a transfer already in
   * flight is the single most valuable sentence on the screen. `past_due` is the
   * third: the paid period has ALREADY ended and they are inside the grace window,
   * so the paid-plan promise describes a date in the past and reads as "access ends
   * now" — the grace deadline is what is actually true there.
   *
   * Returned as nodes rather than a string precisely because this used to go
   * through `window.confirm`, which flattens it: no emphasis on the "do NOT
   * cancel", the origin as the title, and no way to theme it.
   */
  function cancelPrompt(): { title: string; body: React.ReactNode; confirmLabel: string } {
    if (billing?.state === 'pending') {
      return {
        title: 'Cancel this checkout?',
        confirmLabel: 'Cancel checkout',
        body: (
          <>
            <p>You have not paid yet, so nothing is charged and you stay on the Free plan.</p>
            <p className="confirmWarn">
              <strong>If you have already sent a payment that has not confirmed yet, do not cancel.</strong>{' '}
              It will still apply when it lands, and this rail cannot send it back.
            </p>
          </>
        ),
      };
    }
    if (billing?.state === 'past_due') {
      return {
        title: 'Cancel your subscription?',
        confirmLabel: 'Cancel subscription',
        body: (
          <>
            <p>This invoice is unpaid, so there is no paid period left to keep.</p>
            <p>
              Your access continues{' '}
              {billing.subscription?.graceEndsAt ? (
                <>
                  until <strong>{formatUtcDate(billing.subscription.graceEndsAt)}</strong>
                </>
              ) : (
                'for the rest of the grace period'
              )}
              , then your account moves to the Free plan. Your API keys keep working at Free limits.
            </p>
          </>
        ),
      };
    }
    return {
      title: 'Cancel your subscription?',
      confirmLabel: 'Cancel subscription',
      body: (
        <>
          <p>You keep full access until the end of the period you have already paid for.</p>
          <p>
            After that your account moves to the Free plan, and your API keys keep working at Free limits.
          </p>
        </>
      ),
    };
  }

  async function cancel() {
    setConfirmCancel(false);
    // Nothing left to pay — and `cancel` ends in a NON-silent `load()`, whose
    // skeleton would tear the dialog down anyway.
    setPayWith(null);
    setBusy(true);
    setNotice('');
    try {
      const { endsAt, immediate } = await portalApi.cancelSubscription();
      setNotice(
        immediate
          ? 'Your checkout was cancelled — you are on the Free plan.'
          : `Your subscription will end on ${formatUtcDate(endsAt)}.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel the subscription');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Open the pay dialog AND re-read billing.
   *
   * Starting a checkout creates an invoice SERVER-SIDE — and until now nothing
   * told this page about it. `onInstructions` only opened the dialog, so a
   * customer who pressed "Switch to Pro" and then closed the dialog without
   * paying was looking at a page that still believed there was nothing owed:
   * no "$1.01 is due for Pro", no Pay button, no "Cancel the change to pro",
   * until they reloaded. The invoice existed the whole time.
   *
   * Silent, for the reason `load` documents: a non-silent refresh swaps the
   * subtree for a skeleton, which would unmount the dialog this just opened
   * along with the wallet it has connected.
   */
  const openPayDialog = useCallback(
    (next: OnChainInstructions) => {
      setPayWith(next);
      void load({ silent: true });
    },
    [load],
  );

  async function cancelChange() {
    setBusy(true);
    setError('');
    try {
      const { planKey } = await portalApi.cancelPendingChange();
      setNotice(`The pending change was cancelled. You are still on ${planKey}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel the change');
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    setBusy(true);
    setNotice('');
    try {
      const { renewsAt } = await portalApi.resumeSubscription();
      setNotice(`Your subscription will continue and renews on ${formatUtcDate(renewsAt)}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resume the subscription');
    } finally {
      setBusy(false);
    }
  }

  // What there is to pay, if anything. Present for BOTH shapes the rail can
  // return — a new `authorization` and a legacy `deposit` — because the dialog
  // handles both and the button that opens it should not care which.
  const instructions = billing?.openInvoice?.instructions ?? null;
  const currency = billing?.openInvoice?.currency ?? 'USD';

  return (
    <div>
      <div className="portalHead">
        <div>
          <h1>Billing</h1>
          <p>
            Your plan, your invoices and your payment history. Coverage is Uniswap v4 on Ethereum,
            Arbitrum and Avalanche — <Link href="/pricing">see what each plan includes</Link>.
          </p>
        </div>
        {/* No "Plans" button up here any more. It sat in the page header where
            it said the same thing to everybody, while the card directly below
            already knows whether this customer is on Free, mid-checkout, lapsed
            or paying — so the call to action belongs THERE, worded for the case
            it is in ("See plans" vs "Change plan"). See BillingBanner. */}
      </div>

      {loading ? (
        <div className="admin-card">
          <SkeletonRows rows={4} />
        </div>
      ) : error ? (
        <ErrorNotice message={error} onRetry={() => void load()} />
      ) : billing ? (
        <>
          {/* THE PAY ACTIONS LIVE IN THE BANNER, not in a panel below it. There is
              one thing to do with an unpaid invoice and one thing to do with a
              checkout you have changed your mind about, and both belong next to
              the sentence that describes the situation — a separate "Manage" card
              repeating the same cancel button read as a second, different action. */}
          {/* ONE CARD for the whole plan story: what you are on, what you can
              do about it, and what you could move to. They were three separate
              cards saying "the plans are just below" and then making you scroll
              past invoices to find them. Nested `.admin-card`s inside collapse to
              plain sections — see the `tw-bridge` rule in app.css. */}
          <div className="admin-card">
          <BillingBanner
            billing={billing}
            actions={
              /* TWO INDEPENDENT CONDITIONS, and they must stay independent. Gating
                 both on `instructions` was a regression: a pending checkout whose
                 invoice has no live instructions — the state
                 `SubscriptionSweepService` re-mints a checkout for — would then
                 offer no way to abandon it either, which is the one action always
                 available to somebody who has paid nothing. */
              instructions || billing.state === 'pending' ? (
                <>
                  {/* NOT while a payment is already on its way. A customer who
                      refreshed during confirmation lands right back here, and
                      the button they see is an invitation to send the money a
                      SECOND time for an invoice the first transfer is about to
                      settle — on a rail that cannot refund. Refreshing never
                      loses a payment (the watcher settles server-side); it
                      loses the knowledge that money is coming, and
                      `paymentInFlight` is that knowledge restored. */}
                  {instructions && !billing.paymentInFlight ? (
                    <button
                      className="admin-btn primary"
                      type="button"
                      onClick={() => setPayWith(instructions)}
                    >
                      Pay {formatMoneyMinor(billing.openInvoice?.amountDueMinor ?? 0, currency)}
                    </button>
                  ) : null}
                  {/* Only for a checkout that has never been paid. Cancelling a
                      LIVE subscription is a different decision with different
                      consequences, and it keeps its own card below. */}
                  {/* NOT once the transfer is signed. Abandoning then is not a
                      no-op — the money cannot be recalled, so it lands on a
                      subscription that is by then `incomplete_expired`, the
                      fold refuses `subscription-not-live`, and the customer
                      ends up on Free holding the payment as CREDIT instead of
                      on the plan they just paid for. The backend refuses it
                      too; this stops us offering it in the first place. */}
                  {/* Beside Pay, not in a card further down. The two things you
                      can do about an unpaid change are pay it or drop it, and
                      splitting them across the page made the second look like a
                      different decision — it also put "Cancel" nearer to
                      "Cancel subscription", which is a genuinely different one. */}
                  {billing.subscription?.pendingPlanKey && !billing.paymentInFlight ? (
                    <button
                      className="admin-btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => void cancelChange()}
                    >
                      {busy ? 'Working…' : `Cancel the change to ${billing.subscription.pendingPlanKey}`}
                    </button>
                  ) : null}
                  {billing.state === 'pending' && !billing.paymentInFlight ? (
                    <button
                      /* `ghost`: this sits NEXT TO the Pay button, and `.admin-btn`
                         alone is the same accent fill as `primary` (which is not a
                         real class in this app's CSS) — so "Pay $1" and "Cancel
                         checkout" were two identical teal buttons side by side. */
                      className="admin-btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmCancel(true)}
                    >
                      {busy ? 'Working…' : 'Cancel checkout'}
                    </button>
                  ) : null}
                </>
              ) : null
            }
            manage={
              /* NOT for `pending`. A never-paid checkout has no period to keep
                 and no subscription to end, so the paid-plan copy ("you keep
                 access until the end of the period you paid for") is untrue for
                 it — its one honest action, abandoning the checkout, is in
                 `actions` beside the Pay button where the decision is made. */
              billing.subscription && billing.state !== 'pending' ? (
                billing.subscription.cancelAtPeriodEnd ? (
                  /* The end date is NOT repeated here — the banner's own line
                     already reads "— ending on <date>" for this exact state, and
                     saying it twice in one card is how the two get to disagree.
                     A bare button also keeps the slot to one row. */
                  <button className="admin-btn primary" disabled={busy} onClick={() => void resume()}>
                    {busy ? 'Working…' : 'Keep my subscription'}
                  </button>
                ) : (
                  <button
                    className="admin-btn ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmCancel(true)}
                  >
                    {busy ? 'Working…' : 'Cancel subscription'}
                  </button>
                )
              ) : null
            }
          />

          {notice ? (
            <div className="admin-card">
              <p>{notice}</p>
            </div>
          ) : null}

          {billing.creditBalanceMinor > 0 ? (
            <div className="admin-card">
              <h2 className="admin-h">Account credit</h2>
              <p>
                <strong>{formatMoneyMinor(billing.creditBalanceMinor)}</strong> is held on your account and
                will be applied automatically to your next invoice.
              </p>
              {/* Said plainly, because a crypto rail cannot send money back and
                  finding that out at the point of asking is worse. */}
              <p className="admin-note">Credit reduces future invoices. It is not refundable to a wallet.</p>
            </div>
          ) : null}

          {/* PLANS INLINE, always. The old "See plans" card was a button whose only
              job was to navigate somewhere else — shown, of all places, to a
              customer with no active plan, on the page about their plan. The
              catalogue IS the answer to "you are on the Free plan", so it belongs
              here rather than one click away. `PlanPicker` is the same component
              /portal/billing/plans renders, so the buy behaviour cannot drift. */}
          <PlanPicker
            /* On the picker itself, NOT on a wrapper `<div id="plans">`: the
               nested-card collapse rule that separates the sections of this card
               is `.admin-card + .admin-card`, and an intervening element broke
               that adjacency — the heading ended up flush against the paragraph
               above it with no rule and no space. */
            id="plans"
            currentPlanKey={billing.planKey}
            onInstructions={openPayDialog}
            onSettled={(text) => {
              setNotice(text);
              void load();
            }}
            heading={<PlansHeading billing={billing} />}
          />
          </div>

          <div className="admin-card">
            <h2 className="admin-h">Invoices</h2>
            {/* `paymentInFlight` gates this list exactly as it gates the banner's
                Pay button. Without it the two disagreed on the SAME invoice:
                the banner correctly said "your transfer has been sent" and hid
                its Pay, while the invoice row a few hundred pixels below still
                offered one — which is the double-payment invitation the banner
                gate exists to remove, reached by a different button. */}
            <InvoiceList
              invoices={invoices}
              payableInvoiceId={
                instructions && !billing.paymentInFlight ? billing.openInvoice?.id : null
              }
              onPay={
                instructions && !billing.paymentInFlight ? () => setPayWith(instructions) : undefined
              }
            />
          </div>

        </>
      ) : null}

      {/* OUTSIDE the loading / error / billing branch, on purpose. Inside it, a
          non-silent `load()` would swap the whole subtree for `<SkeletonRows>` and
          unmount the dialog — taking the connected wallet and the issued payload
          with it. Out here only `payWith` can close it. */}
      {payWith ? (
        <PayModal
          instructions={payWith}
          onPaid={() => {
            // Silent: the dialog is still open showing "Payment sent", and a
            // skeleton behind it would unmount the thing the customer is reading.
            void load({ silent: true });
          }}
          onClose={() => {
            setPayWith(null);
            // The customer may have signed, or abandoned, or simply looked. The
            // page cannot tell from here, so it re-reads rather than guessing —
            // silently, since a skeleton would blank a page that is still valid.
            void load({ silent: true });
          }}
        />
      ) : null}

      {/* Also outside the branch, for the same reason: `cancel` ends in a
          non-silent `load()`, and a skeleton must not delete the dialog that is
          reporting the result. */}
      {confirmCancel ? (
        <ConfirmDialog
          {...cancelPrompt()}
          danger
          cancelLabel="Keep it"
          onConfirm={() => cancel()}
          onCancel={() => setConfirmCancel(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * The heading over the plan catalogue, written for the state the customer is in.
 *
 * It was the word "Plans" — a label, sitting directly under a sentence that had
 * just told them they were on the Free plan, saying nothing that sentence had not
 * already said. The catalogue means something different in each state: an upgrade
 * path on Free, a comparison on a paid plan, and on `pending`/`past_due` a thing
 * to leave alone until the open invoice is settled. That last case matters
 * beyond tone — choosing a plan with a payment in flight comes back as a 409 and
 * reopens the SAME checkout (see `PlanPicker.choose`), so saying so up front is
 * cheaper than letting them find out by clicking.
 */
function PlansHeading({ billing }: { billing: BillingOverview }) {
  const copy = ((): { title: string; blurb: string } => {
    switch (billing.state) {
      case 'active':
        return {
          title: 'Room to grow',
          blurb: `You are on ${billing.planName}. Move up for more units and a higher rate limit, or step down and keep what you have already paid for.`,
        };
      case 'pending':
        return {
          title: 'The rest of the catalogue',
          blurb:
            'Finish the payment above first — choosing again reopens that same checkout rather than starting a second one.',
        };
      case 'past_due':
        return {
          title: 'The rest of the catalogue',
          blurb:
            'Clear the outstanding invoice above first. Changing plan while one is unpaid reopens the same checkout.',
        };
      case 'ended':
        return {
          title: 'Pick a plan back up',
          blurb:
            'Your keys are still working at Free limits. Choose a plan whenever you want the bigger allowance back.',
        };
      default:
        return {
          title: 'Outgrow the Free plan',
          blurb: 'Free is enough to build against. These are the plans that carry production traffic.',
        };
    }
  })();

  return (
    <div className="mb-4">
      <h2 className="admin-h">{copy.title}</h2>
      <p className="admin-note">{copy.blurb}</p>
    </div>
  );
}

