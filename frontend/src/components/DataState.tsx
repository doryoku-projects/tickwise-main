"use client";

/*
 * The loading, error and empty presentations shared by every data-driven view.
 *
 * Lifted verbatim from the one page that already implemented all four states
 * (/portal/keys) rather than designed fresh, so converting the remaining pages
 * introduces no new visual language — the brief's requirement is that the states
 * exist and match, not that they look new.
 */

import type { ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Skeleton list rows. `lines` shapes each row to roughly the content it stands in
 * for, so the placeholder does not visibly resize when real data lands.
 */
export function SkeletonRows({ rows = 3, lines = 2 }: { rows?: number; lines?: number }) {
  return (
    <ul className="divide-y divide-border/60" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center gap-3 py-4">
          <div className="h-4 w-4 animate-pulse rounded bg-muted" />
          <div className="flex-1 space-y-2">
            {Array.from({ length: lines }, (_, l) => (
              <div
                key={l}
                className="h-3 animate-pulse rounded bg-muted"
                style={{ width: l === 0 ? "10rem" : "16rem" }}
              />
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A block-shaped skeleton, for panels and stat cards rather than list rows. */
export function SkeletonBlock({ className = "h-24" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-muted ${className}`} aria-hidden />;
}

/**
 * Inline error. Inline and not a toast, per the brief, and it shows the server's
 * own message rather than a generic one. Retry is offered whenever the caller can
 * re-run the request.
 */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <span className="text-foreground">{message}</span>
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry} className="shrink-0">
          <RefreshCw className="mr-1 h-3.5 w-3.5" /> Try again
        </Button>
      )}
    </div>
  );
}

/**
 * Empty state. The brief is specific that empty must offer a next action rather
 * than just saying "no data", so `action` is part of the shape.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="py-8 text-center">
      <div className="text-sm font-medium">{title}</div>
      {body && <p className="mt-1 text-sm text-muted-foreground">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
