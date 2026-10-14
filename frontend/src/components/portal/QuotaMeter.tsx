'use client';

import Link from 'next/link';
import { formatPeriod } from '../../lib/format';
import type { UsageSnapshot } from '../../lib/portal-api';

/**
 * When the allowance turns over, DERIVED FROM THE QUOTA KEY THE SERVER SENT.
 *
 * This used to be the flat sentence "Resets on the 1st of each month, UTC." —
 * true today (`secondsUntilQuotaReset` counts to the 1st, UTC) but true as an
 * accident of the current implementation, not as anything the response says. If
 * the quota ever moves onto the billing anniversary, that sentence keeps being
 * rendered and starts being a lie, and nothing about it would fail.
 *
 * `usage.period` IS the key the quota is counted under, so reading the turnover
 * off it means the copy can only be wrong if the key is. A key that is not a
 * calendar month means the window has moved somewhere this component cannot
 * date, so it says only the part that is still true rather than guessing.
 */
function resetLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return 'Resets when your next usage window opens.';
  // Month is 0-based, so the un-decremented month number IS the next one — and
  // it rolls the year over for December on its own.
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
  const when = next.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `Resets ${when}, 00:00 UTC.`;
}

/**
 * Units consumed against the plan allowance for the CURRENT CALENDAR MONTH.
 *
 * Two honesty rules are baked in and must not be "simplified" away in a re-skin:
 *  1. The window the quota is counted over is whatever the server sent as
 *     `usage.period` — the label is derived from it by `resetLabel` above
 *     rather than restating today's calendar-month rule as a constant.
 *  2. Endpoints cost different numbers of units, so the unit-cost table is one
 *     click away; without it this reads as a request counter, which it is not.
 *
 * `limit === 0` means unlimited, and the bar is dropped rather than drawn empty
 * — a 0% progress bar on an unmetered plan reads as "no allowance left".
 */
export function QuotaMeter({ usage }: { usage: UsageSnapshot }) {
  const unlimited = usage.limit === 0;
  const pct = unlimited ? 0 : Math.min(100, (usage.units / usage.limit) * 100);
  const tone = pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-gradient-primary';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">
            Units this month
          </div>
          <div className="mt-1 font-display text-2xl font-semibold">
            {usage.units.toLocaleString()}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {unlimited ? 'units used' : `/ ${usage.limit.toLocaleString()}`}
            </span>
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {formatPeriod(usage.period)}
          {!unlimited && ` · ${Math.round(pct)}%`}
          <div>
            <Link href="/pricing#units" className="text-primary hover:underline">
              What counts as a unit?
            </Link>
          </div>
        </div>
      </div>

      {unlimited ? (
        <p className="text-sm text-muted-foreground">Your plan has no monthly unit ceiling.</p>
      ) : (
        <div
          className="h-2 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
        </div>
      )}

      <p className="text-xs text-muted-foreground">{resetLabel(usage.period)}</p>

      {!unlimited && pct >= 100 && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {/* Deliberately does NOT name the date a second time: the reset line
              directly above already derives it from `usage.period`, and the
              hardcoded "the 1st" that used to be here was the same drift
              `resetLabel` exists to remove. */}
          You&apos;ve used your monthly units. Metered endpoints return 429 until the quota resets.
        </div>
      )}
    </div>
  );
}
