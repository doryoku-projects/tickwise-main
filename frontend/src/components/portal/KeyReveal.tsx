'use client';

import { Check, Copy, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { IssuedApiKey } from '../../lib/portal-api';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one-time API key reveal.
 *
 * The backend returns the raw key EXACTLY once and stores only its SHA-256 —
 * there is no second chance. So this is a dedicated surface (never a toast),
 * and it can be dismissed ONLY by the explicit "I've saved it" button: no
 * click-outside handler, no Escape key, nothing that a stray click can trigger.
 * Do not add either.
 *
 * For the same reason focus is TRAPPED here while the key is on screen. Without
 * the trap the page behind stays in the tab order and "I've saved it" is the
 * last focusable element in the document, so one Tab + Enter lands on a
 * background control — or wraps back onto dismiss — and destroys the only copy
 * of the key before it has been saved.
 */
export function KeyReveal({ issued, onDismiss }: { issued: IssuedApiKey; onDismiss: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const backdropRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;

    const restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Land on "Copy key", not on the dismiss button.
    copyRef.current?.focus();

    // Take the rest of the document out of the tab order AND the a11y tree:
    // walk up from the dialog and mark every off-path sibling `inert`, which is
    // inherited, so one attribute per branch covers the whole subtree. Anything
    // already inert is left alone so we never clear someone else's flag.
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

    // `inert` is not everywhere yet, and it does not cycle focus on its own —
    // cycle Tab/Shift-Tab explicitly. Capture phase, on the document, so it
    // still fires if focus has somehow escaped the card.
    function onKeyDown(event: KeyboardEvent) {
      // NOTE: Escape is deliberately NOT handled — see the comment above.
      if (event.key !== 'Tab' || !backdrop) return;
      const stops = Array.from(backdrop.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) {
        event.preventDefault();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && backdrop.contains(active);
      if (event.shiftKey ? !inside || active === first : !inside || active === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      for (const el of inerted) el.removeAttribute('inert');
      restoreFocusTo?.focus();
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.key);
      setCopied('ok');
      setTimeout(() => setCopied('idle'), 2500);
    } catch {
      // Clipboard is blocked outside secure contexts — tell them to select it.
      setCopied('fail');
    }
  }

  return (
    <div
      className="revealBackdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reveal-title"
      ref={backdropRef}
    >
      <div className="revealCard">
        <h2 id="reveal-title">
          <TriangleAlert size={17} style={{ color: 'var(--red)' }} />
          Copy your API key now
        </h2>
        <p className="admin-note">
          {issued.label ? `“${issued.label}” · ` : ''}
          {issued.keyType === 'browser' ? 'Browser key' : 'Server key'}
        </p>

        <div className="revealWarning">
          <TriangleAlert size={16} style={{ flex: '0 0 auto', marginTop: 1 }} />
          <span>
            This is the only time you&apos;ll see this key. We store a hash of it, so we cannot show it again — if
            you lose it, revoke it and create another.
          </span>
        </div>

        {/* Focusable: with the page behind inert, this is the only way a
            keyboard user can reach the key to select it by hand when the
            clipboard is unavailable. */}
        <div className="admin-key" style={{ fontFamily: 'var(--mono)', userSelect: 'all' }} tabIndex={0}>
          {issued.key}
        </div>

        {copied === 'ok' && <div className="admin-ok">Copied to your clipboard.</div>}
        {copied === 'fail' && (
          <div className="admin-error">Couldn&apos;t reach the clipboard — select the key above and copy it.</div>
        )}

        <div className="revealActions">
          <button className="admin-btn ghost" onClick={copy} ref={copyRef}>
            {copied === 'ok' ? <Check size={14} /> : <Copy size={14} />}
            {copied === 'ok' ? 'Copied' : 'Copy key'}
          </button>
          <button className="admin-btn" onClick={onDismiss}>
            I&apos;ve saved it
          </button>
        </div>

        <p className="admin-note" style={{ marginBottom: 0 }}>
          After this, the list shows only the prefix <span className="mono">{issued.prefix}…</span>
        </p>
      </div>
    </div>
  );
}
