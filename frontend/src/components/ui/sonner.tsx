"use client";

import * as React from "react";
import { createPortal } from "react-dom";

import {
  EMPTY_TOASTS,
  dismissToast,
  getToasts,
  subscribeToasts,
  type ToastItem,
} from "@/components/ui/toast";

import "./toast.css";

/*
 * Renders the toast stack. Filename kept as sonner.tsx so src/app/providers.tsx
 * imports unchanged.
 *
 * The icons reproduce sonner's own glyphs: the success path is copied verbatim
 * from the rendered sonner SVG. The error glyph is drawn to match its visual
 * language (same 20x20 viewBox, same filled-circle treatment) rather than copied,
 * because the only error toast in the app fires on a clipboard-write failure and
 * there was no way to trigger it to capture the original.
 */

function SuccessIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.25 6a.75.75 0 011.5 0v4.5a.75.75 0 01-1.5 0V6zm.75 8.25a1 1 0 100-2 1 1 0 000 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function Toast({ item }: { item: ToastItem }) {
  return (
    <li
      className="tw-toast"
      data-closing={item.closing}
      // role="status" + aria-live announces the message without stealing focus,
      // which is what a transient notification wants.
      role="status"
      aria-live="polite"
      onClick={() => dismissToast(item.id)}
    >
      {/* div, not span, matching sonner's element types so text lays out identically. */}
      <div className="tw-toast-icon">
        {item.variant === "success" ? <SuccessIcon /> : <ErrorIcon />}
      </div>
      <div className="tw-toast-title">{item.message}</div>
    </li>
  );
}

export function Toaster() {
  const items = React.useSyncExternalStore(subscribeToasts, getToasts, () => EMPTY_TOASTS);
  const [mounted, setMounted] = React.useState(false);

  // document.body isn't available during SSR, so the portal waits for mount.
  React.useEffect(() => setMounted(true), []);
  if (!mounted || items.length === 0) return null;

  return createPortal(
    <ol className="tw-toaster" tabIndex={-1}>
      {items.map((item) => (
        <Toast key={item.id} item={item} />
      ))}
    </ol>,
    document.body,
  );
}
