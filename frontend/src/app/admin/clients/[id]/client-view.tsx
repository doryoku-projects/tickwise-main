'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { PANEL_PAGE_SIZES, Pagination, usePagination } from '@/components/admin/Pagination';
import { UsageDetailPanel } from '@/components/admin/UsageDetailPanel';
import { EmptyState, InlineError, SkeletonBlock, SkeletonRows } from '@/components/DataState';
import {
  adminApi,
  type AdminPayment,
  type AdminPaymentStatus,
  type AdminSubscription,
  type AdminSubscriptionStatus,
  type ApiKeyRow,
  type ClientDetail,
  type Plan,
  type UsageRow,
} from '@/lib/admin-api';
import { formatMoneyMinor, formatPeriod, formatUtcDate } from '@/lib/format';

/*
 * Everything the admin API knows about one customer, from six real endpoints:
 *
 *   GET /admin/clients/:id               the customer document
 *   GET /admin/clients/:id/usage         metered units per YYYY-MM period
 *   GET /admin/clients/:id/keys          API keys (hashes never leave the server)
 *   GET /admin/plans                     to name this customer's quota and rate limit
 *   GET /admin/subscriptions?customerId=
 *   GET /admin/payments?customerId=
 *
 * A seventh, `GET /admin/clients/:id/usage/detail`, is NOT in this bundle:
 * `UsageDetailPanel` is shared with the clients list and fetches it itself, and
 * a copy here would be a request nothing on this page reads.
 *
 * "Units MTD" is derived HERE and only here, from the monthly usage rows — the
 * clients LIST has no usage in its response, so a units column there would be
 * invented. It deliberately does NOT come from the detail report's totals: those
 * follow the range selector, and a headline stat that moves when a filter moves
 * is not a headline stat.
 */

interface ClientBundle {
  client: ClientDetail;
  plans: Plan[];
  usage: UsageRow[];
  keys: ApiKeyRow[];
  subscriptions: AdminSubscription[];
  payments: AdminPayment[];
}

export function AdminClientDetailView({ id }: { id: string }) {
  const load = useLoad<ClientBundle>(
    id,
    async () => {
      const [client, plans, usage, keys, subscriptions, payments] = await Promise.all([
        adminApi.getClient(id),
        adminApi.listPlans(),
        adminApi.getUsage(id),
        adminApi.listKeys(id),
        adminApi.listSubscriptions({ customerId: id, limit: 50 }),
        adminApi.listPayments({ customerId: id, limit: 50 }),
      ]);
      return { client, plans, usage, keys, subscriptions, payments };
    },
    'Could not load this client.',
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> All clients
        </Link>
        {/* Truncated for the same reason as the clients list's Manage heading,
            and measured the same way: most accounts are named by their email
            address, and a 59-character one at `text-3xl` is 977px of unbreakable
            token against the 343px this column has at 375px. It has no break
            opportunity, nothing between here and `<body>` scrolls, so it used to
            run straight off the edge into `html, body { overflow-x: clip }` —
            invisible AND unreachable, with `documentElement.scrollWidth` still
            reporting a clean 375. `title` keeps the full string readable.
            NOT `overflow-wrap: anywhere`: that is the "REQUEST / S" defect. */}
        <h1
          className="mt-2 truncate font-display text-2xl font-semibold sm:text-3xl"
          title={load.status === 'ready' && load.data ? load.data.client.name : undefined}
        >
          {load.status === 'ready' && load.data ? load.data.client.name : 'Client'}
        </h1>
        <div className="mt-1 font-mono text-xs text-muted-foreground">{id}</div>
      </div>

      {load.status === 'error' ? (
        <InlineError message={load.error} onRetry={load.retry} />
      ) : load.status === 'loading' || !load.data ? (
        <>
          {/* Same grid and same tile height as the real stat row below. */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-4">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonBlock key={i} className="h-20 md:h-24" />
            ))}
          </div>
          {/* Same panels in the same order as `Populated` below, so nothing
              moves when the data lands — the shape of the page is the one thing
              a skeleton is for. */}
          <SkeletonBlock className="h-44" />
          <Panel title="Subscriptions">
            <SkeletonRows rows={2} lines={1} />
          </Panel>
          <Panel title="Payments">
            <SkeletonRows rows={3} lines={1} />
          </Panel>
          <Panel title="API keys">
            <SkeletonRows rows={2} lines={1} />
          </Panel>
          <Panel title="Usage detail">
            <SkeletonBlock className="m-4 h-52" />
          </Panel>
        </>
      ) : (
        <Populated bundle={load.data} />
      )}
    </div>
  );
}

