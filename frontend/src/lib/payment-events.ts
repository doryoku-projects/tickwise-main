/**
 * "A payment just started" — from the pay dialog to the portal-wide strip.
 *
 * WHY AN EVENT AND NOT PROPS. `PaymentInFlightBar` lives in `PortalShell` and
 * the dialog lives inside a page, so there is no component relationship between
 * them; threading a callback would mean every page that can open the dialog
 * also knowing about the shell's strip. And polling is the wrong shape: the bar
 * only polls once it KNOWS something is in flight, so a payment begun while the
 * page is already open was invisible to it until the next navigation or
 * refresh — which is exactly the "I closed the modal and nothing happened"
 * report this fixes.
 *
 * A `window` event rather than a store because the two ends are in different
 * React trees only by accident of layout, and the signal carries no data — it
 * means "ask the server again, now". The server remains the source of truth;
 * this only changes WHEN it is asked.
 */
const PAYMENT_STARTED = 'tickwise:payment-started';

/** Called by the pay flow the moment a transfer is broadcast. */
export function announcePaymentStarted(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PAYMENT_STARTED));
}

/** Returns an unsubscribe function, for a `useEffect` cleanup. */
export function onPaymentStarted(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(PAYMENT_STARTED, listener);
  return () => window.removeEventListener(PAYMENT_STARTED, listener);
}
