'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PayInstructions } from './PayInstructions';
import { SignToPay } from './SignToPay';
import type { OnChainInstructions } from '../../lib/portal-api';
import { WALLET_OVERLAY_TAGS } from '../../lib/wallet';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The pay surface as a dialog.
 *
 * WHY A DIALOG AT ALL. Paying is a single errand with one outcome, and inline it
 * had to share a page with the banner that says a payment is in progress, the
 * card that offers to cancel it, and the invoice table — so the panel that
 * actually takes the money read as one more block of text. On its own layer it is
 * the only thing on screen, which is also what lets the page behind it keep
 * refreshing without competing for attention.
 *
 * ── IT MUST NOT UNMOUNT WHILE IT IS OPEN ────────────────────────────────────
 *
 * `SignToPay` holds the connected wallet and the server-issued payload in its own
 * state. Unmounting it throws both away and drops the customer back to "Prepare
 * payment" — which is exactly the bug the billing page's `load({ silent: true })`
 * exists to avoid. So the caller must render this from state that a background
 * refresh cannot touch, and must render it OUTSIDE any `loading ? <Skeleton/> :`
 * branch. Both pages capture the instructions into their own state for that
 * reason rather than reading them out of the freshly-polled overview.
 *
 * ── DISMISSAL ───────────────────────────────────────────────────────────────
 *
 * Dismissible — Escape, the backdrop and an explicit close button — but NOT while
 * a wallet interaction is in flight. `SignToPay` reports that through
 * `onBusyChange`, and while it is true a stray click or a reflexive Escape would
 * throw away a payload the customer is part-way through signing. Nothing here can
 * lose money: everything signed is already on the server, and a payment that has
 * been broadcast applies whether this dialog is open or not.
 *
 * Deliberately NOT sharing an implementation with `KeyReveal`, which traps focus
 * the same way but must never be dismissible by anything except its own button.
 * A shared shell would put that dismissal one prop away from the one screen whose
 * entire correctness depends on not having it.
 */
