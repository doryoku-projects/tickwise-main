'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { WALLET_OVERLAY_TAGS } from '../lib/wallet';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The chrome every dialog in this app needs, in one place: focus trapped inside
 * it, the rest of the document `inert`, the page behind unable to scroll, and
 * focus returned to something real on the way out.
 *
 * Extracted after the third copy appeared. Each piece is here because getting it
 * wrong produced a real defect, not because it is conventional:
 *
 *  - `inert` on every off-path sibling takes the page out of the tab order AND
 *    the a11y tree with one attribute per branch (it inherits). Anything already
 *    inert is left alone, so we never clear somebody else's flag.
 *  - `WALLET_OVERLAY_TAGS` are SKIPPED. `inert` crosses into a shadow root, so
 *    marking `<onboard-v2>` makes the wallet picker unclickable — and one of these
 *    dialogs exists specifically to open it. See that constant for the full story.
 *  - Tab is cycled explicitly, because `inert` does not do it. The test is "is the
 *    focused element a TAB STOP", not "is it inside" — the card itself is focused
 *    on open and is not a stop, so a `contains()` test would let Shift-Tab walk
 *    straight out of the dialog.
 *  - With NO tab stops at all (a dialog whose only control is disabled mid-action),
 *    focus is parked on the card rather than swallowed, or it lands on `<body>` and
 *    the dialog becomes a keyboard dead end.
 *  - Focus restoration skips a target that is `document.body`, gone from the DOM,
 *    or disabled: `focus()` on any of those is a silent no-op that leaves focus
 *    nowhere, and the opener being REMOVED is the normal case (a button that
 *    completed its job).
 *
 * `dismiss` is optional ON PURPOSE. Passing nothing means Escape does nothing —
 * which is what a dialog that must only be dismissed by its own explicit control
 * requires. Do not add a default.
 */
export function useModalChrome({
  containerRef,
  cardRef,
  dismiss,
  fallbackFocusSelector = '.portalHead h1, h1',
}: {
  /** The backdrop — everything outside it is made inert. */
  containerRef: RefObject<HTMLElement | null>;
  /** The panel that takes focus on open. Must be `tabindex="-1"`. */
  cardRef: RefObject<HTMLElement | null>;
  /**
   * Called on Escape. Return `false` from `canDismiss` to refuse at that moment
   * (a wallet prompt is open, a request is in flight). Omit `dismiss` entirely for
   * a dialog Escape must never close.
   */
  dismiss?: { onDismiss: () => void; canDismiss?: () => boolean };
  /** Focused when the opener is gone. Falls back to the page heading. */
  fallbackFocusSelector?: string;
}): void {
  /**
   * The LATEST `dismiss`, not the one from mount.
   *
   * The trap is mounted-once by design (re-running it would re-inert the document
   * on every render), so a `dismiss` captured in that closure would be frozen at
   * first render — and callers build it inline, closing over state like "is a
   * request in flight". The handler would then read a `canDismiss` that always
   * answers with the FIRST render's value, i.e. Escape would close a dialog
   * mid-action exactly when it must not. Same fix, same reason, as `PayModal`'s
   * `busyRef`.
   */
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();

    const inerted: HTMLElement[] = [];
    for (let child: HTMLElement = container; child !== document.body; ) {
      const parent = child.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === child || !(sibling instanceof HTMLElement)) continue;
        if (sibling.hasAttribute('inert')) continue;
        if (WALLET_OVERLAY_TAGS.includes(sibling.tagName)) continue;
        sibling.setAttribute('inert', '');
        inerted.push(sibling);
      }
      child = parent;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        const current = dismissRef.current;
        if (!current || current.canDismiss?.() === false) return;
        event.preventDefault();
        current.onDismiss();
        return;
      }
      if (event.key !== 'Tab' || !container) return;
      const stops = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) {
        event.preventDefault();
        cardRef.current?.focus();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
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
      // Before focusing: `inert` must come off, or the restore target is
      // still unfocusable.
      for (const el of inerted) el.removeAttribute('inert');
      const opener =
        restoreFocusTo &&
        restoreFocusTo !== document.body &&
        restoreFocusTo.isConnected &&
        !restoreFocusTo.hasAttribute('disabled')
          ? restoreFocusTo
          : null;
      if (opener) {
        opener.focus();
        return;
      }
      const fallback = document.querySelector<HTMLElement>(fallbackFocusSelector);
      if (fallback) {
        fallback.setAttribute('tabindex', '-1');
        fallback.focus();
      }
    };
    // MOUNTED ONCE, deliberately: re-running this would re-inert the document and
    // re-steal focus on every render. `dismiss` is reached through `dismissRef`
    // instead of the deps array — see that ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
