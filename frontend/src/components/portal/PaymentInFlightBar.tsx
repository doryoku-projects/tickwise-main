'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatMoneyMinor } from '../../lib/format';
import { onPaymentStarted } from '../../lib/payment-events';
import { portalApi } from '../../lib/portal-api';

/** While a transfer is confirming. Fast enough to feel live, cheap enough to leave on. */
const POLL_MS = 8000;
/** How long "Payment confirmed" stays up before the bar retires itself. */
const SETTLED_MS = 6000;

/**
 * A payment is on its way — said on EVERY portal page, not just the one the
 * customer happened to be on when they signed.
 *
 * WHY IT LIVES IN THE SHELL. Settlement is server-side: the watcher polls the
 * chain every 30s and applies the payment whether or not anyone is looking. So
 * the customer can sign, close the tab, lose their connection, and come back to
 * the dashboard — and until now nothing anywhere would tell them a payment was
 * mid-flight. Worse, the billing page in that state offers a Pay button, which
 * on a rail with no refunds is an invitation to pay twice.
 *
 * The state is read from the SERVER (`BillingOverview.paymentInFlight`), never
 * from component state or storage, which is precisely what makes it survive a
 * refresh: the browser is not the thing that knows.
 *
 * It also announces the SETTLEMENT for a few seconds. A bar that simply
 * vanishes leaves the customer unsure whether it worked or whether they closed
 * the tab too early — and "it worked" is the whole thing they were waiting for.
 */