export function PayModal({
  instructions,
  onPaid,
  onClose,
}: {
  instructions: OnChainInstructions;
  onPaid: () => void;
  onClose: () => void;
}) {
  /** The wallet interaction in flight, as its own label; '' when idle. */
  const [busyLabel, setBusyLabel] = useState('');
  const busy = Boolean(busyLabel);
  const backdropRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Read by handlers that must not be re-registered on every keystroke of state.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;

    const restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // THE CARD, not the close button. Focus has to move inside for the dialog to
    // be announced and for the trap to have somewhere to start, but landing it on
    // the dismiss control arms Enter to throw the payment away and paints a focus
    // ring on the one thing we least want emphasised. The card is `tabindex="-1"`,
    // so it takes focus programmatically without joining the tab order — first Tab
    // then goes to Close, as it would from the top of any dialog.
    cardRef.current?.focus();

    // Take the rest of the document out of the tab order AND the a11y tree by
    // marking every off-path sibling `inert` (it inherits, so one attribute per
    // branch covers the subtree). Anything already inert is left alone so we
    // never clear somebody else's flag.
    const inerted: HTMLElement[] = [];
    for (let child: HTMLElement = backdrop; child !== document.body; ) {
      const parent = child.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === child || !(sibling instanceof HTMLElement)) continue;
        if (sibling.hasAttribute('inert')) continue;
        // NEVER the wallet's own overlays. `inert` crosses into a shadow root, so
        // marking `<onboard-v2>` would make the wallet picker unclickable even
        // once it paints on top — and this dialog exists to open that picker.
        // Reachable whenever the stack is already booted: a second open, or a
        // wallet sign-in earlier in the session. See WALLET_OVERLAY_TAGS.
        if (WALLET_OVERLAY_TAGS.includes(sibling.tagName)) continue;
        sibling.setAttribute('inert', '');
        inerted.push(sibling);
      }
      child = parent;
    }

    // The page behind must not scroll under the dialog; the dialog scrolls itself.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // `inert` does not cycle focus on its own. Capture phase, on the document, so
    // it still fires if focus has somehow escaped the card.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        // Never mid-signature — see the dismissal note above.
        if (busyRef.current) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !backdrop) return;
      const stops = Array.from(backdrop.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) {
        // REACHABLE, and it used to be a dead end. While a wallet prompt is open
        // the close button is disabled and the panel renders no other control, so
        // the dialog has NO tab stops — and merely swallowing Tab left focus
        // wherever it was, usually `<body>` after the disabled button blurred.
        // Park it on the card so the dialog keeps focus and a screen reader stays
        // in context instead of reading the (inert) page.
        event.preventDefault();
        cardRef.current?.focus();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      // `isStop`, not merely "inside the dialog". The card itself is focused on
      // open and is NOT a tab stop, so a plain `contains()` test would leave the
      // browser to pick the next element by document order — which on Shift-Tab
      // from the card means walking out of the dialog entirely.
      const isStop = active instanceof HTMLElement && stops.includes(active);
      if (event.shiftKey ? !isStop || active === first : !isStop || active === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      // Before focusing anything: `inert` must come off first, or the restore
      // target is still unfocusable.
      for (const el of inerted) el.removeAttribute('inert');
      /**
       * RESTORE FOCUS TO SOMETHING THAT STILL EXISTS.
       *
       * The opener is usually the "Pay $X" button — and the successful path
       * DELETES it: settlement clears `openInvoice`, so the button unmounts while
       * the dialog is still open. `focus()` on a detached node is a silent no-op
       * that leaves `document.activeElement` on `<body>`, so the next Tab restarts
       * at the top of the document. That is the most common exit, not an edge case.
       */
      const opener =
        restoreFocusTo &&
        restoreFocusTo !== document.body &&
        restoreFocusTo.isConnected &&
        !restoreFocusTo.hasAttribute('disabled')
          ? restoreFocusTo
          : null;
      // `document.body` is excluded deliberately: it is what `activeElement`
      // reports when nothing is focused, it is always connected, and focusing it
      // is a silent no-op — so without this it would pass the guard and suppress
      // the fallback, leaving focus nowhere at all.
      if (opener) {
        opener.focus();
        return;
      }
      // A stable anchor that outlives any invoice: the page heading. `focus()`
      // needs it focusable, and `tabindex="-1"` keeps it out of the tab order.
      const heading = document.querySelector<HTMLElement>('.portalHead h1');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus();
      }
    };
  }, []);

  return (
    <div
      className="payModalBackdrop"
      role="dialog"
      aria-modal="true"
      // Labelled by the panel's own heading, which changes with the stage
      // ("Pay with USDC" → "Confirming your payment" → "Payment sent"). A fixed
      // title in this header would contradict it.
      aria-label="Payment"
      aria-busy={busy}
      ref={backdropRef}
      onMouseDown={(event) => {
        // The BACKDROP only, not a drag that happens to end there.
        if (event.target !== event.currentTarget || busy) return;
        onClose();
      }}
    >
      <div className="payModalCard" ref={cardRef} tabIndex={-1}>
        <button
          className="payModalClose"
          type="button"
          disabled={busy}
          onClick={onClose}
          aria-label="Close"
          title={busy ? 'Finish or cancel the request in your wallet first' : 'Close'}
        >
          <X size={16} />
        </button>

        {/* Why the wallet has taken over, announced. The same text is already the
            disabled button's label, and a disabled control's label change is not
            re-announced — so without this the dialog simply goes silent and
            undismissable with no stated reason. */}
        <p className="srOnly" role="status" aria-live="polite">
          {busyLabel}
        </p>

        {/* The same two shapes the pages branch on, kept here so there is ONE
            entry point to paying: an `authorization` gets the sign-to-pay flow, a
            legacy `deposit` invoice its address panel. */}
        {instructions.kind === 'authorization' ? (
          <SignToPay instructions={instructions} onPaid={onPaid} onBusyChange={setBusyLabel} />
        ) : (
          <PayInstructions instructions={instructions} />
        )}
      </div>
    </div>
  );
}
