'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorNotice, SkeletonRows } from '../../../../components/StateViews';
import { formatMoneyMinor } from '../../../../lib/format';
import { portalApi, type CheckoutStatus } from '../../../../lib/portal-api';

/** How often to re-ask while a transfer is unconfirmed. */
const POLL_MS = 5000;
/**
 * How long to keep asking. A crypto confirmation is usually seconds and
 * occasionally minutes; past this the honest thing is to stop spinning and say
 * "we will email you", because the reconcile job on the server WILL pick it up
 * whether or not this tab is open.
 */
const POLL_CEILING_MS = 5 * 60_000;

/**
 * The checkout return page.
 *
 * ── IT DOES NOT REQUIRE A SESSION ─────────────────────────────────────────
 *
 * The customer arrives here FROM THE PAYMENT RAIL, and for a crypto rail that
 * very often means a wallet's in-app browser — a different browsing context
 * with no `tk-portal-token` at all. Authority comes from the `?t=` capability
 * the rail's return URL carries, and the status call goes over the token-less
 * client. `/portal/checkout/return` is in `PORTAL_PUBLIC_PATHS` and the portal
 * layout skips its shell here, so nothing bounces this browser to /login. A
 * login form shown to somebody who has just paid reads as the payment failing.
 *
 * ── `pending` MUST NEVER CLAIM SUCCESS ────────────────────────────────────
 *
 * A transfer is broadcast long before it confirms and the rail redirects the
 * moment it is sent, so `pending` is the COMMONEST state on arrival. Rendering
 * a tick for it means the customer closes the tab believing they are on Pro;
 * if the transfer then underpays or fails, they find out when their keys start
 * 429ing. Every state below says exactly what is true right now.
 */
export function CheckoutReturnClient() {
  const params = useSearchParams();
  const invoiceId = params.get('invoice') ?? '';
  const token = params.get('t') ?? '';

  const [status, setStatus] = useState<CheckoutStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [gaveUp, setGaveUp] = useState(false);
  const startedAt = useRef(Date.now());

  const load = useCallback(async () => {
    if (!invoiceId || !token) {
      setError('That link is missing part of its address. Open Billing to see where your payment stands.');
      setLoading(false);
      return;
    }
    try {
      setStatus(await portalApi.checkoutStatus(invoiceId, token));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check your payment');
    } finally {
      setLoading(false);
    }
  }, [invoiceId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while there is something to wait for. `paid`, `closed` and
  // `short` are settled answers — re-asking would just burn requests.
  useEffect(() => {
    if (!status) return;
    if (status.state !== 'pending' && status.state !== 'awaiting') return;
    if (Date.now() - startedAt.current > POLL_CEILING_MS) {
      setGaveUp(true);
      return;
    }
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [status, load]);

  if (loading) {
    return (
      <div className="admin-card">
        <SkeletonRows rows={3} />
      </div>
    );
  }
  if (error) {
    return <ErrorNotice message={error} onRetry={() => void load()} />;
  }
  if (!status) return null;

  return (
    <div className="admin-card space-y-3">
      <h1 className="font-display text-lg font-semibold">{TITLES[status.state]}</h1>
      <p className="text-muted-foreground">{body(status, gaveUp)}</p>

      {status.state === 'short' ? (
        <p className="mono">
          Received {formatMoneyMinor(status.amountPaidMinor, status.currency)} of{' '}
          {formatMoneyMinor(status.amountDueMinor, status.currency)} —{' '}
          {formatMoneyMinor(status.shortfallMinor, status.currency)} still due.
        </p>
      ) : null}

      <p>
        <Link className="admin-btn primary" href="/portal/billing">
          Go to billing
        </Link>
      </p>

      {status.state === 'pending' || status.state === 'awaiting' ? (
        <p className="admin-note">
          You can close this page. We check for the payment on our side too, and we will email you when it
          lands — you do not need to keep this tab open, and you must not pay a second time.
        </p>
      ) : null}
    </div>
  );
}

const TITLES: Record<CheckoutStatus['state'], string> = {
  paid: 'Payment received',
  // Note what these are NOT called. "Success", "Thank you" and a green tick all
  // assert something that has not happened yet.
  pending: 'Waiting for your payment to confirm',
  awaiting: 'We have not seen your payment yet',
  short: 'Your payment was short',
  closed: 'This invoice is closed',
};

function body(status: CheckoutStatus, gaveUp: boolean): string {
  switch (status.state) {
    case 'paid':
      return `Your ${status.planName} plan is active. Your new limits apply immediately.`;
    case 'pending':
      return gaveUp
        ? `Your transfer has not confirmed yet. This can take longer when the network is busy — we will apply it and email you as soon as it lands.`
        : `We can see your transfer and it has not confirmed yet. Your ${status.planName} plan starts the moment it does.`;
    case 'awaiting':
      return gaveUp
        ? 'We have not seen a payment for this invoice. If you sent one, it will be applied automatically when it arrives.'
        : 'Nothing has arrived for this invoice yet. If you have just sent it, this usually takes a few moments.';
    case 'short':
      // The actionable one: they are NOT on the plan, and the fix is a top-up
      // rather than paying the whole amount again.
      return `Less arrived than the invoice asked for, so your ${status.planName} plan has not started. Send the remaining amount to the same invoice and it will settle.`;
    case 'closed':
      return 'This invoice is no longer payable. Open Billing to see your current plan and any invoice that is outstanding.';
    default:
      return '';
  }
}
