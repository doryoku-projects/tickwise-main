'use client';

/**
 * The four states every list owes the user: loading, error, empty, populated.
 * Loading/error/empty live here so the portal, pricing and the dashboard tell
 * the same story; "populated" is each caller's own markup.
 */

/** Shimmering placeholder rows — same treatment the dashboard table uses. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeletonRows" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeletonRow" />
      ))}
    </div>
  );
}

/** Inline failure with the SERVER's message — never a generic "something went wrong". */
export function ErrorNotice({
  message,
  onRetry,
  /**
   * Overrides the button's wording. "Try again" is a promise that repeating the
   * same call might work, so a failure that will NEVER resolve by repetition
   * (a 403 that needs the session re-evaluated, say) must say what it actually
   * does instead — a button that can only fail again is a dead end.
   */
  retryLabel = 'Try again',
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="notice error" role="alert">
      {message}
      {/* .miniButton, not .admin-btn — this renders on marketing pages too,
          where panel.css is not loaded. */}
      {onRetry && (
        <div style={{ marginTop: 10 }}>
          <button className="miniButton" onClick={onRetry}>
            {retryLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/** Empty with a next action — "no data" on its own is a dead end. */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="emptyState">
      <strong>{title}</strong>
      {hint && <span style={{ maxWidth: '46ch', textAlign: 'center', lineHeight: 1.6 }}>{hint}</span>}
      {action}
    </div>
  );
}