function Populated({ bundle }: { bundle: ClientBundle }) {
  const { client, plans, usage, keys, subscriptions, payments } = bundle;
  const plan = plans.find((p) => p.key === client.planKey);

  // The metering period key is `YYYY-MM` in UTC — the same clock the quota
  // rolls on. Using the visitor's local month would show the wrong row for
  // anyone whose local date has already turned over.
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const mtd = usage.find((u) => u.period === currentPeriod);
  // Over EVERY fetched payment, not the page on screen: this is the count the
  // warning banner above states, and a count of one page is not a count.
  const unappliedPayments = payments.filter((p) => !p.appliedAt);

  /*
   * Three pagers, no filters on this page, so no `resetKey` and no guard —
   * everything here is a read view with nothing open inside it. Panel sizes
   * because these sit in cards, not on a page of their own.
   *
   * The subscriptions and payments arrays are a 50-row fetch (see the bundle
   * above); keys is unbounded, at up to 50 active per Pro account.
   */
  const subscriptionsRef = useRef<HTMLDivElement>(null);
  const paymentsRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<HTMLDivElement>(null);
  const pagedSubscriptions = usePagination(subscriptions, {
    defaultPageSize: 10,
    pageSizes: PANEL_PAGE_SIZES,
  });
  const pagedPayments = usePagination(payments, {
    defaultPageSize: 10,
    pageSizes: PANEL_PAGE_SIZES,
  });
  const pagedKeys = usePagination(keys, { defaultPageSize: 10, pageSizes: PANEL_PAGE_SIZES });

  return (
    <>
      {unappliedPayments.length > 0 && (
        <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
          <div className="font-medium">
            {unappliedPayments.length} of this customer&apos;s payments{' '}
            {unappliedPayments.length === 1 ? 'has' : 'have'} not been applied
          </div>
          <p className="mt-1 text-muted-foreground">
            They have paid and have not been given what they paid for. See the ledger below.
          </p>
        </div>
      )}

      {/* Two across on a phone, not one: as a single column these four numbers
          were 532px, a whole viewport of stats before anything else. Four across
          would be denser still, but at 81px a tile cannot hold its `sub` line and
          each of those lines is the only place its fact appears on the page. */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-4">
        <Stat
          label="Plan"
          value={plan?.name ?? client.planKey}
          sub={client.planSource ? `set by ${client.planSource}` : 'no plan source recorded'}
        />
        <Stat
          label="Units MTD"
          value={(mtd?.unitsConsumed ?? 0).toLocaleString()}
          sub={`${(mtd?.requestCount ?? 0).toLocaleString()} requests · ${formatPeriod(currentPeriod)}`}
        />
        <Stat
          label="Monthly quota"
          value={plan ? (plan.monthlyUnits === 0 ? 'Unlimited' : plan.monthlyUnits.toLocaleString()) : '—'}
          sub={plan ? `${plan.rateLimitPerMin}/min burst` : 'plan not found'}
        />
        <Stat
          label="Account credit"
          value={formatMoneyMinor(client.creditBalanceMinor)}
          sub="held against future invoices"
        />
      </div>

      <div className="rounded-xl border border-border/60 bg-surface p-6 shadow-card">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full border px-2 py-0.5 text-[0.625rem] ${
              client.status === 'active'
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-destructive/40 bg-destructive/10 text-destructive'
            }`}
          >
            {client.status}
          </span>
          {client.emailVerifiedAt ? (
            <span className="rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[0.625rem] text-success">
              email verified
            </span>
          ) : (
            <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[0.625rem] text-warning">
              email unverified
            </span>
          )}
        </div>
        <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Email">
            <span className="text-xs">{client.email ?? '—'}</span>
          </Field>
          {client.pendingEmail && (
            <Field label="Pending email">
              <span className="text-xs">
                {client.pendingEmail}
                <span className="ml-1 text-muted-foreground">(claimed, not proved)</span>
              </span>
            </Field>
          )}
          <Field label="Origin">
            <span className="text-xs">{client.origin ?? '—'}</span>
          </Field>
          <Field label="Client since">
            <Mono>{formatUtcDate(client.createdAt)}</Mono>
          </Field>
          <Field label="Last login">
            <Mono>{client.lastLoginAt ? formatUtcDate(client.lastLoginAt) : 'never'}</Mono>
          </Field>
          {client.intendedPlanKey && (
            <Field label="Intended plan">
              <span className="text-xs">
                {client.intendedPlanKey}
                <span className="ml-1 text-muted-foreground">(asked for at signup; grants nothing)</span>
              </span>
            </Field>
          )}
          {client.currentSubscriptionId && (
            <Field label="Current subscription">
              <Link
                href={`/admin/subscriptions/${client.currentSubscriptionId}`}
                className="font-mono text-xs text-primary hover:underline"
              >
                {client.currentSubscriptionId}
              </Link>
            </Field>
          )}
        </dl>
      </div>

      <Panel title={`Subscriptions · ${subscriptions.length}`}>
        {subscriptions.length === 0 ? (
          <EmptyState
            title="No subscriptions"
            body="This customer has never started a checkout, so they are on whatever plan they were assigned."
          />
        ) : (
          <div className="overflow-x-auto" ref={subscriptionsRef}>
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border/60">
                  <th className="px-4 py-3">Subscription</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Current period</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {pagedSubscriptions.pageItems.map((s) => (
                  <tr key={s._id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/subscriptions/${s._id}`}
                        className="font-mono text-xs text-primary hover:underline"
                        title={s._id}
                      >
                        {shortId(s._id)}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{s.planKey}</td>
                    <td className="px-4 py-3 font-mono">
                      {formatMoneyMinor(s.unitAmountMinor)}
                      <span className="text-muted-foreground">
                        /{s.interval === 'year' ? 'yr' : 'mo'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <SubscriptionStatusPill status={s.status} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {formatUtcDate(s.currentPeriodStart)}
                      <div>→ {formatUtcDate(s.currentPeriodEnd)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* A SIBLING of the horizontal scroller, not a child: the table has a
            48rem floor, so a control inside the scroller slides off with it.
            Outside the `length === 0` branch too, because it renders nothing at
            one page and the empty state has no rows to page. */}
        <Pagination state={pagedSubscriptions} label="subscriptions" scrollTo={subscriptionsRef} />
      </Panel>

      <Panel title={`Payments · ${payments.length}`}>
        {payments.length === 0 ? (
          <EmptyState
            title="No payments"
            body="Nothing has ever been collected from this customer."
          />
        ) : (
          <div className="overflow-x-auto" ref={paymentsRef}>
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border/60">
                  <th className="px-4 py-3">Received</th>
                  <th className="px-4 py-3">Rail · charge</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Applied</th>
                  <th className="px-4 py-3">On chain</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {pagedPayments.pageItems.map((p) => (
                  <tr key={p._id} className={`align-top ${!p.appliedAt ? 'bg-warning/5' : ''}`}>
                    <td className="px-4 py-3 font-mono text-xs">{formatUtcDate(p.receivedAt)}</td>
                    <td className="px-4 py-3">
                      <div className="text-xs">{p.provider}</div>
                      <div
                        className="font-mono text-[0.625rem] text-muted-foreground"
                        title={p.providerPaymentId}
                      >
                        {shortId(p.providerPaymentId)}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono">
                      {formatMoneyMinor(p.amountMinor, p.currency)}
                      {p.overpaidMinor > 0 && (
                        <div className="text-[0.625rem] text-muted-foreground">
                          +{formatMoneyMinor(p.overpaidMinor, p.currency)} over
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <PaymentStatusPill status={p.status} />
                    </td>
                    <td className="px-4 py-3">
                      {p.appliedAt ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatUtcDate(p.appliedAt)}
                        </span>
                      ) : (
                        <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[0.625rem] text-warning">
                          not applied
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[0.625rem] text-muted-foreground">
                      {p.txHash ? (
                        <span title={p.txHash}>
                          {p.chainId ? `chain ${p.chainId} · ` : ''}
                          {shortId(p.txHash)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination state={pagedPayments} label="payments" scrollTo={paymentsRef} />
      </Panel>

      <Panel title={`API keys · ${keys.length}`}>
        {keys.length === 0 ? (
          <EmptyState
            title="No API keys"
            body="This client has not been issued a key, so nothing of theirs is calling the API."
          />
        ) : (
          <div className="overflow-x-auto" ref={keysRef}>
            {/*
              Seven columns need 635px of min-content against the 325px this
              panel gets on a phone, so below `sm` each key is a card instead:
              label with its type and status, the prefix, the origins, then the
              two dates on one line. Nothing is dropped — this is a read view, so
              the four short attributes lose only their column headings.
            */}
            {/* Both this card list and the `sm:` table below page off the SAME
                `pagedKeys` — two lists showing different slices of one array at
                two widths is a resize away from being wrong. */}
            <div className="space-y-2 sm:hidden">
              {pagedKeys.pageItems.map((k) => {
                const origins = k.allowedOrigins ?? [];
                return (
                  <div key={k._id} className="rounded-lg border border-border/60 bg-surface-2/50 p-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="min-w-0 truncate text-[0.8125rem]">{k.label || '—'}</div>
                      <div className="flex shrink-0 items-center gap-1">
                        <span className="rounded border border-border/60 bg-surface-2 px-2 py-0.5 text-xs">
                          {k.keyType ?? (origins.length ? 'browser' : 'server')}
                        </span>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[0.625rem] ${
                            k.status === 'active'
                              ? 'border-success/40 bg-success/10 text-success'
                              : 'border-border/60 bg-surface-2 text-muted-foreground'
                          }`}
                        >
                          {k.status}
                        </span>
                      </div>
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {k.keyPrefix}
                    </div>
                    {origins.length > 0 && (
                      <div className="truncate text-[0.6875rem] text-muted-foreground">
                        {origins[0]}
                        {origins.length > 1 ? ` +${origins.length - 1}` : ''}
                      </div>
                    )}
                    <div className="font-mono text-[0.625rem] text-muted-foreground">
                      created {formatUtcDate(k.createdAt)} · used{' '}
                      {k.lastUsedAt ? formatUtcDate(k.lastUsedAt) : 'never'}
                    </div>
                  </div>
                );
              })}
            </div>
            <table className="hidden w-full text-sm sm:table sm:min-w-[48rem]">
              <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border/60">
                  <th className="px-2 py-2 sm:px-4 sm:py-3">Label</th>
                  <th className="px-2 py-2 sm:px-4 sm:py-3">Prefix</th>
                  <th className="px-2 py-2 sm:px-4 sm:py-3">Type</th>
                  <th className="px-2 py-2 sm:px-4 sm:py-3">Origins</th>
                  <th className="px-2 py-2 sm:px-4 sm:py-3">Status</th>
                  <th className="px-2 py-2 sm:px-4 sm:py-3">Created</th>
                  <th className="px-2 py-2 sm:px-4 sm:py-3">Last used</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {pagedKeys.pageItems.map((k) => (
                  <tr key={k._id} className="align-top">
                    <td className="px-2 py-2 sm:px-4 sm:py-3">{k.label || '—'}</td>
                    <td className="px-2 py-2 font-mono text-xs text-muted-foreground sm:px-4 sm:py-3">
                      {k.keyPrefix}
                    </td>
                    <td className="px-2 py-2 sm:px-4 sm:py-3">
                      <span className="rounded border border-border/60 bg-surface-2 px-2 py-0.5 text-xs">
                        {k.keyType ?? (k.allowedOrigins?.length ? 'browser' : 'server')}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-[0.625rem] text-muted-foreground sm:px-4 sm:py-3">
                      {k.allowedOrigins?.length ? k.allowedOrigins.join(', ') : '—'}
                    </td>
                    <td className="px-2 py-2 sm:px-4 sm:py-3">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[0.625rem] ${
                          k.status === 'active'
                            ? 'border-success/40 bg-success/10 text-success'
                            : 'border-border/60 bg-surface-2 text-muted-foreground'
                        }`}
                      >
                        {k.status}
                      </span>
                    </td>
                    <td className="px-2 py-2 font-mono text-xs sm:px-4 sm:py-3">
                      {formatUtcDate(k.createdAt)}
                    </td>
                    <td className="px-2 py-2 font-mono text-xs text-muted-foreground sm:px-4 sm:py-3">
                      {k.lastUsedAt ? formatUtcDate(k.lastUsedAt) : 'never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination state={pagedKeys} label="keys" scrollTo={keysRef} />
      </Panel>

      <UsageDetailPanel clientId={client._id} />

      <p className="text-xs text-muted-foreground">
        Read-only. Plan assignment, key issuing and revocation live on the clients list; no
        financial write is wired into this view.
      </p>
    </>
  );
}

// ─── Local atoms (see the note in ../../subscriptions/page.tsx) ──────────────

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[0.625rem] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

/* Padding and type step down below `md` so two of these fit a phone width with
   the `sub` line intact; the desktop tile is unchanged. */
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-surface p-3 shadow-card md:p-6">
      <div className="text-[0.625rem] uppercase tracking-widest text-muted-foreground md:text-xs">
        {label}
      </div>
      <div className="mt-1 font-display text-lg font-semibold md:text-2xl">{value}</div>
      {sub && (
        <div className="mt-1 text-[0.5rem] text-muted-foreground md:text-[0.625rem]">{sub}</div>
      )}
    </div>
  );
}

/** `actions` is the panel's own control slot — a filter that governs only its body. */
function Panel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-surface shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-4 text-xs uppercase tracking-widest text-muted-foreground sm:px-6">
        {/* A real heading, not a styled span — the only section names below the
            page `h1`, and a heading list is the one keyboard way to reach them. */}
        <h2 className="font-sans text-xs uppercase tracking-widest">{title}</h2>
        {actions}
      </div>
      <div className="px-2 py-1">{children}</div>
    </div>
  );
}

const SUBSCRIPTION_TONES: Record<string, string> = {
  active: 'border-success/40 bg-success/10 text-success',
  trialing: 'border-success/40 bg-success/10 text-success',
  past_due: 'border-warning/40 bg-warning/10 text-warning',
  incomplete: 'border-warning/40 bg-warning/10 text-warning',
  unpaid: 'border-destructive/40 bg-destructive/10 text-destructive',
};

function SubscriptionStatusPill({ status }: { status: AdminSubscriptionStatus }) {
  const tone = SUBSCRIPTION_TONES[status] ?? 'border-border/60 bg-surface-2 text-muted-foreground';
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[0.625rem] ${tone}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

const PAYMENT_TONES: Record<string, string> = {
  succeeded: 'border-success/40 bg-success/10 text-success',
  pending: 'border-warning/40 bg-warning/10 text-warning',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
};

function PaymentStatusPill({ status }: { status: AdminPaymentStatus }) {
  const tone = PAYMENT_TONES[status] ?? 'border-border/60 bg-surface-2 text-muted-foreground';
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[0.625rem] ${tone}`}>
      {status}
    </span>
  );
}

/** Loading / error / ready for one request. See the note in ../../subscriptions/page.tsx. */
function useLoad<T>(key: string, fetcher: () => Promise<T>, fallback: string) {
  const [state, setState] = useState<{
    status: 'loading' | 'error' | 'ready';
    data: T | null;
    error: string;
  }>({ status: 'loading', data: null, error: '' });
  const [attempt, setAttempt] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', data: null, error: '' });
    fetcherRef
      .current()
      .then((data) => {
        if (active) setState({ status: 'ready', data, error: '' });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          data: null,
          error: err instanceof Error ? err.message : fallback,
        });
      });
    return () => {
      active = false;
    };
  }, [key, attempt, fallback]);

  return { ...state, retry: () => setAttempt((a) => a + 1) };
}
