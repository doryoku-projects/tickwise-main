"use client";

import { X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/*
 * Was @radix-ui/react-dialog. Built on the native <dialog> element opened with
 * showModal(), which provides for free the three things that actually matter
 * here and are easy to get wrong by hand:
 *
 *   - top-layer rendering, so it escapes any ancestor's overflow/z-index/
 *     transform without needing a portal
 *   - a real focus trap (everything outside a modal dialog is inert per spec)
 *   - a cancelable `cancel` event on Escape — which is exactly the hook the
 *     one-time key reveal needs to refuse dismissal until acknowledged
 *
 * What it does NOT give, and is implemented below:
 *
 *   - backdrop-click-to-close. Native <dialog> ignores it, so it is wired via a
 *     click whose target is the dialog element itself (i.e. the click landed on
 *     the dialog's own box, not inside the content) — and routed through the
 *     same interceptor as Escape so a caller can block it.
 *   - open/close transitions. Driven off a data-state attribute, with the
 *     imperative .close() deferred until the animation has played.
 *
 * One real gotcha: Tailwind's Preflight resets `margin: 0` on every element,
 * which defeats the UA's `dialog:modal { margin: auto }` centering. So the
 * original fixed/translate centering classes are kept rather than relying on
 * native centering.
 */

type DialogContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
};
const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialog(): DialogContextValue {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error("Dialog parts must be rendered inside <Dialog>");
  return ctx;
}

/** Mirrors the shape of Radix's interceptor events: call preventDefault() to block. */
type InterceptEvent = { defaultPrevented: boolean; preventDefault: () => void };

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const titleId = React.useId();
  const descriptionId = React.useId();
  return (
    <DialogContext.Provider value={{ open, onOpenChange, titleId, descriptionId }}>
      {children}
    </DialogContext.Provider>
  );
}

/** Must stay in step with the duration-200 class on the dialog element. */
const CLOSE_ANIMATION_MS = 200;

export function DialogContent({
  className,
  children,
  onInteractOutside,
  onEscapeKeyDown,
  ...props
}: {
  className?: string;
  children: React.ReactNode;
  onInteractOutside?: (event: InterceptEvent) => void;
  onEscapeKeyDown?: (event: InterceptEvent) => void;
} & Omit<React.DialogHTMLAttributes<HTMLDialogElement>, "open">) {
  const { open, onOpenChange, titleId } = useDialog();
  const ref = React.useRef<HTMLDialogElement>(null);
  const [state, setState] = React.useState<"open" | "closing">("closing");

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (open && !el.open) {
      el.showModal();
      // Next frame, so the animate-in class has a starting state to leave.
      const raf = requestAnimationFrame(() => setState("open"));
      return () => cancelAnimationFrame(raf);
    }

    if (!open && el.open) {
      setState("closing");
      const timer = setTimeout(() => el.close(), CLOSE_ANIMATION_MS);
      return () => clearTimeout(timer);
    }
  }, [open]);

  /** Runs a caller's interceptor and closes unless it called preventDefault(). */
  const requestClose = (interceptor?: (event: InterceptEvent) => void) => {
    const event: InterceptEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    interceptor?.(event);
    if (!event.defaultPrevented) onOpenChange(false);
  };

  return (
    <dialog
      ref={ref}
      data-state={state}
      aria-labelledby={titleId}
      // Escape fires `cancel`; always prevent the native close so the decision
      // routes through onOpenChange (and any caller interceptor) instead.
      onCancel={(event) => {
        event.preventDefault();
        requestClose(onEscapeKeyDown);
      }}
      onClick={(event) => {
        if (event.target === ref.current) requestClose(onInteractOutside);
      }}
      className={cn(
        // `hidden [&[open]]:grid` rather than a bare `grid`: the UA stylesheet
        // hides a closed <dialog> via `dialog:not([open]) { display: none }`, but
        // an author `display: grid` beats any UA rule, which left the dialog
        // visible after it had actually closed. Keying display off the [open]
        // attribute restores that, and keeps the element displayed through the
        // closing animation (the attribute is only removed by .close()).
        "m-0 fixed left-[50%] top-[50%] z-50 hidden w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 text-foreground shadow-lg duration-200 [&[open]]:grid backdrop:bg-[color-mix(in_oklab,var(--background)_78%,transparent)] data-[state=closing]:animate-out data-[state=closing]:fade-out-0 data-[state=closing]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:rounded-lg",
        className,
      )}
      {...props}
    >
      {/* Unmounted while closed, matching the previous behaviour, so form state
          inside resets between openings and closed content isn't reachable. */}
      {open && children}
      <button
        type="button"
        onClick={() => requestClose()}
        className="absolute right-4 top-4 cursor-pointer rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </button>
    </dialog>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  const { titleId } = useDialog();
  return (
    <h2
      id={titleId}
      className={cn("text-lg font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  const { descriptionId } = useDialog();
  return (
    <p id={descriptionId} className={cn("text-sm text-muted-foreground", className)} {...props} />
  );
}
