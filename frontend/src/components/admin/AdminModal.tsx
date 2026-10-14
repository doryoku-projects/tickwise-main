'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The admin overlay: a panel that belongs to ONE row, on its own layer.
 *
 * WHY, on the clients list specifically. The Manage panel is taller than the
 * viewport — plan control, key issuing, the keys grid, the metered usage detail
 * and the monthly rollup — and rendering it as a second `<tr>` pushed every
 * client below it off the screen, so opening one row destroyed the list the
 * operator was reading. Lifting it out changes nothing about the panel and
 * everything about the page behind it: the table stays exactly where it was, and
 * closing puts the operator back on the same row with no scroll jump to undo.
 *
 * Modelled on `PayModal` — same trap, same `inert` sweep, same scroll lock —
 * but deliberately NOT shared with it. That dialog's dismissal is gated on a
 * wallet interaction in flight and its restore-focus fallback is a portal
 * heading; folding both into one shell would put the payment rules one prop away
 * from a surface that has no payments.
 *
 * ── DISMISSAL ───────────────────────────────────────────────────────────────
 *
 * Escape, the backdrop, and the close button all call `onClose`, which is the
 * caller's guarded close — on the clients list that is `closeRow`, and it asks
 * before discarding a freshly issued key. So dismissal here is a REQUEST, not a
 * guarantee: the caller decides whether the panel actually goes away.
 */
export function AdminModal({
  labelledBy,
  onClose,
  children,
}: {
  /** Id of the heading inside `children`; the dialog is named by it. */
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Read by handlers registered once, so a new `onClose` identity on every
  // parent render does not re-bind the document listener.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;

    const restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The card, not the close button: focus must move inside for the dialog to be
    // announced, but landing on the dismiss control arms Enter to close the panel
    // the operator just opened. `tabindex="-1"` takes focus without joining the
    // tab order, so the first Tab goes to Close as it would in any dialog.
    cardRef.current?.focus();

    // Everything off the dialog's path out of the tab order AND the a11y tree.
    // `inert` inherits, so one attribute per branch covers its whole subtree;
    // anything already inert is left alone so we never clear someone else's flag.
    const inerted: HTMLElement[] = [];
    for (let child: HTMLElement = backdrop; child !== document.body; ) {
      const parent = child.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === child || !(sibling instanceof HTMLElement)) continue;
        if (sibling.hasAttribute('inert')) continue;
        sibling.setAttribute('inert', '');
        inerted.push(sibling);
      }
      child = parent;
    }

    // The list behind must not scroll under the dialog; the dialog scrolls itself.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // `inert` does not cycle focus on its own. Capture phase on the document, so
    // it still fires if focus has somehow escaped the card.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !backdrop) return;
      const stops = Array.from(backdrop.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) {
        event.preventDefault();
        cardRef.current?.focus();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      // `isStop`, not merely "inside the dialog": the card itself is focused on
      // open and is not a tab stop, so a plain `contains()` test would let
      // Shift-Tab from the card walk straight out of the dialog.
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
      // `inert` off FIRST — the restore target is inside one of these subtrees
      // and is unfocusable until the flag is gone.
      for (const el of inerted) el.removeAttribute('inert');
      /*
       * Back to the opener — the row's own Manage button — but only if it is
       * still in the document. Turning the page or reloading the list replaces
       * that row, and `focus()` on a detached node is a silent no-op that parks
       * `activeElement` on `<body>`, restarting the next Tab at the top of the
       * page. `document.body` itself is excluded for the same reason: it is what
       * `activeElement` reports when nothing is focused.
       */
      if (
        restoreFocusTo &&
        restoreFocusTo !== document.body &&
        restoreFocusTo.isConnected &&
        !restoreFocusTo.hasAttribute('disabled')
      ) {
        restoreFocusTo.focus();
      }
    };
  }, []);

  return (
    <div
      className="adminModalBackdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      ref={backdropRef}
      onMouseDown={(event) => {
        // The BACKDROP only — not a text drag inside the card that happens to
        // release out here.
        if (event.target !== event.currentTarget) return;
        onClose();
      }}
    >
      <div className="adminModalCard" ref={cardRef} tabIndex={-1}>
        <button className="adminModalClose" type="button" onClick={onClose} aria-label="Close" title="Close">
          <X size={16} />
        </button>
        {children}
      </div>
    </div>
  );
}