export function PaymentInFlightBar() {
  const pathname = usePathname();
  const [inFlight, setInFlight] = useState(false);
  const [justSettled, setJustSettled] = useState(false);
  /**
   * WHICH payment, and which plan it settled into. Without these the bar is
   * ambiguous in the one sequence people actually hit: pay for Standard, watch
   * it confirm, start a Pro upgrade — and the identical "Payment on its way"
   * comes back, which reads as the confirmation having been reversed. Reported
   * exactly that way: "initially when I paid it said confirmed, then I
   * refreshed and saw it was not."
   */
  const [forPlan, setForPlan] = useState('');
  const [amount, setAmount] = useState('');
  const [nowOn, setNowOn] = useState('');
  /** Confirmations, when the chain can be read. Blocks, never seconds. */
  const [progress, setProgress] = useState<{ confirmations: number; minConfirmations: number } | null>(
    null,
  );
  // Whether the previous poll saw a payment, so the transition can be detected
  // without re-rendering on every tick.
  const wasInFlight = useRef(false);

  const check = useCallback(async () => {
    try {
      const billing = await portalApi.billing();
      const now = Boolean(billing.paymentInFlight);
      setInFlight(now);
      setNowOn(billing.planName);
      if (now && billing.openInvoice) {
        setForPlan(billing.openInvoice.planName);
        setAmount(formatMoneyMinor(billing.openInvoice.amountDueMinor, billing.openInvoice.currency));
      }
      setProgress(
        billing.paymentProgress
          ? {
              confirmations: billing.paymentProgress.confirmations,
              minConfirmations: billing.paymentProgress.minConfirmations,
            }
          : null,
      );
      if (wasInFlight.current && !now) {
        setJustSettled(true);
        window.setTimeout(() => setJustSettled(false), SETTLED_MS);
      }
      wasInFlight.current = now;
    } catch {
      // Silent. This is an ambient indicator on every portal page — a billing
      // endpoint blip must not produce an error banner over somebody's API keys.
    }
  }, []);

  // Re-checked on navigation as well as on mount: the customer may have signed
  // on /portal/billing and walked to /portal/keys, and each page is a fresh
  // mount only because the shell persists across them.
  useEffect(() => {
    void check();
  }, [check, pathname]);

  useEffect(() => {
    if (!inFlight) return;
    const tick = window.setInterval(() => void check(), POLL_MS);
    return () => window.clearInterval(tick);
  }, [inFlight, check]);

  /*
   * A payment begun while this page is already open.
   *
   * The poll above only runs once the bar KNOWS something is in flight, so a
   * customer who signed in the dialog and then closed it saw nothing until they
   * navigated or refreshed — "I closed the modal and it did not show". The pay
   * flow announces the broadcast; this asks the server again straight away.
   * The server is still the source of truth, the event only changes WHEN it is
   * asked.
   */
  useEffect(() => onPaymentStarted(() => void check()), [check]);

  if (!inFlight && !justSettled) return null;

  const settled = !inFlight && justSettled;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 text-sm sm:px-6 ${
        settled
          ? 'border-success/30 bg-success/10 text-success'
          : 'border-primary/30 bg-primary/10 text-foreground'
      }`}
    >
      {settled ? (
        <CheckMark />
      ) : (
        /* The "gif", drawn in CSS. An actual image would be a fixed palette in a
           themeable UI, a network request, and one more thing to inline past the
           CSP — where two divs and a keyframe already read as motion. */
        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
        </span>
      )}

      {/*
       * THREE SEGMENTS, not one sentence.
       *
       * It read as a run-on: "$1 for Standard is on its way. 2 of 12
       * confirmations — 10 blocks to go. This finishes on its own, even if you
       * close this page." Three problems at once — "2 of 12" and "10 blocks to
       * go" are the SAME fact stated twice, the mono count broke the line's
       * rhythm mid-sentence, and the reassurance competed with the number for
       * the same reading weight.
       *
       * Now: what is happening (emphasis), how far along (a bar, because a
       * ratio is a shape before it is a number), and the reassurance (muted,
       * because it never changes). Separated by dots so the eye can skip
       * whichever it did not come for.
       */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {settled ? (
          <>
            <strong className="font-semibold">Payment confirmed.</strong>
            <span>{nowOn ? `You are on ${nowOn}.` : 'Your plan is active.'}</span>
          </>
        ) : (
          <>
            <strong className="font-semibold">
              {amount && forPlan ? `${amount} for ${forPlan} is on its way` : 'Payment on its way'}
            </strong>

            {progress ? (
              <>
                <Dot />
                {/* The bar carries the ratio; the digits are for anyone who
                    wants to compare against a block explorer. `tabular-nums`
                    so the count does not shift the layout as it climbs. */}
                <span className="flex items-center gap-2">
                  <span
                    className="h-1.5 w-16 overflow-hidden rounded-full bg-primary/20"
                    role="progressbar"
                    aria-valuenow={Math.min(progress.confirmations, progress.minConfirmations)}
                    aria-valuemin={0}
                    aria-valuemax={progress.minConfirmations}
                    aria-label="Confirmations"
                  >
                    <span
                      className="block h-full rounded-full bg-primary transition-[width] duration-500"
                      style={{
                        width: `${Math.min(100, Math.round((progress.confirmations / Math.max(1, progress.minConfirmations)) * 100))}%`,
                      }}
                    />
                  </span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {Math.min(progress.confirmations, progress.minConfirmations)}/
                    {progress.minConfirmations}
                  </span>
                </span>
              </>
            ) : null}

            <Dot />
            <span className="text-muted-foreground">Safe to close this page.</span>
          </>
        )}
      </span>

      {/* Not when you are already looking at it. The link is a shortcut from the
          other portal pages; on /portal/billing it points at the page it is
          sitting on. */}
      {!settled && pathname !== '/portal/billing' ? (
        <Link
          href="/portal/billing"
          className="ml-auto shrink-0 underline decoration-primary/40 underline-offset-4 hover:decoration-primary"
        >
          View billing
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Segment separator, ONE LINE ONLY.
 *
 * Hidden below `sm` because a separator cannot know it is at the end of a line:
 * once the bar wraps — which it does on a phone — the dot before the wrapped
 * segment is left dangling at the end of the previous one. Observed exactly
 * that: "…2/12 ·" with the tail on the next line. Where the segments stack,
 * the stacking IS the separation and the dot is noise.
 */
function Dot() {
  return (
    <span aria-hidden className="hidden text-muted-foreground/50 sm:inline">
      ·
    </span>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="9" className="stroke-current" strokeWidth="1.5" opacity="0.4" />
      <path
        d="M6 10.5l2.6 2.5L14 7.5"
        className="stroke-current"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
