'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The confirmation step for an action worth pausing on — replacing
 * `window.confirm`.
 *
 * `window.confirm` was not merely ugly here. It renders the ORIGIN as the title
 * ("api.tickwise.xyz says"), it cannot be styled or themed, it cannot show the
 * consequence with any emphasis, it BLOCKS the event loop so nothing behind it
 * can keep polling, and on a crypto rail the copy it flattens is exactly the
 * copy that matters — "do NOT cancel if you have already sent a payment".
 *
 * Dismissal is a CANCEL here, so Escape and the backdrop are both allowed —
 * unlike `PayModal`, where dismissing discards a payload the customer is
 * part-way through signing. Both are refused while the action is in flight: an
 * Escape arriving mid-request would leave the caller's `busy` state stranded
 * with no dialog to report back into.
 *
 * `onConfirm` may be async; this owns the pending state so every caller does
 * not have to invent one.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Never mind',
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  /** Rich by design — the consequence usually needs more than one sentence. */
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Paints the confirm control as destructive. */
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      // The caller usually unmounts us on success; guarding anyway so a caller
      // that does NOT cannot leave the buttons dead.
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent
        className="max-w-md"
        // Both dismissal routes are refused mid-flight, for the reason in the
        // header comment. `preventDefault` leaves the dialog mounted.
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">{body}</div>
        <DialogFooter>
          {/* The two controls do opposite things, so they must not look alike —
              the bug this replaces was a "log out" and a "stay signed in"
              painted identically, which is how somebody ends a session while
              reaching for the button that keeps it. */}
          <Button variant="ghost" type="button" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={danger ? 'destructive' : 'default'}
            className={danger ? undefined : 'bg-gradient-primary'}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
