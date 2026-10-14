'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { InlineError, SkeletonBlock, SkeletonRows } from '@/components/DataState';
import { Card } from '@/components/portal/Card';
import { PendingEmailNotice, VerifyEmailPrompt } from '@/components/portal/EmailControls';
import { NoEmailNotice } from '@/components/portal/NoEmailNotice';
import { QuotaMeter } from '@/components/portal/QuotaMeter';
import { Button } from '@/components/ui/button';
import { httpStatus, portalApi, type AccountOverview } from '@/lib/portal-api';

export default function PortalOverviewPage() {
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /**
   * A 403 from this route means the SHELL, not this page, owns the screen — it
   * withholds every child until it has decided whether the portal is locked,
   * and renders the verify-to-continue gate when it is. So this page must never
   * answer a 403 with its own retry: two screens for one problem, and the retry
   * on this one could only ever fail again.
   *
   * Reaching this branch at all means the shell's decision and this fetch
   * disagreed (the shell's `me` request failed, or verification changed under
   * us mid-flight), so the way forward is to make the shell decide again —
   * which a reload does, and a re-fetch of this route does not.
   */
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setForbidden(false);
    try {
      setOverview(await portalApi.overview());
    } catch (err) {
      // Status, not prose: the server is free to reword its 403 at any time.
      if (httpStatus(err) === 403) setForbidden(true);
      setError(err instanceof Error ? err.message : 'Failed to load your account');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your plan, the units you&apos;ve used this month, and your keys.
          </p>
        </div>
        <Button asChild className="bg-gradient-primary">
          <Link href="/portal/keys">Create an API key</Link>
        </Button>
      </div>

      {loading ? (
        <>
          <Card>
            <SkeletonBlock className="h-20" />
          </Card>
          <Card>
            <SkeletonRows rows={2} />
          </Card>
        </>
      ) : error ? (
        <InlineError
          message={error}
          onRetry={forbidden ? () => window.location.reload() : () => void load()}
        />
      ) : overview ? (
        <>
          {/* Three distinct states, in priority order — never ask someone to
              check an inbox we don't know, and never ask for a code that was
              never minted.

              1. No address at all (wallet-only signup): the banner carries the
                 form, and the code entry appears inside it the moment an
                 address is claimed.
              2. A PENDING claim: an address was claimed and the code is
                 outstanding. Shown from `customer.pendingEmail`, so it is here
                 on a plain reload and not only right after submitting, and
                 shown even when a verified `email` already exists — that is
                 someone half-way through changing address, and they need the
                 input, not silence.
              3. An unverified SIGNUP address. `emailVerificationRequired`
                 gates this one and only this one: it decides whether an
                 unproven signup is locked out, and a deployment that doesn't
                 verify signups must not nag about it. A CLAIM is always proved
                 regardless of that flag, which is why (2) sits above it and
                 ignores it. */}
          {!overview.customer.email ? (
            <NoEmailNotice
              customer={overview.customer}
              emailVerificationRequired={overview.emailVerificationRequired}
              onSaved={load}
            />
          ) : overview.customer.pendingEmail ? (
            <PendingEmailNotice email={overview.customer.pendingEmail} onVerified={load} />
          ) : (
            overview.emailVerificationRequired &&
            !overview.customer.emailVerifiedAt && (
              <VerifyEmailPrompt email={overview.customer.email} onVerified={load} />
            )
          )}

          <Card>
            <QuotaMeter usage={overview.usage} />
          </Card>

          <Card>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Account</div>
            {/* TWO across on a phone, not four. The usage page's four-across
                tiles carry pure figures; this row leads with a plan NAME, and
                the four columns a 375px card allows are ~50px of text each —
                "Professional" needs 104px even at the small step, so four
                across would truncate the one value here that is not
                self-evident. Two columns give ~112px, which every real value
                clears, and still turn four full-width rows into two.

                Back to ONE below 360px, the same width `.statGrid` gives up at
                on the settings page, so the portal collapses in one step rather
                than two. Measured at 320px the pair leaves 83px a tile, which
                clips "1,000,000" to "1,000,0…" — and a truncated figure has
                stopped being the figure. */}
            <div className="mt-4 grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:gap-4 lg:grid-cols-4">
              <Stat label="Plan" value={overview.plan?.name ?? overview.customer.planKey} />
              <Stat
                label="Monthly units"
                value={
                  overview.plan?.monthlyUnits === 0
                    ? 'Unlimited'
                    : (overview.plan?.monthlyUnits ?? overview.usage.limit).toLocaleString()
                }
              />
              <Stat
                label="Rate limit"
                value={
                  overview.plan?.rateLimitPerMin
                    ? `${overview.plan.rateLimitPerMin.toLocaleString()} / min`
                    : '—'
                }
              />
              <Stat
                label="Active keys"
                value={`${overview.keys.active}${overview.keys.max > 0 ? ` / ${overview.keys.max}` : ''}`}
              />
            </div>

            {overview.keys.active === 0 && (
              <div className="mt-5 border-t border-border/60 pt-5">
                <p className="text-sm text-muted-foreground">
                  You don&apos;t have an API key yet — nothing can call the API until you create
                  one.
                </p>
                <Button asChild className="mt-3 bg-gradient-primary">
                  <Link href="/portal/keys">Create your first key</Link>
                </Button>
              </div>
            )}
          </Card>

          <Card>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">
              Next steps
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Send your key as the <code className="text-foreground">KC-APIKey</code> header on any{' '}
              <code className="text-foreground">/v1</code> endpoint. Coverage is Uniswap v4 on
              Ethereum, Arbitrum and Avalanche.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/portal/usage">See your usage</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/pricing#units">What a unit costs</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/explore">Browse the data</Link>
              </Button>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}

/**
 * One account figure. Padding, label and value all step down below `sm`, the
 * same language the usage page's `Metric` speaks — one notch gentler, because
 * two columns leave twice the room four do.
 *
 * The value is clipped rather than wrapped, and carries its own `title`. Every
 * label fits one line at the narrow step (widest is "Monthly units" at 78px in
 * ~112px), so the tiles' values sit on one baseline; a value allowed to wrap
 * would drop one of them a line below its neighbour and read as a fault. The
 * clip is the guard for a plan name longer than any we ship — it keeps the
 * name reachable on hover and, more to the point, stops it widening the track.
 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-surface-2/50 p-3 sm:p-4">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground sm:text-xs sm:tracking-widest">
        {label}
      </div>
      <div className="mt-1 truncate font-display text-base font-semibold sm:text-xl" title={value}>
        {value}
      </div>
    </div>
  );
}
